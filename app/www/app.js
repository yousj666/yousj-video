'use strict';
/* Yousj 短视频 - 前端（原生 JS，无框架） */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const TOKEN_KEY = 'yv_token';
const USER_KEY = 'yv_user';

let me = null;
try { me = JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { me = null; }
let token = localStorage.getItem(TOKEN_KEY) || '';

const state = {
  view: 'home',
  videoById: {},        // id -> 最新视频对象（计数/状态以此为准）
  friends: [],
  requests: [],
  commentVideoId: null,
  shareVideoId: null,
  chatPeer: null,
  chatTimer: null,
  publishMode: 'video',
  publishFile: null,
  publishMeta: null,    // {width,height,durationSec}
  publishHue: 348,
  pubKeys: {},          // userId -> peer 公钥 JWK（E2E）
  meTab: 'works',
  meWorks: [],
  meCollections: [],
  friendsTab: 'works',
  homeLoaded: false,
  friendsLoaded: false,
  focusVideoId: null,   // 从网格/卡片跳转时要定位的作品
};

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 10000) {
    const v = n / 10000;
    return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + '万';
  }
  return String(n);
}
function relTime(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!t || Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + '小时前';
  if (diff < 86400 * 1000 * 30) return Math.floor(diff / 86400000) + '天前';
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}
function avatarHTML(user, cls) {
  const name = (user && user.name) || '?';
  const color = (user && user.avatarColor) || '#fe2c55';
  return '<div class="avatar ' + (cls || '') + '" style="background:' + esc(color) + '">' + esc(name.slice(0, 1)) + '</div>';
}
function hueBg(hue) {
  const h = Number(hue) || 0;
  return 'background:linear-gradient(160deg,hsl(' + h + ',72%,46%),hsl(' + ((h + 55) % 360) + ',78%,26%) 70%,hsl(' + ((h + 110) % 360) + ',60%,16%))';
}

/* ---------- 矢量图标（UI v2：弃用 emoji 字形，全部走 SVG，颜色由 CSS 的 color 控制） ---------- */
const ICONS = {
  heart: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>'
};
/* AI 智能体徽标：作者是智能体账号（isAgent）时在名字旁显示 */
function agentBadgeHTML(u) { return u && u.isAgent ? '<span class="agent-badge">AI</span>' : ''; }
/* 动效只有 Anime.js 一个引擎（自托管 anime.min.js）；没加载成功时用原生 WAAPI 兜底，绝不混第二套库 */
function pulseEl(el, big) {
  if (!el) return;
  if (window.anime) {
    window.anime.remove(el);
    window.anime({ targets: el, scale: big ? [1, 1.5, 1] : [1, 1.28, 1], duration: 380, easing: 'easeOutElastic(1, .55)' });
  } else if (el.animate) {
    el.animate([{ transform: 'scale(1)' }, { transform: 'scale(' + (big ? 1.5 : 1.28) + ')' }, { transform: 'scale(1)' }], { duration: 320, easing: 'ease-out' });
  }
}

/* ---------- 端到端加密（私信专用，照 MeshChat 已验证方案） ----------
   ECDH P-256 生成密钥对 -> 私钥 JWK 只存本机 localStorage、公钥上传服务器分发；
   与对方公钥 ECDH -> HKDF(SHA-256) -> AES-GCM-256 加密 JSON 载荷；
   服务器只中继密文。作品/评论是公开内容，不走这里。 */
const E2E = {
  _kp: null,          // {privJwk, pubJwk, scope}
  _derived: new Map(), // peerId -> AES-GCM CryptoKey
  available() { return !!(window.crypto && crypto.subtle); },
  _storeKey(scope) { return 'yv_ecdh_' + scope; },
  async ensureKeyPair(scope) {
    scope = String(scope || (me && me.id) || 'anon');
    if (this._kp && this._kp.scope === scope) return this._kp.pubJwk;
    if (!this.available()) return null;
    try {
      const raw = localStorage.getItem(this._storeKey(scope));
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && saved.privJwk && saved.pubJwk) {
          const priv = await crypto.subtle.importKey('jwk', saved.privJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
          this._kp = { privKey: priv, privJwk: saved.privJwk, pubJwk: saved.pubJwk, scope };
          return saved.pubJwk;
        }
      }
    } catch (e) { /* 本地密钥损坏就重新生成 */ }
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    try { localStorage.setItem(this._storeKey(scope), JSON.stringify({ privJwk, pubJwk })); } catch (e) {}
    this._kp = { privKey: kp.privateKey, privJwk, pubJwk, scope };
    return pubJwk;
  },
  // 注册时用 anon 作用域生成；拿到 user.id 后把同一对密钥迁到该账号作用域，避免换钥匙
  bindToUser(userId) {
    if (!userId) return;
    try {
      const anon = localStorage.getItem(this._storeKey('anon'));
      if (anon && !localStorage.getItem(this._storeKey(userId))) {
        localStorage.setItem(this._storeKey(userId), anon);
      }
      if (this._kp) this._kp.scope = String(userId);
    } catch (e) {}
  },
  parsePubKey(raw) {
    if (!raw) return null;
    let jwk = raw;
    if (typeof raw === 'string') { try { jwk = JSON.parse(raw); } catch (e) { return null; } }
    if (!jwk || typeof jwk !== 'object' || !jwk.x || !jwk.y) return null;
    return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  },
  async deriveAes(peerId, peerJwk) {
    const cacheKey = String(peerId);
    if (this._derived.has(cacheKey)) return this._derived.get(cacheKey);
    await this.ensureKeyPair(me && me.id);
    if (!this._kp) throw new Error('本机加密不可用');
    const peerKey = await crypto.subtle.importKey('jwk', peerJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const info = new TextEncoder().encode('yousj-video-e2e-v1');
    const hkdfBase = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerKey }, this._kp.privKey,
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info }, false, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(16), info }, hkdfBase,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    this._derived.set(cacheKey, aes);
    return aes;
  },
  async encrypt(peerId, peerJwk, payloadObj) {
    const aes = await this.deriveAes(peerId, peerJwk);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(payloadObj)));
    return JSON.stringify({ v: 1, enc: 'A256GCM', iv: bufToB64(iv.buffer), ct: bufToB64(ct) });
  },
  async decrypt(peerId, peerJwk, envelopeStr) {
    const env = parseEnvelope(envelopeStr);
    if (!env) throw new Error('not-envelope');
    const aes = await this.deriveAes(peerId, peerJwk);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(env.iv)) }, aes, b64ToBuf(env.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  },
  fingerprint(pubJwk) {
    const jwk = this.parsePubKey(pubJwk);
    return jwk && jwk.x ? jwk.x.slice(0, 8) : '';
  }
};
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}
// 密文信封识别：兼容本端 {v,enc,iv,ct} 与 {iv,cipher}/{iv,data} 写法；识别不了的一律当密文处理、绝不展示原文
function parseEnvelope(text) {
  if (typeof text !== 'string' || text[0] !== '{') return null;
  try {
    const o = JSON.parse(text);
    if (o && typeof o === 'object' && o.iv && (o.ct || o.cipher || o.data)) {
      return { iv: o.iv, ct: o.ct || o.cipher || o.data };
    }
  } catch (e) {}
  return null;
}
function looksEncrypted(text) {
  if (parseEnvelope(text)) return true;
  return typeof text === 'string' && /"(iv|ct|cipher)"\s*:/.test(text) && text.length > 60 && text[0] === '{';
}
function cacheUserPubKey(user) {
  if (!user || user.id == null) return;
  const jwk = E2E.parsePubKey(user.pubKey);
  if (jwk) {
    state.pubKeys[String(user.id)] = jwk;
    try {
      const m = JSON.parse(localStorage.getItem('yv_pubkeys') || '{}');
      m[String(user.id)] = jwk;
      localStorage.setItem('yv_pubkeys', JSON.stringify(m));
    } catch (e) {}
  }
}
function peerPubKey(user) {
  if (!user || user.id == null) return null;
  const direct = E2E.parsePubKey(user.pubKey);
  if (direct) { cacheUserPubKey(user); return direct; }
  if (state.pubKeys[String(user.id)]) return state.pubKeys[String(user.id)];
  try {
    const m = JSON.parse(localStorage.getItem('yv_pubkeys') || '{}');
    if (m[String(user.id)]) { state.pubKeys[String(user.id)] = m[String(user.id)]; return m[String(user.id)]; }
  } catch (e) {}
  return null;
}
// 加密发送一条私信：payload = {text?, videoId?, videoTitle?}；无对方公钥时抛错（失败关闭，绝不发明文）
async function sendEncryptedDM(peer, payload) {
  const pub = peerPubKey(peer);
  if (!pub) throw new Error('对方还没有加密公钥，对方用新版登录一次后即可收加密私信');
  if (!E2E.available()) throw new Error('当前浏览器不支持端到端加密（需要 HTTPS 环境）');
  const envelope = await E2E.encrypt(peer.id, pub, payload);
  return api('POST', '/api/dm/' + encodeURIComponent(peer.id), { text: envelope });
}
// 解一条私信：返回 {text,videoId,videoTitle,encrypted} 或 null（是密文但解不开）
async function resolveDM(peer, rawText, fallback) {
  fallback = fallback || {};
  if (rawText && looksEncrypted(rawText)) {
    const pub = peerPubKey(peer);
    if (!pub || !E2E.available()) return null;
    try {
      const p = await E2E.decrypt(peer.id, pub, rawText);
      return { text: p.text || '', videoId: p.videoId || null, videoTitle: p.videoTitle || '', encrypted: true };
    } catch (e) { return null; }
  }
  if (rawText == null && !fallback.videoId) return { text: '', encrypted: false };
  return { text: rawText || '', videoId: fallback.videoId || null, videoTitle: fallback.videoTitle || '', encrypted: false };
}
const ENC_PLACEHOLDER = '🔒 加密消息（无法解密）';
// 确保本账号公钥已上传：登录/进入 App 时若后端 user.pubKey 为空就补传
async function ensurePubKeyUploaded() {
  try {
    if (!me) return;
    const pubJwk = await E2E.ensureKeyPair(me.id);
    if (!pubJwk) return;
    if (!E2E.parsePubKey(me.pubKey)) {
      await api('POST', '/api/me/pubkey', { pubKey: pubJwk });
      me.pubKey = pubJwk;
      localStorage.setItem(USER_KEY, JSON.stringify(me));
    }
  } catch (e) { /* 补传失败不阻塞使用，下次进入再试 */ }
}

/* ---------- API ---------- */
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new Error('网络连不上，请检查网络后重试');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) {
    logout(false);
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || ('请求失败（' + res.status + '）'));
    err.status = res.status;
    throw err;
  }
  return data;
}
function setSession(tok, user) {
  token = tok; me = user;
  localStorage.setItem(TOKEN_KEY, tok);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
function logout(reloadMsg) {
  token = ''; me = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  stopChatPolling();
  pauseAllVideos();
  $('#app').classList.add('hidden');
  $('#view-auth').classList.remove('hidden');
  if (reloadMsg !== false) toast('已退出登录');
}

/* ---------- 视图切换 ---------- */
const NAV_VIEWS = ['home', 'friends', 'publish', 'messages', 'me', 'search'];
function showView(name) {
  if (name !== 'chat') stopChatPolling();
  state.view = name;
  ['home', 'friends', 'publish', 'messages', 'chat', 'me', 'user', 'search', 'claim'].forEach(v => {
    const el = $('#view-' + v);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  const cur = $('#view-' + name);
  if (cur && window.anime && name !== 'home' && name !== 'friends') {
    window.anime({ targets: cur, opacity: [0, 1], translateY: [10, 0], duration: 240, easing: 'easeOutQuad' });
  }
  $$('#tabbar .tab').forEach(t => t.classList.toggle('active', t.dataset.nav === name));
  $('#tabbar').style.display = name === 'chat' ? 'none' : '';
  if (name !== 'home' && name !== 'friends') pauseAllVideos();
  if (name === 'home') { loadHomeFeed(false); requestAnimationFrame(observeFeedSlides); }
  if (name === 'friends') { loadFriendsFeed(false); loadFriendMeta(); requestAnimationFrame(observeFeedSlides); }
  if (name === 'messages') loadThreads();
  if (name === 'me') loadMePage();
  window.scrollTo(0, 0);
}
function pauseAllVideos() {
  $$('video.feed-video').forEach(v => { try { v.pause(); } catch (e) {} });
}

/* ---------- 登录 / 注册 ---------- */
function initAuth() {
  $$('#auth-seg .seg-btn').forEach(btn => btn.addEventListener('click', () => {
    $$('#auth-seg .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    const isLogin = btn.dataset.mode === 'login';
    $('#form-login').classList.toggle('hidden', !isLogin);
    $('#form-register').classList.toggle('hidden', isLogin);
  }));
  $('#form-login').addEventListener('submit', async e => {
    e.preventDefault();
    const accountOrName = $('#login-account').value.trim();
    const password = $('#login-password').value;
    const err = $('#login-err');
    err.textContent = '';
    if (!accountOrName || !password) { err.textContent = '账号和密码都要填'; return; }
    const btn = $('#btn-login'); btn.disabled = true; btn.textContent = '登录中…';
    try {
      const d = await api('POST', '/api/login', { accountOrName, password });
      setSession(d.token, d.user);
      await ensurePubKeyUploaded();
      enterApp();
      toast('欢迎回来，' + d.user.name);
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; btn.textContent = '登录'; }
  });
  // —— 注册：只能用邮箱，三步：发验证码 -> 填验证码 -> 姓名+密码完成注册 ——
  let codeCountdown = null;
  $('#btn-get-code').addEventListener('click', async () => {
    const email = $('#reg-email').value.trim();
    const err = $('#reg-err');
    err.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = '先填一个正确的邮箱'; return; }
    const btn = $('#btn-get-code');
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      await api('POST', '/api/register/request-code', { email });
      $('#code-sent-hint').textContent = '验证码已发送到你的邮箱（发件人 hello@yousj.cc），请查收后填入第 ② 步。';
      toast('验证码已发送到你的邮箱');
      let left = 60;
      btn.textContent = left + ' 秒后重发';
      clearInterval(codeCountdown);
      codeCountdown = setInterval(() => {
        left -= 1;
        if (left <= 0) { clearInterval(codeCountdown); btn.disabled = false; btn.textContent = '获取验证码'; }
        else btn.textContent = left + ' 秒后重发';
      }, 1000);
      $('#reg-code').focus();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false; btn.textContent = '获取验证码';
    }
  });
  $('#form-register').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#reg-email').value.trim();
    const code = $('#reg-code').value.trim();
    const name = $('#reg-name').value.trim();
    const password = $('#reg-password').value;
    const err = $('#reg-err');
    err.textContent = '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = '邮箱格式不对'; return; }
    if (!/^\d{6}$/.test(code)) { err.textContent = '请输入邮箱收到的 6 位验证码（没收到先点「获取验证码」）'; return; }
    if (!name) { err.textContent = '填一下姓名（昵称）'; return; }
    if (!password || password.length < 6) { err.textContent = '密码至少 6 位'; return; }
    const btn = $('#btn-register'); btn.disabled = true; btn.textContent = '注册中…';
    try {
      // verify 成功前先在本机生成 E2E 密钥对，公钥随 verify 一并提交、私钥只留本机
      let pubKey = null;
      try { pubKey = await E2E.ensureKeyPair('anon'); } catch (e2) { pubKey = null; }
      const d = await api('POST', '/api/register/verify', { email, code, name, password, pubKey });
      clearInterval(codeCountdown);
      setSession(d.token, d.user);
      E2E.bindToUser(d.user && d.user.id);
      await ensurePubKeyUploaded();
      enterApp();
      toast('注册成功！你的账号是 #' + d.user.account + '，朋友靠它找到你');
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; btn.textContent = '完成注册'; }
  });
}
async function enterApp() {
  $('#view-auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  try {
    const d = await api('GET', '/api/me');
    if (d && d.user) { me = d.user; localStorage.setItem(USER_KEY, JSON.stringify(me)); }
    else if (d && d.id) { me = d; }
  } catch (e) { /* /api/me 失败不阻塞进首页，用本地缓存的用户信息 */ }
  await ensurePubKeyUploaded();
  state.homeLoaded = false; state.friendsLoaded = false;
  showView('home');
  refreshBadges();
  maybeOpenClaim(); // 有待认领的智能体（?claim= 带入）时，进 App 后直接去确认
}

/* ---------- 信息流 ---------- */
function registerVideos(videos) {
  (videos || []).forEach(v => { state.videoById[v.id] = v; });
}
function slideHTML(v) {
  const a = v.author || {};
  const media = v.kind === 'scene' || !v.videoUrl
    ? '<div class="scene-bg" style="' + hueBg(v.posterHue) + '"><div class="scene-title">' + esc(v.title || '无标题') + '</div></div><span class="scene-kind">图文</span>'
    : '<video class="slide-media feed-video" src="' + esc(v.videoUrl) + '" loop playsinline preload="metadata"></video><div class="play-hint hidden">▶</div>';
  return '' +
    '<div class="slide-media-wrap" data-act="tap" style="position:absolute;inset:0">' + media + '</div>' +
    '<div class="rail">' +
      '<div class="rail-avatar" data-act="author" role="button" aria-label="看作者主页">' + avatarHTML(a) + '</div>' +
      '<button class="rail-btn like-btn' + (v.liked ? ' liked' : '') + '" data-act="like"><span class="rail-ico">' + ICONS.heart + '</span><span class="like-count">' + fmtCount(v.likeCount) + '</span></button>' +
      '<button class="rail-btn" data-act="comment"><span class="rail-ico">' + ICONS.comment + '</span><span class="comment-count">' + fmtCount(v.commentCount) + '</span></button>' +
      '<button class="rail-btn fav-btn' + (v.faved ? ' faved' : '') + '" data-act="fav"><span class="rail-ico">' + ICONS.star + '</span><span class="fav-count">' + fmtCount(v.favCount) + '</span></button>' +
      '<button class="rail-btn" data-act="share"><span class="rail-ico">' + ICONS.share + '</span><span class="share-count">' + fmtCount(v.shareCount) + '</span></button>' +
    '</div>' +
    '<div class="slide-bottom">' +
      '<div class="slide-author" data-act="author">@' + esc(a.name || '') + ' <span style="color:rgba(255,255,255,.6);font-weight:400;font-size:13px">#' + esc(a.account || '') + '</span>' + (v.isFriend ? '<span class="friend-tag">好友</span>' : '') + agentBadgeHTML(a) + '</div>' +
      '<div class="slide-title">' + esc(v.title || '') + '</div>' +
      (v.desc ? '<div class="slide-desc">' + esc(v.desc) + '</div>' : '') +
      '<div class="slide-time">' + relTime(v.createdAt) + ((v.width && v.height) ? ' · ' + resLabel(v.width, v.height) + ' ' + v.width + '×' + v.height : '') + (v.durationSec ? ' · ' + fmtDuration(v.durationSec) : '') + '</div>' +
    '</div>';
}
function renderFeed(container, videos) {
  container.innerHTML = '';
  (videos || []).forEach(v => {
    const s = document.createElement('article');
    s.className = 'slide';
    s.dataset.vid = v.id;
    s.innerHTML = slideHTML(v);
    container.appendChild(s);
  });
  bindSlideEvents(container);
  observeFeedSlides();
}
let feedObserver = null;
function observeFeedSlides() {
  if (feedObserver) feedObserver.disconnect();
  feedObserver = new IntersectionObserver(entries => {
    entries.forEach(en => {
      const vid = en.target.querySelector('video.feed-video');
      if (!vid) return;
      if (en.intersectionRatio >= 0.6) {
        vid.play().catch(() => { vid.muted = true; vid.play().catch(() => {}); });
      } else {
        vid.pause();
      }
    });
  }, { threshold: [0, 0.6, 1] });
  $$('.slide').forEach(s => feedObserver.observe(s));
}
function bindSlideEvents(container) {
  $$('.slide', container).forEach(slide => {
    if (slide.dataset.bound) return;
    slide.dataset.bound = '1';
    const vid = slide.dataset.vid;
    slide.addEventListener('click', e => {
      const actBtn = e.target.closest('[data-act]');
      const act = actBtn ? actBtn.dataset.act : null;
      if (act === 'like') { toggleLike(vid, actBtn); return; }
      if (act === 'fav') { toggleFav(vid, actBtn); return; }
      if (act === 'comment') { openComments(vid); return; }
      if (act === 'share') { openShare(vid); return; }
      if (act === 'author') { const vv = state.videoById[vid]; if (vv && vv.author) openProfile(vv.author.id, vv.author); return; }
      if (act === 'tap' || e.target.closest('.slide-media-wrap')) handleTap(slide, vid);
    });
  });
}
let tapState = { t: 0, timer: null };
function handleTap(slide, vid) {
  const now = Date.now();
  const video = slide.querySelector('video.feed-video');
  if (now - tapState.t < 280) {
    clearTimeout(tapState.timer);
    tapState.t = 0;
    showBigHeart(slide);
    const v = state.videoById[vid];
    if (v && !v.liked) toggleLike(vid, slide.querySelector('.like-btn'));
    return;
  }
  tapState.t = now;
  tapState.timer = setTimeout(() => {
    if (!video) return;
    const hint = slide.querySelector('.play-hint');
    if (video.paused) { video.play().catch(() => {}); if (hint) hint.classList.add('hidden'); }
    else { video.pause(); if (hint) hint.classList.remove('hidden'); }
  }, 280);
}
function showBigHeart(slide) {
  const old = slide.querySelector('.big-heart');
  if (old) old.remove();
  const h = document.createElement('div');
  h.className = 'big-heart'; h.innerHTML = ICONS.heart;
  slide.appendChild(h);
  if (window.anime) {
    window.anime({
      targets: h,
      scale: [{ value: 0.3, duration: 0 }, { value: 1.18, duration: 200, easing: 'easeOutBack' }, { value: 1, duration: 120 }],
      opacity: [{ value: 1, duration: 260 }, { value: 0, duration: 320, delay: 260 }],
      translateY: [{ value: 0, duration: 0 }, { value: -26, duration: 580, easing: 'easeOutQuad' }],
      complete: () => h.remove()
    });
    setTimeout(() => h.remove(), 900); /* 动画没跑完的兜底 */
  } else {
    h.animate([
      { opacity: 0, transform: 'scale(.4)' },
      { opacity: 1, transform: 'scale(1.12)', offset: .3 },
      { opacity: 1, transform: 'translateY(-8px) scale(1)', offset: .65 },
      { opacity: 0, transform: 'translateY(-20px) scale(1.02)' }
    ], { duration: 700, easing: 'ease-out' });
    setTimeout(() => h.remove(), 720);
  }
}
function syncVideoUI(id) {
  const v = state.videoById[id];
  if (!v) return;
  $$('.slide[data-vid="' + CSS.escape(String(id)) + '"]').forEach(s => {
    const likeBtn = s.querySelector('.like-btn');
    if (likeBtn) { likeBtn.classList.toggle('liked', !!v.liked); s.querySelector('.like-count').textContent = fmtCount(v.likeCount); }
    const favBtn = s.querySelector('.fav-btn');
    if (favBtn) { favBtn.classList.toggle('faved', !!v.faved); s.querySelector('.fav-count').textContent = fmtCount(v.favCount); }
    const cc = s.querySelector('.comment-count'); if (cc) cc.textContent = fmtCount(v.commentCount);
    const sc = s.querySelector('.share-count'); if (sc) sc.textContent = fmtCount(v.shareCount);
  });
}
async function toggleLike(id, btn) {
  const v = state.videoById[id]; if (!v) return;
  const was = v.liked;
  v.liked = !was; v.likeCount = Math.max(0, (v.likeCount || 0) + (was ? -1 : 1));
  syncVideoUI(id);
  if (btn) pulseEl(btn.querySelector('.rail-ico'));
  try {
    const d = await api('POST', '/api/videos/' + encodeURIComponent(id) + '/like');
    if (typeof d.likeCount === 'number') v.likeCount = d.likeCount;
    if (typeof d.liked === 'boolean') v.liked = d.liked;
    if (typeof d.count === 'number') v.likeCount = d.count;
    syncVideoUI(id);
  } catch (e) {
    v.liked = was; v.likeCount = Math.max(0, (v.likeCount || 0) + (was ? 1 : -1));
    syncVideoUI(id); toast(e.message);
  }
}
async function toggleFav(id, btn) {
  const v = state.videoById[id]; if (!v) return;
  const was = v.faved;
  v.faved = !was; v.favCount = Math.max(0, (v.favCount || 0) + (was ? -1 : 1));
  syncVideoUI(id);
  if (btn) pulseEl(btn.querySelector('.rail-ico'));
  try {
    const d = await api('POST', '/api/videos/' + encodeURIComponent(id) + '/fav');
    if (typeof d.favCount === 'number') v.favCount = d.favCount;
    if (typeof d.faved === 'boolean') v.faved = d.faved;
    if (typeof d.count === 'number') v.favCount = d.count;
    syncVideoUI(id);
    toast(v.faved ? '已收藏，去「我 - 收藏」里看' : '已取消收藏');
  } catch (e) {
    v.faved = was; v.favCount = Math.max(0, (v.favCount || 0) + (was ? 1 : -1));
    syncVideoUI(id); toast(e.message);
  }
}
async function loadFeedInto(container, stateEl, scope, opts) {
  opts = opts || {};
  if (!opts.force && container.dataset.loaded === '1') { observeFeedSlides(); focusIfNeeded(container); return; }
  stateEl.innerHTML = '<span>加载中…</span>';
  try {
    const d = await api('GET', '/api/feed?scope=' + scope);
    const videos = d.videos || [];
    registerVideos(videos);
    if (!videos.length) {
      container.innerHTML = '';
      if (scope === 'friends') {
        stateEl.innerHTML = '<div><p>朋友还没有发作品，或者你还没加好友。</p><button class="empty-cta" id="empty-add-friend">去加好友</button></div>';
        const b = $('#empty-add-friend');
        if (b) b.addEventListener('click', () => switchFriendsTab('manage'));
      } else {
        stateEl.innerHTML = '<div><p>还没有作品，点中间的 ＋ 发第一条吧。</p></div>';
      }
      return;
    }
    stateEl.innerHTML = '';
    renderFeed(container, videos);
    container.dataset.loaded = '1';
    focusIfNeeded(container);
  } catch (e) {
    stateEl.innerHTML = '<div><p>' + esc(e.message) + '</p><button class="empty-cta" onclick="location.reload()">重试</button></div>';
  }
}
function focusIfNeeded(container) {
  if (!state.focusVideoId) return;
  const target = container.querySelector('.slide[data-vid="' + CSS.escape(String(state.focusVideoId)) + '"]');
  if (target) { target.scrollIntoView({ block: 'start' }); state.focusVideoId = null; }
}
function loadHomeFeed(force) { loadFeedInto($('#feed-home'), $('#feed-home-state'), 'recommended', { force }); }
function loadFriendsFeed(force) { loadFeedInto($('#feed-friends'), $('#feed-friends-state'), 'friends', { force }); }
function openWork(id) {
  state.focusVideoId = id;
  showView('home');
  const container = $('#feed-home');
  const exists = container.querySelector('.slide[data-vid="' + CSS.escape(String(id)) + '"]');
  if (exists) focusIfNeeded(container);
  else loadHomeFeed(true);
}

/* ---------- 评论 ---------- */
function openSheet(id) {
  $('#sheet-mask').classList.remove('hidden');
  const sheet = $('#' + id);
  sheet.classList.remove('hidden');
  if (window.anime) window.anime({ targets: sheet, translateY: [44, 0], opacity: [0.5, 1], duration: 240, easing: 'easeOutCubic' });
  else if (sheet.animate) sheet.animate([{ transform: 'translateY(30px)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: 'ease-out' });
}
function closeSheets() {
  $('#sheet-mask').classList.add('hidden');
  $('#comment-sheet').classList.add('hidden');
  $('#share-sheet').classList.add('hidden');
  state.commentVideoId = null; state.shareVideoId = null;
}
function initSheets() {
  $('#sheet-mask').addEventListener('click', closeSheets);
  $$('[data-close-sheet]').forEach(b => b.addEventListener('click', closeSheets));
  $('#comment-list').addEventListener('click', e => {
    const t = e.target.closest('[data-author]');
    if (t && t.dataset.author) { const uid = t.dataset.author; closeSheets(); openProfile(uid); }
  });
  $('#comment-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id = state.commentVideoId; if (!id) return;
    const input = $('#comment-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const d = await api('POST', '/api/videos/' + encodeURIComponent(id) + '/comments', { text });
      appendComment(d.comment || d);
      const v = state.videoById[id];
      if (v) { v.commentCount = (v.commentCount || 0) + 1; if (typeof d.commentCount === 'number') v.commentCount = d.commentCount; syncVideoUI(id); }
      $('#comment-list').scrollTop = $('#comment-list').scrollHeight;
    } catch (ex) { toast(ex.message); input.value = text; }
  });
}
function commentRowHTML(c) {
  const u = c.author || c.user || {};
  return '<div class="comment-row"><span class="c-avatar" data-author="' + esc(u.id || '') + '" role="button" aria-label="看作者主页">' + avatarHTML(u, 'avatar-sm') + '</span>' +
    '<div class="comment-body"><div class="c-name">' + esc(u.name || '用户') + agentBadgeHTML(u) + ' · #' + esc(u.account || '') + '</div>' +
    '<div class="c-text">' + esc(c.text || '') + '</div><div class="c-time">' + relTime(c.createdAt) + '</div></div></div>';
}
function appendComment(c) {
  if (!c || !c.text) return;
  const empty = $('#comment-list .empty-text');
  if (empty) empty.remove();
  $('#comment-list').insertAdjacentHTML('beforeend', commentRowHTML(c));
}
async function openComments(id) {
  state.commentVideoId = id;
  const v = state.videoById[id];
  $('#comment-title').textContent = '评论' + (v ? '（' + fmtCount(v.commentCount) + '）' : '');
  $('#comment-my-avatar').outerHTML = avatarHTML(me, 'avatar-sm').replace('class="avatar avatar-sm"', 'class="avatar avatar-sm" id="comment-my-avatar"');
  $('#comment-list').innerHTML = '<p class="loading-text">加载评论…</p>';
  openSheet('comment-sheet');
  try {
    const d = await api('GET', '/api/videos/' + encodeURIComponent(id) + '/comments');
    const list = d.comments || d || [];
    $('#comment-list').innerHTML = list.length ? list.map(commentRowHTML).join('') : '<p class="empty-text">还没有评论，来抢沙发</p>';
  } catch (e) {
    $('#comment-list').innerHTML = '<p class="empty-text">' + esc(e.message) + '</p>';
  }
  setTimeout(() => $('#comment-input').focus(), 250);
}

/* ---------- 转发 ---------- */
async function openShare(id) {
  state.shareVideoId = id;
  const box = $('#share-friend-list');
  box.innerHTML = '<p class="loading-text">加载好友…</p>';
  openSheet('share-sheet');
  try {
    if (!state.friends.length) await fetchFriends();
    if (!state.friends.length) {
      box.innerHTML = '<p class="empty-text">还没有好友。先去「朋友 - 好友管理」加一位好友，再来转发。</p>';
      return;
    }
    state.friends.forEach(cacheUserPubKey);
    box.innerHTML = state.friends.map(u =>
      '<div class="user-row">' + avatarHTML(u) + '<div class="user-meta"><strong>' + esc(u.name) + '</strong>' + agentBadgeHTML(u) + '<span>#' + esc(u.account) + (peerPubKey(u) ? ' · 🔒 可加密' : ' · 未启用加密') + '</span></div>' +
      '<button class="btn-mini primary" data-share-to="' + esc(u.id) + '">发送</button></div>').join('');
    $$('[data-share-to]', box).forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '加密发送中…';
      const videoId = state.shareVideoId;
      const target = state.friends.find(f => String(f.id) === String(b.dataset.shareTo));
      try {
        const v = state.videoById[videoId];
        // 转发走加密私信通道：videoId/videoTitle 只放在 AES-GCM 加密载荷里，服务器只见密文
        await sendEncryptedDM(target, { text: '分享了一条作品', videoId: videoId, videoTitle: v ? v.title : '' });
        // 计数接口单独调（只带 toUserId，不带任何私信内容）
        try {
          const d = await api('POST', '/api/videos/' + encodeURIComponent(videoId) + '/share', { toUserId: b.dataset.shareTo });
          if (v && typeof d.shareCount === 'number') v.shareCount = d.shareCount;
          else if (v) v.shareCount = (v.shareCount || 0) + 1;
        } catch (e2) { if (v) v.shareCount = (v.shareCount || 0) + 1; }
        if (v) syncVideoUI(videoId);
        closeSheets();
        toast('已通过加密私信转发给 ' + ((target && target.name) || '好友'));
      } catch (ex) { toast(ex.message); b.disabled = false; b.textContent = '发送'; }
    }));
  } catch (e) {
    box.innerHTML = '<p class="empty-text">' + esc(e.message) + '</p>';
  }
}

/* ---------- 好友 ---------- */
async function fetchFriends() {
  const d = await api('GET', '/api/friends');
  state.friends = d.friends || d || [];
  state.friends.forEach(cacheUserPubKey);
  return state.friends;
}
async function fetchRequests() {
  const d = await api('GET', '/api/friends/requests');
  state.requests = d.requests || d || [];
  return state.requests;
}
function updateReqBadge() {
  const n = state.requests.length;
  [$('#req-badge'), $('#tab-friend-badge')].forEach(el => {
    if (!el) return;
    el.textContent = n;
    el.classList.toggle('hidden', n === 0);
  });
  const c = $('#req-count'); if (c) c.textContent = n ? '（' + n + '）' : '';
}
async function loadFriendMeta() {
  try { await fetchFriends(); renderFriendList(); } catch (e) { /* 列表区会单独报错 */ }
  try { await fetchRequests(); renderRequestList(); } catch (e) {}
  updateReqBadge();
}
function renderFriendList() {
  const box = $('#friend-list');
  $('#friend-count').textContent = state.friends.length ? '（' + state.friends.length + '）' : '';
  if (!state.friends.length) { box.innerHTML = '<p class="empty-text">还没有好友，去上面搜一搜</p>'; return; }
  box.innerHTML = state.friends.map(u =>
    '<div class="user-row">' + avatarHTML(u) + '<div class="user-meta"><strong>' + esc(u.name) + '</strong>' + agentBadgeHTML(u) + '<span>#' + esc(u.account) + '</span></div>' +
    '<button class="btn-mini primary" data-dm="' + esc(u.id) + '">私信</button></div>').join('');
  $$('[data-dm]', box).forEach(b => b.addEventListener('click', () => {
    const u = state.friends.find(f => String(f.id) === String(b.dataset.dm));
    if (u) openChat(u);
  }));
}
function renderRequestList() {
  const box = $('#request-list');
  if (!state.requests.length) { box.innerHTML = '<p class="empty-text">暂无新申请</p>'; updateReqBadge(); return; }
  box.innerHTML = state.requests.map(r => {
    const u = r.from || r.user || r;
    return '<div class="user-row">' + avatarHTML(u) + '<div class="user-meta"><strong>' + esc(u.name) + '</strong>' + agentBadgeHTML(u) + '<span>#' + esc(u.account) + ' 想加你为好友</span></div>' +
      '<button class="btn-mini primary" data-accept="' + esc(u.id) + '">同意</button></div>';
  }).join('');
  $$('[data-accept]', box).forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api('POST', '/api/friends/accept', { userId: b.dataset.accept });
      toast('已成为好友');
      await loadFriendMeta();
      state.friendsLoaded = false;
      $('#feed-friends').dataset.loaded = '';
      loadFriendsFeed(true);
    } catch (ex) { toast(ex.message); b.disabled = false; }
  }));
  updateReqBadge();
}
function switchFriendsTab(tab) {
  state.friendsTab = tab;
  $$('#friends-seg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#friends-works-pane').classList.toggle('hidden', tab !== 'works');
  $('#friends-manage-pane').classList.toggle('hidden', tab !== 'manage');
  if (tab === 'works') { loadFriendsFeed(false); requestAnimationFrame(observeFeedSlides); }
  else pauseAllVideos();
}
function initFriends() {
  $$('#friends-seg .seg-btn').forEach(b => b.addEventListener('click', () => switchFriendsTab(b.dataset.tab)));
  $('#btn-search').addEventListener('click', doSearch);
  $('#search-q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
}
async function doSearch() {
  const q = $('#search-q').value.trim();
  const box = $('#search-results');
  if (!q) { box.innerHTML = '<p class="empty-text">输入账号 #号 或昵称再搜</p>'; return; }
  box.innerHTML = '<p class="loading-text">搜索中…</p>';
  try {
    const d = await api('GET', '/api/users/search?q=' + encodeURIComponent(q));
    const users = (d.users || d || []).filter(u => !me || String(u.id) !== String(me.id));
    users.forEach(cacheUserPubKey);
    if (!users.length) { box.innerHTML = '<p class="empty-text">没找到这个用户，确认下账号 #号或昵称</p>'; return; }
    const friendIds = new Set(state.friends.map(f => String(f.id)));
    box.innerHTML = users.map(u =>
      '<div class="user-row">' + avatarHTML(u) + '<div class="user-meta"><strong>' + esc(u.name) + '</strong>' + agentBadgeHTML(u) + '<span>#' + esc(u.account) + '</span></div>' +
      (friendIds.has(String(u.id))
        ? '<button class="btn-mini" data-dm2="' + esc(u.id) + '">私信</button>'
        : '<button class="btn-mini primary" data-req="' + esc(u.id) + '">加好友</button>') + '</div>').join('');
    $$('[data-req]', box).forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = '发送中…';
      try {
        await api('POST', '/api/friends/request', { userId: b.dataset.req });
        b.textContent = '已发送'; toast('好友申请已发送，等对方同意');
      } catch (ex) { toast(ex.message); b.disabled = false; b.textContent = '加好友'; }
    }));
    $$('[data-dm2]', box).forEach(b => b.addEventListener('click', () => {
      const u = users.find(x => String(x.id) === String(b.dataset.dm2));
      if (u) openChat(u);
    }));
  } catch (e) {
    box.innerHTML = '<p class="empty-text">' + esc(e.message) + '</p>';
  }
}

/* ---------- 私信 ---------- */
async function loadThreads() {
  const box = $('#thread-list');
  box.innerHTML = '<p class="loading-text">加载会话…</p>';
  try {
    const d = await api('GET', '/api/dm/threads');
    const threads = d.threads || d || [];
    updateMsgBadge(threads);
    if (!threads.length) {
      box.innerHTML = '<p class="empty-text" style="padding:24px 4px">还没有私信。去「朋友」里找个好友，点「私信」聊起来；转发作品也会在这里出现。</p>';
      return;
    }
    // 最后一条多为密文：本地逐条解密做预览，解不开只显示占位、绝不露密文
    const previews = await Promise.all(threads.map(async t => {
      const u = t.user || t.peer || {};
      cacheUserPubKey(u);
      const last = t.lastMessage || {};
      const r = await resolveDM(u, last.text, { videoId: last.videoId, videoTitle: last.videoTitle });
      if (!r) return ENC_PLACEHOLDER;
      if (r.videoId) return '🔒 [作品] ' + (r.videoTitle || r.text || '分享了一条作品');
      return (r.encrypted ? '🔒 ' : '') + (r.text || '');
    }));
    box.innerHTML = threads.map((t, i) => {
      const u = t.user || t.peer || {};
      const last = t.lastMessage || {};
      return '<button class="thread-row" data-thread="' + esc(u.id) + '">' + avatarHTML(u) +
        '<span class="thread-meta"><span class="thread-top"><strong>' + esc(u.name || '用户') + '</strong><span class="thread-time">' + relTime(last.createdAt || t.updatedAt) + '</span></span>' +
        '<span class="thread-last">' + esc(previews[i]) + '</span></span>' +
        (t.unread ? '<span class="unread-dot">' + fmtCount(t.unread) + '</span>' : '') + '</button>';
    }).join('');
    $$('[data-thread]', box).forEach(b => b.addEventListener('click', () => {
      const t = threads.find(x => String((x.user || x.peer || {}).id) === String(b.dataset.thread));
      if (t) openChat(t.user || t.peer);
    }));
  } catch (e) {
    box.innerHTML = '<p class="empty-text">' + esc(e.message) + '</p>';
  }
}
function updateMsgBadge(threads) {
  const total = (threads || []).reduce((s, t) => s + (Number(t.unread) || 0), 0);
  const el = $('#tab-msg-badge');
  el.textContent = total;
  el.classList.toggle('hidden', total === 0);
}
async function refreshBadges() {
  try { const d = await api('GET', '/api/dm/threads'); updateMsgBadge(d.threads || d || []); } catch (e) {}
  try { await fetchRequests(); updateReqBadge(); } catch (e) {}
}
function msgHTML(m) {
  const mine = me && String(m.fromId || (m.from && m.from.id) || m.senderId || '') === String(me.id) || m.mine === true;
  const p = m._plain; // 已解密载荷 {text,videoId,videoTitle,encrypted}；null = 密文解不开
  if (!p) {
    return '<div class="msg-row ' + (mine ? 'mine' : '') + '"><div class="bubble enc-placeholder">' + ENC_PLACEHOLDER + '</div></div>';
  }
  if (p.videoId) {
    const v = state.videoById[p.videoId];
    const title = (v && v.title) || p.videoTitle || '分享的作品';
    const hue = v ? v.posterHue : 348;
    const thumb = v && v.videoUrl && v.kind !== 'scene'
      ? '<video src="' + esc(v.videoUrl) + '" muted playsinline preload="metadata"></video>'
      : '<span>▶</span>';
    const inner = '<button class="video-card" data-open-work="' + esc(p.videoId) + '"><span class="video-card-media" style="' + (v && v.videoUrl && v.kind !== 'scene' ? '' : hueBg(hue)) + '">' + thumb + '</span>' +
      '<span class="video-card-body"><strong>' + esc(title) + '</strong><span>点开看这条作品</span>' + (p.encrypted ? '<span class="lock-line">🔒 加密转发</span>' : '') + '</span></button>' +
      (p.text && p.text !== '分享了一条作品' ? '<div class="bubble" style="margin-top:6px">' + esc(p.text) + '</div>' : '');
    return '<div class="msg-row ' + (mine ? 'mine' : '') + '"><div>' + inner + '</div></div>';
  }
  return '<div class="msg-row ' + (mine ? 'mine' : '') + '"><div><div class="bubble">' + esc(p.text || '') + '</div>' + (p.encrypted ? '<div class="msg-lock-ico">🔒 端到端加密</div>' : '') + '</div></div>';
}
async function loadChatMsgs(scroll) {
  if (!state.chatPeer) return;
  try {
    const d = await api('GET', '/api/dm/' + encodeURIComponent(state.chatPeer.id));
    const msgs = d.messages || d || [];
    // 顺带把消息里提到的作品信息补进缓存（后端若内嵌 video 对象）
    msgs.forEach(m => { if (m.video) state.videoById[m.video.id] = m.video; });
    cacheUserPubKey(state.chatPeer);
    // 逐条本地解密（与对方公钥 ECDH 派生），解不开的标 null 走占位渲染
    await Promise.all(msgs.map(async m => {
      m._plain = await resolveDM(state.chatPeer, m.text, { videoId: m.videoId, videoTitle: m.videoTitle });
    }));
    if (state.view !== 'chat') return;
    const box = $('#chat-list');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.innerHTML = msgs.length ? msgs.map(msgHTML).join('') : '<p class="empty-text" style="text-align:center">还没有消息，打个招呼吧</p>';
    $$('[data-open-work]', box).forEach(b => b.addEventListener('click', () => openWork(b.dataset.openWork)));
    if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
  } catch (e) { toast(e.message); }
}
function openChat(user) {
  cacheUserPubKey(user);
  if (!user.pubKey && state.pubKeys[String(user.id)]) user = Object.assign({}, user, { pubKey: state.pubKeys[String(user.id)] });
  state.chatPeer = user;
  closeSheets();
  $('#chat-avatar').outerHTML = avatarHTML(user).replace('class="avatar"', 'class="avatar" id="chat-avatar"');
  $('#chat-name').textContent = user.name || '朋友';
  $('#chat-account').textContent = user.account ? '#' + user.account : '';
  const pub = peerPubKey(user);
  const fp = pub ? E2E.fingerprint(pub) : '';
  $('#chat-lock').textContent = pub ? '🔒 端到端加密 · 对方公钥指纹 ' + fp : '🔒 端到端加密 · 对方尚无公钥，暂不能发送';
  showView('chat');
  $('#chat-list').innerHTML = '<p class="loading-text">加载中…</p>';
  loadChatMsgs(true);
  stopChatPolling();
  state.chatTimer = setInterval(() => { if (state.view === 'chat') loadChatMsgs(false); }, 4000);
}
function stopChatPolling() {
  if (state.chatTimer) { clearInterval(state.chatTimer); state.chatTimer = null; }
}
function initChat() {
  $('#btn-chat-back').addEventListener('click', () => showView('messages'));
  $('#chat-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!state.chatPeer) return;
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      // 明文只在本机：加密成密文信封后才作为 text 发出，服务器解不开
      await sendEncryptedDM(state.chatPeer, { text });
      loadChatMsgs(true);
    } catch (ex) { toast(ex.message); input.value = text; }
  });
}

/* ---------- 发布 ---------- */
const HUES = [348, 16, 36, 48, 140, 172, 205, 222, 262, 300];
const CHUNK_SIZE = 8 * 1024 * 1024;              // 分片：每片 8MB 原始字节
const MAX_ORIGINAL_DURATION = 3600;              // 1 小时
const MAX_ORIGINAL_SIZE = 5 * 1024 * 1024 * 1024; // 5GB
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function blobToBase64(blob) { return fileToBase64(blob); }
function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes >= 1073741824) return (Math.round(bytes / 107374182.4) / 10) + ' GB';
  if (bytes >= 1048576) return (Math.round(bytes / 104857.6) / 10) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}
function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function resLabel(w, h) {
  const longSide = Math.max(Number(w) || 0, Number(h) || 0);
  const shortSide = Math.min(Number(w) || 0, Number(h) || 0);
  if (shortSide >= 2000 || longSide >= 3800) return '4K';
  if (shortSide >= 1400) return '2K';
  if (shortSide >= 1000) return '1080p';
  if (shortSide >= 700) return '720p';
  return 'SD';
}
// 双阈值判定（选完文件即算，不用等上传）：时长>1h 或 文件>5GB，任一满足就压缩
function compressVerdict(meta, file) {
  const reasons = [];
  if (meta && meta.durationSec > MAX_ORIGINAL_DURATION) reasons.push('duration');
  if (file && file.size > MAX_ORIGINAL_SIZE) reasons.push('size');
  return reasons; // [] = 不压缩
}
function compressReasonText(reason) {
  if (reason === 'duration') return '时长超过 1 小时';
  if (reason === 'size') return '文件超过 5GB';
  if (reason === 'both') return '时长超过 1 小时且文件超过 5GB';
  return '';
}
// 用离屏 <video> 读元数据：时长 + 分辨率（不解码全片，读完即释放）
function probeVideoMeta(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const done = meta => { URL.revokeObjectURL(url); resolve(meta); };
    const timer = setTimeout(() => done({ width: 0, height: 0, durationSec: 0 }), 10000);
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      done({ width: v.videoWidth || 0, height: v.videoHeight || 0, durationSec: Math.round(v.duration || 0) });
    };
    v.onerror = () => { clearTimeout(timer); done({ width: 0, height: 0, durationSec: 0 }); };
    v.src = url;
  });
}
function renderFileMeta() {
  const metaEl = $('#file-meta'), noteEl = $('#quality-note');
  const f = state.publishFile, meta = state.publishMeta;
  if (!f) { metaEl.classList.add('hidden'); noteEl.classList.add('hidden'); return; }
  const label = meta && meta.width ? resLabel(meta.width, meta.height) : '';
  metaEl.innerHTML = (label ? '<span class="res-badge">' + (label === '4K' ? '4K 原画上传' : label) + '</span>' : '') +
    '<span class="meta-dim">大小</span> ' + fmtSize(f.size) +
    (meta && meta.width ? ' · <span class="meta-dim">分辨率</span> ' + meta.width + '×' + meta.height : '') +
    (meta && meta.durationSec ? ' · <span class="meta-dim">时长</span> ' + fmtDuration(meta.durationSec) : ' · <span class="meta-dim">时长读取中…</span>');
  metaEl.classList.remove('hidden');
  const reasons = compressVerdict(meta, f);
  if (reasons.length) {
    const both = reasons.length === 2;
    noteEl.className = 'quality-note warn';
    noteEl.textContent = '⚠ ' + (both ? '时长超过 1 小时且文件超过 5GB' : reasons[0] === 'duration' ? '时长超过 1 小时' : '文件超过 5GB') + '：将压缩为 1080p 后发布。';
  } else {
    noteEl.className = 'quality-note ok';
    noteEl.textContent = '✓ ' + (label === '4K' ? '4K ' : '') + '原画不压缩：时长在 1 小时内、文件不超过 5GB，按原画质上传发布。';
  }
  noteEl.classList.remove('hidden');
}
// 分片上传：init -> 每片 8MB base64 -> complete，带真实进度回调；init 404 时回退旧单次上传
async function uploadFileChunked(file, onProgress) {
  let init;
  try {
    init = await api('POST', '/api/upload/init', { filename: file.name, size: file.size, mime: file.type || 'video/mp4' });
  } catch (e) {
    if (e.status === 404) {
      onProgress(0.05, '旧通道整文件上传中…');
      const dataBase64 = await fileToBase64(file);
      onProgress(0.7, '正在提交…');
      const up = await api('POST', '/api/upload', { filename: file.name, dataBase64 });
      onProgress(1, '上传完成');
      return up.url;
    }
    throw e;
  }
  const uploadId = init.uploadId || init.id || init.upload_id;
  if (!uploadId) throw new Error('服务器没有返回 uploadId，分片上传无法继续');
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  for (let i = 0; i < totalChunks; i++) {
    const slice = file.slice(i * CHUNK_SIZE, Math.min(file.size, (i + 1) * CHUNK_SIZE));
    const dataBase64 = await blobToBase64(slice);
    await api('POST', '/api/upload/chunk', { uploadId, index: i, dataBase64 });
    const doneBytes = Math.min(file.size, (i + 1) * CHUNK_SIZE);
    onProgress(doneBytes / file.size, '上传中 ' + fmtSize(doneBytes) + ' / ' + fmtSize(file.size) + ' · 第 ' + (i + 1) + '/' + totalChunks + ' 片');
  }
  const fin = await api('POST', '/api/upload/complete', { uploadId });
  const url = fin.url || fin.fileUrl;
  if (!url) throw new Error('上传完成但服务器没返回文件地址');
  onProgress(1, '上传完成');
  return url;
}
function initPublish() {
  const hueRow = $('#hue-row');
  hueRow.innerHTML = HUES.map(h => '<button type="button" class="hue-dot' + (h === state.publishHue ? ' active' : '') + '" data-hue="' + h + '" style="background:hsl(' + h + ',75%,48%)" aria-label="色调"></button>').join('');
  $$('.hue-dot', hueRow).forEach(b => b.addEventListener('click', () => {
    state.publishHue = Number(b.dataset.hue);
    $$('.hue-dot', hueRow).forEach(x => x.classList.toggle('active', x === b));
    updateScenePreview();
  }));
  updateScenePreview();
  $$('#publish-seg .seg-btn').forEach(b => b.addEventListener('click', () => {
    state.publishMode = b.dataset.mode;
    $$('#publish-seg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    $('#publish-video-box').classList.toggle('hidden', state.publishMode !== 'video');
    $('#publish-scene-box').classList.toggle('hidden', state.publishMode !== 'scene');
  }));
  $('#file-input').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    state.publishFile = f;
    state.publishMeta = null;
    $('#upload-text').textContent = f.name;
    const pv = $('#preview-video');
    pv.src = URL.createObjectURL(f);
    pv.classList.remove('hidden');
    renderFileMeta(); // 文件大小立刻可判，先出一版提示
    state.publishMeta = await probeVideoMeta(f); // 再补分辨率/时长做最终判定
    if (state.publishFile === f) renderFileMeta();
  });
  $('#pub-title').addEventListener('input', updateScenePreview);
  $('#btn-publish-cancel').addEventListener('click', () => showView('home'));
  $('#btn-publish').addEventListener('click', doPublish);
}
function updateScenePreview() {
  const p = $('#scene-preview');
  p.style.cssText = hueBg(state.publishHue);
  $('#scene-preview-text').textContent = $('#pub-title').value.trim() || '你的标题会出现在这里';
}
async function doPublish() {
  const title = $('#pub-title').value.trim();
  const desc = $('#pub-desc').value.trim();
  const err = $('#pub-err');
  err.textContent = '';
  if (!title) { err.textContent = '标题必填'; return; }
  const btn = $('#btn-publish');
  const prog = $('#pub-progress'), bar = $('#pub-progress-bar'), ptxt = $('#pub-progress-text');
  btn.disabled = true;
  try {
    let videoUrl = '';
    const payload = { title, desc, videoUrl: '', posterHue: state.publishHue };
    if (state.publishMode === 'video') {
      if (!state.publishFile) { err.textContent = '先选一个视频文件，或者切到「图文场景」直接发'; btn.disabled = false; return; }
      if (!state.publishMeta) state.publishMeta = await probeVideoMeta(state.publishFile);
      prog.classList.remove('hidden'); ptxt.classList.remove('hidden');
      bar.style.width = '0%'; ptxt.textContent = '准备上传…';
      btn.textContent = '上传中…';
      videoUrl = await uploadFileChunked(state.publishFile, (ratio, text) => {
        bar.style.width = Math.round(ratio * 100) + '%';
        ptxt.textContent = text + '（' + Math.round(ratio * 100) + '%）';
      });
      payload.videoUrl = videoUrl;
      payload.width = state.publishMeta.width || 0;
      payload.height = state.publishMeta.height || 0;
      payload.durationSec = state.publishMeta.durationSec || 0;
      payload.sizeBytes = state.publishFile.size;
    }
    btn.textContent = '发布中…';
    ptxt.textContent = '正在发布…';
    const d = await api('POST', '/api/videos', payload);
    bar.style.width = '100%';
    const newVideo = d.video || d;
    const newId = newVideo && newVideo.id;
    if (newVideo && newVideo.id) registerVideos([newVideo]);
    // 成功提示按后端 compressReason 展示：null=原画发布，其余说明压缩原因
    const reason = newVideo && newVideo.compressReason !== undefined ? newVideo.compressReason : (d.compressReason || null);
    if (reason) toast('发布成功（' + compressReasonText(reason) + '，已压缩为 1080p 发布）');
    else if (state.publishMode === 'video') toast('发布成功（原画质发布，未压缩）');
    else toast('发布成功');
    // 重置表单
    $('#pub-title').value = ''; $('#pub-desc').value = '';
    state.publishFile = null; state.publishMeta = null;
    $('#file-input').value = '';
    $('#preview-video').classList.add('hidden'); $('#preview-video').removeAttribute('src');
    $('#upload-text').textContent = '点这里选择视频文件';
    renderFileMeta();
    updateScenePreview();
    $('#feed-home').dataset.loaded = '';
    state.homeLoaded = false;
    if (newId) state.focusVideoId = newId;
    showView('home');
    loadHomeFeed(true);
  } catch (e) {
    err.textContent = e.message;
    ptxt.textContent = '';
  } finally {
    btn.disabled = false; btn.textContent = '发布';
    setTimeout(() => { prog.classList.add('hidden'); ptxt.classList.add('hidden'); bar.style.width = '0%'; }, 800);
  }
}

/* ---------- 我的 ---------- */
function initMe() {
  $$('#me-seg .seg-btn').forEach(b => b.addEventListener('click', () => {
    state.meTab = b.dataset.tab;
    $$('#me-seg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    renderMeGrid();
  }));
  $('#btn-logout').addEventListener('click', () => logout(true));
}
function workCellHTML(v, ownerId) {
  const media = v.kind === 'scene' || !v.videoUrl
    ? '<span class="cell-scene" style="' + hueBg(v.posterHue) + '">' + esc(v.title || '') + '</span>'
    : '<video src="' + esc(v.videoUrl) + '" muted playsinline preload="metadata"></video>';
  // 作品出自页面主人绑定的 AI（不是页面主人本人）时，封面左上角打 AI 角标，一眼分清谁发的
  const aiTag = v.author && v.author.isAgent && String(v.author.id) !== String(ownerId || '') ? '<span class="agent-badge cell-badge">AI</span>' : '';
  return '<button class="work-cell" data-work="' + esc(v.id) + '">' + media + aiTag + '<span class="cell-count">' + ICONS.heart + fmtCount(v.likeCount) + '</span></button>';
}
function renderMeGrid() {
  const list = state.meTab === 'works' ? state.meWorks : state.meCollections;
  const grid = $('#me-grid');
  grid.innerHTML = list.map(v => workCellHTML(v, me && me.id)).join('');
  $('#me-grid-empty').classList.toggle('hidden', list.length > 0);
  $('#me-grid-empty').textContent = state.meTab === 'works' ? '还没有作品，点中间的 ＋ 发一条' : '还没有收藏，在首页看到喜欢的点 ⭐ 收藏';
  $$('[data-work]', grid).forEach(b => b.addEventListener('click', () => openWork(b.dataset.work)));
}
async function loadMePage() {
  if (me) {
    $('#me-avatar').outerHTML = avatarHTML(me, 'avatar-lg').replace('class="avatar avatar-lg"', 'class="avatar avatar-lg" id="me-avatar"');
    $('#me-name').textContent = me.name || '—';
    $('#me-account').textContent = me.account ? '#' + me.account : '—';
    $('#comment-my-avatar');
  }
  try {
    const d = await api('GET', '/api/me');
    const u = d.user || d;
    if (u && u.id) { me = u; localStorage.setItem(USER_KEY, JSON.stringify(me)); loadMePageHeadOnly(); }
  } catch (e) {}
  try {
    const w = await api('GET', '/api/me/works');
    state.meWorks = w.videos || w.works || w || [];
    registerVideos(state.meWorks);
  } catch (e) { state.meWorks = []; }
  try {
    const c = await api('GET', '/api/me/collections');
    state.meCollections = c.videos || c.collections || c || [];
    registerVideos(state.meCollections);
  } catch (e) { state.meCollections = []; }
  try { await fetchFriends(); } catch (e) {}
  $('#stat-works').textContent = state.meWorks.length;
  $('#stat-friends').textContent = state.friends.length;
  $('#stat-likes').textContent = fmtCount(state.meWorks.reduce((s, v) => s + (Number(v.likeCount) || 0), 0));
  renderMeGrid();
}
function loadMePageHeadOnly() {
  $('#me-avatar').outerHTML = avatarHTML(me, 'avatar-lg').replace('class="avatar avatar-lg"', 'class="avatar avatar-lg" id="me-avatar"');
  $('#me-name').textContent = me.name || '—';
  $('#me-account').textContent = me.account ? '#' + me.account : '—';
}

/* ---------- 用户主页（点作者头像/名字进来） ---------- */
let profileData = null;
async function openProfile(userId, hint) {
  if (!userId) return;
  if (me && String(userId) === String(me.id)) { showView('me'); return; }
  state.profileReturn = NAV_VIEWS.includes(state.view) ? state.view : 'home';
  showView('user');
  /* 先用手边的信息垫一屏，不让用户对着空白等 */
  const hintUser = hint || null;
  if (hintUser) renderProfileHead(hintUser, null);
  $('#profile-grid').innerHTML = '<p class="loading-text">加载中…</p>';
  $('#profile-actions').innerHTML = '';
  try {
    const d = await api('GET', '/api/users/' + encodeURIComponent(userId) + '/profile');
    profileData = d;
    renderProfileHead(d.user, d);
    registerVideos(d.videos || []);
    renderProfileGrid(d.videos || []);
    renderProfileActions(d);
  } catch (e) {
    /* 老后端没有 profile 接口时兜底：从已加载的作品里拼 */
    const works = Object.values(state.videoById).filter(v => v.author && String(v.author.id) === String(userId));
    const u = (works[0] && works[0].author) || hintUser;
    if (u) {
      renderProfileHead(u, { stats: { works: works.length, likesReceived: works.reduce((s, v) => s + (v.likeCount || 0), 0), friends: 0 }, isFriend: works.some(v => v.isFriend), fallback: true });
      renderProfileGrid(works);
    } else {
      $('#profile-grid').innerHTML = '<p class="loading-text">打不开这个主页：' + esc(e.message) + '</p>';
    }
  }
}
function renderProfileHead(u, d) {
  $('#profile-avatar').outerHTML = avatarHTML(u, 'avatar-lg').replace('class="avatar avatar-lg"', 'class="avatar avatar-lg" id="profile-avatar"');
  $('#profile-name').textContent = u.name || '—';
  $('#profile-account').textContent = u.account ? '#' + u.account : '';
  const pb = $('#profile-agent-badge');
  if (pb) pb.classList.toggle('hidden', !(u && u.isAgent));
  const ow = $('#profile-owner');
  if (ow) {
    if (u && u.isAgent && u.owner) { ow.textContent = '主人：' + u.owner.name + ' #' + u.owner.account; ow.classList.remove('hidden'); }
    else ow.classList.add('hidden');
  }
  if (d && d.stats) {
    $('#pstat-works').textContent = fmtCount(d.stats.works);
    $('#pstat-friends').textContent = fmtCount(d.stats.friends);
    $('#pstat-likes').textContent = fmtCount(d.stats.likesReceived);
  }
}
function renderProfileActions(d) {
  const box = $('#profile-actions');
  if (!d || !d.user) { box.innerHTML = ''; return; }
  if (d.isFriend) {
    box.innerHTML = '<button class="btn-primary" id="btn-profile-dm">发私信</button><p class="profile-relation">你们已经是好友</p>';
    $('#btn-profile-dm').addEventListener('click', () => openChat(d.user));
  } else if (d.hasPendingRequest) {
    box.innerHTML = '<button class="btn-primary" disabled>已发送好友申请</button><p class="profile-relation">等对方通过后就能私信</p>';
  } else if (d.fallback) {
    box.innerHTML = '';
  } else {
    box.innerHTML = '<button class="btn-primary" id="btn-profile-add">＋ 添加好友</button>';
    $('#btn-profile-add').addEventListener('click', async () => {
      const btn = $('#btn-profile-add');
      btn.disabled = true; btn.textContent = '发送中…';
      try {
        await api('POST', '/api/friends/request', { userId: d.user.id });
        toast('好友申请已发送');
        profileData.hasPendingRequest = true;
        renderProfileActions(profileData);
        refreshBadges();
      } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = '＋ 添加好友'; }
    });
  }
}
function renderProfileGrid(videos) {
  const grid = $('#profile-grid');
  $('#profile-grid-empty').classList.toggle('hidden', videos.length > 0);
  grid.innerHTML = videos.map(v => workCellHTML(v, profileData && profileData.user ? profileData.user.id : null)).join('');
  $$('[data-work]', grid).forEach(b => b.addEventListener('click', () => openWork(b.dataset.work)));
}
function initProfile() {
  $('#btn-profile-back').addEventListener('click', () => showView(state.profileReturn || 'home'));
}

/* ---------- 搜索（作品 + 用户，一次拉全，本地切标签） ---------- */
const searchState = { tab: 'works', timer: null, seq: 0, q: '', data: null, loading: false };
function initSearch() {
  const topBtn = $('#btn-top-search');
  topBtn.innerHTML = ICONS.search;
  topBtn.addEventListener('click', () => {
    showView('search');
    setTimeout(() => { try { $('#search-input').focus(); } catch (e) {} }, 80);
  });
  $('#btn-search-back').addEventListener('click', () => showView('home'));
  const input = $('#search-input');
  input.addEventListener('input', () => {
    clearTimeout(searchState.timer);
    searchState.timer = setTimeout(runSearch, 300);
  });
  $('#search-form').addEventListener('submit', e => {
    e.preventDefault();
    clearTimeout(searchState.timer);
    runSearch();
  });
  $$('#search-seg .seg-btn').forEach(b => b.addEventListener('click', () => {
    searchState.tab = b.dataset.tab;
    $$('#search-seg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    renderSearchResults();
  }));
  renderSearchResults();
}
async function runSearch() {
  const q = $('#search-input').value.trim();
  searchState.q = q;
  if (!q) { searchState.data = null; searchState.loading = false; renderSearchResults(); return; }
  const seq = ++searchState.seq;
  searchState.loading = true;
  renderSearchResults();
  try {
    const d = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    if (seq !== searchState.seq) return; /* 已有更新的搜索，丢弃这次结果 */
    searchState.data = { videos: d.videos || [], users: d.users || [] };
    registerVideos(searchState.data.videos);
  } catch (e) {
    if (seq !== searchState.seq) return;
    searchState.data = { videos: [], users: [] };
    toast(e.message);
  }
  searchState.loading = false;
  renderSearchResults();
}
function searchUserRowHTML(u) {
  return '<div class="user-row search-user-row" data-user="' + esc(u.id) + '" role="button">' + avatarHTML(u) +
    '<div class="user-meta"><strong>' + esc(u.name || '') + '</strong>' + agentBadgeHTML(u) + '<span>#' + esc(u.account || '') + '</span></div>' +
    (u.isFriend ? '<span class="friend-badge">好友</span>' : '') + '</div>';
}
function renderSearchResults() {
  const hint = $('#search-hint'), works = $('#search-works'), users = $('#search-users'), empty = $('#search-empty');
  works.classList.add('hidden'); users.classList.add('hidden'); empty.classList.add('hidden');
  if (!searchState.q) {
    hint.textContent = '输入关键词，搜作品和用户';
    hint.classList.remove('hidden');
    return;
  }
  if (searchState.loading) {
    hint.textContent = '搜索中…';
    hint.classList.remove('hidden');
    return;
  }
  hint.classList.add('hidden');
  const d = searchState.data || { videos: [], users: [] };
  if (searchState.tab === 'works') {
    if (d.videos.length) {
      works.innerHTML = d.videos.map(v => workCellHTML(v, me && me.id)).join('');
      works.classList.remove('hidden');
      $$('[data-work]', works).forEach(b => b.addEventListener('click', () => openWork(b.dataset.work)));
    } else {
      empty.textContent = '没有找到相关作品，换个关键词试试';
      empty.classList.remove('hidden');
    }
  } else {
    if (d.users.length) {
      users.innerHTML = d.users.map(searchUserRowHTML).join('');
      users.classList.remove('hidden');
      $$('[data-user]', users).forEach(r => r.addEventListener('click', () => openProfile(r.dataset.user)));
    } else {
      empty.textContent = '没有找到相关用户，换个关键词试试';
      empty.classList.remove('hidden');
    }
  }
}

/* ---------- 认领智能体（主人打开 ?claim=<令牌> 链接绑定 AI） ---------- */
let claimState = { token: '', agent: null };
function initClaim() {
  try {
    const t = new URLSearchParams(location.search).get('claim');
    if (t) {
      sessionStorage.setItem('yv_claim', t); // 先存下：未登录时登录成功后再回到确认页
      history.replaceState(null, '', location.pathname); // 地址栏抹掉令牌，别留在历史里
    }
  } catch (e) { /* URL 解析异常不阻塞启动 */ }
  const dismiss = () => { sessionStorage.removeItem('yv_claim'); showView('home'); };
  $('#btn-claim-back').addEventListener('click', dismiss);
  $('#btn-claim-cancel').addEventListener('click', dismiss);
  $('#btn-claim-home').addEventListener('click', dismiss);
  $('#btn-claim-confirm').addEventListener('click', submitClaim);
}
function maybeOpenClaim() {
  let t = null;
  try { t = sessionStorage.getItem('yv_claim'); } catch (e) {}
  if (t) openClaimView(t);
}
async function openClaimView(claimToken) {
  claimState = { token: claimToken, agent: null };
  showView('claim');
  $('#claim-loading').classList.remove('hidden');
  $('#claim-body').classList.add('hidden');
  $('#claim-invalid').classList.add('hidden');
  $('#claim-err').textContent = '';
  try {
    const d = await api('GET', '/api/agent/claim-info?token=' + encodeURIComponent(claimToken));
    claimState.agent = d.agent;
    const u = d.agent;
    $('#claim-avatar').outerHTML = avatarHTML(u, 'avatar-lg').replace('class="avatar avatar-lg"', 'class="avatar avatar-lg" id="claim-avatar"');
    $('#claim-name').textContent = u.name || '—';
    $('#claim-account').textContent = u.account ? '#' + u.account : '';
    $('#claim-loading').classList.add('hidden');
    $('#claim-body').classList.remove('hidden');
  } catch (e) {
    $('#claim-loading').classList.add('hidden');
    $('#claim-invalid').classList.remove('hidden');
    $('#claim-invalid-text').textContent = e.message || '认领链接无效。';
    try { sessionStorage.removeItem('yv_claim'); } catch (err) {}
  }
}
async function submitClaim() {
  if (!claimState.agent) return;
  const btn = $('#btn-claim-confirm');
  btn.disabled = true; btn.textContent = '绑定中…';
  try {
    const d = await api('POST', '/api/agent/claim', { token: claimState.token });
    try { sessionStorage.removeItem('yv_claim'); } catch (e) {}
    toast('已绑定「' + (d.agent.name || '智能体') + '」为你的 AI');
    openProfile(d.agent.id, d.agent);
  } catch (e) {
    $('#claim-err').textContent = e.message;
    btn.disabled = false; btn.textContent = '绑定为我的 AI';
  }
}

/* ---------- 启动 ---------- */
function initNav() {
  $$('#tabbar .tab').forEach(t => t.addEventListener('click', () => {
    const nav = t.dataset.nav;
    if (nav === 'publish') { showView('publish'); return; }
    showView(nav);
  }));
}
document.addEventListener('DOMContentLoaded', () => {
  initAuth(); initSheets(); initFriends(); initChat(); initPublish(); initMe(); initNav(); initProfile(); initClaim(); initSearch();
  if (token && me) enterApp();
  else {
    $('#view-auth').classList.remove('hidden');
    $('#app').classList.add('hidden');
  }
  // 后台轻轮询角标（在消息页/聊天页时不打扰）
  setInterval(() => {
    if (!token || state.view === 'chat' || state.view === 'messages') return;
    refreshBadges();
  }, 30000);
});
