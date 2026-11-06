#!/usr/bin/env node
// Yousj 短视频 —— 全链路 E2E 测试（零依赖，只用 Node 内置模块，Node >= 18）
//
// 用法：
//   1. 先把服务跑起来（测试注册必须开 dev 取码模式）：
//        ALLOW_DEV_CODE=1 node server/server.js
//   2. 再跑本脚本：             node tests/e2e.mjs
//      换地址：                 BASE=http://127.0.0.1:18088 node tests/e2e.mjs
//
// 注册定版：仅邮箱验证码流程——POST /api/register/request-code {email} 发码
// （生产经自建邮局、发件人 hello@yousj.cc；dev 模式响应带 devCode），
// POST /api/register/verify {email,code,name,password,pubKey?} 验码建号；
// 旧的直接注册接口已废弃（410）。本脚本断言：错码建号失败、已注册邮箱
// 再请求验证码返回 409、旧接口返回 410。登录以邮箱+密码为主（兼容账号#号）。
//
// 覆盖链路（每步打印 ✓/✗，最后汇总 PASS/FAIL，失败时退出码非 0）：
//   health → 邮箱验证码注册两用户（含 409/错码/410 断言）→ 邮箱密码登录
//   → A 发作品 → 分片上传小文件拼合后可访问
//   → B 在推荐流看到 → 点赞 → 收藏 → 评论
//   → 搜人 → 加好友申请 → 接受 → 朋友流看到 A 作品
//   → B 私信 A（发送模拟密文）→ A 取回的密文与发送一字不差（证明服务器不改密文）
//   → A 转发作品给 B → B 私信里收到作品卡片 → 收藏列表有该作品
//
// 私信加密说明：私信是端到端加密的（ECDH P-256 + HKDF + AES-GCM-256，
// 客户端加密、服务器只存密文），所以 e2e 不发明文，而是发一段模拟的
// 密文字符串、再断言取回时原样未变——服务器若解密/改写/截断都会被抓到。
//
// 分片上传说明：接口为 init / chunk / complete，每片 8MB（本测试用小文件
// 切成 3 片走完整流程，拼合后逐字节比对，证明拼合无误且能通过 URL 访问）。
//
// 压缩规则（双阈值）：时长 > 1 小时 或 文件 > 5GB，任一触发即压缩为 1080p；
// 两者都不超则保 4K 原画、不压缩。作品对象带 compressReason 字段：
// null（不压缩）/ "duration" / "size" / "both"。本测试发布的是小作品，
// 应断言其 compressReason === null。
//
// 接口命名说明：每一步都会依次尝试一组候选路径（以当前后端 server.js 的
// 真实路径为首选，其余为同义兜底），哪条先通（2xx）就用哪条，
// 所以它测的是「功能通不通」，不是「路径名对不对」。

import { createHash } from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:18088').replace(/\/+$/, '');
const TIMEOUT_MS = 10_000;

// ---------- 小工具 ----------

const results = [];
function step(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  return ok;
}

async function req(method, path, { token, body, form } = {}) {
  const headers = {};
  let payload;
  if (form) {
    payload = form; // FormData：不要手动设 Content-Type，fetch 会带 boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { status: 0, data: null, text: String(err && err.message ? err.message : err) };
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 响应就留 null，看 text */ }
  return { status: res.status, data, text };
}

const isOk = (r) => r.status >= 200 && r.status < 300;

// 依次尝试候选调用，返回第一个 2xx 的结果（连同命中的下标）；全败返回最后一个结果
async function tryAll(candidates) {
  let last = null;
  for (let i = 0; i < candidates.length; i++) {
    last = await candidates[i]();
    if (isOk(last)) return { res: last, idx: i };
  }
  return { res: last, idx: -1 };
}

// 从各种常见响应形状里掏 token / id / user / 列表
function pickToken(d) {
  if (!d || typeof d !== 'object') return null;
  return d.token || d.data?.token || d.user?.token || d.session?.token || null;
}
function pickUser(d) {
  if (!d || typeof d !== 'object') return null;
  return d.user || d.data?.user || (d.id || d.userId ? d : null) || d.data || null;
}
function pickUserId(d) {
  const u = pickUser(d);
  if (!u || typeof u !== 'object') return null;
  return u.id ?? u.userId ?? u._id ?? u.account ?? u.no ?? null;
}
function pickWorkId(d) {
  if (!d || typeof d !== 'object') return null;
  const w = d.work || d.video || d.post || d.data?.work || d.data?.video || d.data || d;
  if (w && typeof w === 'object') return w.id ?? w.workId ?? w.videoId ?? w._id ?? null;
  return null;
}
function pickList(d) {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (const key of ['items', 'list', 'works', 'videos', 'posts', 'feed', 'data', 'results', 'users', 'messages', 'favorites', 'requests']) {
    if (Array.isArray(d[key])) return d[key];
    if (d[key] && typeof d[key] === 'object') {
      const inner = pickList(d[key]);
      if (inner.length) return inner;
    }
  }
  return [];
}
// 在响应里找某个作品（按 id 或标题），找不到再退化为全文包含判断
function containsWork(data, workId, title) {
  const list = pickList(data);
  const hit = list.some((it) => {
    if (!it || typeof it !== 'object') return false;
    const id = it.id ?? it.workId ?? it.videoId ?? it.work?.id ?? it.video?.id;
    return (workId != null && String(id) === String(workId)) || (title && it.title === title);
  });
  if (hit) return true;
  const raw = JSON.stringify(data ?? '');
  return (workId != null && raw.includes(String(workId))) || (title ? raw.includes(title) : false);
}
function containsUser(data, userId, nickname) {
  const list = pickList(data);
  const hit = list.some((it) => {
    if (!it || typeof it !== 'object') return false;
    const id = it.id ?? it.userId ?? it._id;
    return (userId != null && String(id) === String(userId)) || it.nickname === nickname || it.name === nickname || it.username === nickname;
  });
  if (hit) return true;
  const raw = JSON.stringify(data ?? '');
  return raw.includes(nickname) || (userId != null && raw.includes(String(userId)));
}

// ---------- 主流程 ----------

async function main() {
  console.log(`E2E target: ${BASE}\n`);

  // 0. 健康检查
  {
    const { res } = await tryAll([
      () => req('GET', '/api/health'),
      () => req('GET', '/health'),
      () => req('GET', '/'),
    ]);
    if (!step('health 健康检查', isOk(res), `status=${res.status}`)) {
      console.log('\n服务没起来？先跑 node server/server.js 再重试。');
      return summarize();
    }
  }

  // 准备两个测试账号（带时间戳后缀，避免重跑撞名/撞邮箱）
  // 注册定版流程（仅邮箱验证码）：request-code 发码 → verify 验码建号。
  // 服务须以 ALLOW_DEV_CODE=1 启动，request-code 的响应才会带 devCode 供测试取码
  // （生产环境验证码只走邮件：发件人 hello@yousj.cc，经自建邮局）。
  const RUN = Date.now().toString(36);
  const pass = 'e2e-test-123456';
  const aNick = `e2e_a_${RUN}`;
  const bNick = `e2e_b_${RUN}`;
  const aEmail = `e2e_a_${RUN}@example.com`;
  const bEmail = `e2e_b_${RUN}@example.com`;

  function pickDevCode(d) {
    if (!d || typeof d !== 'object') return null;
    const c = d.devCode ?? d.code ?? d.data?.devCode ?? d.data?.code ?? null;
    return c == null ? null : String(c);
  }

  async function requestCode(email) {
    return req('POST', '/api/register/request-code', { body: { email } });
  }
  async function verifyRegister(email, code, name) {
    return req('POST', '/api/register/verify', {
      body: { email, code, name, nickname: name, password: pass },
    });
  }

  // --- 用户 A：完整走一遍验证码流程，外加错码 / 重复邮箱 / 旧接口三条断言 ---
  let aToken = null;
  let aId = null;
  {
    const rc = await requestCode(aEmail);
    const devCode = pickDevCode(rc.data);
    if (!step('A 请求注册验证码（dev 模式拿到 devCode）', isOk(rc) && devCode != null,
      `status=${rc.status}${devCode == null ? '，没拿到 devCode：服务须以 ALLOW_DEV_CODE=1 启动' : ''}`)) return summarize();

    const wrongCode = devCode === '000000' ? '999999' : '000000';
    const bad = await verifyRegister(aEmail, wrongCode, aNick);
    step('A 错验证码建号失败', !isOk(bad), `status=${bad.status}（期望 4xx）`);

    const regA = await verifyRegister(aEmail, devCode, aNick);
    aToken = pickToken(regA.data);
    aId = pickUserId(regA.data);
    if (!step('A 验码建号成功', isOk(regA), `status=${regA.status}`)) return summarize();

    const dup = await requestCode(aEmail);
    step('已注册邮箱再请求验证码返回 409', dup.status === 409, `status=${dup.status}`);

    const legacy = await req('POST', '/api/register', { body: { name: `legacy_${RUN}`, password: pass } });
    step('旧直接注册接口已废弃（410）', legacy.status === 410, `status=${legacy.status}`);
  }

  // --- 用户 B：同样验证码流程（不再重复负面断言） ---
  let bToken = null;
  let bId = null;
  {
    const rc = await requestCode(bEmail);
    const devCode = pickDevCode(rc.data);
    if (!step('B 请求注册验证码', isOk(rc) && devCode != null, `status=${rc.status}`)) return summarize();
    const regB = await verifyRegister(bEmail, devCode, bNick);
    bToken = pickToken(regB.data);
    bId = pickUserId(regB.data);
    if (!step('B 验码建号成功', isOk(regB), `status=${regB.status}`)) return summarize();
  }

  // --- 登录：邮箱 + 密码为主（兼容账号#号） ---
  {
    const body = { email: aEmail, accountOrName: aEmail, account: aEmail, password: pass };
    const { res } = await tryAll([
      () => req('POST', '/api/login', { body }),
      () => req('POST', '/api/auth/login', { body }),
    ]);
    const t = pickToken(res.data);
    if (t) aToken = t;
    if (aId == null) aId = pickUserId(res.data);
    step('A 邮箱+密码登录成功', isOk(res), `status=${res.status}`);
  }

  // 兜底：注册响应没给 id 时，用「搜人」反查（此时搜索接口若已可用）
  // 真正的搜人断言在后面还会正式测一次。

  // 1. A 发布作品（先试 JSON 直发，再试 multipart 上传一个假视频文件）
  const title = `e2e作品_${RUN}`;
  let workId = null;
  {
    const jsonBody = { title, description: 'e2e 自动测试作品', desc: 'e2e 自动测试作品', text: title, caption: title, videoUrl: '' };
    const jsonTry = await tryAll([
      () => req('POST', '/api/works', { token: aToken, body: jsonBody }),
      () => req('POST', '/api/videos', { token: aToken, body: jsonBody }),
      () => req('POST', '/api/posts', { token: aToken, body: jsonBody }),
      () => req('POST', '/api/publish', { token: aToken, body: jsonBody }),
    ]);
    let res = jsonTry.res;
    if (!isOk(res)) {
      const makeForm = () => {
        const f = new FormData();
        f.append('video', new Blob(['e2e fake video bytes'], { type: 'video/mp4' }), 'e2e.mp4');
        f.append('file', new Blob(['e2e fake video bytes'], { type: 'video/mp4' }), 'e2e.mp4');
        f.append('title', title);
        f.append('description', 'e2e 自动测试作品');
        f.append('text', title);
        return f;
      };
      const formTry = await tryAll([
        () => req('POST', '/api/works', { token: aToken, form: makeForm() }),
        () => req('POST', '/api/videos', { token: aToken, form: makeForm() }),
        () => req('POST', '/api/upload', { token: aToken, form: makeForm() }),
        () => req('POST', '/api/publish', { token: aToken, form: makeForm() }),
      ]);
      res = formTry.res;
    }
    workId = pickWorkId(res.data);
    if (!step('A 发布作品', isOk(res), `status=${res.status} workId=${workId ?? '?'}`)) return summarize();
  }

  // 1b. 分片上传：小文件切 3 片走 init → chunk → complete，拼合后逐字节比对
  // （正式规格每片 8MB；测试文件小，但流程与大文件完全一致）
  {
    const CHUNK_SPEC = 8 * 1024 * 1024; // 规格：每片 8MB，init 时声明给服务器
    const original = Buffer.alloc(180_001);
    for (let i = 0; i < original.length; i++) original[i] = i % 251;
    const slices = [original.subarray(0, 60_000), original.subarray(60_000, 120_000), original.subarray(120_000)];
    const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
    let okAll = false;
    let detail = '';
    try {
      const initBody = {
        filename: `e2e-chunk_${RUN}.mp4`, size: original.length, totalChunks: slices.length,
        chunks: slices.length, chunkSize: CHUNK_SPEC, mimeType: 'video/mp4', contentType: 'video/mp4',
      };
      const initTry = await tryAll([
        () => req('POST', '/api/upload/init', { token: aToken, body: initBody }),
        () => req('POST', '/api/uploads/init', { token: aToken, body: initBody }),
        () => req('POST', '/api/chunk-upload/init', { token: aToken, body: initBody }),
        () => req('POST', '/api/upload/chunk/init', { token: aToken, body: initBody }),
      ]);
      const initRes = initTry.res;
      const uploadId = initRes.data?.uploadId ?? initRes.data?.id ?? initRes.data?.data?.uploadId ?? initRes.data?.data?.id ?? null;
      if (!isOk(initRes) || uploadId == null) {
        detail = `init status=${initRes.status} uploadId=${uploadId ?? '?'}`;
      } else {
        detail = `uploadId=${uploadId}`;
        let chunksOk = true;
        for (let i = 0; i < slices.length; i++) {
          const dataBase64 = Buffer.from(slices[i]).toString('base64');
          const chunkBody = { uploadId, index: i, chunkIndex: i, dataBase64, data: dataBase64 };
          const ct = await tryAll([
            () => req('POST', '/api/upload/chunk', { token: aToken, body: chunkBody }),
            () => req('POST', '/api/uploads/chunk', { token: aToken, body: chunkBody }),
            () => req('POST', `/api/upload/${encodeURIComponent(String(uploadId))}/chunk`, { token: aToken, body: chunkBody }),
            () => {
              const f = new FormData();
              f.append('chunk', new Blob([slices[i]], { type: 'application/octet-stream' }), `chunk_${i}`);
              f.append('file', new Blob([slices[i]], { type: 'application/octet-stream' }), `chunk_${i}`);
              f.append('uploadId', String(uploadId));
              f.append('index', String(i));
              return req('POST', '/api/upload/chunk', { token: aToken, form: f });
            },
          ]);
          if (!isOk(ct.res)) { chunksOk = false; detail = `chunk ${i} status=${ct.res.status}`; break; }
        }
        if (chunksOk) {
          const compTry = await tryAll([
            () => req('POST', '/api/upload/complete', { token: aToken, body: { uploadId } }),
            () => req('POST', '/api/uploads/complete', { token: aToken, body: { uploadId } }),
            () => req('POST', `/api/upload/${encodeURIComponent(String(uploadId))}/complete`, { token: aToken, body: {} }),
          ]);
          const comp = compTry.res;
          const fileUrl = comp.data?.url ?? comp.data?.fileUrl ?? comp.data?.data?.url ?? comp.data?.path ?? null;
          if (!isOk(comp) || !fileUrl) {
            detail = `complete status=${comp.status} url=${fileUrl ?? '?'}`;
          } else {
            const abs = fileUrl.startsWith('http') ? fileUrl : BASE + (fileUrl.startsWith('/') ? fileUrl : '/' + fileUrl);
            const got = await fetch(abs, { headers: aToken ? { Authorization: `Bearer ${aToken}` } : {}, signal: AbortSignal.timeout(TIMEOUT_MS) });
            const assembled = Buffer.from(await got.arrayBuffer());
            okAll = got.ok && assembled.length === original.length && sha256(assembled) === sha256(original);
            detail = `url=${fileUrl} bytes=${assembled.length}/${original.length} sha256match=${sha256(assembled) === sha256(original)}`;
          }
        }
      }
    } catch (err) {
      detail = String(err && err.message ? err.message : err);
    }
    step('分片上传：小文件拼合后可访问且逐字节一致', okAll, detail);
  }

  // 2. B 在推荐流看到 A 的作品
  {
    const { res } = await tryAll([
      () => req('GET', '/api/feed', { token: bToken }),
      () => req('GET', '/api/feed/recommend', { token: bToken }),
      () => req('GET', '/api/videos', { token: bToken }),
      () => req('GET', '/api/works', { token: bToken }),
      () => req('GET', '/api/posts', { token: bToken }),
    ]);
    const seen = isOk(res) && containsWork(res.data, workId, title);
    // 若发布响应没给 workId，后面多步只能靠标题认作品——从流里把 id 捞回来
    if (seen && workId == null) {
      const it = pickList(res.data).find((x) => x && (x.title === title));
      if (it) workId = it.id ?? it.workId ?? it.videoId ?? null;
    }
    step('B 在推荐流看到 A 的作品', seen, `status=${res.status} workId=${workId ?? '?'}`);

    // 2b. 压缩双阈值断言：本作品时长与体积都远低于阈值（>1h 或 >5GB 才压到 1080p），
    //     其 compressReason 必须为 null（保原画不压缩）
    const item = pickList(res.data).find((x) => x && typeof x === 'object' && (
      (workId != null && String(x.id ?? x.workId ?? x.videoId ?? '') === String(workId)) || x.title === title
    ));
    // 注意：compressReason 合法值就是 null，不能用 ?? 链（会把 null 吞成 undefined）
    const reason = item
      ? (item.compressReason !== undefined ? item.compressReason : item.video?.compressReason)
      : undefined;
    step(
      '小作品未触发压缩（compressReason=null，双阈值均未超）',
      item != null && reason === null,
      item == null ? '推荐流里没找到该作品对象' : `compressReason=${JSON.stringify(reason)}`,
    );
  }

  const wid = encodeURIComponent(String(workId ?? ''));

  // 3. B 点赞
  if (workId != null) {
    const { res } = await tryAll([
      () => req('POST', `/api/videos/${wid}/like`, { token: bToken, body: {} }),
      () => req('POST', `/api/works/${wid}/like`, { token: bToken, body: {} }),
      () => req('POST', '/api/like', { token: bToken, body: { workId, videoId: workId, id: workId } }),
    ]);
    step('B 点赞', isOk(res), `status=${res.status}`);
  } else {
    step('B 点赞', false, '缺 workId，跳过');
  }

  // 4. B 收藏（后端真实路径是 /fav，其余为同义兜底）
  if (workId != null) {
    const { res } = await tryAll([
      () => req('POST', `/api/videos/${wid}/fav`, { token: bToken, body: {} }),
      () => req('POST', `/api/videos/${wid}/favorite`, { token: bToken, body: {} }),
      () => req('POST', `/api/videos/${wid}/collect`, { token: bToken, body: {} }),
      () => req('POST', `/api/works/${wid}/favorite`, { token: bToken, body: {} }),
      () => req('POST', `/api/works/${wid}/collect`, { token: bToken, body: {} }),
      () => req('POST', '/api/favorites', { token: bToken, body: { workId, videoId: workId } }),
      () => req('POST', '/api/collects', { token: bToken, body: { workId, videoId: workId } }),
    ]);
    step('B 收藏', isOk(res), `status=${res.status}`);
  } else {
    step('B 收藏', false, '缺 workId，跳过');
  }

  // 5. B 评论
  const commentText = `e2e评论_${RUN}`;
  if (workId != null) {
    const body = { text: commentText, content: commentText, comment: commentText };
    const { res } = await tryAll([
      () => req('POST', `/api/videos/${wid}/comments`, { token: bToken, body }),
      () => req('POST', `/api/works/${wid}/comments`, { token: bToken, body }),
      () => req('POST', '/api/comments', { token: bToken, body: { ...body, workId, videoId: workId } }),
    ]);
    step('B 评论', isOk(res), `status=${res.status}`);
  } else {
    step('B 评论', false, '缺 workId，跳过');
  }

  // 6. 搜人：B 搜到 A
  {
    const q = encodeURIComponent(aNick);
    const { res } = await tryAll([
      () => req('GET', `/api/users/search?q=${q}`, { token: bToken }),
      () => req('GET', `/api/search?q=${q}`, { token: bToken }),
      () => req('GET', `/api/search/users?q=${q}`, { token: bToken }),
      () => req('GET', `/api/users?q=${q}`, { token: bToken }),
      () => req('GET', `/api/search?keyword=${q}`, { token: bToken }),
    ]);
    const found = isOk(res) && containsUser(res.data, aId, aNick);
    if (found && aId == null) {
      const it = pickList(res.data).find((x) => x && (x.nickname === aNick || x.name === aNick || x.username === aNick));
      if (it) aId = it.id ?? it.userId ?? it._id ?? null;
    }
    step('B 搜人搜到 A', found, `status=${res.status} aId=${aId ?? '?'}`);
  }

  // 兜底：实在拿不到对方 id 时，好友/私信步骤用昵称当寻址字段一起带上，
  // 后端若支持按昵称/#号寻址也能通；都不支持则如实判 ✗。

  // 7. B 向 A 发好友申请
  let friendSent = false;
  {
    const body = { toId: aId, friendId: aId, userId: aId, targetId: aId, to: aNick, nickname: aNick };
    const { res } = await tryAll([
      () => req('POST', '/api/friends/request', { token: bToken, body }),
      () => req('POST', '/api/friend-requests', { token: bToken, body }),
      () => req('POST', '/api/friends', { token: bToken, body }),
      () => req('POST', '/api/friends/add', { token: bToken, body }),
    ]);
    friendSent = isOk(res);
    step('B 加好友申请', friendSent, `status=${res.status}`);
  }

  // 8. A 接受好友申请（先拉申请列表找 requestId，找不到就用 fromId 直接受）
  {
    let requestId = null;
    const listTry = await tryAll([
      () => req('GET', '/api/friends/requests', { token: aToken }),
      () => req('GET', '/api/friend-requests', { token: aToken }),
      () => req('GET', '/api/friends/pending', { token: aToken }),
    ]);
    if (isOk(listTry.res)) {
      const list = pickList(listTry.res.data);
      const hit = list.find((x) => x && typeof x === 'object' && (
        String(x.fromId ?? x.from ?? x.senderId ?? '') === String(bId ?? '') ||
        x.fromNickname === bNick || x.nickname === bNick || list.length === 1
      )) || list[0];
      if (hit) requestId = hit.id ?? hit.requestId ?? null;
      if (bId == null && hit) bId = hit.fromId ?? hit.senderId ?? null;
    }
    const body = { requestId, id: requestId, fromId: bId, friendId: bId, userId: bId, from: bNick };
    const { res } = await tryAll([
      () => req('POST', '/api/friends/accept', { token: aToken, body }),
      () => req('POST', '/api/friend-requests/accept', { token: aToken, body }),
      () => req('POST', '/api/friends/accept-request', { token: aToken, body }),
      ...(requestId != null
        ? [() => req('POST', `/api/friends/requests/${encodeURIComponent(String(requestId))}/accept`, { token: aToken, body })]
        : []),
    ]);
    step('A 接受好友申请', isOk(res), `status=${res.status} requestId=${requestId ?? '?'}`);
  }

  // 9. B 在朋友流看到 A 的作品（后端真实路径是 /api/feed?scope=friends）
  {
    const { res } = await tryAll([
      () => req('GET', '/api/feed?scope=friends', { token: bToken }),
      () => req('GET', '/api/feed/friends', { token: bToken }),
      () => req('GET', '/api/friends/feed', { token: bToken }),
      () => req('GET', '/api/feed?type=friends', { token: bToken }),
      () => req('GET', '/api/feed?tab=friends', { token: bToken }),
      () => req('GET', '/api/works/friends', { token: bToken }),
    ]);
    step('B 在朋友流看到 A 的作品', isOk(res) && containsWork(res.data, workId, title), `status=${res.status}`);
  }

  // 10. B 私信 A —— 发的不是明文，而是一段「模拟密文」
  // 私信在真实客户端里是端到端加密的（ECDH P-256 + HKDF + AES-GCM-256），
  // 服务器只负责原样存/转发密文。这里拼一段格式与真实密文载荷一致的字符串
  // （版本标记 + base64 的 iv + base64 的 ciphertext），发送后由 A 取回，
  // 断言与发送值一字不差：服务器若尝试解密、转码、截断或改写都会被抓到。
  const cipherText = (() => {
    const iv = Buffer.from(`iv-${RUN}-0123456789ab`).toString('base64');
    const ct = Buffer.from(`ciphertext-payload-${RUN}-` + 'x'.repeat(96)).toString('base64');
    return `E2E1.${iv}.${ct}`;
  })();
  {
    const body = { toId: aId, receiverId: aId, to: aId, userId: aId, nickname: aNick, text: cipherText, content: cipherText, message: cipherText };
    const { res } = await tryAll([
      ...(aId != null
        ? [() => req('POST', `/api/dm/${encodeURIComponent(String(aId))}`, { token: bToken, body: { text: cipherText } })]
        : []),
      () => req('POST', '/api/messages', { token: bToken, body }),
      () => req('POST', '/api/dm', { token: bToken, body }),
      () => req('POST', '/api/chat', { token: bToken, body }),
      ...(aId != null
        ? [() => req('POST', `/api/messages/${encodeURIComponent(String(aId))}`, { token: bToken, body })]
        : []),
    ]);
    step('B 私信 A（发送模拟密文）', isOk(res), `status=${res.status}`);
  }

  // 10b. A 取回该私信，断言密文原样（逐字相等，不是包含关系）
  {
    const readCandidates = [
      ...(bId != null
        ? [() => req('GET', `/api/dm/${encodeURIComponent(String(bId))}`, { token: aToken })]
        : []),
      () => req('GET', `/api/messages/${encodeURIComponent(String(bId ?? ''))}`, { token: aToken }),
      () => req('GET', `/api/conversations/${encodeURIComponent(String(bId ?? ''))}/messages`, { token: aToken }),
      () => req('GET', '/api/dm/threads', { token: aToken }),
      () => req('GET', '/api/messages', { token: aToken }),
    ];
    let verbatim = false;
    let lastStatus = 0;
    for (const c of readCandidates) {
      const r = await c();
      lastStatus = r.status;
      if (!isOk(r)) continue;
      const msgs = pickList(r.data);
      verbatim = msgs.some((m) => m && typeof m === 'object' && (m.text === cipherText || m.content === cipherText || m.ciphertext === cipherText || m.body === cipherText));
      // 兜底：响应不是消息数组形状时，退化为全文精确片段判断（密文无空格，JSON 转义不影响它）
      if (!verbatim && msgs.length === 0 && JSON.stringify(r.data ?? '').includes(cipherText)) verbatim = true;
      if (verbatim) break;
    }
    step('A 取回的私信密文与发送一字不差（服务器不改密文）', verbatim, `status=${lastStatus}`);
  }

  // 11. A 转发作品给 B —— 按定版的真实客户端流程：
  //     ① 先给 B 发一条带 videoId 的私信（作品卡片；真实客户端里 text 是密文），
  //        服务器只存密文 + videoId 引用，不自己生成明文卡片消息；
  //     ② 再调 /api/videos/:id/share {toUserId} 给作品计转发数（该接口只计数）。
  if (workId != null) {
    let cardOk = false;
    let cardStatus = 0;
    if (bId != null) {
      const card = await tryAll([
        () => req('POST', `/api/dm/${encodeURIComponent(String(bId))}`, { token: aToken, body: { text: `E2E1.card.${RUN}`, videoId: workId } }),
        () => req('POST', '/api/messages', { token: aToken, body: { toId: bId, receiverId: bId, userId: bId, text: title, videoId: workId, workId, type: 'work' } }),
      ]);
      cardOk = isOk(card.res);
      cardStatus = card.res.status;
    }
    const fwdBody = { toUserId: bId, toId: bId, receiverId: bId, to: bId, userId: bId, nickname: bNick, workId, videoId: workId };
    const { res } = await tryAll([
      () => req('POST', `/api/videos/${wid}/share`, { token: aToken, body: fwdBody }),
      () => req('POST', `/api/videos/${wid}/forward`, { token: aToken, body: fwdBody }),
      () => req('POST', `/api/works/${wid}/share`, { token: aToken, body: fwdBody }),
      () => req('POST', `/api/works/${wid}/forward`, { token: aToken, body: fwdBody }),
    ]);
    step('A 转发作品给 B（私信卡片 + share 计数）', cardOk && isOk(res), `card status=${cardStatus}, share status=${res.status}`);
  } else {
    step('A 转发作品给 B（私信卡片 + share 计数）', false, '缺 workId，跳过');
  }

  // 12. B 的私信会话里收到作品卡片（与 A 的会话中出现该作品）
  {
    const candidates = [
      () => req('GET', `/api/dm/${encodeURIComponent(String(aId ?? ''))}`, { token: bToken }),
      () => req('GET', `/api/messages/${encodeURIComponent(String(aId ?? ''))}`, { token: bToken }),
      () => req('GET', `/api/messages?with=${encodeURIComponent(String(aId ?? ''))}`, { token: bToken }),
      () => req('GET', `/api/conversations/${encodeURIComponent(String(aId ?? ''))}/messages`, { token: bToken }),
      () => req('GET', '/api/dm/threads', { token: bToken }),
      () => req('GET', '/api/messages', { token: bToken }),
      () => req('GET', '/api/conversations', { token: bToken }),
    ];
    let found = false;
    let lastStatus = 0;
    for (const c of candidates) {
      const r = await c();
      lastStatus = r.status;
      if (isOk(r) && containsWork(r.data, workId, title)) { found = true; break; }
    }
    step('B 私信里收到作品卡片', found, `status=${lastStatus}`);
  }

  // 13. B 的收藏列表里有该作品（后端真实路径是 /api/me/collections）
  {
    const candidates = [
      () => req('GET', '/api/me/collections', { token: bToken }),
      () => req('GET', '/api/favorites', { token: bToken }),
      () => req('GET', '/api/me/favorites', { token: bToken }),
      () => req('GET', '/api/users/me/favorites', { token: bToken }),
      () => req('GET', '/api/collects', { token: bToken }),
      () => req('GET', '/api/me/collects', { token: bToken }),
      () => req('GET', '/api/favorites/list', { token: bToken }),
    ];
    let found = false;
    let lastStatus = 0;
    for (const c of candidates) {
      const r = await c();
      lastStatus = r.status;
      if (isOk(r) && containsWork(r.data, workId, title)) { found = true; break; }
    }
    step('B 收藏列表有该作品', found, `status=${lastStatus}`);
  }

  return summarize();
}

function summarize() {
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\n${passed === total ? 'PASS' : 'FAIL'} ${passed}/${total}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error('✗ 脚本异常', err);
  process.exitCode = 1;
});
