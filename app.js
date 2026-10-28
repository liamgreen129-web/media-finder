/* Media Finder — a personal MEGA media browser.
   Everything runs in the browser: it talks to MEGA's API directly with the open-source megajs
   library, decrypts thumbnails here, and streams videos through the service worker (sw.js). */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo');
const LS = {
  get(k, d) { try { const v = localStorage.getItem('mf.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mf.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('mf.' + k); } catch {} }
};

/* ---------------- File types ---------------- */
const EXT = {
  photo: 'jpg jpeg png gif heic heif webp bmp tif tiff dng cr2 cr3 nef arw raf orf rw2 avif',
  video: 'mp4 mov m4v 3gp 3g2 mkv avi webm wmv mts m2ts ts flv mpg mpeg ogv',
  audio: 'mp3 m4a aac wav flac ogg opus aiff aif wma'
};
const KIND_OF = {};
for (const [k, list] of Object.entries(EXT)) for (const e of list.split(' ')) KIND_OF[e] = k;
const PLAYABLE_VIDEO = new Set(['mp4', 'mov', 'm4v', '3gp', '3g2']);
const SHOWABLE_PHOTO = new Set(['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'bmp', 'avif', 'tif', 'tiff']);
const MIME = { mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', '3gp': 'video/3gpp', '3g2': 'video/3gpp2', webm: 'video/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', aiff: 'audio/aiff', aif: 'audio/aiff' };

const fmtSize = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i];
};

/* ---------------- Bytes helpers ---------------- */
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/,/g, '');
  while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
function aesKeyOf(fileKey) { // 32-byte node key -> 16-byte AES key
  const k = new Uint8Array(16);
  for (let i = 0; i < 16; i++) k[i] = fileKey[i] ^ fileKey[16 + i];
  return k;
}
// MEGA encrypts thumbnails with AES-CBC, zero IV, zero padding. WebCrypto insists on PKCS#7
// padding, so we append one extra block that decrypts to a valid padding block.
async function cbcDecryptZeroPadded(keyBytes, data) {
  const len = data.length - (data.length % 16);
  data = data.subarray(0, len);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const pad = new Uint8Array(16).fill(16);
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: data.slice(len - 16) }, key, pad)).slice(0, 16);
  const full = new Uint8Array(len + 16); full.set(data); full.set(extra, len);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, full));
}

/* ---------------- State ---------------- */
const state = {
  storage: null,
  rootId: LS.get('root', null),
  kind: LS.get('kind', 'video'),
  sort: LS.get('sort', 'new'),
  cols: LS.get('cols', 2),
  query: '',
  all: [],       // every file under the chosen folder
  results: [],   // after filtering + sorting
  shown: 0,      // how many tiles are rendered
  current: -1    // index in results of the item open in the viewer
};
const PAGE = 120;

/* ---------------- MEGA ---------------- */
if (window.mega && mega.File) {
  // megajs doesn't keep the "fa" (file attributes = thumbnail/preview handles) field; keep it.
  const orig = mega.File.prototype.loadMetadata;
  mega.File.prototype.loadMetadata = function (aes, opt) { this.fa = opt && opt.fa; return orig.call(this, aes, opt); };
}

async function signIn(email, password, code) {
  const opts = { email, password, keepalive: false, autologin: true, autoload: true };
  if (code) opts.secondFactorCode = code;
  const s = new mega.Storage(opts);
  await s.ready;
  return s;
}

async function restoreSession() {
  const saved = LS.get('session', null);
  if (!saved) return null;
  const s = mega.Storage.fromJSON({ ...saved, options: { email: saved.email, keepalive: false } });
  await s.reload(true);
  return s;
}

function saveSession(s) {
  const j = s.toJSON(); // contains the password in options — never store that
  LS.set('session', { key: j.key, sid: j.sid, name: j.name, user: j.user, email: s.email || (j.options && j.options.email) });
}

// Send an API request in the right context for a file: your own account, a file inside a
// shared folder link (needs the folder id as ?n=), or a single shared file link (p=).
function req(file, body) {
  const n = file.node;
  if (Array.isArray(n.downloadId)) {
    return n.api.request({ ...body, n: n.downloadId[1], _querystring: { n: n.downloadId[0] } });
  }
  if (!n.nodeId && n.downloadId) return n.api.request({ ...body, p: n.downloadId });
  return state.storage.api.request({ ...body, n: n.nodeId });
}
// Same, for commands that don't name a node (thumbnail fetches)
function ctxReq(file, body) {
  const n = file.node;
  if (Array.isArray(n.downloadId)) return n.api.request({ ...body, _querystring: { n: n.downloadId[0] } });
  if (!n.nodeId && n.downloadId) return n.api.request(body);
  return state.storage.api.request(body);
}

const dlCache = new Map(); // id -> {g, s, t}
async function downloadUrl(file) {
  const c = dlCache.get(file.id);
  if (c && Date.now() - c.t < 20 * 60 * 1000) return c;
  const r = await req(file, { a: 'g', g: 1, ssl: 2 });
  if (typeof r.g !== 'string' || !r.g.startsWith('http')) throw new Error('MEGA didn’t return a download link (possibly over transfer quota).');
  const v = { g: r.g, s: r.s, t: Date.now() };
  dlCache.set(file.id, v);
  return v;
}

async function streamUrl(file) {
  const d = await downloadUrl(file);
  const q = new URLSearchParams({ u: d.g, k: toHex(file.node.key), s: String(d.s), m: MIME[file.ext] || 'application/octet-stream' });
  return new URL('stream/' + encodeURIComponent(file.id) + '?' + q, location.href).href;
}

/* ---------- Thumbnails & previews (type 0 = small thumb, 1 = ~1000px preview) ---------- */
function faHandle(file, type) {
  if (!file.fa) return null;
  for (const part of file.fa.split('/')) {
    const m = /^\d+:(\d+)\*(.+)$/.exec(part);
    if (m && Number(m[1]) === type) return m[2];
  }
  return null;
}

let thumbCache = null;
const thumbUrls = new Map();
async function loadAttr(file, type) {
  const handle = faHandle(file, type);
  if (!handle) return null;
  const memo = handle + ':' + type;
  if (thumbUrls.has(memo)) return thumbUrls.get(memo);
  const p = (async () => {
    const cacheKey = new URL('__fa/' + encodeURIComponent(handle), location.href).href;
    try { thumbCache = thumbCache || await caches.open('fa-v1'); } catch { thumbCache = null; }
    let blob;
    const hit = thumbCache && await thumbCache.match(cacheKey);
    if (hit) blob = await hit.blob();
    else {
      const r = await ctxReq(file, { a: 'ufa', fah: handle, ssl: 2, r: 1 });
      const res = await fetch(r.p + '/' + type, { method: 'POST', body: b64urlToBytes(handle) });
      if (!res.ok) throw new Error('thumb ' + res.status);
      const buf = new Uint8Array(await res.arrayBuffer());
      const len = buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24);
      const plain = await cbcDecryptZeroPadded(aesKeyOf(file.node.key), buf.subarray(12, 12 + len));
      blob = new Blob([plain], { type: 'image/jpeg' });
      if (thumbCache) thumbCache.put(cacheKey, new Response(blob)).catch(() => {});
    }
    return URL.createObjectURL(blob);
  })();
  thumbUrls.set(memo, p);
  p.catch(() => thumbUrls.delete(memo));
  return p;
}

// Small queue so we don't fire hundreds of requests at once while scrolling.
const queue = []; let running = 0; const MAX_PARALLEL = 5;
function enqueue(job) { queue.push(job); pump(); }
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.pop(); // newest first = what's on screen now
    if (!job.wanted()) continue;
    running++;
    job.run().catch(() => {}).finally(() => { running--; pump(); });
  }
}

/* ---------------- Building the file list ---------------- */
function itemFor(ch, path) {
  const dot = ch.name.lastIndexOf('.');
  const ext = dot > 0 ? ch.name.slice(dot + 1).toLowerCase() : '';
  const id = ch.nodeId || (Array.isArray(ch.downloadId) ? ch.downloadId[1] : ch.downloadId);
  return { id, node: ch, name: ch.name, lname: ch.name.toLowerCase(), ext,
    kind: KIND_OF[ext] || 'other', size: ch.size || 0, ts: ch.timestamp || 0, path, fa: ch.fa };
}

function collect(rootNode) {
  if (!rootNode.directory) return rootNode.name ? [itemFor(rootNode, '')] : [];
  const out = [];
  const walk = (node, path) => {
    for (const ch of node.children || []) {
      if (ch.directory) walk(ch, path ? path + ' / ' + ch.name : ch.name);
      else if (ch.name) out.push(itemFor(ch, path));
    }
  };
  walk(rootNode, '');
  return out;
}

function rootChoices() {
  if (state.link) return [{ node: state.link.root, label: state.link.root.name || 'Shared link' }];
  const s = state.storage;
  const list = [{ node: s.root, label: 'Cloud Drive' }];
  for (const m of s.mounts || []) {
    if (m === s.root || m === s.trash || m === s.inbox) continue;
    if (m.directory) list.push({ node: m, label: m.name || 'Shared folder' });
  }
  return list;
}

function currentRoot() {
  if (state.link) return state.link.cur || state.link.root;
  const s = state.storage;
  return (state.rootId && s.files && s.files[state.rootId]) || s.root;
}

function rebuild() {
  const root = currentRoot();
  state.all = collect(root);
  $('folderName').textContent = nodeLabel(root);
  $('folderSub').textContent = state.link
    ? (root.directory ? 'Shared link · all subfolders ▾' : 'Shared file')
    : 'and all subfolders ▾';
  $('linkBtn').innerHTML = state.link ? ICON_CLOSE : ICON_LINK;
  $('linkBtn').setAttribute('aria-label', state.link ? 'Close shared link' : 'Open shared link');
  $('logoutBtn').classList.toggle('hidden', !state.storage || !!state.link);
  applyFilters();
}

/* ---------------- Shared links ---------------- */
const ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function cleanLink(text) {
  // tolerate links pasted with line breaks/spaces, or without https://
  const t = String(text || '').replace(/[\r\n]+/g, '');
  const m = /(?:https?:\/\/)?(?:www\.)?mega(?:\.co)?\.nz\/[^\s<>"']+/i.exec(t);
  if (!m) return null;
  let u = m[0].replace(/[)\].,'"]+$/, '');
  if (!/^https?:/i.test(u)) u = 'https://' + u;
  return u;
}

// Turn any MEGA link style into {id, key, folder, sub}:
//   new:  mega.nz/folder/ID#KEY  (/file/SUB or /folder/SUB after the key opens one item inside)
//         mega.nz/file/ID#KEY
//   old:  mega.nz/#F!ID!KEY  (!SUB optional)   mega.nz/#!ID!KEY
//   also: mega.nz/embed/ID#KEY, mega.nz/folder/ID!KEY and similar mistypes
function parseLink(url) {
  const u = new URL(url);
  let hash = decodeURIComponent(u.hash.replace(/^#/, ''));
  const path = u.pathname;
  let m;
  if ((m = /\/(folder|file|embed)\/([\w-]+)(?:[!#]([\w-]+))?/.exec(path + (hash ? '#' + hash : '')))) {
    const folder = m[1] === 'folder';
    const id = m[2];
    let key = m[3] || '', sub = null;
    const rest = /^[\w-]+\/(?:file|folder)\/([\w-]+)/.exec(hash);
    if (rest) sub = rest[1];
    if (!key && hash && /^[\w-]+$/.test(hash)) key = hash;
    return { id, key, folder, sub };
  }
  if ((m = /^(F?)!([\w-]+)(?:!([\w-]+))?(?:[!@]([\w-]+))?/.exec(hash))) {
    return { id: m[2], key: m[3] || '', folder: m[1] === 'F', sub: m[4] || null };
  }
  if (/^P!/.test(hash)) throw new Error('This is a password-protected link (#P!). Those can’t be opened here yet.');
  throw new Error('Couldn’t read this MEGA link. Check it was copied completely.');
}

async function openLink(text, keyText) {
  let url = cleanLink(text);
  if (!url) throw new Error('That doesn’t look like a MEGA link. It should start with https://mega.nz/');
  const p = parseLink(url);
  if (!p.key && keyText) p.key = String(keyText).replace(/\s+/g, '').replace(/^[#!]+/, '');
  if (!p.key) { const e = new Error('NEEDKEY'); e.needKey = true; throw e; }
  if (!/^[\w-]+$/.test(p.key)) throw new Error('That key has characters a MEGA key can’t contain. Check it was copied completely.');
  // remember it in a tidy, complete form
  url = `https://mega.nz/${p.folder ? 'folder' : 'file'}/${p.id}#${p.key}` + (p.sub ? `/file/${p.sub}` : '');
  const f = new mega.File({ downloadId: p.id, key: p.key, directory: p.folder, loadedFile: p.sub || undefined });
  const node = await f.loadAttributes();
  if (!node.directory && !node.fa) {
    // megajs drops the thumbnail info for single-file links; fetch it ourselves
    try { const r = await node.api.request({ a: 'g', p: node.downloadId }); node.fa = r.fa; } catch {}
  }
  if (!node.timestamp && f.timestamp) node.timestamp = f.timestamp;
  state.link = { root: node, url };
  const recent = LS.get('links', []).filter((l) => l.url !== url);
  recent.unshift({ url, name: node.name || 'Shared link', folder: !!node.directory });
  LS.set('links', recent.slice(0, 6));
  if ($('main').classList.contains('hidden')) showMain();
  rebuild();
  if (!node.directory) {
    if (!state.results.length) { state.kind = 'all'; markChips(); applyFilters(); }
    openViewer(0);
  }
}

function closeLink() {
  state.link = null;
  if (state.storage) rebuild();
  else { $('main').classList.add('hidden'); showLogin(); }
}

function openLinkSheet() {
  $('linkInput').value = '';
  $('keyInput').value = '';
  $('keyRow').classList.add('hidden');
  $('linkError').textContent = '';
  const list = $('recentLinks'); list.innerHTML = '';
  const recent = LS.get('links', []);
  $('recentWrap').classList.toggle('hidden', !recent.length);
  for (const l of recent) {
    const b = document.createElement('button'); b.className = 'item';
    b.innerHTML = (l.folder
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>') +
      '<span class="t"></span><span class="c">✕</span>';
    b.querySelector('.t').textContent = l.name;
    b.onclick = (e) => {
      if (e.target.classList.contains('c')) { LS.set('links', LS.get('links', []).filter((x) => x.url !== l.url)); openLinkSheet(); return; }
      submitLink(l.url);
    };
    list.append(b);
  }
  $('linkSheet').classList.remove('hidden');
}

async function submitLink(text) {
  const btn = $('linkOpen');
  btn.disabled = true; btn.textContent = 'Opening…'; $('linkError').textContent = '';
  try {
    await openLink(text, $('keyInput').value);
    $('linkSheet').classList.add('hidden');
  } catch (e) {
    const m = String(e && e.message || e);
    if (e && e.needKey) {
      $('keyRow').classList.remove('hidden');
      $('keyInput').focus();
      $('linkError').textContent = 'This link needs its decryption key. Paste the key you were sent.';
      return;
    }
    $('linkError').textContent = /ENOENT|-9|EBLOCKED|-16/.test(m) ? 'This link no longer exists or was taken down.'
      : /EKEY|decrypt|Attributes|Invalid argument/.test(m) ? 'That decryption key doesn’t match this link.' : m;
  } finally { btn.disabled = false; btn.textContent = 'Open'; }
}

/* ---------------- Filtering, sorting, rendering ---------------- */
function applyFilters(keepScroll) {
  const q = state.query.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const k = state.kind;
  let r = state.all.filter((f) =>
    (k === 'all' || (k === 'media' ? (f.kind === 'photo' || f.kind === 'video') : f.kind === k)) &&
    terms.every((t) => f.lname.includes(t) || f.path.toLowerCase().includes(t)));
  const by = {
    new: (a, b) => b.ts - a.ts, old: (a, b) => a.ts - b.ts,
    big: (a, b) => b.size - a.size, small: (a, b) => a.size - b.size,
    name: (a, b) => a.lname.localeCompare(b.lname, undefined, { numeric: true }),
    folder: (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }) || a.lname.localeCompare(b.lname, undefined, { numeric: true })
  }[state.sort];
  r.sort(by);
  state.results = r;
  const total = r.reduce((n, f) => n + f.size, 0);
  const noun = { video: 'videos', photo: 'photos', media: 'photos & videos', audio: 'audio files', all: 'files' }[k];
  $('status').textContent = `${r.length.toLocaleString()} ${noun} · ${fmtSize(total)}`;
  $('grid').innerHTML = '';
  state.shown = 0;
  $('empty').classList.toggle('hidden', r.length > 0);
  $('empty').textContent = r.length ? '' : (q ? 'Nothing matches that name.' : `No ${noun} in this folder or its subfolders.`);
  renderMore();
  if (!keepScroll) window.scrollTo(0, 0);
}

const PLAY_ICON = '<svg viewBox="0 0 10 12"><path d="M0 0l10 6-10 6z" fill="#fff"/></svg>';
const tileIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const el = e.target; el._visible = e.isIntersecting;
    if (e.isIntersecting && !el._requested) {
      el._requested = true;
      const f = state.results[Number(el.dataset.i)];
      const type = state.cols >= 4 ? 0 : 1;
      enqueue({ wanted: () => el.isConnected && el._visible !== false, run: async () => {
        let url = await loadAttr(f, type).catch(() => null);
        if (!url && type === 1) url = await loadAttr(f, 0).catch(() => null);
        if (!url) { if (el.isConnected) el._requested = false; return; }
        const img = el.querySelector('img');
        img.onload = () => img.classList.add('loaded');
        img.src = url;
        el.querySelector('.ph').classList.add('hidden');
      } });
      // if it scrolled away before loading, let it try again next time
      setTimeout(() => { if (!el.querySelector('img').src) el._requested = false; }, 4000);
    }
  }
}, { rootMargin: '600px 0px' });

function tileFor(f, i) {
  const b = document.createElement('button');
  b.className = 'tile'; b.dataset.i = i;
  b.innerHTML = `<img alt="" decoding="async"><div class="ph">${f.ext || f.kind}</div>` +
    (f.kind === 'video' ? `<div class="play">${PLAY_ICON}</div>` : '') +
    `<div class="meta"><span class="n"></span><span class="s">${fmtSize(f.size)}</span></div>`;
  b.querySelector('.n').textContent = f.name;
  b.addEventListener('click', () => openViewer(i));
  if (DEMO) { const img = b.querySelector('img'); img.src = demoThumb(f, i); img.classList.add('loaded'); b.querySelector('.ph').classList.add('hidden'); }
  else tileIO.observe(b);
  return b;
}

function renderMore() {
  const grid = $('grid');
  const end = Math.min(state.results.length, state.shown + PAGE);
  const frag = document.createDocumentFragment();
  for (let i = state.shown; i < end; i++) frag.appendChild(tileFor(state.results[i], i));
  grid.appendChild(frag);
  state.shown = end;
}
new IntersectionObserver((e) => { if (e[0].isIntersecting && state.shown < state.results.length) renderMore(); }, { rootMargin: '1200px 0px' }).observe($('more'));

function setCols(n) {
  const changedTier = (state.cols >= 4) !== (n >= 4); // small tiles use small thumbs
  state.cols = n; LS.set('cols', n);
  document.documentElement.style.setProperty('--cols', n);
  $('grid').dataset.cols = n;
  for (const b of $('sizeSeg').children) b.classList.toggle('on', Number(b.dataset.cols) === n);
  if (changedTier && state.results.length) applyFilters(true);
}

/* ---------------- Viewer ---------------- */
let viewerOpen = false;
let viewToken = 0;

function openViewer(i) {
  if (!viewerOpen) { history.pushState({ viewer: true }, ''); viewerOpen = true; }
  $('viewer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  show(i);
}

function closeViewer(fromPop) {
  if (!viewerOpen) return;
  viewerOpen = false;
  clearStage();
  $('viewer').classList.add('hidden');
  document.body.style.overflow = '';
  const tile = document.querySelector(`.tile[data-i="${state.current}"]`);
  if (tile) tile.scrollIntoView({ block: 'nearest' });
  if (!fromPop) history.back();
}

function clearStage() {
  const v = $('stage').querySelector('video, audio');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  $('stage').innerHTML = '';
}

function stageMsg(html) { $('stage').innerHTML = `<div class="msg">${html}</div>`; }

async function show(i) {
  const f = state.results[i]; if (!f) return;
  const token = ++viewToken;
  document.querySelector('.tile.current')?.classList.remove('current');
  state.current = i;
  while (i >= state.shown) renderMore();
  document.querySelector(`.tile[data-i="${i}"]`)?.classList.add('current');
  $('vName').textContent = f.name;
  $('vPath').textContent = (f.path || 'Top level') + ' · ' + fmtSize(f.size);
  $('vCount').textContent = `${i + 1} of ${state.results.length}`;
  $('prevBtn').disabled = i === 0;
  $('nextBtn').disabled = i === state.results.length - 1;
  clearStage();
  const stale = () => token !== viewToken || !viewerOpen;

  if (DEMO) { $('stage').innerHTML = `<img src="${demoThumb(f, i)}">`; return; }

  try {
    if (f.kind === 'video') {
      if (!PLAYABLE_VIDEO.has(f.ext)) {
        stageMsg(`iPhone can’t play <b>.${f.ext}</b> videos in a browser. MP4 and MOV files work.`);
        return;
      }
      const v = document.createElement('video');
      v.controls = true; v.playsInline = true; v.autoplay = true; v.preload = 'metadata';
      v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
      $('stage').appendChild(v);
      loadAttr(f, 1).then((p) => { if (p && !stale()) v.poster = p; }).catch(() => {});
      await swReady;
      const src = await streamUrl(f);
      if (stale()) return;
      v.src = src;
      v.play().catch(() => {});
      v.addEventListener('error', () => { if (!stale()) stageMsg('This video couldn’t be played. It may use a format your phone doesn’t support, or MEGA’s transfer quota may be used up.'); });
    } else if (f.kind === 'photo') {
      const img = document.createElement('img');
      img.alt = f.name;
      $('stage').appendChild(img);
      const prev = await loadAttr(f, 1).catch(() => null) || await loadAttr(f, 0).catch(() => null);
      if (stale()) return;
      if (prev) img.src = prev;
      if (SHOWABLE_PHOTO.has(f.ext) && f.size < 60 * 1024 * 1024) {
        await swReady;
        const full = new Image();
        full.onload = () => { if (!stale()) img.src = full.src; };
        full.src = await streamUrl(f);
      } else if (!prev) stageMsg(`No preview available for .${f.ext} files.`);
    } else if (f.kind === 'audio') {
      const a = document.createElement('audio');
      a.controls = true; a.autoplay = true;
      a.style.width = '90%';
      $('stage').appendChild(a);
      await swReady;
      a.src = await streamUrl(f);
      a.play().catch(() => {});
    } else {
      stageMsg(`No preview for this file type.<br><br>${fmtSize(f.size)}`);
    }
  } catch (err) {
    if (!stale()) stageMsg('Couldn’t load this file: ' + (err && err.message || err));
  }
}

function step(d) {
  const n = state.current + d;
  if (n >= 0 && n < state.results.length) show(n);
}

// swipe left/right on photos to move through results
(() => {
  let x0 = null, y0 = 0;
  const st = $('stage');
  st.addEventListener('touchstart', (e) => { if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') { x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  st.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    else if (dy > 120 && Math.abs(dy) > Math.abs(dx) * 1.5) closeViewer();
    x0 = null;
  });
})();

/* ---------------- Folder picker ---------------- */
let pickStack = [];
function openSheet() {
  if (!currentRoot().directory) return;
  pickStack = [];
  // start at the chosen folder, with its parents as breadcrumbs
  let n = currentRoot();
  const chain = [];
  while (n) { chain.unshift(n); n = n.parent; }
  pickStack = chain.length ? chain : [rootChoices()[0].node];
  renderSheet();
  $('sheet').classList.remove('hidden');
}
function nodeLabel(n) { return state.storage && n === state.storage.root ? 'Cloud Drive' : (n.name || 'Folder'); }
function renderSheet() {
  const cur = pickStack[pickStack.length - 1];
  const crumbs = $('crumbs'); crumbs.innerHTML = '';
  if (pickStack.length > 1 || rootChoices().length > 1) {
    const top = document.createElement('button'); top.textContent = 'All'; top.onclick = () => { pickStack = []; renderSheet(); };
    crumbs.append(top);
  }
  pickStack.forEach((n, idx) => {
    crumbs.append(' / ');
    const b = document.createElement('button'); b.textContent = nodeLabel(n);
    b.onclick = () => { pickStack = pickStack.slice(0, idx + 1); renderSheet(); };
    crumbs.append(b);
  });
  const list = $('folderList'); list.innerHTML = '';
  const folders = cur ? (cur.children || []).filter((c) => c.directory).sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }))
    : rootChoices().map((c) => c.node);
  for (const f of folders) {
    const b = document.createElement('button'); b.className = 'item';
    const sub = (f.children || []).filter((c) => c.directory).length;
    b.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span class="t"></span><span class="c"></span>';
    b.querySelector('.t').textContent = nodeLabel(f);
    b.querySelector('.c').textContent = sub ? sub + ' ›' : '';
    b.onclick = () => { pickStack.push(f); renderSheet(); };
    list.append(b);
  }
  if (!folders.length) list.innerHTML = '<div class="empty" style="padding:30px">No subfolders</div>';
  $('sheetPick').disabled = !cur;
}
$('folderBtn').onclick = openSheet;
$('sheetCancel').onclick = () => $('sheet').classList.add('hidden');
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('sheet').classList.add('hidden'); });
$('sheetPick').onclick = () => {
  const cur = pickStack[pickStack.length - 1]; if (!cur) return;
  if (state.link) state.link.cur = cur;
  else { state.rootId = cur === state.storage.root ? null : cur.nodeId; LS.set('root', state.rootId); }
  $('sheet').classList.add('hidden');
  rebuild();
};

/* ---------------- Wiring ---------------- */
for (const c of $('chips').children) {
  c.onclick = () => { state.kind = c.dataset.kind; LS.set('kind', state.kind); markChips(); applyFilters(); };
}
function markChips() { for (const c of $('chips').children) c.classList.toggle('on', c.dataset.kind === state.kind); }
$('sort').value = state.sort;
$('sort').onchange = () => { state.sort = $('sort').value; LS.set('sort', state.sort); applyFilters(); };
let qTimer;
$('query').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.query = $('query').value; applyFilters(); }, 180); });
for (const b of $('sizeSeg').children) b.onclick = () => setCols(Number(b.dataset.cols));
$('closeBtn').onclick = () => closeViewer();
$('prevBtn').onclick = () => step(-1);
$('nextBtn').onclick = () => step(1);
window.addEventListener('popstate', () => closeViewer(true));
document.addEventListener('keydown', (e) => {
  if (!viewerOpen) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'ArrowLeft') step(-1);
});
$('refreshBtn').onclick = async () => {
  if (DEMO) return;
  setLoading('Refreshing…');
  try {
    if (state.link) { const l = state.link; await openLink(l.url); }
    else { await state.storage.reload(true); rebuild(); }
  } catch (e) { $('status').textContent = 'Refresh failed: ' + e.message; }
};
$('linkBtn').onclick = () => (state.link ? closeLink() : openLinkSheet());
$('loginLinkBtn').onclick = () => openLinkSheet();
$('linkCancel').onclick = () => $('linkSheet').classList.add('hidden');
$('linkSheet').addEventListener('click', (e) => { if (e.target.id === 'linkSheet') $('linkSheet').classList.add('hidden'); });
$('linkForm').addEventListener('submit', (e) => { e.preventDefault(); submitLink($('linkInput').value); });
function checkLinkNeedsKey() {
  const u = cleanLink($('linkInput').value);
  let need = false;
  try { need = !!u && !parseLink(u).key; } catch {}
  if (need) $('keyRow').classList.remove('hidden');
}
$('linkInput').addEventListener('input', checkLinkNeedsKey);
$('keyPaste').onclick = async () => {
  try { const t = await navigator.clipboard.readText(); $('keyInput').value = t.trim(); submitLink($('linkInput').value); }
  catch { $('linkError').textContent = 'Couldn’t read the clipboard. Long-press the key box and tap Paste.'; }
};
$('linkPaste').onclick = async () => {
  try { const t = await navigator.clipboard.readText(); $('linkInput').value = t; checkLinkNeedsKey(); if (cleanLink(t)) submitLink(t); }
  catch { $('linkError').textContent = 'Couldn’t read the clipboard. Long-press the box and tap Paste.'; }
};
$('logoutBtn').onclick = () => {
  if (!confirm('Sign out of MEGA on this phone?')) return;
  LS.del('session'); LS.del('root');
  if (state.storage && state.storage.close) state.storage.close().catch(() => {});
  if (thumbCache) caches.delete('fa-v1');
  location.reload();
};

function setLoading(text) {
  $('grid').innerHTML = '';
  $('empty').classList.remove('hidden');
  $('empty').innerHTML = `<div class="spinner"></div>${text}`;
  $('status').textContent = '';
}

function showMain() {
  $('login').classList.add('hidden');
  $('main').classList.remove('hidden');
  markChips(); setCols(state.cols);
  $('linkBtn').innerHTML = state.link ? ICON_CLOSE : ICON_LINK;
}

function showLogin(msg) {
  $('main').classList.add('hidden');
  $('login').classList.remove('hidden');
  $('loginError').textContent = msg || '';
  const saved = LS.get('email', '');
  if (saved && !$('email').value) $('email').value = saved;
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim(), pw = $('password').value, code = $('mfa').value.trim();
  $('loginBtn').disabled = true; $('loginBtn').textContent = 'Signing in…'; $('loginError').textContent = '';
  try {
    const s = await signIn(email, pw, code || undefined);
    state.storage = s;
    LS.set('email', email);
    if ($('remember').checked) saveSession(s); else LS.del('session');
    $('password').value = '';
    showMain(); rebuild();
  } catch (err) {
    const m = String(err && err.message || err);
    if (/EMFAREQUIRED|-26/.test(m)) {
      $('mfaField').classList.remove('hidden'); $('mfa').focus();
      $('loginError').textContent = 'Enter the 6-digit code from your authenticator app.';
    } else if (/ENOENT|-9|EACCESS|-11|password/i.test(m)) {
      $('loginError').textContent = 'Wrong email or password.';
    } else {
      $('loginError').textContent = 'Sign-in failed: ' + m;
    }
  } finally {
    $('loginBtn').disabled = false; $('loginBtn').textContent = 'Sign in';
  }
});

/* ---------------- Service worker ---------------- */
const swReady = (async () => {
  if (!('serviceWorker' in navigator)) throw new Error('This browser can’t stream files (no service worker support).');
  await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((res) => {
      navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
      setTimeout(res, 3000);
    });
  }
  if (!navigator.serviceWorker.controller) throw new Error('Please close and reopen the app once to finish setting it up.');
})();
swReady.catch(() => {});

/* ---------------- Demo mode (?demo) — fake data to preview the layout ---------------- */
function demoThumb(f, i) {
  const h = (i * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},55%,45%)"/><stop offset="1" stop-color="hsl(${(h + 60) % 360},60%,25%)"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="${120 + (i * 37) % 160}" cy="${130 + (i * 53) % 120}" r="${50 + (i % 4) * 15}" fill="rgba(255,255,255,.18)"/><path d="M0 400 L${140 + (i * 13) % 80} ${250 + (i * 7) % 60} L260 330 L330 270 L400 330 L400 400Z" fill="rgba(0,0,0,.28)"/></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
function startDemo() {
  const folders = ['Camera Uploads', 'Camera Uploads / 2025', 'Trips / Tasmania', 'Trips / Japan / Kyoto', 'Family', 'Screen recordings'];
  const exts = ['mp4', 'mov', 'jpg', 'heic', 'mp4', 'png', 'm4v', 'jpg'];
  const all = [];
  for (let i = 0; i < 300; i++) {
    const ext = exts[i % exts.length];
    all.push({ id: 'd' + i, name: (KIND_OF[ext] === 'video' ? 'VID_' : 'IMG_') + (20250000 + i * 97) + '.' + ext, ext, kind: KIND_OF[ext],
      size: (KIND_OF[ext] === 'video' ? 40e6 : 3e6) * (1 + (i * 31 % 17) / 4), ts: 1.7e9 - i * 86400, path: folders[i % folders.length] });
  }
  all.forEach((f) => (f.lname = f.name.toLowerCase()));
  state.all = all;
  state.storage = { root: {} };
  showMain();
  $('folderName').textContent = 'Cloud Drive';
  $('linkBtn').innerHTML = ICON_LINK;
  applyFilters();
}

/* ---------------- Start ---------------- */
(async () => {
  if (DEMO) return startDemo();
  if (!window.mega) return showLogin('Couldn’t load the MEGA library. Check your connection and reopen the app.');
  // Media Finder can be opened with a link: .../media-finder/?link=https://mega.nz/folder/...#key
  const startLink = new URLSearchParams(location.search).get('link') || (location.hash.startsWith('#https') ? decodeURIComponent(location.hash.slice(1)) : null);
  if (LS.get('session', null)) {
    showMain(); setLoading('Loading your files…');
    try {
      state.storage = await restoreSession();
      rebuild();
    } catch (e) {
      LS.del('session');
      if (!startLink) return showLogin('Your session expired. Please sign in again.');
    }
  }
  if (startLink) {
    history.replaceState(null, '', location.pathname);
    if ($('main').classList.contains('hidden')) showLogin();
    openLinkSheet(); $('linkInput').value = startLink; submitLink(startLink);
    return;
  }
  if (!state.storage) showLogin();
})();
})();
