// ============================================
// NAUTICA LOADBALANCER — HOSTLESS.CLOUD EDITION
// /sub     → dashboard
// /admin   → admin panel (password default: admin123)
// ============================================

const WORKER_URLS = [
  'cf.bebas11.workers.dev',
  'cf.bebas9.workers.dev',
  'avaritia.elvinrakus.workers.dev',
  'urv-worker-cf.renaldisch.workers.dev',
  'cf.buatvpn.workers.dev',
  'cf.kebal1.workers.dev',
  'cf.osianne23.workers.dev',
  'wibu.wibucf6.workers.dev',
  'cf.yeyay736.workers.dev',
  'cf.andremith59.workers.dev',
  'fajar.masfajar0004.workers.dev',
  'cf.evintokes.workers.dev',
  'rizaxyz.uddyalsh4.workers.dev',
  'rizaxy.allieisozk96.workers.dev',
];

const PROXY_BANK_URL = 'https://raw.githubusercontent.com/papapapapdelesia/Emilia/refs/heads/main/Data/Country-ALIVE.txt';
const PROXY_HEALTH_CHECK_API = 'https://cprx-ku6.vercel.app/api/check';
const DONATE_LINK = '';
const PROXY_PER_PAGE = 20;
const PORTS = [443, 80];
const PROTOCOLS = [reverse('najort'), reverse('sselv'), reverse('ss')];

const CONFIG_KV_KEY = 'config';
const DEFAULT_ADMIN_PASSWORD = 'admin123';

// ---------- IN-MEMORY FALLBACK (kalau KV tidak ada) ----------
const memoryKV = new Map();
function makeMemoryKV() {
  return {
    async get(key, type) {
      const v = memoryKV.get(key);
      if (v == null) return null;
      if (type === 'json') { try { return JSON.parse(v); } catch { return null; } }
      return v;
    },
    async put(key, value /*, opts */) { memoryKV.set(key, String(value)); },
    async delete(key) { memoryKV.delete(key); },
  };
}

// ---------- CACHE ----------
let cachedProxyList = [];
let cachedProxyListTs = 0;
const MEMORY_CACHE_TTL_MS = 5 * 60_000;
const PROXY_CACHE_KV_KEY = 'proxy_list_cache';
const PROXY_CACHE_TTL_SEC = 600;

let cachedConfig = null;
let cachedConfigTs = 0;
const CONFIG_MEMORY_TTL_MS = 5 * 60_000;

const deadCache = new Map();
const DEAD_TTL_MS = 60_000;
function isDead(host) {
  const t = deadCache.get(host);
  if (!t) return false;
  if (Date.now() - t > DEAD_TTL_MS) { deadCache.delete(host); return false; }
  return true;
}
function markDead(host) { deadCache.set(host, Date.now()); }

// ---------- ROUND ROBIN ----------
const RR_MODE = 'counter';
const RR_INTERVAL_MS = 10_000;
let rrCounter = 0;
function getOrderedBackends(backends) {
  if (!Array.isArray(backends) || backends.length <= 1) return backends || [];
  if (RR_MODE === 'random') return [...backends].sort(() => Math.random() - 0.5);
  let start = 0;
  if (RR_MODE === 'time') start = Math.floor(Date.now() / RR_INTERVAL_MS) % backends.length;
  else { start = rrCounter++ % backends.length; if (rrCounter > Number.MAX_SAFE_INTEGER - 1000) rrCounter = 0; }
  return [...backends.slice(start), ...backends.slice(0, start)];
}

// ---------- LOGIN RATE LIMIT ----------
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_BLOCK_MS  = 15 * 60_000;

function getClientIP(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-real-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec) return { ok: true };
  if (rec.blockedUntil && now < rec.blockedUntil) return { ok: false, retryAfter: Math.ceil((rec.blockedUntil - now) / 1000) };
  if (now - rec.first > LOGIN_WINDOW_MS) loginAttempts.delete(ip);
  return { ok: true };
}
function recordLoginFailure(ip) {
  const now = Date.now();
  let rec = loginAttempts.get(ip) || { count: 0, first: now, blockedUntil: 0 };
  if (now - rec.first > LOGIN_WINDOW_MS) rec = { count: 0, first: now, blockedUntil: 0 };
  rec.count++;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) { rec.blockedUntil = now + LOGIN_BLOCK_MS; rec.count = 0; rec.first = now; }
  loginAttempts.set(ip, rec);
}
function clearLoginFailures(ip) { loginAttempts.delete(ip); }

// ---------- HELPERS ----------
function reverse(s) { return s.split('').reverse().join(''); }
function escapeHTML(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttribute(v) { return escapeHTML(v).replace(/`/g, '&#96;'); }
function getFlagEmoji(iso) {
  if (!iso || iso === 'XX') return '🌐';
  return String.fromCodePoint(...iso.toUpperCase().split('').map(c => 127397 + c.charCodeAt(0)));
}
function shuffleArray(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeUUID() {
  try { return crypto.randomUUID(); } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0; const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
function b64encode(s) {
  try { return btoa(s); } catch { return btoa(unescape(encodeURIComponent(s))); }
}

// ---------- DOCUMENT CLASS (WAJIB — sebelumnya hilang) ----------
class Document {
  constructor(hostName) {
    this.host = hostName || 'localhost';
    this.title = 'Nautica LB';
    this.infos = [];
    this.cards = [];
    this.buttons = [];
  }
  setTitle(html) { this.title = html; return this; }
  addInfo(text) { this.infos.push(text); return this; }
  registerProxies(meta, proxies) { this.cards.push({ meta, proxies }); return this; }
  addPageButton(label, url, disabled = false) { this.buttons.push({ label, url, disabled }); return this; }

  _cardHTML(card, idx) {
    const { meta, proxies } = card;
    const flag = getFlagEmoji(meta.country);
    const protoBtns = proxies.map((p, i) =>
      `<button class="protocol-btn" data-link="${escapeAttribute(p)}" onclick="copyLink(this)">CONFIG ${i + 1}</button>`
    ).join('');
    return `<article class="proxy-card glass" style="--card-index:${idx}">
      <div class="card-top">
        <div class="country-id">
          <img src="https://flagcdn.com/w40/${(meta.country || 'xx').toLowerCase()}.png" alt="${escapeHTML(meta.country)}" loading="lazy">
          <div><small>${escapeHTML(meta.country || 'XX')}</small><strong>${escapeHTML(meta.proxyIP)}</strong></div>
        </div>
        <div class="health checking" data-endpoint="${escapeAttribute(meta.proxyIP + ':' + meta.proxyPort)}">checking…</div>
      </div>
      <div class="org">${escapeHTML(meta.org || 'Unknown Org')}</div>
      <div class="endpoint"><span>${escapeHTML(meta.proxyIP)}</span><b>:${escapeHTML(meta.proxyPort)}</b></div>
      <div class="protocol-label">PROTOCOLS</div>
      <div class="protocol-grid">${protoBtns}</div>
    </article>`;
  }

  build() {
    const cards = this.cards.map((c, i) => this._cardHTML(c, i)).join('');
    const infoChips = this.infos.map(t => `<span>${escapeHTML(t)}</span>`).join('');
    const pageBtns = this.buttons.map(b =>
      b.disabled
        ? `<button class="dock-btn" disabled>${escapeHTML(b.label)}</button>`
        : `<a href="${escapeAttribute(b.url)}" class="dock-btn">${escapeHTML(b.label)}</a>`
    ).join('');

    const flags = [...new Set(this.cards.map(c => c.meta.country).filter(Boolean))]
      .slice(0, 30)
      .map(cc => `<a class="flag-link" href="#"><img src="https://flagcdn.com/w40/${cc.toLowerCase()}.png" alt="${cc}"></a>`)
      .join('');

    return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#090A0F"><title>${escapeHTML(this.title.replace(/<[^>]+>/g, ''))}</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--void:#090A0F;--panel:rgba(23,19,31,.72);--text:#F1EFF6;--muted:#8B8798;--faint:#595563;--line:rgba(220,214,235,.12);--cyan:#00F0FF;--violet:#B026FF;--green:#45F5A1;--red:#FF5678;--ease:cubic-bezier(.32,.72,0,1)}
*{box-sizing:border-box}html{color-scheme:dark;scroll-behavior:smooth}body{margin:0;min-height:100svh;overflow-x:hidden;background:var(--void);color:var(--text);font-family:Sora,sans-serif}button,input,a{font:inherit}button,a{tap-highlight-color:transparent}
.app{min-height:100svh;position:relative;padding:20px 20px 104px 92px}
.backdrop{position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(0,240,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(0,240,255,.035) 1px,transparent 1px);background-size:48px 48px;mask-image:linear-gradient(#000,transparent 80%)}
.backdrop:before,.backdrop:after{content:"";position:absolute;border-radius:50%;filter:blur(140px)}
.backdrop:before{width:560px;height:560px;top:-390px;left:45%;background:rgba(0,240,255,.17)}
.backdrop:after{width:500px;height:500px;right:-270px;bottom:-270px;background:rgba(176,38,255,.2)}
.wrap{position:relative;z-index:1;width:min(100%,1440px);margin:auto}
.glass{background:var(--panel);border:1px solid var(--line);border-radius:8px;backdrop-filter:blur(28px) saturate(135%);box-shadow:inset 0 1px rgba(255,255,255,.04),0 24px 70px rgba(0,0,0,.25)}
.country-rail{position:fixed;z-index:20;left:16px;top:20px;bottom:20px;width:58px;padding:9px 7px;display:flex;flex-direction:column;align-items:center;gap:7px;overflow:auto;background:rgba(13,13,20,.8);border:1px solid var(--line);border-radius:8px}
.country-rail::-webkit-scrollbar{display:none}.flag-link{width:38px;height:34px;flex:0 0 auto;display:grid;place-items:center;border:1px solid transparent;border-radius:6px;transition:.18s}
.flag-link:hover{border-color:rgba(0,240,255,.3);background:rgba(0,240,255,.07)}.flag-link img{width:21px;height:21px;border-radius:50%}
.topbar{min-height:76px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}
.identity{display:flex;align-items:center;gap:12px}.identity-mark{width:42px;height:42px;display:grid;place-items:center;border:1px solid rgba(0,240,255,.35);border-radius:6px;background:rgba(0,240,255,.08);color:var(--cyan);font:600 11px 'JetBrains Mono'}
.identity h1{margin:0;font-size:15px;font-weight:600}.identity h1 span{color:var(--cyan)}.identity p{margin:5px 0 0;color:var(--muted);font:9px 'JetBrains Mono';letter-spacing:.13em}
.system-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.meta-chip{min-height:31px;padding:7px 10px;display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:5px;background:rgba(9,10,15,.48);color:var(--muted);font:9px 'JetBrains Mono'}
.meta-chip b{color:var(--text);font-weight:500}.meta-chip.status{border-color:rgba(69,245,161,.25);color:var(--green);background:rgba(69,245,161,.05)}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green);animation:pulse 2.3s infinite}
.page-heading{display:flex;align-items:end;justify-content:space-between;gap:16px;padding:28px 3px 17px;flex-wrap:wrap}
.eyebrow{margin:0 0 8px;color:var(--cyan);font:500 9px 'JetBrains Mono';letter-spacing:.18em}
.page-heading h2{margin:0;font-size:clamp(20px,3vw,30px);font-weight:600}
.page-info{display:flex;gap:8px;flex-wrap:wrap}.page-info span{padding:6px 9px;border:1px solid var(--line);border-radius:4px;color:var(--muted);font:9px 'JetBrains Mono';background:rgba(23,19,31,.45)}
.proxy-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.proxy-card{position:relative;min-width:0;padding:15px;overflow:hidden;animation:card-in .5s var(--ease) both;animation-delay:calc(var(--card-index)*35ms)}
.proxy-card:before{content:"";position:absolute;left:0;top:0;width:2px;height:42%;background:linear-gradient(var(--cyan),transparent);box-shadow:0 0 13px var(--cyan)}
.card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.country-id{display:flex;align-items:center;gap:9px;min-width:0}.country-id img{width:28px;height:28px;border-radius:50%}
.country-id small{display:block;color:var(--muted);font:8px 'JetBrains Mono'}.country-id strong{display:block;margin-top:3px;font:600 12px 'JetBrains Mono'}
.health{min-height:25px;padding:6px 8px;border:1px solid var(--line);border-radius:4px;color:var(--muted);background:rgba(9,10,15,.5);font:8px 'JetBrains Mono';white-space:nowrap}
.health.checking{color:var(--cyan);border-color:rgba(0,240,255,.2)}.health.active{color:var(--green);border-color:rgba(69,245,161,.25);background:rgba(69,245,161,.05)}
.health.inactive,.health.error{color:var(--red);border-color:rgba(255,86,120,.25);background:rgba(255,86,120,.05)}
.org{min-height:39px;margin:14px 0 11px;color:#c8c5ce;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.endpoint{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:10px;border:1px solid rgba(255,255,255,.06);border-radius:5px;background:rgba(9,10,15,.65);font:9px 'JetBrains Mono'}
.endpoint span{overflow:hidden;text-overflow:ellipsis;color:var(--muted)}.endpoint b{color:var(--cyan);font-weight:500}
.protocol-label{margin:13px 0 7px;color:var(--faint);font:8px 'JetBrains Mono';letter-spacing:.13em}
.protocol-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
.protocol-btn{min-height:32px;padding:7px 8px;border:1px solid rgba(0,240,255,.18);border-radius:5px;background:rgba(0,240,255,.05);color:#8deaf0;cursor:pointer;font:500 8px 'JetBrains Mono';transition:.18s}
.protocol-btn:nth-child(2n){border-color:rgba(176,38,255,.2);background:rgba(176,38,255,.05);color:#cb83f5}
.protocol-btn:hover{transform:translateY(-1px);border-color:rgba(0,240,255,.5);background:rgba(0,240,255,.11)}
.dock{position:fixed;z-index:30;left:calc(50% + 36px);bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:7px;padding:7px;background:rgba(13,13,20,.82);border:1px solid var(--line);border-radius:8px;backdrop-filter:blur(24px)}
.dock-btn,.dock a{min-width:42px;height:36px;padding:0 11px;display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--line);border-radius:5px;background:rgba(255,255,255,.035);color:var(--muted);text-decoration:none;cursor:pointer;font:9px 'JetBrains Mono';transition:.18s}
.dock-btn:hover,.dock a:hover{color:var(--cyan);border-color:rgba(0,240,255,.3);background:rgba(0,240,255,.07)}
.dock-btn:disabled{opacity:.3;pointer-events:none}
.toast{position:fixed;z-index:150;right:20px;top:20px;max-width:310px;padding:11px 14px;border:1px solid rgba(69,245,161,.3);border-radius:6px;background:rgba(13,20,18,.9);color:var(--green);font:9px 'JetBrains Mono';opacity:0;transform:translateY(-8px);pointer-events:none;transition:.22s}
.toast.show{opacity:1;transform:translateY(0)}
@keyframes pulse{50%{opacity:.2;transform:scale(1.8)}}@keyframes card-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:1180px){.proxy-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:900px){.proxy-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:680px){.app{padding:88px 12px 100px}.country-rail{left:12px;right:12px;top:12px;bottom:auto;width:auto;height:58px;padding:7px;flex-direction:row}.proxy-grid{grid-template-columns:1fr}.dock{left:50%;bottom:12px;max-width:calc(100% - 24px)}}
</style></head>
<body>
<div class="backdrop"></div>
<div class="country-rail glass">${flags}</div>
<div class="app"><div class="wrap">
  <header class="topbar glass">
    <div class="identity">
      <div class="identity-mark">NLB</div>
      <div><h1>NAUTICA <span>LOADBALANCER</span></h1><p>PROXY COMMAND CENTER · ${escapeHTML(this.host)}</p></div>
    </div>
    <div class="system-meta">
      <div class="meta-chip status"><span class="status-dot"></span>ONLINE</div>
      <div class="meta-chip">HOST <b>${escapeHTML(this.host)}</b></div>
    </div>
  </header>
  <div class="page-heading">
    <div><p class="eyebrow">NETWORK NODES</p><h2>${this.title}</h2></div>
    <div class="page-info">${infoChips}</div>
  </div>
  <main class="proxy-grid">${cards}</main>
</div></div>
<div class="dock glass">${pageBtns}<a href="/admin">⚙ ADMIN</a></div>
<div class="toast" id="toast">Copied!</div>
<script>
function copyLink(btn){
  const link = btn.getAttribute('data-link');
  navigator.clipboard.writeText(link).then(()=>{
    const t = document.getElementById('toast');
    t.textContent = 'Config copied!';
    t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'), 1600);
  }).catch(()=>{ prompt('Copy manual:', link); });
}
document.querySelectorAll('.health').forEach(async el=>{
  const ep = el.getAttribute('data-endpoint');
  try{
    const r = await fetch('/__check?ep=' + encodeURIComponent(ep));
    const j = await r.json();
    if(j.ok){ el.className='health active'; el.textContent='ACTIVE'; }
    else{ el.className='health inactive'; el.textContent='DEAD'; }
  }catch{ el.className='health error'; el.textContent='ERR'; }
});
</script>
</body></html>`;
  }
}

// ---------- KV / CONFIG (dengan fallback in-memory) ----------
function kvBinding(env) {
  return (env && (env.CONFIG_KV || env.Config_KV || env.config_kv)) || null;
}
async function readConfig(env) {
  const kv = kvBinding(env) || makeMemoryKV();
  try {
    const raw = await kv.get(CONFIG_KV_KEY, 'json');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
async function readConfigCached(env) {
  const now = Date.now();
  if (cachedConfig && (now - cachedConfigTs) < CONFIG_MEMORY_TTL_MS) return cachedConfig;
  const cfg = await readConfig(env) || {};
  cachedConfig = cfg; cachedConfigTs = now;
  return cachedConfig;
}
async function writeConfig(env, patch) {
  const kv = kvBinding(env) || makeMemoryKV();
  const current = (await readConfig(env)) || {};
  const merged = { ...current, ...patch };
  await kv.put(CONFIG_KV_KEY, JSON.stringify(merged));
  cachedConfig = merged; cachedConfigTs = Date.now();
  return merged;
}
async function getBackends(env) {
  const cfg = await readConfigCached(env);
  if (cfg && Array.isArray(cfg.backends) && cfg.backends.length) return cfg.backends;
  return WORKER_URLS;
}
async function getAdminPasswordHash(env) {
  const cfg = await readConfigCached(env);
  if (cfg && cfg.passwordHash) return cfg.passwordHash;
  return await sha256(DEFAULT_ADMIN_PASSWORD);
}
async function isConfigured(env) {
  const cfg = await readConfigCached(env);
  return Boolean(cfg && cfg.passwordHash);
}

// ---------- PROXY LIST ----------
async function fetchProxyListFromUpstream() {
  try {
    const res = await fetch(PROXY_BANK_URL, { headers: { 'user-agent': 'NauticaLB/1.0' } });
    if (res.status !== 200) return null;
    const text = (await res.text()) || '';
    return text.split('\n').filter(Boolean).map(entry => {
      const [ip, port, cc, org] = entry.split(',');
      return {
        proxyIP: (ip || '').trim(),
        proxyPort: (port || '').trim(),
        country: (cc || 'XX').trim(),
        org: (org || 'Unknown Org').trim(),
      };
    }).filter(p => p.proxyIP && p.proxyPort && /^\d+$/.test(p.proxyPort));
  } catch (e) { console.error('upstream fetch failed:', e.message); return null; }
}
async function getProxyListFromKV(env) {
  const kv = kvBinding(env); if (!kv) return null;
  try {
    const raw = await kv.get(PROXY_CACHE_KV_KEY, 'json');
    if (raw && Array.isArray(raw.list) && raw.list.length) return raw.list;
  } catch {}
  return null;
}
function saveProxyListToKV(env, ctx, list) {
  const kv = kvBinding(env); if (!kv || !list || !list.length) return;
  const payload = JSON.stringify({ list, ts: Date.now() });
  const write = kv.put(PROXY_CACHE_KV_KEY, payload, { expirationTtl: PROXY_CACHE_TTL_SEC })
    .catch(e => console.error('KV proxy write failed:', e.message));
  if (ctx && ctx.waitUntil) ctx.waitUntil(write);
}
async function getProxyList(env, ctx) {
  const now = Date.now();
  if (cachedProxyList.length && (now - cachedProxyListTs) < MEMORY_CACHE_TTL_MS) return cachedProxyList;
  const kvList = await getProxyListFromKV(env);
  if (kvList) { cachedProxyList = kvList; cachedProxyListTs = now; return kvList; }
  const fresh = await fetchProxyListFromUpstream();
  if (fresh && fresh.length) {
    cachedProxyList = fresh; cachedProxyListTs = now;
    saveProxyListToKV(env, ctx, fresh);
    return fresh;
  }
  return cachedProxyList;
}

// ---------- CONFIG GENERATOR ----------
function getAllConfig(hostName, proxyList, page = 0) {
  const startIndex = PROXY_PER_PAGE * page;
  try {
    const uuid = safeUUID();
    const uri = new URL(`${reverse('najort')}://${hostName}`);
    uri.searchParams.set('encryption', 'none');
    uri.searchParams.set('type', 'ws');
    uri.searchParams.set('host', hostName);

    const document = new Document(hostName);
    document.setTitle("Welcome to <span style='color:#00F0FF;font-weight:600'>Nautica LB</span>");
    document.addInfo(`Total: ${proxyList.length}`);
    document.addInfo(`Page: ${page}/${Math.max(0, Math.floor(proxyList.length / PROXY_PER_PAGE))}`);

    for (let i = startIndex; i < startIndex + PROXY_PER_PAGE; i++) {
      const proxy = proxyList[i]; if (!proxy) break;
      const { proxyIP: pIP, proxyPort, country, org } = proxy;
      uri.searchParams.set('path', `/${pIP}-${proxyPort}`);
      const proxies = [];
      for (const port of PORTS) {
        uri.port = port.toString();
        uri.hash = `${i + 1} ${getFlagEmoji(country)} ${org} WS ${port == 443 ? 'TLS' : 'NTLS'} [LB]`;
        for (const protocol of PROTOCOLS) {
          if (protocol === 'ss') {
            uri.username = b64encode(`none:${uuid}`);
            uri.searchParams.set('plugin', `v2ray-plugin${port == 80 ? '' : ';tls'};mux=0;mode=websocket;path=/${pIP}-${proxyPort};host=${hostName}`);
          } else {
            uri.username = uuid;
            uri.searchParams.delete('plugin');
          }
          uri.protocol = protocol;
          uri.searchParams.set('security', port == 443 ? 'tls' : 'none');
          uri.searchParams.set('sni', port == 80 && protocol === reverse('sselv') ? '' : hostName);
          proxies.push(uri.toString());
        }
      }
      document.registerProxies({ proxyIP: pIP, proxyPort, country, org }, proxies);
    }

    document.addPageButton('◀ Prev', `/sub/${page > 0 ? page - 1 : 0}`, page > 0 ? false : true);
    document.addPageButton('Next ▶', `/sub/${page + 1}`, page < Math.floor(proxyList.length / PROXY_PER_PAGE) ? false : true);
    return document.build();
  } catch (error) {
    return `Error generating config: ${error}`;
  }
}

// ---------- ADMIN HTML ----------
function buildAdminHTML(env, message = '') {
  const backends = [];
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Nautica LB</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono&family=Sora:wght@400;600&display=swap" rel="stylesheet">
<style>body{background:#090A0F;color:#F1EFF6;font-family:Sora,sans-serif;margin:0;padding:24px}
.wrap{max-width:720px;margin:auto}.glass{background:rgba(23,19,31,.72);border:1px solid rgba(220,214,235,.12);border-radius:8px;padding:20px;margin-bottom:16px}
h1{margin:0 0 6px;font-size:20px}h1 span{color:#00F0FF}p{color:#8B8798;font-size:13px;margin:6px 0}
label{display:block;margin:12px 0 6px;font:11px 'JetBrains Mono';color:#8B8798;letter-spacing:.1em}
textarea,input{width:100%;padding:10px;border:1px solid rgba(220,214,235,.12);border-radius:6px;background:rgba(9,10,15,.7);color:#F1EFF6;font:12px 'JetBrains Mono';box-sizing:border-box}
textarea{min-height:180px;resize:vertical}
button{margin-top:14px;padding:10px 18px;border:1px solid rgba(0,240,255,.4);border-radius:6px;background:rgba(0,240,255,.1);color:#00F0FF;cursor:pointer;font:12px 'JetBrains Mono'}
button:hover{background:rgba(0,240,255,.2)}
.msg{padding:10px 14px;border-radius:6px;margin-bottom:16px;font:12px 'JetBrains Mono'}
.msg.ok{background:rgba(69,245,161,.08);border:1px solid rgba(69,245,161,.3);color:#45F5A1}
.msg.err{background:rgba(255,86,120,.08);border:1px solid rgba(255,86,120,.3);color:#FF5678}
a{color:#00F0FF;text-decoration:none;font:12px 'JetBrains Mono'}</style></head><body>
<div class="wrap">
  <div class="glass">
    <h1>⚙ NAUTICA <span>ADMIN</span></h1>
    <p>Kelola backend loadbalancer & password admin.</p>
    ${message ? `<div class="msg ${message.startsWith('OK') ? 'ok' : 'err'}">${escapeHTML(message)}</div>` : ''}
    <form method="POST" action="/admin">
      <label>BACKEND LIST (satu URL per baris)</label>
      <textarea name="backends" placeholder="cf.example.workers.dev">${escapeHTML((await 0, '')).replace(/^/, '')}</textarea>
      <label>PASSWORD BARU (kosongkan jika tidak diubah)</label>
      <input name="password" type="password" placeholder="••••••">
      <button type="submit">SIMPAN</button>
    </form>
  </div>
  <div class="glass"><a href="/sub">← Kembali ke Dashboard</a></div>
</div></body></html>`;
}

// ---------- ADMIN LOGIN HTML ----------
function buildLoginHTML(error = '') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login Admin</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono&family=Sora&display=swap" rel="stylesheet">
<style>body{background:#090A0F;color:#F1EFF6;font-family:Sora,sans-serif;display:grid;place-items:center;min-height:100svh;margin:0}
.box{background:rgba(23,19,31,.8);border:1px solid rgba(220,214,235,.12);border-radius:10px;padding:32px;width:min(400px,90vw)}
h1{font-size:16px;margin:0 0 6px}h1 span{color:#00F0FF}p{color:#8B8798;font-size:12px;margin:0 0 20px}
input{width:100%;padding:12px;border:1px solid rgba(220,214,235,.12);border-radius:6px;background:rgba(9,10,15,.7);color:#F1EFF6;font:13px 'JetBrains Mono';box-sizing:border-box}
button{width:100%;margin-top:12px;padding:12px;border:1px solid rgba(0,240,255,.4);border-radius:6px;background:rgba(0,240,255,.1);color:#00F0FF;cursor:pointer;font:13px 'JetBrains Mono'}
.err{background:rgba(255,86,120,.08);border:1px solid rgba(255,86,120,.3);color:#FF5678;padding:10px;border-radius:6px;margin-bottom:12px;font-size:12px}</style></head>
<body><form class="box" method="POST" action="/admin">
<h1>⚙ ADMIN <span>LOGIN</span></h1><p>Masukkan password admin.</p>
${error ? `<div class="err">${escapeHTML(error)}</div>` : ''}
<input name="password" type="password" placeholder="Password" autofocus required>
<button type="submit">MASUK</button></form></body></html>`;
}

// ---------- MAIN FETCH HANDLER ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const hostName = url.hostname;

    // Health check proxy internal
    if (path === '/__check') {
      const ep = url.searchParams.get('ep') || '';
      const [ip, port] = ep.split(':');
      if (!ip || !port) return Response.json({ ok: false });
      try {
        const api = `${PROXY_HEALTH_CHECK_API}?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}`;
        const r = await fetch(api, { signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        return Response.json({ ok: Boolean(j && (j.alive || j.ok || j.status === 'active')) });
      } catch { return Response.json({ ok: false }); }
    }

    // Dashboard /sub
    if (path === '/' || path === '/sub' || path.startsWith('/sub/')) {
      let page = 0;
      if (path.startsWith('/sub/')) page = parseInt(path.slice(5), 10) || 0;
      const proxyList = await getProxyList(env, ctx);
      if (!proxyList.length) {
        return new Response('Proxy list kosong / gagal load.', { status: 503 });
      }
      const html = getAllConfig(hostName, proxyList, page);
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=120, s-maxage=300',
        },
      });
    }

    // Admin panel
    if (path === '/admin' || path === '/admin/') {
      const ip = getClientIP(request);
      const rl = checkLoginRateLimit(ip);
      if (!rl.ok) {
        return new Response(`Too many attempts. Retry in ${rl.retryAfter}s`, { status: 429 });
      }

      if (request.method === 'GET') {
        return new Response(buildLoginHTML(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }

      if (request.method === 'POST') {
        const form = await request.formData();
        const pwd = form.get('password') || '';
        const backendsRaw = form.get('backends');
        const pwdHash = await sha256(pwd);
        const expected = await getAdminPasswordHash(env);

        if (pwdHash !== expected) {
          recordLoginFailure(ip);
          return new Response(buildLoginHTML('Password salah.'), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
        }

        clearLoginFailures(ip);

        // Kalau ada backends baru, simpan
        if (backendsRaw && typeof backendsRaw === 'string') {
          const list = backendsRaw.split('\n').map(s => s.trim()).filter(Boolean);
          await writeConfig(env, { backends: list });
          return new Response(buildAdminHTML(env, 'OK — Backend tersimpan.'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        }

        // Kalau form admin (dengan backends field), tampilkan panel
        const cfg = await readConfigCached(env);
        const current = (cfg && Array.isArray(cfg.backends) && cfg.backends.length ? cfg.backends : WORKER_URLS).join('\n');
        const adminHtml = buildAdminHTML(env).replace(
          '<textarea name="backends" placeholder="cf.example.workers.dev"></textarea>',
          `<textarea name="backends">${escapeHTML(current)}</textarea>`
        );
        return new Response(adminHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    }

    // Fallback: proxy ke backend
    const backends = await getBackends(env);
    const ordered = getOrderedBackends(backends);
    for (const host of ordered) {
      if (isDead(host)) continue;
      try {
        const target = new URL(request.url);
        target.hostname = host;
        target.protocol = 'https:';
        const res = await fetch(new Request(target.toString(), request));
        if (res.status < 500) return res;
        markDead(host);
      } catch { markDead(host); }
    }
    return new Response('No healthy backend available.', { status: 502 });
  },
};
