// 自测脚本：起临时端口 + 独立数据文件，跑通 邮箱验证码注册→发作品→点赞→收藏→评论→加好友→私信→转发计数 全链路
// 用法：node test-api.mjs   （不污染正式 data.json）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18188;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yousj-video-test-'));
const DATA_FILE = path.join(tmp, 'data.json');
const UPLOAD_DIR = path.join(tmp, 'uploads');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${extra}`); }
}
async function api(method, p, { token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
async function waitHealth(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch {}
    await new Promise(s => setTimeout(s, 200));
  }
  return false;
}
// 邮箱验证码注册辅助：request-code（dev 模式回 devCode）-> verify 建号；apiFn 可换成第二实例的 api2
async function registerViaEmail(email, name, password, extra = {}, apiFn = api) {
  const rc = await apiFn('POST', '/api/register/request-code', { body: { email } });
  if (rc.status !== 200 || !rc.j || !rc.j.devCode) return { rc, verify: null };
  const verify = await apiFn('POST', '/api/register/verify', { body: { email, code: rc.j.devCode, name, password, ...extra } });
  return { rc, verify };
}

// 邮箱注册自测走 dev 发信模式：ALLOW_DEV_CODE=1 且清空邮件通道 env，request-code 响应带 devCode
const MAIL_ENV_OFF = { MAIL_WEBHOOK_URL: '', SMTP_HOST: '', SMTP_PORT: '', SMTP_USER: '', SMTP_PASS: '' };
const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
  env: { ...process.env, ...MAIL_ENV_OFF, PORT: String(PORT), DATA_FILE, UPLOAD_DIR, ALLOW_DEV_CODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', d => process.stderr.write('[server] ' + d));

try {
  check('服务启动 /api/health', await waitHealth());

  // ===== v3：邮箱验证码注册 =====
  // 旧直注册接口废弃
  const oldReg = await api('POST', '/api/register', { body: { name: '直注册', password: '123456' } });
  check('旧 POST /api/register 返回 410', oldReg.status === 410 && oldReg.j.error === '请使用邮箱验证码注册', JSON.stringify(oldReg.j));
  // 错码 400：先拿真码，再故意输错码
  const rcWrong = await api('POST', '/api/register/request-code', { body: { email: 'wrong@example.com' } });
  check('request-code dev 模式返回 devCode', rcWrong.status === 200 && /^\d{6}$/.test(rcWrong.j.devCode || ''), JSON.stringify(rcWrong.j));
  const wrongCode = rcWrong.j.devCode === '000000' ? '000001' : '000000';
  const verifyWrong = await api('POST', '/api/register/verify', { body: { email: 'wrong@example.com', code: wrongCode, name: '错码者', password: '123456' } });
  check('输错验证码 400', verifyWrong.status === 400, JSON.stringify(verifyWrong.j));
  // 60 秒重发限制：新邮箱发一次后立即重发 -> 429
  const rc1 = await api('POST', '/api/register/request-code', { body: { email: 'throttle@example.com' } });
  const rc2 = await api('POST', '/api/register/request-code', { body: { email: 'throttle@example.com' } });
  check('同邮箱 60 秒内重发验证码 429', rc1.status === 200 && rc2.status === 429, `${rc1.status}/${rc2.status}`);
  // 邮箱格式非法 400
  const rcBad = await api('POST', '/api/register/request-code', { body: { email: 'not-an-email' } });
  check('邮箱格式非法 400', rcBad.status === 400);

  // 注册 A、B（全走邮箱流程）
  const { verify: regARaw } = await registerViaEmail('a@example.com', '测试甲', '123456');
  const regA = regARaw || { status: 0, j: null };
  check('邮箱注册 A 返回 token+user+account#号', regA.status === 200 && !!regA.j.token && /^测试甲#\d{4}$/.test(regA.j.user.account || ''), JSON.stringify(regA.j));
  check('注册响应 user 不带 email', regA.status === 200 && !('email' in regA.j.user), JSON.stringify(regA.j));
  const { verify: regBRaw } = await registerViaEmail('b@example.com', '测试乙', '654321');
  const regB = regBRaw || { status: 0, j: null };
  check('邮箱注册 B 成功且号不重复', regB.status === 200 && regB.j.user.id !== regA.j.user.id && regB.j.user.account !== regA.j.user.account);
  const tA = regA.j.token, tB = regB.j.token, idA = regA.j.user.id, idB = regB.j.user.id;

  // 已注册邮箱再 request-code -> 409
  const rcDup = await api('POST', '/api/register/request-code', { body: { email: 'a@example.com' } });
  check('已注册邮箱 request-code 409', rcDup.status === 409 && rcDup.j.error === '该邮箱已注册', JSON.stringify(rcDup.j));

  // 登录：邮箱（主）+ 昵称 + 账号，错密码统一 401
  const loginMail = await api('POST', '/api/login', { body: { accountOrName: 'a@example.com', password: '123456' } });
  check('邮箱登录', loginMail.status === 200 && !!loginMail.j.token && loginMail.j.user.id === idA, JSON.stringify(loginMail.j));
  const loginMailUpper = await api('POST', '/api/login', { body: { accountOrName: 'A@Example.COM', password: '123456' } });
  check('邮箱登录大小写不敏感', loginMailUpper.status === 200 && loginMailUpper.j.user.id === idA);
  const loginName = await api('POST', '/api/login', { body: { accountOrName: '测试甲', password: '123456' } });
  check('昵称登录', loginName.status === 200 && !!loginName.j.token);
  const loginAcc = await api('POST', '/api/login', { body: { accountOrName: regA.j.user.account, password: '123456' } });
  check('账号登录', loginAcc.status === 200 && !!loginAcc.j.token);
  const loginBad = await api('POST', '/api/login', { body: { accountOrName: '测试甲', password: '000000' } });
  check('错密码 401 且文案统一', loginBad.status === 401 && loginBad.j.error === '账号或密码不对');
  const noAuth = await api('GET', '/api/feed');
  check('无 token 访问 feed 被 401', noAuth.status === 401);

  // 种子 + 推荐流
  const feed0 = await api('GET', '/api/feed?scope=recommended', { token: tA });
  check('推荐流含 4 条种子 scene', feed0.status === 200 && feed0.j.videos.length >= 4 && feed0.j.videos.some(v => v.kind === 'scene' && v.videoUrl === ''), JSON.stringify(feed0.j).slice(0, 200));

  // 上传（假 mp4 头，小文件即可）
  const fakeMp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 1, 2, 3, 4]).toString('base64');
  const up = await api('POST', '/api/upload', { token: tA, body: { filename: 'clip.mp4', dataBase64: fakeMp4 } });
  check('上传 mp4 返回 /uploads/ 地址', up.status === 200 && typeof up.j.url === 'string' && up.j.url.startsWith('/uploads/'), JSON.stringify(up.j));
  const upBad = await api('POST', '/api/upload', { token: tA, body: { filename: 'x.exe', dataBase64: fakeMp4 } });
  check('上传非法格式被拒', upBad.status === 400);

  // 发作品
  const pub = await api('POST', '/api/videos', { token: tA, body: { title: '自测作品', desc: 'hello', videoUrl: up.j.url, posterHue: 200 } });
  const vid = pub.j && pub.j.id;
  check('发布作品 kind=video', pub.status === 200 && !!vid && pub.j.kind === 'video', JSON.stringify(pub.j));

  // 点赞切换
  const like1 = await api('POST', `/api/videos/${vid}/like`, { token: tB });
  check('B 点赞 -> liked=true,count=1', like1.status === 200 && like1.j.liked === true && like1.j.likeCount === 1, JSON.stringify(like1.j));
  const like2 = await api('POST', `/api/videos/${vid}/like`, { token: tB });
  check('B 再点 -> 取消赞 count=0', like2.status === 200 && like2.j.liked === false && like2.j.likeCount === 0);
  await api('POST', `/api/videos/${vid}/like`, { token: tB }); // 恢复为已赞，给 stats 用

  // 收藏 + 我的收藏
  const fav1 = await api('POST', `/api/videos/${vid}/fav`, { token: tB });
  check('B 收藏 -> faved=true,count=1', fav1.status === 200 && fav1.j.faved === true && fav1.j.favCount === 1);
  const coll = await api('GET', '/api/me/collections', { token: tB });
  check('B 的收藏列表含该作品', coll.status === 200 && coll.j.videos.some(v => v.id === vid));

  // 评论
  const cm = await api('POST', `/api/videos/${vid}/comments`, { token: tB, body: { text: '拍得不错！' } });
  check('B 评论成功', cm.status === 200 && cm.j.text === '拍得不错！' && cm.j.author && cm.j.author.id === idB, JSON.stringify(cm.j));
  const cms = await api('GET', `/api/videos/${vid}/comments`, { token: tA });
  check('评论列表可读', cms.status === 200 && cms.j.comments.length === 1);

  // 加好友：搜索 -> 申请 -> 对方列表 -> 接受 -> 双方好友
  const search = await api('GET', '/api/users/search?q=' + encodeURIComponent('测试乙'), { token: tA });
  const found = (search.j.users || search.j.results || []).find(u => u.id === idB);
  check('按昵称搜到 B', !!found, JSON.stringify(search.j));
  const reqF = await api('POST', '/api/friends/request', { token: tA, body: { userId: idB } });
  check('A 发好友申请', reqF.status === 200, JSON.stringify(reqF.j));
  const reqList = await api('GET', '/api/friends/requests', { token: tB });
  const hasReq = (reqList.j.requests || []).some(r => (r.from && r.from.id === idA) || (r.user && r.user.id === idA) || r.fromId === idA);
  check('B 收到好友申请', hasReq, JSON.stringify(reqList.j));
  const acc = await api('POST', '/api/friends/accept', { token: tB, body: { userId: idA } });
  check('B 接受申请', acc.status === 200, JSON.stringify(acc.j));
  const flA = await api('GET', '/api/friends', { token: tA });
  const flB = await api('GET', '/api/friends', { token: tB });
  check('互认：A、B 好友列表互含对方', (flA.j.friends || []).some(u => u.id === idB) && (flB.j.friends || []).some(u => u.id === idA));

  // 好友流：B 能在 friends 流看到 A 的作品
  const feedF = await api('GET', '/api/feed?scope=friends', { token: tB });
  check('好友流含 A 的作品', feedF.status === 200 && feedF.j.videos.some(v => v.id === vid));

  // 私信
  const dmSend = await api('POST', `/api/dm/${idB}`, { token: tA, body: { text: '你好，这是私信' } });
  check('A 给好友 B 发私信', dmSend.status === 200 && dmSend.j.mine === true, JSON.stringify(dmSend.j));
  const threads = await api('GET', '/api/dm/threads', { token: tB });
  const th = (threads.j.threads || []).find(t => t.peer && t.peer.id === idA);
  check('B 会话列表有未读=1', !!th && th.unread === 1, JSON.stringify(threads.j));
  const dmRead = await api('GET', `/api/dm/${idA}`, { token: tB });
  check('B 读私信内容正确', dmRead.status === 200 && dmRead.j.messages.length === 1 && dmRead.j.messages[0].text === '你好，这是私信' && dmRead.j.messages[0].mine === false);
  const threads2 = await api('GET', '/api/dm/threads', { token: tB });
  const th2 = (threads2.j.threads || []).find(t => t.peer && t.peer.id === idA);
  check('读后未读清零', !!th2 && th2.unread === 0);

  // 转发给好友：share 只计数（卡片由前端发 E2E 加密私信），不得新增服务器私信
  const dmBeforeShare = await api('GET', `/api/dm/${idA}`, { token: tB });
  const dmCountBefore = (dmBeforeShare.j.messages || []).length;
  const share = await api('POST', `/api/videos/${vid}/share`, { token: tA, body: { toUserId: idB } });
  check('转发给好友成功 shareCount=1', share.status === 200 && share.j.shareCount === 1, JSON.stringify(share.j));
  const dmAfter = await api('GET', `/api/dm/${idA}`, { token: tB });
  const shareMsg = (dmAfter.j.messages || []).find(m => m.videoId === vid);
  check('share 后对方私信无新增服务器消息（无重复卡片）', (dmAfter.j.messages || []).length === dmCountBefore && !shareMsg, JSON.stringify((dmAfter.j.messages || []).map(m => m.videoId)));

  // 非好友限制：注册 C，未加好友时私信/转发被拒
  const { verify: regC } = await registerViaEmail('c@example.com', '测试丙', '111111');
  const tC = regC.j.token, idC = regC.j.user.id;
  const dmStranger = await api('POST', `/api/dm/${idC}`, { token: tA, body: { text: 'hi' } });
  check('非好友私信 403', dmStranger.status === 403);
  const shareStranger = await api('POST', `/api/videos/${vid}/share`, { token: tA, body: { toUserId: idC } });
  check('非好友转发 403', shareStranger.status === 403);
  const feedFC = await api('GET', '/api/feed?scope=friends', { token: tC });
  check('无好友时好友流为空数组', feedFC.status === 200 && Array.isArray(feedFC.j.videos) && feedFC.j.videos.length === 0);

  // 我的：作品与统计
  const works = await api('GET', '/api/me/works', { token: tA });
  check('A 的作品列表含自测作品', works.status === 200 && works.j.videos.some(v => v.id === vid));
  const meA = await api('GET', '/api/me', { token: tA });
  check('A 的 stats: works>=1 friends=1 likesReceived>=1', meA.status === 200 && meA.j.stats.works >= 1 && meA.j.stats.friends === 1 && meA.j.stats.likesReceived >= 1, JSON.stringify(meA.j));
  check('/api/me 带本人 email（公开对象不带）', meA.status === 200 && meA.j.user.email === 'a@example.com', JSON.stringify(meA.j));

  // ===== v2：分片上传 =====
  const chunkPayload = Buffer.concat([Buffer.from('YOUSJ-CHUNK-'), Buffer.alloc(5000, 7), Buffer.from([0, 255, 1, 254, 2, 253])]);
  const slices = [chunkPayload.subarray(0, 100), chunkPayload.subarray(100, 3000), chunkPayload.subarray(3000)];
  const init = await api('POST', '/api/upload/init', { token: tA, body: { filename: 'big4k.mp4', size: chunkPayload.length, mime: 'video/mp4' } });
  check('分片上传 init 返回 uploadId', init.status === 200 && !!init.j.uploadId, JSON.stringify(init.j));
  const initTooBig = await api('POST', '/api/upload/init', { token: tA, body: { filename: 'huge.mp4', size: 20 * 1024 * 1024 * 1024 + 1, mime: 'video/mp4' } });
  check('分片上传超 20GB 被拒 413', initTooBig.status === 413);
  // 乱序发送 3 片，complete 应按 index 拼合
  for (const idx of [2, 0, 1]) {
    const ch = await api('POST', '/api/upload/chunk', { token: tA, body: { uploadId: init.j.uploadId, index: idx, dataBase64: slices[idx].toString('base64') } });
    check(`分片 ${idx} 上传成功`, ch.status === 200, JSON.stringify(ch.j));
  }
  const complete = await api('POST', '/api/upload/complete', { token: tA, body: { uploadId: init.j.uploadId } });
  check('分片 complete 返回 url+size', complete.status === 200 && complete.j.url && complete.j.size === chunkPayload.length, JSON.stringify(complete.j));
  if (complete.j && complete.j.url) {
    const r = await fetch(BASE + complete.j.url);
    const got = Buffer.from(await r.arrayBuffer());
    check('拼合后内容与原始二进制一致', r.status === 200 && got.equals(chunkPayload), `len got=${got.length} want=${chunkPayload.length}`);
  }

  // ===== v2：pubKey（E2E 公钥分发） =====
  const pubD = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x-of-D', y: 'y-of-D' });
  const { verify: regD } = await registerViaEmail('d@example.com', '测试丁', '222222', { pubKey: pubD });
  check('注册带 pubKey，响应 user.pubKey 原样返回', regD.status === 200 && regD.j.user.pubKey === pubD, JSON.stringify(regD.j));
  const searchD = await api('GET', '/api/users/search?q=' + encodeURIComponent('测试丁'), { token: tA });
  const foundD = (searchD.j.users || []).find(u => u.id === regD.j.user.id);
  check('search 能拿到对方 pubKey', !!foundD && foundD.pubKey === pubD, JSON.stringify(searchD.j));

  const { verify: regE } = await registerViaEmail('e@example.com', '测试戊', '333333');
  const tE = regE.j.token, idE = regE.j.user.id;
  check('未带 pubKey 注册时 pubKey=null', regE.status === 200 && regE.j.user.pubKey === null, JSON.stringify(regE.j));
  const pubE = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x-of-E', y: 'y-of-E' });
  const setE = await api('POST', '/api/me/pubkey', { token: tE, body: { pubKey: pubE } });
  check('/api/me/pubkey 补传成功', setE.status === 200 && setE.j.ok === true && setE.j.pubKey === pubE, JSON.stringify(setE.j));
  const pubA = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x-of-A', y: 'y-of-A' });
  const setA = await api('POST', '/api/me/pubkey', { token: tA, body: { pubKey: pubA } });
  check('A 补传 pubKey 成功', setA.status === 200 && setA.j.pubKey === pubA);
  // A 与戊成为好友后，好友列表 / 会话列表 peer 都带补传的 pubKey
  await api('POST', '/api/friends/request', { token: tA, body: { userId: idE } });
  const reqE = await api('GET', '/api/friends/requests', { token: tE });
  const reqFromA = (reqE.j.requests || []).find(r => (r.from && r.from.id === idA));
  check('好友申请里的 from 带 A 的 pubKey', !!reqFromA && reqFromA.from.pubKey === pubA, JSON.stringify(reqE.j));
  await api('POST', '/api/friends/accept', { token: tE, body: { userId: idA } });
  const flA2 = await api('GET', '/api/friends', { token: tA });
  const friendE = (flA2.j.friends || []).find(u => u.id === idE);
  check('好友列表能拿到戊补传的 pubKey', !!friendE && friendE.pubKey === pubE, JSON.stringify(flA2.j));
  await api('POST', `/api/dm/${idE}`, { token: tA, body: { text: '戊你好' } });
  const threadsE = await api('GET', '/api/dm/threads', { token: tE });
  const thE = (threadsE.j.threads || []).find(t => t.peer && t.peer.id === idA);
  check('私信会话 peer 带 A 的 pubKey', !!thE && thE.peer.pubKey === pubA, JSON.stringify(threadsE.j));

  // ===== v2：私信 10KB 密文字符串原样存取 =====
  const cipherText = JSON.stringify({ v: 1, iv: 'aabbccddeeff', ct: 'A7f9'.repeat(3000) }); // >12KB
  check('密文测试串长度 >10KB', cipherText.length > 10 * 1024, String(cipherText.length));
  const dmCipher = await api('POST', `/api/dm/${idB}`, { token: tA, body: { text: cipherText } });
  check('发送 10KB 密文私信成功', dmCipher.status === 200 && dmCipher.j.text === cipherText, JSON.stringify(dmCipher.j).slice(0, 120));
  const dmCipherRead = await api('GET', `/api/dm/${idA}`, { token: tB });
  const cipherMsg = (dmCipherRead.j.messages || []).find(m => m.text && m.text.length > 10 * 1024);
  check('对方取回密文与原文逐字一致', !!cipherMsg && cipherMsg.text === cipherText);

  // ===== v2：作品时长/分辨率与压缩标记 =====
  const pubLong = await api('POST', '/api/videos', { token: tA, body: { title: '长片', desc: '', videoUrl: up.j.url, posterHue: 10, width: 3840, height: 2160, durationSec: 3700 } });
  check('4K 长片(3700s) width/height/durationSec 保存且 needsCompression=true', pubLong.status === 200 && pubLong.j.width === 3840 && pubLong.j.height === 2160 && pubLong.j.durationSec === 3700 && pubLong.j.needsCompression === true, JSON.stringify(pubLong.j));
  check('长片 compressReason=duration 且目标 1080p、fileSizeBytes 为真实小文件大小', pubLong.j.compressReason === 'duration' && pubLong.j.compressTarget === '1080p' && typeof pubLong.j.fileSizeBytes === 'number' && pubLong.j.fileSizeBytes < 1024, JSON.stringify(pubLong.j));
  const pubShort = await api('POST', '/api/videos', { token: tA, body: { title: '短片', desc: '', videoUrl: up.j.url, posterHue: 20, width: 3840, height: 2160, durationSec: 60 } });
  check('4K 短片(60s) needsCompression=false', pubShort.status === 200 && pubShort.j.durationSec === 60 && pubShort.j.needsCompression === false, JSON.stringify(pubShort.j));
  check('短片 compressReason=null、compressTarget=null', pubShort.j.compressReason === null && pubShort.j.compressTarget === null, JSON.stringify(pubShort.j));
  const works2 = await api('GET', '/api/me/works', { token: tA });
  const longInWorks = (works2.j.videos || []).find(v => v.id === (pubLong.j && pubLong.j.id));
  check('me/works 返回也带 durationSec/needsCompression', !!longInWorks && longInWorks.durationSec === 3700 && longInWorks.needsCompression === true);

  // 上传文件可静态访问
  if (up.j && up.j.url) {
    const r = await fetch(BASE + up.j.url);
    check('上传文件可通过 /uploads/ 访问', r.status === 200);
  }

  // ===== 用户主页接口 GET /api/users/:id/profile =====
  // 用全新两用户，保证「发 2 条作品、stats.works=2」的断言不受前面的流程干扰
  const { verify: regPA } = await registerViaEmail('prof-a@example.com', '主页甲', '123456');
  const { verify: regPB } = await registerViaEmail('prof-b@example.com', '主页乙', '123456');
  const tPA = regPA.j.token, idPA = regPA.j.user.id, accPA = regPA.j.user.account;
  const tPB = regPB.j.token, idPB = regPB.j.user.id;
  const profPub1 = await api('POST', '/api/videos', { token: tPA, body: { title: '主页作品一', desc: '', videoUrl: '', posterHue: 100 } });
  await new Promise(s => setTimeout(s, 20)); // 拉开 createdAt，保证倒序断言确定
  const profPub2 = await api('POST', '/api/videos', { token: tPA, body: { title: '主页作品二', desc: '', videoUrl: '', posterHue: 110 } });
  const profB = await api('GET', `/api/users/${idPA}/profile`, { token: tPB });
  check('B 查 A 主页 200 且 user.account 对', profB.status === 200 && profB.j.user && profB.j.user.id === idPA && profB.j.user.account === accPA, JSON.stringify(profB.j).slice(0, 200));
  check('B 查 A 主页 isSelf=false、isFriend=false、hasPendingRequest=false', profB.j.isSelf === false && profB.j.isFriend === false && profB.j.hasPendingRequest === false, JSON.stringify(profB.j).slice(0, 200));
  check('A 主页 stats.works=2 且带 likesReceived/friends', profB.j.stats && profB.j.stats.works === 2 && typeof profB.j.stats.likesReceived === 'number' && typeof profB.j.stats.friends === 'number', JSON.stringify(profB.j.stats));
  check('A 主页 videos 长度=2 且按 createdAt 倒序', Array.isArray(profB.j.videos) && profB.j.videos.length === 2 && profB.j.videos[0].id === profPub2.j.id && profB.j.videos[1].id === profPub1.j.id && profB.j.videos[0].author.id === idPA, JSON.stringify((profB.j.videos || []).map(v => v.title)));
  const profSelf = await api('GET', `/api/users/${idPB}/profile`, { token: tPB });
  check('B 查自己主页 isSelf=true', profSelf.status === 200 && profSelf.j.isSelf === true && profSelf.j.user.id === idPB, JSON.stringify(profSelf.j).slice(0, 160));
  const prof404 = await api('GET', '/api/users/00000000-0000-0000-0000-000000000000/profile', { token: tPB });
  check('查不存在的用户主页 404', prof404.status === 404 && prof404.j.error === '用户不存在', JSON.stringify(prof404.j));
  // 申请中 -> hasPendingRequest=true；接受后 -> isFriend=true、hasPendingRequest=false
  await api('POST', '/api/friends/request', { token: tPB, body: { userId: idPA } });
  const profPending = await api('GET', `/api/users/${idPA}/profile`, { token: tPB });
  check('B 已向 A 发申请后主页 hasPendingRequest=true、isFriend 仍 false', profPending.j.hasPendingRequest === true && profPending.j.isFriend === false, JSON.stringify(profPending.j).slice(0, 200));
  await api('POST', '/api/friends/accept', { token: tPA, body: { userId: idPB } });
  const profFriend = await api('GET', `/api/users/${idPA}/profile`, { token: tPB });
  check('A 接受后 B 看 A 主页 isFriend=true、hasPendingRequest=false、stats.friends=1', profFriend.j.isFriend === true && profFriend.j.hasPendingRequest === false && profFriend.j.stats.friends === 1, JSON.stringify(profFriend.j).slice(0, 200));

  // ===== 全局搜索 GET /api/search =====
  // 全新两用户 + 独特关键词，保证命中计数不受种子/前序流程干扰
  const { verify: regSchA } = await registerViaEmail('search-a@example.com', '寻作者', '123456');
  const { verify: regSchB } = await registerViaEmail('search-b@example.com', '搜索人', '123456');
  const tSchA = regSchA.j.token, idSchA = regSchA.j.user.id;
  const tSchB = regSchB.j.token;
  const KW = '紫葡萄汽水';
  await api('POST', '/api/videos', { token: tSchA, body: { title: '夏日' + KW + '测评', desc: '清凉一夏', videoUrl: '', posterHue: 200 } });
  await api('POST', '/api/videos', { token: tSchA, body: { title: '普通标题', desc: '这杯' + KW + '真不错', videoUrl: '', posterHue: 210 } });
  const schKw = await api('GET', '/api/search?q=' + encodeURIComponent(KW), { token: tSchB });
  check('按标题/描述关键词搜作品命中 2 条（标题 1 + 描述 1）', schKw.status === 200 && Array.isArray(schKw.j.videos) && schKw.j.videos.length === 2 && schKw.j.videos.every(v => v.author.id === idSchA), JSON.stringify((schKw.j.videos || []).map(v => v.title)));
  const schAuthor = await api('GET', '/api/search?q=' + encodeURIComponent('寻作者'), { token: tSchB });
  check('按作者名搜到其全部作品（2 条）', schAuthor.status === 200 && schAuthor.j.videos.length === 2 && schAuthor.j.videos[0].author.name === '寻作者', JSON.stringify((schAuthor.j.videos || []).map(v => v.title)));
  check('搜作者名时 users 命中目标用户且带 isFriend=false', Array.isArray(schAuthor.j.users) && schAuthor.j.users.some(u => u.id === idSchA && u.isFriend === false), JSON.stringify(schAuthor.j.users));
  const schEmpty = await api('GET', '/api/search?q=' + encodeURIComponent('   '), { token: tSchB });
  check('q 全空格返回 videos/users 双空', schEmpty.status === 200 && schEmpty.j.videos.length === 0 && schEmpty.j.users.length === 0, JSON.stringify(schEmpty.j));
  const schUsersOnly = await api('GET', '/api/search?type=users&q=' + encodeURIComponent('寻作者'), { token: tSchB });
  check('type=users 时 videos 为空、users 仍命中', schUsersOnly.status === 200 && schUsersOnly.j.videos.length === 0 && schUsersOnly.j.users.some(u => u.id === idSchA), JSON.stringify(schUsersOnly.j).slice(0, 200));
  const schWorksOnly = await api('GET', '/api/search?type=works&q=' + encodeURIComponent('寻作者'), { token: tSchB });
  check('type=works 时 users 为空、videos 仍命中', schWorksOnly.status === 200 && schWorksOnly.j.users.length === 0 && schWorksOnly.j.videos.length === 2, JSON.stringify(schWorksOnly.j).slice(0, 200));
  const schNoAuth = await api('GET', '/api/search?q=' + encodeURIComponent(KW), {});
  check('未登录搜 401', schNoAuth.status === 401, String(schNoAuth.status));

  // ===== 智能体开放 API：manifest + 开放注册（主实例未设 AGENT_REGISTER_CODE） =====
  const manifest = await api('GET', '/api/agent/manifest', {});
  check('manifest 公开可读且 registerCodeRequired=false', manifest.status === 200 && manifest.j.name === 'Yousj 短视频 Agent API' && manifest.j.version === 1 && manifest.j.auth.registerCodeRequired === false && manifest.j.auth.keyPrefix === 'yv_', JSON.stringify(manifest.j).slice(0, 200));
  check('manifest endpoints 覆盖注册/发作品/私信', Array.isArray(manifest.j.endpoints) && manifest.j.endpoints.some(e => e.method === 'POST' && e.path === '/api/agent/register') && manifest.j.endpoints.some(e => e.method === 'POST' && e.path === '/api/videos') && manifest.j.endpoints.some(e => e.path === '/api/dm/:userId'), JSON.stringify((manifest.j.endpoints || []).length));
  const meHuman = await api('GET', '/api/me', { token: tA });
  check('人类账号 publicUser.isAgent=false 且 owner=null', meHuman.status === 200 && meHuman.j.user.isAgent === false && meHuman.j.user.owner === null, JSON.stringify(meHuman.j.user));
  const openAgent = await api('POST', '/api/agent/register', { body: { name: '开放注册机器人' } });
  check('未设注册码时开放注册成功（含 claimUrl）', openAgent.status === 200 && openAgent.j.user.isAgent === true && /^yv_[0-9a-f]{48}$/.test(openAgent.j.apiKey || '') && typeof openAgent.j.claimUrl === 'string' && openAgent.j.claimUrl.includes('?claim=') && openAgent.j.claimExpiresAt > Date.now(), JSON.stringify(openAgent.j).slice(0, 240));

  // ===== 智能体注册码 + API Key 鉴权 + 认领流程：第三实例（AGENT_REGISTER_CODE 已设） =====
  {
    const PORT3 = 18190;
    const BASE3 = `http://127.0.0.1:${PORT3}`;
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'yousj-video-test3-'));
    const DATA3 = path.join(tmp3, 'data.json');
    const AGENT_CODE = 'agent-code-xyz';
    const child3 = spawn(process.execPath, [path.join(dir, 'server.js')], {
      env: { ...process.env, ...MAIL_ENV_OFF, PORT: String(PORT3), DATA_FILE: DATA3, UPLOAD_DIR: path.join(tmp3, 'uploads'), ALLOW_DEV_CODE: '1', AGENT_REGISTER_CODE: AGENT_CODE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const api3 = async (method, p, { token, body } = {}) => {
      const r = await fetch(BASE3 + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let j = null; try { j = await r.json(); } catch {}
      return { status: r.status, j };
    };
    try {
      let up3ok = false;
      for (let i = 0; i < 50 && !up3ok; i++) {
        try { const r = await fetch(BASE3 + '/api/health'); up3ok = r.ok; } catch {}
        if (!up3ok) await new Promise(s => setTimeout(s, 200));
      }
      check('智能体测试实例启动（已设注册码）', up3ok);
      const manifest3 = await api3('GET', '/api/agent/manifest', {});
      check('设码后 manifest registerCodeRequired=true', manifest3.status === 200 && manifest3.j.auth.registerCodeRequired === true, JSON.stringify(manifest3.j.auth));

      const wrongCode = await api3('POST', '/api/agent/register', { body: { name: '机器人小V', code: 'nope' } });
      check('错注册码 403 且文案准确', wrongCode.status === 403 && wrongCode.j.error === '智能体注册码不对', JSON.stringify(wrongCode.j));
      const noCode = await api3('POST', '/api/agent/register', { body: { name: '机器人小V' } });
      check('不带注册码 403', noCode.status === 403, JSON.stringify(noCode.j));

      const regAgent = await api3('POST', '/api/agent/register', { body: { name: '机器人小V', code: AGENT_CODE } });
      const akey = regAgent.j && regAgent.j.apiKey;
      const agentId = regAgent.j && regAgent.j.user && regAgent.j.user.id;
      const claimToken = regAgent.j && regAgent.j.claimUrl ? regAgent.j.claimUrl.split('?claim=')[1] : '';
      check('对码注册成功：account#号 + isAgent + yv_ key 格式', regAgent.status === 200 && /^机器人小V#\d{4}$/.test(regAgent.j.user.account || '') && regAgent.j.user.isAgent === true && /^yv_[0-9a-f]{48}$/.test(akey || ''), JSON.stringify(regAgent.j).slice(0, 240));
      check('注册响应带 claimUrl 与 7 天内过期的 claimExpiresAt', !!claimToken && regAgent.j.claimExpiresAt > Date.now() && regAgent.j.claimExpiresAt < Date.now() + 7 * 24 * 3600 * 1000 + 60000, JSON.stringify(regAgent.j).slice(0, 240));

      const dupAgent = await api3('POST', '/api/agent/register', { body: { name: '机器人小V', code: AGENT_CODE } });
      check('同名智能体再注册 409', dupAgent.status === 409, JSON.stringify(dupAgent.j));

      const meAgent = await api3('GET', '/api/me', { token: akey });
      check('用 API Key 调 /api/me 成功且 isAgent=true、email=null', meAgent.status === 200 && meAgent.j.user.id === agentId && meAgent.j.user.isAgent === true && meAgent.j.user.email === null, JSON.stringify(meAgent.j).slice(0, 200));
      const badKey = await api3('GET', '/api/me', { token: 'yv_' + '0'.repeat(48) });
      check('错 API Key 401', badKey.status === 401, String(badKey.status));
      const agentLogin = await api3('POST', '/api/login', { body: { accountOrName: regAgent.j.user.account, password: 'whatever1' } });
      check('智能体账号走密码登录被拒 401（不崩）', agentLogin.status === 401, JSON.stringify(agentLogin.j));

      // 用 key 发图文作品 -> feed / search 可见
      const agentPub = await api3('POST', '/api/videos', { token: akey, body: { title: '智能体图文作品XYZ', desc: '由 AI 发布', videoUrl: '', posterHue: 160 } });
      check('智能体用 key 发图文作品成功 kind=scene', agentPub.status === 200 && agentPub.j.kind === 'scene' && agentPub.j.author.id === agentId && agentPub.j.author.isAgent === true, JSON.stringify(agentPub.j).slice(0, 200));
      const agentFeed = await api3('GET', '/api/feed?scope=recommended', { token: akey });
      check('智能体作品出现在 feed', agentFeed.status === 200 && agentFeed.j.videos.some(v => v.id === agentPub.j.id), JSON.stringify((agentFeed.j.videos || []).length));
      const agentSearch = await api3('GET', '/api/search?q=' + encodeURIComponent('智能体图文'), { token: akey });
      check('智能体作品能被 search 搜到', agentSearch.status === 200 && agentSearch.j.videos.some(v => v.id === agentPub.j.id), JSON.stringify(agentSearch.j).slice(0, 160));

      // 认领流程：claim-info -> 人类 claim -> owner 落定 -> 令牌失效
      const ci = await api3('GET', '/api/agent/claim-info?token=' + encodeURIComponent(claimToken), {});
      check('claim-info 有效令牌返回智能体（owner=null）', ci.status === 200 && ci.j.agent.id === agentId && ci.j.agent.owner === null, JSON.stringify(ci.j).slice(0, 200));
      const ciFake = await api3('GET', '/api/agent/claim-info?token=' + 'f'.repeat(48), {});
      check('claim-info 假令牌 404', ciFake.status === 404, String(ciFake.status));

      const { verify: regOwner } = await registerViaEmail('owner@example.com', '认领主人', '123456', {}, api3);
      const tOwner = regOwner.j.token, idOwner = regOwner.j.user.id;
      const claim = await api3('POST', '/api/agent/claim', { token: tOwner, body: { token: claimToken } });
      check('人类认领成功：agent.owner 指向认领者', claim.status === 200 && claim.j.agent.id === agentId && claim.j.agent.owner && claim.j.agent.owner.id === idOwner && claim.j.owner.id === idOwner, JSON.stringify(claim.j).slice(0, 240));
      const profAfter = await api3('GET', `/api/users/${agentId}/profile`, { token: tOwner });
      check('认领后 profile 里 publicUser.owner 正确', profAfter.status === 200 && profAfter.j.user.owner && profAfter.j.user.owner.id === idOwner && profAfter.j.user.owner.account === regOwner.j.user.account, JSON.stringify(profAfter.j.user).slice(0, 200));
      const claimAgain = await api3('POST', '/api/agent/claim', { token: tOwner, body: { token: claimToken } });
      check('同一令牌再 claim 失败（一次性）', claimAgain.status === 404, String(claimAgain.status) + ' ' + JSON.stringify(claimAgain.j));
      const ciAfter = await api3('GET', '/api/agent/claim-info?token=' + encodeURIComponent(claimToken), {});
      check('认领后 claim-info 同令牌 404', ciAfter.status === 404, String(ciAfter.status));

      // AI 作品进主人页面：绑定后再发 1 条，主人 works/profile 与智能体自己 profile 都要对得上
      const agentPub2 = await api3('POST', '/api/videos', { token: akey, body: { title: '绑定后智能体作品', desc: '', videoUrl: '', posterHue: 170 } });
      check('绑定后智能体再发作品成功', agentPub2.status === 200 && agentPub2.j.author.id === agentId, JSON.stringify(agentPub2.j).slice(0, 160));
      const ownerWorks = await api3('GET', '/api/me/works', { token: tOwner });
      const ow = (ownerWorks.j.videos || []).find(v => v.id === agentPub2.j.id);
      check('主人 /api/me/works 含智能体作品且 author 仍是智能体', ownerWorks.status === 200 && !!ow && ow.author.id === agentId && ow.author.isAgent === true, JSON.stringify((ownerWorks.j.videos || []).map(v => v.title)));
      const ownerMe = await api3('GET', '/api/me', { token: tOwner });
      check('主人 /api/me stats.works=2（智能体两条都计入）', ownerMe.status === 200 && ownerMe.j.stats.works === 2, JSON.stringify(ownerMe.j.stats));
      const { verify: regPasser } = await registerViaEmail(' passer@example.com'.trim(), '路人甲', '123456', {}, api3);
      const profOwnerByStranger = await api3('GET', `/api/users/${idOwner}/profile`, { token: regPasser.j.token });
      check('陌生人看主人 profile：videos 含智能体作品、stats.works=2', profOwnerByStranger.status === 200 && profOwnerByStranger.j.videos.some(v => v.id === agentPub2.j.id) && profOwnerByStranger.j.stats.works === 2, JSON.stringify(profOwnerByStranger.j.stats) + ' ' + JSON.stringify((profOwnerByStranger.j.videos || []).map(v => v.title)));
      const profAgentSelf = await api3('GET', `/api/users/${agentId}/profile`, { token: tOwner });
      check('智能体自己 profile 仍含其全部作品（2 条）', profAgentSelf.status === 200 && profAgentSelf.j.videos.some(v => v.id === agentPub2.j.id) && profAgentSelf.j.stats.works === 2 && profAgentSelf.j.videos.every(v => v.author.id === agentId), JSON.stringify(profAgentSelf.j.stats));

      // 智能体不能认领别人
      const regAgent2 = await api3('POST', '/api/agent/register', { body: { name: '机器人小乙', code: AGENT_CODE } });
      const claimToken2 = regAgent2.j.claimUrl.split('?claim=')[1];
      const agentClaim = await api3('POST', '/api/agent/claim', { token: akey, body: { token: claimToken2 } });
      check('智能体账号 claim 别人 403', agentClaim.status === 403, JSON.stringify(agentClaim.j));

      // 认领链接重新生成：未绑定可随时刷新、旧链接作废；已绑定 409；人类账号 403
      const akey2 = regAgent2.j.apiKey;
      const humanGen = await api3('POST', '/api/agent/claim-link', { token: regPasser.j.token });
      check('人类账号调 claim-link 403', humanGen.status === 403, JSON.stringify(humanGen.j));
      const regen = await api3('POST', '/api/agent/claim-link', { token: akey2 });
      const newToken2 = regen.j && regen.j.claimUrl ? regen.j.claimUrl.split('?claim=')[1] : '';
      check('未绑定智能体重新生成认领链接 200 且链接已换新', regen.status === 200 && !!newToken2 && newToken2 !== claimToken2 && regen.j.claimExpiresAt > Date.now(), JSON.stringify(regen.j).slice(0, 200));
      const ciOld = await api3('GET', '/api/agent/claim-info?token=' + encodeURIComponent(claimToken2), {});
      check('旧认领链接立即作废（claim-info 404）', ciOld.status === 404, String(ciOld.status));
      const ciNew = await api3('GET', '/api/agent/claim-info?token=' + encodeURIComponent(newToken2), {});
      check('新认领链接可用（claim-info 200）', ciNew.status === 200 && ciNew.j.agent.name === '机器人小乙', JSON.stringify(ciNew.j).slice(0, 160));
      const boundGen = await api3('POST', '/api/agent/claim-link', { token: akey });
      check('已绑定智能体再生成认领链接 409', boundGen.status === 409, JSON.stringify(boundGen.j));

      // 落盘检查：data.json 里绝不能有 key / 认领令牌明文
      const rawData = fs.readFileSync(DATA3, 'utf8');
      check('data.json 里搜不到 API Key 明文', !rawData.includes(akey), 'apiKey leaked!');
      check('data.json 里搜不到认领令牌明文', !rawData.includes(claimToken) && !rawData.includes(claimToken2), 'claim token leaked!');
      const parsed = JSON.parse(rawData);
      const agentRec = parsed.users.find(u => u.id === agentId);
      check('落盘记录：passwordHash=null、isAgent=true、只存 sha256 哈希', !!agentRec && agentRec.passwordHash === null && agentRec.isAgent === true && /^[0-9a-f]{64}$/.test(agentRec.apiKeyHash || '') && agentRec.ownerId === idOwner && agentRec.claimTokenHash === null, JSON.stringify(agentRec).slice(0, 240));
    } finally {
      child3.kill();
      try { fs.rmSync(tmp3, { recursive: true, force: true }); } catch {}
    }
  }

  // ===== 压缩 size 分支：另起一个服务实例，用 COMPRESS_SIZE_BYTES=100 把阈值临时调小 =====
  // （主实例仍是默认 5GB，不受影响；这样不用造 5GB 大文件就能测到 size/both 分支）
  {
    const PORT2 = 18189;
    const BASE2 = `http://127.0.0.1:${PORT2}`;
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'yousj-video-test2-'));
    const child2 = spawn(process.execPath, [path.join(dir, 'server.js')], {
      env: { ...process.env, ...MAIL_ENV_OFF, PORT: String(PORT2), DATA_FILE: path.join(tmp2, 'data.json'), UPLOAD_DIR: path.join(tmp2, 'uploads'), COMPRESS_SIZE_BYTES: '100', ALLOW_DEV_CODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const api2 = async (method, p, { token, body } = {}) => {
      const r = await fetch(BASE2 + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let j = null; try { j = await r.json(); } catch {}
      return { status: r.status, j };
    };
    try {
      let up2ok = false;
      for (let i = 0; i < 50 && !up2ok; i++) {
        try { const r = await fetch(BASE2 + '/api/health'); up2ok = r.ok; } catch {}
        if (!up2ok) await new Promise(s => setTimeout(s, 200));
      }
      check('size 分支测试实例启动（阈值=100字节）', up2ok);
      const { verify: reg2 } = await registerViaEmail('t2@example.com', '阈值测', '123456', {}, api2);
      const t2 = reg2.j.token;
      // 真实文件 300 字节 > 阈值 100：走 /api/upload 落盘，后端按 videoUrl 反查真实大小判定
      const bigFake = Buffer.alloc(300, 9).toString('base64');
      const up2 = await api2('POST', '/api/upload', { token: t2, body: { filename: 's.mp4', dataBase64: bigFake } });
      const vSize = await api2('POST', '/api/videos', { token: t2, body: { title: '短时长大文件', videoUrl: up2.j.url, durationSec: 60, width: 3840, height: 2160 } });
      check('durationSec=60 但真实文件>阈值 -> needsCompression=true, compressReason=size', vSize.status === 200 && vSize.j.needsCompression === true && vSize.j.compressReason === 'size' && vSize.j.fileSizeBytes === 300 && vSize.j.compressTarget === '1080p', JSON.stringify(vSize.j));
      const vBoth = await api2('POST', '/api/videos', { token: t2, body: { title: '长时长大文件', videoUrl: up2.j.url, durationSec: 3700 } });
      check('时长+大小都超 -> compressReason=both', vBoth.status === 200 && vBoth.j.needsCompression === true && vBoth.j.compressReason === 'both', JSON.stringify(vBoth.j));
      const vDurOnly = await api2('POST', '/api/videos', { token: t2, body: { title: '无文件长时长', videoUrl: '', durationSec: 3700 } });
      check('无文件仅时长超 -> compressReason=duration', vDurOnly.status === 200 && vDurOnly.j.needsCompression === true && vDurOnly.j.compressReason === 'duration' && vDurOnly.j.fileSizeBytes === null, JSON.stringify(vDurOnly.j));
      const vNone = await api2('POST', '/api/videos', { token: t2, body: { title: '无文件短时长', videoUrl: '', durationSec: 60 } });
      check('都不超 -> needsCompression=false, compressReason=null', vNone.status === 200 && vNone.j.needsCompression === false && vNone.j.compressReason === null, JSON.stringify(vNone.j));
    } finally {
      child2.kill();
      try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch {}
    }
  }
} catch (e) {
  failed++; console.log('FAIL  自测异常: ' + e.message);
} finally {
  child.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n===== 自测结果: ${passed} PASS / ${failed} FAIL =====`);
process.exit(failed ? 1 : 0);
