// Yousj 短视频 后端：零外部依赖（仅 Node 内置模块）
// 中继服务器中继模式，账号仿 MeshChat relay.js 思路（账号=昵称#4位号、scrypt 哈希）；
// 注册只走邮箱验证码（hello@yousj.cc 发信，见 sendMail），登录以邮箱+密码为主。
// 数据存 data.json（原子写：tmp + rename），上传存 uploads/，静态托管 ../app/www/。
// 跑法：node server.js   默认端口 18088（PORT 可覆盖），DATA_FILE / UPLOAD_DIR 可覆盖。
'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '18088', 10);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const WWW_DIR = path.join(__dirname, '..', 'app', 'www');
const MAX_UPLOAD = 200 * 1024 * 1024;
// 分片上传（保 4K 大文件）：单片上限 16MB，总大小上限 20GB；分片暂存 uploads/.chunks/<uploadId>/
const MAX_CHUNK = 16 * 1024 * 1024;
const MAX_TOTAL_UPLOAD = 20 * 1024 * 1024 * 1024;
const CHUNK_ROOT = () => path.join(UPLOAD_DIR, '.chunks');
// 压缩规则（合并版）：时长 >3600s 或 真实文件大小 >5GB 任一满足即需压缩，目标统一 1080p。
// 阈值可用环境变量 COMPRESS_SIZE_BYTES 覆盖（仅供自测把阈值调小验证 size 分支），默认 5GB。
const COMPRESS_SIZE_BYTES = (() => { const n = Number(process.env.COMPRESS_SIZE_BYTES); return Number.isFinite(n) && n > 0 ? n : 5 * 1024 * 1024 * 1024; })();
const COMPRESS_DURATION_SEC = 3600;
const COMPRESS_TARGET = '1080p';
const ALLOWED_EXT = new Set(['.mp4', '.webm', '.mov']);
const AVATAR_COLORS = ['#ff6b6b', '#feca57', '#48dbfb', '#1dd1a1', '#f368e0', '#ff9f43', '#54a0ff', '#5f27cd', '#c8d6e5', '#10ac84', '#ee5253', '#2e86de'];

// ---------- 密码 ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'), 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function newId() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }

// ---------- 发信 sendMail(to, subject, text) ----------
// 凭据只读环境变量，绝不硬编码。通道顺序：
//   ① MAIL_WEBHOOK_URL 存在 -> POST JSON {from:"hello@yousj.cc",to,subject,text}
//   ② SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS 齐全且端口 465 -> tls.connect 隐式 TLS + AUTH LOGIN
//      （587/2525 的 STARTTLS 不在此实现：握手时序不稳，等有真实服务商需求再单独做）
//   ③ 都没配且 ALLOW_DEV_CODE=1 -> dev 模式（调用方打印验证码并把 devCode 回传，生产绝不启用）
// 发件人固定 hello@yousj.cc（MAIL_FROM 可覆盖显示地址）。
const MAIL_FROM = process.env.MAIL_FROM || 'hello@yousj.cc';
function mailConfigured() {
  if (process.env.MAIL_WEBHOOK_URL) return 'webhook';
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS) return Number(SMTP_PORT) === 465 ? 'smtp465' : 'smtp-unsupported-port';
  return null;
}
function devMailEnabled() { return !mailConfigured() && process.env.ALLOW_DEV_CODE === '1'; }
function postJsonWebhook(urlStr, payload) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('MAIL_WEBHOOK_URL 无效')); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 10000 }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error('webhook 返回 ' + res.statusCode));
      });
    });
    req.on('timeout', () => req.destroy(new Error('webhook 超时')));
    req.on('error', reject);
    req.end(data);
  });
}
function encodeHeaderWord(s) {
  return '=?UTF-8?B?' + Buffer.from(String(s), 'utf8').toString('base64') + '?=';
}
function smtpTlsSend({ host, port, user, pass, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 15000 });
    socket.setEncoding('utf8');
    let buf = '';
    let waiter = null;
    let failed = false;
    const fail = (e) => { if (!failed) { failed = true; try { socket.destroy(); } catch {} reject(e); } };
    socket.on('error', fail);
    socket.on('timeout', () => fail(new Error('SMTP 连接超时')));
    // 逐行攒齐一条 SMTP 应答：多行应答以 "NNN-" 开头、"NNN " 结尾行收束
    function nextResponse() {
      return new Promise((res2, rej2) => {
        waiter = { res: res2, rej: rej2 };
        drain();
      });
    }
    function drain() {
      if (!waiter) return;
      const lines = buf.split('\r\n');
      // 最后一截可能是不完整行，留在 buf 里
      buf = lines.pop();
      const done = [];
      let complete = false;
      for (const line of lines) {
        done.push(line);
        const m = /^(\d{3})([ -])/.exec(line);
        if (m && m[2] === ' ') complete = true;
      }
      if (complete) { const w = waiter; waiter = null; w.res(done.join('\n')); }
      else { buf = done.join('\r\n') + (done.length ? '\r\n' : '') + buf; }
    }
    socket.on('data', (d) => { buf += d; drain(); });
    const expect = async (codes) => {
      const r = await nextResponse();
      const code = parseInt(r.slice(0, 3), 10);
      if (!codes.includes(code)) throw new Error('SMTP 应答异常: ' + r.split('\n')[0]);
      return r;
    };
    const cmd = (line) => new Promise((res2, rej2) => {
      socket.write(line + '\r\n', (e) => (e ? rej2(e) : res2()));
    });
    (async () => {
      try {
        await expect([220]); // greeting（secureConnect 后服务器先发）
        await cmd('EHLO yousj.cc'); await expect([250]);
        await cmd('AUTH LOGIN'); await expect([334]);
        await cmd(Buffer.from(user, 'utf8').toString('base64')); await expect([334]);
        await cmd(Buffer.from(pass, 'utf8').toString('base64')); await expect([235]);
        await cmd(`MAIL FROM:<${MAIL_FROM}>`); await expect([250]);
        await cmd(`RCPT TO:<${to}>`); await expect([250, 251]);
        await cmd('DATA'); await expect([354]);
        const bodyB64 = Buffer.from(String(text), 'utf8').toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
        const message = [
          `From: ${MAIL_FROM}`,
          `To: ${to}`,
          `Subject: ${encodeHeaderWord(subject)}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          bodyB64,
          '.',
        ].join('\r\n');
        await cmd(message); await expect([250]);
        await cmd('QUIT');
        try { await expect([221]); } catch {}
        socket.end();
        resolve();
      } catch (e) { fail(e); }
    })();
  });
}
async function sendMail(to, subject, text) {
  const mode = mailConfigured();
  if (mode === 'webhook') {
    await postJsonWebhook(process.env.MAIL_WEBHOOK_URL, { from: MAIL_FROM, to, subject, text });
    return 'webhook';
  }
  if (mode === 'smtp465') {
    await smtpTlsSend({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT),
      user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, to, subject, text,
    });
    return 'smtp';
  }
  if (mode === 'smtp-unsupported-port') throw new Error('SMTP 端口非 465，STARTTLS 未实现');
  throw new Error('未配置邮件通道');
}

// ---------- 数据层 ----------
function emptyData() {
  return { users: [], tokens: {}, videos: [], comments: [], friends: {}, friendRequests: [], dms: [], dmReads: {}, regCodes: {} };
}
let db = emptyData();
let isFresh = false;
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) { isFresh = true; db = emptyData(); return; }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw.trim()) { isFresh = true; db = emptyData(); return; }
    const parsed = JSON.parse(raw);
    db = Object.assign(emptyData(), parsed);
  } catch (e) {
    console.error('loadData failed, starting empty:', e.message);
    isFresh = true; db = emptyData();
  }
}
function saveData() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('saveData failed:', e.message); }
}

// ---------- 工具 ----------
function usedNumbers() { return new Set(db.users.map(u => u.number)); }
function allocNumber() {
  const used = usedNumbers();
  for (let i = 0; i < 300; i++) {
    const n = 1000 + Math.floor(Math.random() * 9000);
    if (!used.has(n)) return n;
  }
  for (let n = 1000; n < 10000; n++) if (!used.has(n)) return n;
  for (let n = 10000; n < 100000; n++) if (!used.has(n)) return n;
  throw new Error('numbers exhausted');
}
function formatNumber(n) { return n < 10000 ? String(n).padStart(4, '0') : String(n); }
function pickColor(seedStr) {
  let h = 0; const s = String(seedStr || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function userById(id) { return db.users.find(u => u.id === id) || null; }
function publicUser(u) {
  if (!u) return null;
  // pubKey：用户 E2E 公钥（JWK JSON 字符串），前端据此做 ECDH+AES-GCM 端到端加密；无则 null
  return { id: u.id, account: u.account, name: u.name, avatarColor: u.avatarColor, pubKey: u.pubKey || null };
}
function sanitizePubKey(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 8192) return null;
  return s;
}
function friendsOf(userId) { return db.friends[userId] || []; }
function isFriend(a, b) { return friendsOf(a).includes(b); }
function ensureFriendList(id) { if (!Array.isArray(db.friends[id])) db.friends[id] = []; return db.friends[id]; }

// 按 videoUrl 反查 uploads 磁盘上的真实文件大小（不信前端声明的 size）
function fileSizeForUrl(videoUrl) {
  if (!videoUrl || typeof videoUrl !== 'string' || !videoUrl.startsWith('/uploads/')) return null;
  try {
    const file = path.join(UPLOAD_DIR, path.basename(videoUrl));
    const st = fs.statSync(file);
    return st.isFile() ? st.size : null;
  } catch { return null; }
}
// 压缩判定：时长超限或真实大小超限任一满足即 true，并给出原因；v1 只标记不转码
function compressInfo(v) {
  const byDuration = typeof v.durationSec === 'number' && v.durationSec > COMPRESS_DURATION_SEC;
  const size = typeof v.fileSizeBytes === 'number' ? v.fileSizeBytes : fileSizeForUrl(v.videoUrl);
  const bySize = typeof size === 'number' && size > COMPRESS_SIZE_BYTES;
  const compressReason = byDuration && bySize ? 'both' : byDuration ? 'duration' : bySize ? 'size' : null;
  return { fileSizeBytes: typeof size === 'number' ? size : null, needsCompression: !!compressReason, compressReason };
}
function videoView(v, meId) {
  const author = userById(v.authorId);
  const ci = compressInfo(v);
  return {
    id: v.id,
    author: publicUser(author) || { id: v.authorId, account: '', name: '已注销', avatarColor: '#888888' },
    title: v.title || '',
    desc: v.desc || '',
    videoUrl: v.videoUrl || '',
    posterHue: typeof v.posterHue === 'number' ? v.posterHue : 210,
    kind: v.kind === 'scene' ? 'scene' : 'video',
    // 视频元数据（前端发布时探测后上报，保 4K：width/height 原样保存不缩放）
    width: typeof v.width === 'number' ? v.width : null,
    height: typeof v.height === 'number' ? v.height : null,
    durationSec: typeof v.durationSec === 'number' ? v.durationSec : null,
    // 真实文件大小（发布时按 videoUrl 反查磁盘存入，旧记录在 view 时现查兜底）
    fileSizeBytes: ci.fileSizeBytes,
    // 时长>1h 或 文件>5GB 任一满足即需压缩（目标 1080p）；v1 只打标记不真正转码（转码管线后置），都不满足原文件不动
    needsCompression: ci.needsCompression,
    compressReason: ci.compressReason,
    compressTarget: ci.needsCompression ? COMPRESS_TARGET : null,
    createdAt: v.createdAt,
    likeCount: (v.likedBy || []).length,
    commentCount: db.comments.filter(c => c.videoId === v.id).length,
    favCount: (v.favedBy || []).length,
    shareCount: v.shareCount || 0,
    liked: meId ? (v.likedBy || []).includes(meId) : false,
    faved: meId ? (v.favedBy || []).includes(meId) : false,
    isFriend: meId ? isFriend(meId, v.authorId) : false,
  };
}
function commentView(c) {
  const author = userById(c.authorId);
  return { id: c.id, author: publicUser(author) || { id: c.authorId, account: '', name: '已注销', avatarColor: '#888888' }, text: c.text, createdAt: c.createdAt };
}
function dmView(m, meId) {
  return {
    id: m.id, fromId: m.fromId, text: m.text || '',
    videoId: m.videoId || null, videoTitle: m.videoTitle || null,
    createdAt: m.createdAt, mine: m.fromId === meId,
  };
}
function statsFor(userId) {
  const my = db.videos.filter(v => v.authorId === userId);
  return {
    works: my.length,
    followers: friendsOf(userId).length,
    friends: friendsOf(userId).length,
    likesReceived: my.reduce((s, v) => s + (v.likedBy || []).length, 0),
  };
}
function createUser(name, password, pubKey, email) {
  const number = allocNumber();
  const numStr = formatNumber(number);
  const user = {
    id: newId(), name, number, account: name + '#' + numStr,
    // email：仅邮箱注册流程写入（种子账号为 null）；publicUser 不外露，只在 /api/me 给本人
    email: email ? String(email).toLowerCase() : null,
    passwordHash: hashPassword(password),
    avatarColor: pickColor(name + numStr),
    pubKey: sanitizePubKey(pubKey),
    createdAt: Date.now(),
  };
  db.users.push(user);
  ensureFriendList(user.id);
  return user;
}
function numOrNull(x) {
  if (x == null || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function createVideo(authorId, { title, desc, videoUrl, posterHue, width, height, durationSec }) {
  const v = {
    id: newId(), authorId, title: title || '', desc: desc || '',
    videoUrl: videoUrl || '',
    posterHue: typeof posterHue === 'number' ? posterHue : Math.floor(Math.random() * 360),
    kind: videoUrl ? 'video' : 'scene',
    width: numOrNull(width), height: numOrNull(height), durationSec: numOrNull(durationSec),
    // 发布时即按 videoUrl 反查磁盘真实大小并落盘，后续判定都以这个真实值为准
    fileSizeBytes: fileSizeForUrl(videoUrl || ''),
    createdAt: Date.now(), likedBy: [], favedBy: [], shareCount: 0,
  };
  db.videos.push(v);
  return v;
}
function pushDm(fromId, toId, text, videoId) {
  let videoTitle = null;
  if (videoId) { const v = db.videos.find(x => x.id === videoId); if (v) videoTitle = v.title || ''; }
  const m = { id: newId(), fromId, toId, text: text || '', videoId: videoId || null, videoTitle, createdAt: Date.now() };
  db.dms.push(m);
  return m;
}

// ---------- 种子数据（首次启动） ----------
function seed() {
  if (!isFresh && db.users.length > 0) return;
  if (db.videos.length > 0) return;
  const a = createUser('阿澈', crypto.randomBytes(8).toString('hex'));
  const b = createUser('小满', crypto.randomBytes(8).toString('hex'));
  const now = Date.now();
  const seeds = [
    { authorId: a.id, title: '海边的风', desc: '傍晚的海风，吹散了一天的疲惫 🌊', posterHue: 205, createdAt: now - 5 * 3600 * 1000 },
    { authorId: a.id, title: '城市夜跑', desc: '霓虹灯下的五公里，今晚状态不错', posterHue: 275, createdAt: now - 3 * 3600 * 1000 },
    { authorId: b.id, title: '阳台小花园', desc: '新开的茉莉，香得整个阳台都是', posterHue: 140, createdAt: now - 2 * 3600 * 1000 },
    { authorId: b.id, title: '周末烘焙日', desc: '第一次做巴斯克蛋糕，居然成功了！', posterHue: 32, createdAt: now - 1 * 3600 * 1000 },
  ];
  for (const s of seeds) {
    const v = createVideo(s.authorId, { title: s.title, desc: s.desc, videoUrl: '', posterHue: s.posterHue });
    v.createdAt = s.createdAt;
  }
  saveData();
  console.log('seeded: 2 authors, 4 scene videos');
}

// ---------- HTTP 工具 ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD * 1.5 + 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
function authUser(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const uid = db.tokens[m[1].trim()];
  if (!uid) return null;
  return userById(uid);
}
function issueToken(user) {
  const token = newToken();
  db.tokens[token] = user.id;
  saveData();
  return token;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(res, baseDir, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(baseDir, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(path.resolve(baseDir))) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
}

// ---------- 路由 ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/health' && method === 'GET') return sendJson(res, 200, { ok: true });

  // --- 公开：邮箱验证码注册（三步）/ 登录 ---
  // 旧的昵称直注册已废弃：只允许邮箱注册
  if (p === '/api/register' && method === 'POST') {
    return sendJson(res, 410, { error: '请使用邮箱验证码注册' });
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const CODE_TTL_MS = 10 * 60 * 1000;   // 验证码 10 分钟过期
  const CODE_RESEND_MS = 60 * 1000;     // 同邮箱 60 秒不可重发
  const CODE_MAX_FAILS = 5;             // 错验 5 次作废

  if (p === '/api/register/request-code' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 100) return sendJson(res, 400, { error: '邮箱格式不对' });
    if (db.users.some(u => u.email === email)) return sendJson(res, 409, { error: '该邮箱已注册' });
    if (!db.regCodes) db.regCodes = {};
    const prev = db.regCodes[email];
    const now = Date.now();
    if (prev && prev.lastSentAt && now - prev.lastSentAt < CODE_RESEND_MS) {
      return sendJson(res, 429, { error: '验证码发送太频繁，请 60 秒后再试' });
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const subject = 'Yousj 短视频注册验证码';
    const text = `你的 Yousj 短视频注册验证码是：${code}\n\n验证码 10 分钟内有效，请勿泄露给他人。\n如果不是你本人操作，请忽略这封邮件。`;
    const dev = devMailEnabled();
    if (dev) {
      // 开发模式：不真发信，控制台打印 + 响应回传 devCode（仅 ALLOW_DEV_CODE=1 且未配邮件通道时）
      console.log(`[dev] 注册验证码 ${email}: ${code}`);
    } else {
      try { await sendMail(email, subject, text); }
      catch (e) { console.error('sendMail failed:', e.message); return sendJson(res, 502, { error: '验证码发送失败' }); }
    }
    // 只存哈希（scrypt salt:hash），不存明文验证码
    db.regCodes[email] = { hash: hashPassword(code), expiresAt: now + CODE_TTL_MS, lastSentAt: now, fails: 0 };
    saveData();
    return sendJson(res, 200, dev ? { ok: true, devCode: code } : { ok: true });
  }

  if (p === '/api/register/verify' && method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const name = String(body.name || '').trim().slice(0, 20);
    const password = String(body.password || '');
    if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: '邮箱格式不对' });
    if (db.users.some(u => u.email === email)) return sendJson(res, 409, { error: '该邮箱已注册' });
    if (!db.regCodes) db.regCodes = {};
    const rec = db.regCodes[email];
    if (!rec || !rec.hash || Date.now() > rec.expiresAt) {
      if (rec) { delete db.regCodes[email]; saveData(); }
      return sendJson(res, 400, { error: '验证码无效或已过期' });
    }
    if (!verifyPassword(code, rec.hash)) {
      rec.fails = (rec.fails || 0) + 1;
      if (rec.fails >= CODE_MAX_FAILS) delete db.regCodes[email]; // 错满 5 次作废
      saveData();
      return sendJson(res, 400, { error: '验证码不正确' });
    }
    if (!name) return sendJson(res, 400, { error: '姓名不能为空' });
    if (password.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
    let user;
    try { user = createUser(name, password, body.pubKey, email); } catch { return sendJson(res, 500, { error: '账号号段已满' }); }
    delete db.regCodes[email];
    const token = issueToken(user); // issueToken 内已 saveData，验证码删除一并落盘
    return sendJson(res, 200, { token, user: publicUser(user) });
  }

  if (p === '/api/login' && method === 'POST') {
    const body = await readBody(req);
    const loginId = String(body.accountOrName || body.account || body.name || '').trim();
    const password = String(body.password || '');
    let user = null;
    if (loginId) {
      // 主：邮箱登录（大小写不敏感）；兼容：账号#号
      user = db.users.find(u => u.email && u.email === loginId.toLowerCase())
        || db.users.find(u => u.account === loginId) || null;
      if (!user) {
        // 昵称登录：同名多账号时逐个验密码，命中即是本人
        for (const u of db.users) if (u.name === loginId && verifyPassword(password, u.passwordHash)) { user = u; break; }
      }
    }
    if (!user || !verifyPassword(password, user.passwordHash)) return sendJson(res, 401, { error: '账号或密码不对' });
    const token = issueToken(user);
    return sendJson(res, 200, { token, user: publicUser(user) });
  }

  // --- 以下都要鉴权 ---
  const me = authUser(req);
  if (!me) return sendJson(res, 401, { error: '未登录或登录已失效' });

  if (p === '/api/me' && method === 'GET') {
    // email 只给本人看：publicUser 不带 email，这里单独附上
    return sendJson(res, 200, { user: { ...publicUser(me), email: me.email || null }, stats: statsFor(me.id) });
  }

  // 登录后补传/更新 E2E 公钥
  if (p === '/api/me/pubkey' && method === 'POST') {
    const body = await readBody(req);
    const pubKey = sanitizePubKey(body.pubKey);
    if (!pubKey) return sendJson(res, 400, { error: 'pubKey 无效' });
    me.pubKey = pubKey;
    saveData();
    return sendJson(res, 200, { ok: true, pubKey: me.pubKey });
  }

  if (p === '/api/feed' && method === 'GET') {
    const scope = url.searchParams.get('scope') || 'recommended';
    let list = [...db.videos].sort((a, b) => b.createdAt - a.createdAt);
    if (scope === 'friends') {
      const fset = new Set(friendsOf(me.id));
      list = list.filter(v => fset.has(v.authorId));
    }
    return sendJson(res, 200, { videos: list.map(v => videoView(v, me.id)) });
  }

  // --- 分片上传（4K 大文件走这条：init -> chunk*N -> complete） ---
  const chunkMetaPath = (uploadId) => path.join(CHUNK_ROOT(), uploadId, 'meta.json');
  const loadChunkMeta = (uploadId) => {
    if (!/^[a-f0-9]{32}$/.test(uploadId || '')) return null;
    try { return JSON.parse(fs.readFileSync(chunkMetaPath(uploadId), 'utf8')); } catch { return null; }
  };
  if (p === '/api/upload/init' && method === 'POST') {
    const body = await readBody(req);
    const filename = String(body.filename || '');
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return sendJson(res, 400, { error: '只允许 mp4/webm/mov 视频' });
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0 || Math.floor(size) !== size) return sendJson(res, 400, { error: 'size 无效' });
    if (size > MAX_TOTAL_UPLOAD) return sendJson(res, 413, { error: '文件超过 20GB 上限' });
    const uploadId = crypto.randomBytes(16).toString('hex');
    const dir = path.join(CHUNK_ROOT(), uploadId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      filename, ext, size, mime: String(body.mime || ''), ownerId: me.id, createdAt: Date.now(),
    }));
    return sendJson(res, 200, { uploadId });
  }
  if (p === '/api/upload/chunk' && method === 'POST') {
    const body = await readBody(req);
    const uploadId = String(body.uploadId || '');
    const meta = loadChunkMeta(uploadId);
    if (!meta) return sendJson(res, 404, { error: '上传会话不存在' });
    if (meta.ownerId !== me.id) return sendJson(res, 403, { error: '无权操作该上传' });
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0) return sendJson(res, 400, { error: 'index 无效' });
    if (!body.dataBase64 || typeof body.dataBase64 !== 'string') return sendJson(res, 400, { error: '缺少分片数据' });
    const b64 = body.dataBase64.includes(',') ? body.dataBase64.split(',').pop() : body.dataBase64;
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { return sendJson(res, 400, { error: '分片数据无效' }); }
    if (buf.length === 0) return sendJson(res, 400, { error: '分片为空' });
    if (buf.length > MAX_CHUNK) return sendJson(res, 413, { error: '单片超过 16MB' });
    fs.writeFileSync(path.join(CHUNK_ROOT(), uploadId, index + '.part'), buf);
    return sendJson(res, 200, { ok: true, index, bytes: buf.length });
  }
  if (p === '/api/upload/complete' && method === 'POST') {
    const body = await readBody(req);
    const uploadId = String(body.uploadId || '');
    const meta = loadChunkMeta(uploadId);
    if (!meta) return sendJson(res, 404, { error: '上传会话不存在' });
    if (meta.ownerId !== me.id) return sendJson(res, 403, { error: '无权操作该上传' });
    const dir = path.join(CHUNK_ROOT(), uploadId);
    const parts = fs.readdirSync(dir)
      .filter(f => f.endsWith('.part'))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    if (parts.length === 0) return sendJson(res, 400, { error: '没有收到任何分片' });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safe = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + meta.ext;
    const dest = path.join(UPLOAD_DIR, safe);
    let total = 0;
    try {
      const ws = fs.createWriteStream(dest);
      for (const part of parts) {
        const buf = fs.readFileSync(path.join(dir, part));
        total += buf.length;
        // 逐片（<=16MB）顺序写入，避免大文件整载入内存
        await new Promise((resolve, reject) => ws.write(buf, (e) => (e ? reject(e) : resolve())));
      }
      await new Promise((resolve, reject) => ws.end((e) => (e ? reject(e) : resolve())));
    } catch (e) {
      try { fs.unlinkSync(dest); } catch {}
      return sendJson(res, 500, { error: '拼合失败: ' + e.message });
    }
    // 校验总字节数与 init 声明一致，不一致则删成品、保留分片供重试
    if (total !== meta.size) {
      try { fs.unlinkSync(dest); } catch {}
      return sendJson(res, 400, { error: `大小校验失败：声明 ${meta.size} 字节，实际拼合 ${total} 字节` });
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return sendJson(res, 200, { url: '/uploads/' + safe, size: total });
  }

  if (p === '/api/upload' && method === 'POST') {
    const body = await readBody(req);
    const filename = String(body.filename || '');
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return sendJson(res, 400, { error: '只允许 mp4/webm/mov 视频' });
    if (!body.dataBase64 || typeof body.dataBase64 !== 'string') return sendJson(res, 400, { error: '缺少文件数据' });
    const b64 = body.dataBase64.includes(',') ? body.dataBase64.split(',').pop() : body.dataBase64;
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { return sendJson(res, 400, { error: '文件数据无效' }); }
    if (buf.length === 0) return sendJson(res, 400, { error: '文件为空' });
    if (buf.length > MAX_UPLOAD) return sendJson(res, 413, { error: '文件超过 200MB' });
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safe = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, safe), buf);
    return sendJson(res, 200, { url: '/uploads/' + safe });
  }

  if (p === '/api/videos' && method === 'POST') {
    const body = await readBody(req);
    const posterHueRaw = body.posterHue;
    const v = createVideo(me.id, {
      title: String(body.title || '').slice(0, 100),
      desc: String(body.desc || '').slice(0, 500),
      videoUrl: String(body.videoUrl || ''),
      posterHue: typeof posterHueRaw === 'number' ? posterHueRaw : (posterHueRaw != null && !isNaN(Number(posterHueRaw)) ? Number(posterHueRaw) : undefined),
      width: body.width, height: body.height, durationSec: body.durationSec,
    });
    saveData();
    return sendJson(res, 200, videoView(v, me.id));
  }

  const mLike = /^\/api\/videos\/([^/]+)\/like$/.exec(p);
  if (mLike && method === 'POST') {
    const v = db.videos.find(x => x.id === decodeURIComponent(mLike[1]));
    if (!v) return sendJson(res, 404, { error: '作品不存在' });
    v.likedBy = v.likedBy || [];
    const i = v.likedBy.indexOf(me.id);
    let liked;
    if (i >= 0) { v.likedBy.splice(i, 1); liked = false; } else { v.likedBy.push(me.id); liked = true; }
    saveData();
    return sendJson(res, 200, { liked, likeCount: v.likedBy.length });
  }
  const mFav = /^\/api\/videos\/([^/]+)\/fav$/.exec(p);
  if (mFav && method === 'POST') {
    const v = db.videos.find(x => x.id === decodeURIComponent(mFav[1]));
    if (!v) return sendJson(res, 404, { error: '作品不存在' });
    v.favedBy = v.favedBy || [];
    const i = v.favedBy.indexOf(me.id);
    let faved;
    if (i >= 0) { v.favedBy.splice(i, 1); faved = false; } else { v.favedBy.push(me.id); faved = true; }
    saveData();
    return sendJson(res, 200, { faved, favCount: v.favedBy.length });
  }
  const mComments = /^\/api\/videos\/([^/]+)\/comments$/.exec(p);
  if (mComments && method === 'GET') {
    const vid = decodeURIComponent(mComments[1]);
    if (!db.videos.find(x => x.id === vid)) return sendJson(res, 404, { error: '作品不存在' });
    const comments = db.comments.filter(c => c.videoId === vid).sort((a, b) => a.createdAt - b.createdAt).map(commentView);
    return sendJson(res, 200, { comments });
  }
  if (mComments && method === 'POST') {
    const vid = decodeURIComponent(mComments[1]);
    if (!db.videos.find(x => x.id === vid)) return sendJson(res, 404, { error: '作品不存在' });
    const body = await readBody(req);
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) return sendJson(res, 400, { error: '评论不能为空' });
    const c = { id: newId(), videoId: vid, authorId: me.id, text, createdAt: Date.now() };
    db.comments.push(c); saveData();
    return sendJson(res, 200, commentView(c));
  }
  const mShare = /^\/api\/videos\/([^/]+)\/share$/.exec(p);
  if (mShare && method === 'POST') {
    const vid = decodeURIComponent(mShare[1]);
    const v = db.videos.find(x => x.id === vid);
    if (!v) return sendJson(res, 404, { error: '作品不存在' });
    const body = await readBody(req);
    const toUserId = String(body.toUserId || body.userId || '');
    const target = userById(toUserId);
    if (!target) return sendJson(res, 404, { error: '用户不存在' });
    if (!isFriend(me.id, target.id)) return sendJson(res, 403, { error: '只能转发给好友' });
    // 只计数，不再生成私信：转发卡片由前端先发一条 E2E 加密私信再调本接口，
    // 服务器若再造一条明文消息，聊天里会重复且显示成无法解密。
    v.shareCount = (v.shareCount || 0) + 1;
    saveData();
    return sendJson(res, 200, { ok: true, shareCount: v.shareCount });
  }

  // --- 用户主页（个人主页：作者信息 + 关系状态 + 统计 + 全部作品） ---
  const mProfile = /^\/api\/users\/([^/]+)\/profile$/.exec(p);
  if (mProfile && method === 'GET') {
    const target = userById(decodeURIComponent(mProfile[1]));
    if (!target) return sendJson(res, 404, { error: '用户不存在' });
    const s = statsFor(target.id);
    const videos = db.videos.filter(v => v.authorId === target.id)
      .sort((a, b) => b.createdAt - a.createdAt).map(v => videoView(v, me.id));
    return sendJson(res, 200, {
      user: publicUser(target),
      isSelf: target.id === me.id,
      isFriend: isFriend(me.id, target.id),
      // 待处理申请：查现成的好友申请记录（fromId=请求者、toId=对方 且尚未被接受/清理）
      hasPendingRequest: db.friendRequests.some(r => r.fromId === me.id && r.toId === target.id),
      stats: { works: s.works, likesReceived: s.likesReceived, friends: s.friends },
      videos,
    });
  }

  // --- 全局搜索（作品 + 用户；type=all|works|users，默认 all，只查一边时另一边空数组） ---
  if (p === '/api/search' && method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 200, { videos: [], users: [] });
    const typeRaw = String(url.searchParams.get('type') || 'all');
    const type = (typeRaw === 'works' || typeRaw === 'users') ? typeRaw : 'all';
    const ql = q.toLowerCase();
    let videos = [], users = [];
    if (type !== 'users') {
      videos = db.videos.filter(v => {
        const author = userById(v.authorId);
        return (v.title || '').toLowerCase().includes(ql)
          || (v.desc || '').toLowerCase().includes(ql)
          || (author && (author.name || '').toLowerCase().includes(ql));
      }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(v => videoView(v, me.id));
    }
    if (type !== 'works') {
      users = db.users
        .filter(u => u.id !== me.id && (u.account.toLowerCase().includes(ql) || u.name.toLowerCase().includes(ql) || formatNumber(u.number) === q || String(u.number) === q))
        .slice(0, 20).map(u => ({ ...publicUser(u), isFriend: isFriend(me.id, u.id) }));
    }
    return sendJson(res, 200, { videos, users });
  }

  // --- 好友 ---
  if (p === '/api/users/search' && method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 200, { users: [], results: [] });
    const ql = q.toLowerCase();
    const users = db.users
      .filter(u => u.id !== me.id && (u.account.toLowerCase().includes(ql) || u.name.toLowerCase().includes(ql) || formatNumber(u.number) === q || String(u.number) === q))
      .slice(0, 20).map(publicUser);
    return sendJson(res, 200, { users, results: users });
  }
  if (p === '/api/friends/request' && method === 'POST') {
    const body = await readBody(req);
    const target = userById(String(body.userId || ''));
    if (!target) return sendJson(res, 404, { error: '用户不存在' });
    if (target.id === me.id) return sendJson(res, 400, { error: '不能添加自己' });
    if (isFriend(me.id, target.id)) return sendJson(res, 400, { error: '已经是好友' });
    if (!db.friendRequests.some(r => r.fromId === me.id && r.toId === target.id)) {
      db.friendRequests.push({ fromId: me.id, toId: target.id, createdAt: Date.now() });
      saveData();
    }
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/friends/requests' && method === 'GET') {
    const requests = db.friendRequests.filter(r => r.toId === me.id)
      .map(r => { const u = publicUser(userById(r.fromId)); return { from: u, user: u, fromId: r.fromId, createdAt: r.createdAt }; })
      .filter(r => r.user);
    return sendJson(res, 200, { requests });
  }
  if (p === '/api/friends/accept' && method === 'POST') {
    const body = await readBody(req);
    const otherId = String(body.userId || '');
    const other = userById(otherId);
    if (!other) return sendJson(res, 404, { error: '用户不存在' });
    const idx = db.friendRequests.findIndex(r => r.fromId === otherId && r.toId === me.id);
    if (idx < 0 && !isFriend(me.id, otherId)) return sendJson(res, 400, { error: '没有待处理的好友申请' });
    if (idx >= 0) db.friendRequests.splice(idx, 1);
    // 双向互认
    const a = ensureFriendList(me.id); if (!a.includes(otherId)) a.push(otherId);
    const b = ensureFriendList(otherId); if (!b.includes(me.id)) b.push(me.id);
    saveData();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/friends' && method === 'GET') {
    const friends = friendsOf(me.id).map(id => publicUser(userById(id))).filter(Boolean);
    return sendJson(res, 200, { friends });
  }

  // --- 私信 ---
  if (p === '/api/dm/threads' && method === 'GET') {
    const byPeer = new Map();
    for (const m of db.dms) {
      if (m.fromId !== me.id && m.toId !== me.id) continue;
      const peerId = m.fromId === me.id ? m.toId : m.fromId;
      const cur = byPeer.get(peerId);
      if (!cur || m.createdAt > cur.lastAt) {
        byPeer.set(peerId, { peerId, lastText: m.videoId ? ('[作品] ' + (m.videoTitle || m.text || '')) : (m.text || ''), lastAt: m.createdAt });
      }
    }
    const threads = [...byPeer.values()].map(t => {
      const readAt = db.dmReads[me.id + ':' + t.peerId] || 0;
      const unread = db.dms.filter(m => m.fromId === t.peerId && m.toId === me.id && m.createdAt > readAt).length;
      return { peer: publicUser(userById(t.peerId)), lastText: t.lastText, lastAt: t.lastAt, unread };
    }).filter(t => t.peer).sort((a, b) => b.lastAt - a.lastAt);
    return sendJson(res, 200, { threads });
  }
  const mDm = /^\/api\/dm\/([^/]+)$/.exec(p);
  if (mDm && method === 'GET') {
    const peerId = decodeURIComponent(mDm[1]);
    const peer = userById(peerId);
    if (!peer) return sendJson(res, 404, { error: '用户不存在' });
    const messages = db.dms
      .filter(m => (m.fromId === me.id && m.toId === peerId) || (m.fromId === peerId && m.toId === me.id))
      .sort((a, b) => a.createdAt - b.createdAt).map(m => dmView(m, me.id));
    db.dmReads[me.id + ':' + peerId] = Date.now();
    saveData();
    return sendJson(res, 200, { messages });
  }
  if (mDm && method === 'POST') {
    const peerId = decodeURIComponent(mDm[1]);
    const peer = userById(peerId);
    if (!peer) return sendJson(res, 404, { error: '用户不存在' });
    if (!isFriend(me.id, peerId)) return sendJson(res, 403, { error: '只能给好友发私信' });
    const body = await readBody(req);
    // 私信 text 上限 64KB：前端传的是 ECDH+AES-GCM 密文 JSON 字符串，服务器原样存储/返回，绝不解析或改动
    const text = String(body.text || '').slice(0, 64 * 1024);
    const videoId = body.videoId ? String(body.videoId) : null;
    if (!text.trim() && !videoId) return sendJson(res, 400, { error: '消息不能为空' });
    if (videoId && !db.videos.find(v => v.id === videoId)) return sendJson(res, 404, { error: '作品不存在' });
    const m = pushDm(me.id, peerId, text, videoId);
    saveData();
    return sendJson(res, 200, dmView(m, me.id));
  }

  // --- 我的 ---
  if (p === '/api/me/collections' && method === 'GET') {
    const videos = db.videos.filter(v => (v.favedBy || []).includes(me.id))
      .sort((a, b) => b.createdAt - a.createdAt).map(v => videoView(v, me.id));
    return sendJson(res, 200, { videos });
  }
  if (p === '/api/me/works' && method === 'GET') {
    const videos = db.videos.filter(v => v.authorId === me.id)
      .sort((a, b) => b.createdAt - a.createdAt).map(v => videoView(v, me.id));
    return sendJson(res, 200, { videos });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

// ---------- 主服务器 ----------
loadData();
seed();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/uploads/')) return serveStatic(res, UPLOAD_DIR, url.pathname.slice('/uploads'.length));
    return serveStatic(res, WWW_DIR, url.pathname);
  } catch (e) {
    console.error('request error:', e.message);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
  }
});
server.listen(PORT, () => console.log(`Yousj 短视频 server running at http://localhost:${PORT}/ data=${DATA_FILE}`));
