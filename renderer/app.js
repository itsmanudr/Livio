'use strict';
(() => {
const lp = window.lp, $ = (s) => document.querySelector(s), clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const EASE = 'cubic-bezier(.32,.72,0,1)';
const S = { items: [], view: [], filter: 'all', cur: 0, open: false, sound: true, info: false };
const scroller = $('#scroller'), grid = $('#grid'), empty = $('#empty'), none = $('#none'), subtitle = $('#subtitle');
const viewer = $('#viewer'), stage = $('#vStage'), track = $('#vTrack'), tabbar = $('#tabbar'), strip = $('#strip'), sheet = $('#sheet');
let toastT = 0;
const toast = (m, ms = 5200) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = (d) => new Date(d).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/* ---------- disk cache (IndexedDB, in the data folder) ---------- */
const dbp = new Promise((res) => { try { const r = indexedDB.open('lp-cache', 1); r.onupgradeneeded = () => { r.result.createObjectStore('thumbs'); r.result.createObjectStore('meta'); }; r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (_) { res(null); } });
const idb = (st, mode, fn) => dbp.then((d) => (d ? new Promise((res) => { try { const tx = d.transaction(st, mode), r = fn(tx.objectStore(st)); tx.oncomplete = () => res(r && r.result); tx.onerror = tx.onabort = () => res(undefined); } catch (_) { res(undefined); } }) : undefined));
const idbGet = (st, k) => idb(st, 'readonly', (o) => o.get(k)), idbPut = (st, k, v) => idb(st, 'readwrite', (o) => o.put(v, k));
const idbMany = (st, keys) => dbp.then((d) => (!d ? [] : new Promise((res) => { const out = new Array(keys.length); try { const tx = d.transaction(st, 'readonly'), o = tx.objectStore(st); keys.forEach((k, i) => { o.get(k).onsuccess = (e) => { out[i] = e.target.result; }; }); tx.oncomplete = () => res(out); tx.onerror = tx.onabort = () => res(out); } catch (_) { res(out); } }))); 
const ckey = (f) => f.path + '|' + f.size + '|' + Math.round(f.mtime), TS = 300;
/* ---------- worker pool ---------- */
const workers = [], queue = [], pending = new Map(), cache = new Map(); let seq = 0;
async function initPool() {
  const [a, b] = await Promise.all([fetch('vendor/libheif-bundle.js').then((r) => r.text()), fetch('imgworker.js').then((r) => r.text())]);
  const WURL = URL.createObjectURL(new Blob([a + '\n' + b.replace(/importScripts\([^)]*\);/, '')], { type: 'text/javascript' }));
  for (let i = 0, n = clamp((navigator.hardwareConcurrency || 4) - 1, 2, 6); i < n; i++) {
    const w = new Worker(WURL); w.busy = false;
    w.onmessage = (e) => { const { id, blob, error } = e.data, j = pending.get(id); pending.delete(id); w.busy = false; if (j) error ? j.rej(new Error(error)) : j.res(blob); pump(); };
    w.onerror = () => { w.busy = false; pump(); };
    workers.push(w);
  }
  pump();
}
initPool().catch(() => toast('Could not start the image decoder.'));
function pump() {
  for (const w of workers) {
    if (w.busy) continue; let j; while ((j = queue.shift()) && j.skip && j.skip()) j.rej(new Error('skipped')); if (!j) return; w.busy = true;
    lp.readFile(j.file.path).then((buf) => { const id = ++seq; pending.set(id, j); w.postMessage({ id, buf, ext: j.file.ext, maxDim: j.max, quality: j.q }, [buf]); })
      .catch((e) => { w.busy = false; j.rej(e); pump(); });
  }
}
function renderURL(file, max, q, urgent, skip) {
  const k = file.path + '|' + max; if (cache.has(k)) return cache.get(k); const persist = max <= 400, key = ckey(file);
  const p = (persist ? idbGet('thumbs', key) : Promise.resolve(null)).then((b) => b || new Promise((res, rej) => { queue.unshift({ file, max, q, res, rej, skip }); pump(); })
    .then((bl) => { if (persist) idbPut('thumbs', key, bl); return bl; })).then((b) => URL.createObjectURL(b));
  p.catch(() => cache.delete(k)); cache.set(k, p); return p;
}
let vchain = Promise.resolve();
function videoThumb(it) {
  const k = 'v|' + it.vid.path; if (cache.has(k)) return cache.get(k);
  const key = ckey(it.vid);
  const job = vchain.then(async () => { const [cb, cd] = await Promise.all([idbGet('thumbs', 'v|' + key), idbGet('meta', 'd|' + key)]); if (cb) { it.dur = cd; return URL.createObjectURL(cb); }
    return new Promise((res, rej) => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = it.vid.url;
    const to = setTimeout(() => rej(new Error('timeout')), 9000);
    v.onloadedmetadata = () => { it.dur = v.duration; v.currentTime = Math.min(.1, v.duration / 2); };
    v.onseeked = () => { const s = 360 / Math.max(v.videoWidth, v.videoHeight), c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); c.toBlob((b) => { clearTimeout(to); v.removeAttribute('src'); v.load(); idbPut('thumbs', 'v|' + key, b); idbPut('meta', 'd|' + key, it.dur); res(URL.createObjectURL(b)); }, 'image/jpeg', .8); };
    v.onerror = () => { clearTimeout(to); rej(new Error('video')); };
  }); });
  vchain = job.catch(() => {}); cache.set(k, job); return job;
}
const thumbURL = (it, skip) => (it.type === 'video' ? videoThumb(it) : renderURL(it.img, TS, .78, false, skip));

/* ---------- library ---------- */
const dirOf = (p) => p.slice(0, p.length - p.split(/[\\/]/).pop().length);
const stemOf = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
async function build(files) {
  const m = new Map();
  for (const f of files) { const k = dirOf(f.path).toLowerCase() + stemOf(f.name); const e = m.get(k) || {}; e[f.kind] = f; m.set(k, e); }
  S.items = [...m.values()].map((e) => e.img ? { img: e.img, vid: e.vid || null, t: e.img.mtime, type: e.vid ? 'live' : 'photo', main: e.img } : { img: null, vid: e.vid, t: e.vid.mtime, type: 'video', main: e.vid })
    ;
  const got = await idbMany('meta', S.items.map((it) => 'm|' + ckey(it.main)));
  S.items.forEach((it, i) => { const c = got[i]; if (c) { it.t = c.t; if (c.x) it.exif0 = c.x; it.done = true; } });
  S.items.sort((a, b) => b.t - a.t); applyFilter(); readDates(S.items.filter((i) => !i.done));
}
function applyFilter() {
  S.view = S.items.filter((i) => S.filter === 'all' || i.type === S.filter);
  const has = S.items.length > 0; empty.hidden = has; grid.hidden = !S.view.length; none.hidden = !has || !!S.view.length;
  const c = (t) => S.items.filter((i) => i.type === t).length, ph = c('photo') + c('live'), vd = c('video');
  subtitle.textContent = has ? [ph && `${ph} ${ph === 1 ? 'photo' : 'photos'}`, c('live') && `${c('live')} Live`, vd && `${vd} ${vd === 1 ? 'video' : 'videos'}`].filter(Boolean).join(' · ') + (S.reading ? ' · reading dates…' : '') : '';
  renderGrid();
}
const io = new IntersectionObserver((es) => { for (const e of es) { const t = e.target; t._vis = e.isIntersecting; if (!e.isIntersecting || t._req || t.classList.contains('ready')) continue;
  t._req = true; const it = S.view[+t.dataset.i];
  thumbURL(it, () => !t._vis || !t.isConnected).then((u) => { t.querySelector('img').src = u; t.classList.add('ready'); const d = t.querySelector('.dur'); if (d && it.dur) d.textContent = fmtDur(it.dur); })
    .catch((err) => { t._req = false; if (!/skipped/.test(err && err.message)) { t._req = true; t.classList.add('ready'); } }); } }, { root: scroller, rootMargin: '600px' });
function renderGrid() {
  io.disconnect(); grid.textContent = ''; const f = document.createDocumentFragment();
  S.view.forEach((it, i) => { const t = document.createElement('div'); t.className = 'tile' + (it.type !== 'photo' ? ' has-b' : ''); t.dataset.i = i;
    t.innerHTML = '<img draggable="false" alt="">' + (it.type === 'live' ? '<span class="b bl"><svg class="i"><use href="#i-live"/></svg></span>' : it.type === 'video' ? '<span class="b bl"><svg class="i"><use href="#i-video"/></svg></span><span class="b br dur"></span>' : '');
    t.onclick = () => openViewer(i, t); f.append(t); io.observe(t); });
  grid.append(f); requestAnimationFrame(railUpdate); grid.animate([{ opacity: 0, transform: 'scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: EASE });
}
async function load(paths) { if (!paths || !paths.length) return; const files = await lp.scan(paths); if (!files.length) return toast('No photos or videos found in this folder.'); scroller.scrollTop = 0; build(files); }
const rail = $('#rail'), rthumb = $('#railThumb'), rbub = $('#railBubble'), TH = 56; let railT = 0, rdrag = false;
const monthLabel = (ms) => { const x = new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); return x[0].toUpperCase() + x.slice(1); };
function labelAt() { const t0 = grid.firstElementChild; if (!t0 || !S.view.length) return ''; const tw = t0.offsetWidth + 2, cols = Math.max(1, Math.round((grid.clientWidth + 2) / tw));
  const row = Math.max(0, Math.floor((scroller.scrollTop - grid.offsetTop + tw * .5) / tw)); return monthLabel(S.view[Math.min(S.view.length - 1, row * cols)].t); }
function railUpdate() { const max = scroller.scrollHeight - scroller.clientHeight; rail.hidden = max < 80 || !S.view.length; if (rail.hidden) return;
  const y = clamp(scroller.scrollTop / max, 0, 1) * Math.max(0, rail.clientHeight - TH); rthumb.style.transform = `translateY(${y}px)`; rbub.style.top = y + TH / 2 + 'px'; rbub.textContent = labelAt(); }
scroller.addEventListener('scroll', () => { document.documentElement.style.setProperty('--p', clamp(scroller.scrollTop / 56, 0, 1)); railUpdate(); rail.classList.add('show'); clearTimeout(railT); railT = setTimeout(() => { if (!rdrag) rail.classList.remove('show'); }, 1000); }, { passive: true });
const railMove = (e) => { const r = rail.getBoundingClientRect(); scroller.scrollTop = clamp((e.clientY - r.top - TH / 2) / Math.max(1, r.height - TH), 0, 1) * (scroller.scrollHeight - scroller.clientHeight); };
rail.addEventListener('pointerdown', (e) => { rail.setPointerCapture(e.pointerId); rdrag = true; rail.classList.add('drag'); railMove(e); });
rail.addEventListener('pointermove', (e) => { if (rdrag) railMove(e); });
const railEnd = () => { rdrag = false; rail.classList.remove('drag'); clearTimeout(railT); railT = setTimeout(() => rail.classList.remove('show'), 900); };
rail.addEventListener('pointerup', railEnd); rail.addEventListener('pointercancel', railEnd); addEventListener('resize', railUpdate);
const pick = async () => load(await lp.pick());
const dragEl = (el) => { el.addEventListener('mousedown', (e) => { if (e.button || e.target.closest('button,input,.strip,.scrub')) return; lp.win.drag(); });
  el.addEventListener('dblclick', (e) => { if (!e.target.closest('button,input,.strip,.scrub')) lp.win.max(); }); };
dragEl(topbar); dragEl($('.v-top'));
$('#wMin').onclick = () => lp.win.min(); $('#wMax').onclick = () => lp.win.max(); $('#wClose').onclick = () => lp.win.close();
$('#btnOpen').onclick = pick; $('#btnOpen2').onclick = pick;
tabbar.querySelectorAll('button').forEach((b, i) => b.onclick = () => {
  S.filter = b.dataset.f; tabbar.style.setProperty('--i', i);
  tabbar.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b)); scroller.scrollTop = 0; applyFilter();
});
addEventListener('dragover', (e) => e.preventDefault()); addEventListener('drop', (e) => e.preventDefault());

/* ---------- EXIF (JPEG + HEIC) ---------- */
const u32 = (u, o) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0, u16 = (u, o) => (u[o] << 8) | u[o + 1], t4 = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
function parseTiff(buf, k) {
  try {
    const dv = new DataView(buf, k), le = dv.getUint16(0) === 0x4949, g16 = (o) => dv.getUint16(o, le), g32 = (o) => dv.getUint32(o, le);
    const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const val = (off) => { const t = g16(off + 2), c = g32(off + 4), n = (SZ[t] || 1) * c, p = n <= 4 ? off + 8 : g32(off + 8); let o = [];
      if (t === 2) { let s = ''; for (let i = 0; i < c - 1; i++) s += String.fromCharCode(dv.getUint8(p + i)); return s.trim(); }
      for (let i = 0; i < Math.min(c, 8); i++) o.push(t === 3 ? g16(p + i * 2) : t === 4 ? g32(p + i * 4) : t === 9 ? dv.getInt32(p + i * 4, le) : t === 5 ? g32(p + i * 8) / (g32(p + i * 8 + 4) || 1) : t === 10 ? dv.getInt32(p + i * 8, le) / (dv.getInt32(p + i * 8 + 4, le) || 1) : dv.getUint8(p + i));
      return c === 1 ? o[0] : o; };
    const ifd = (off) => { const m = {}; try { const n = g16(off); for (let i = 0; i < n; i++) { const e = off + 2 + 12 * i; m[g16(e)] = val(e); } } catch (_) {} return m; };
    const a = ifd(g32(4)), e = a[0x8769] ? ifd(a[0x8769]) : {}, g = a[0x8825] ? ifd(a[0x8825]) : {};
    const dms = (v) => (Array.isArray(v) && v.length >= 3 ? v[0] + v[1] / 60 + v[2] / 3600 : null);
    const m = { make: a[0x10f], model: a[0x110], lens: e[0xa434], iso: Array.isArray(e[0x8827]) ? e[0x8827][0] : e[0x8827], f: e[0x829d], exp: e[0x829a], fl: e[0x920a], fl35: e[0xa405], ev: e[0x9204], w: e[0xa002], h: e[0xa003] };
    const d = e[0x9003] || e[0x9004] || a[0x132]; if (d) { const q = String(d).match(/(\d+):(\d+):(\d+)[ T](\d+):(\d+):(\d+)/); if (q && +q[1] > 1971) m.dt = new Date(+q[1], q[2] - 1, +q[3], +q[4], +q[5], +q[6]); }
    const la = dms(g[2]), lo = dms(g[4]); if (la != null && lo != null) { m.lat = g[1] === 'S' ? -la : la; m.lon = g[3] === 'W' ? -lo : lo; if (typeof g[6] === 'number') m.alt = g[5] === 1 ? -g[6] : g[6]; }
    return m;
  } catch (_) { return null; }
}
function heifExif(u, s, e) {
  let id = null, loc = null;
  for (let p = s; p + 8 <= e;) { const sz = u32(u, p), ty = t4(u, p + 4); if (sz < 8) break;
    if (ty === 'iinf') { const v = u[p + 8]; let q = p + 12 + (v ? 4 : 2); const end = p + sz;
      while (q + 8 <= end) { const isz = u32(u, q); if (t4(u, q + 4) === 'infe') { const iv = u[q + 8]; if (iv >= 2) { const il = iv === 2 ? 2 : 4, iid = il === 2 ? u16(u, q + 12) : u32(u, q + 12); if (t4(u, q + 12 + il + 2) === 'Exif') id = iid; } } if (isz < 8) break; q += isz; } }
    if (ty === 'iloc') loc = p;
    p += sz; }
  if (id == null || loc == null) return null;
  const p = loc, v = u[p + 8], a = u[p + 12] >> 4, b = u[p + 12] & 15, c = u[p + 13] >> 4, d = v ? u[p + 13] & 15 : 0; let q = p + 14;
  const rd = (n) => { let x = 0; for (let i = 0; i < n; i++) x = x * 256 + u[q + i]; q += n; return x; };
  const cnt = v < 2 ? rd(2) : rd(4);
  for (let i = 0; i < cnt; i++) { const iid = v < 2 ? rd(2) : rd(4); if (v >= 1) rd(2); rd(2); const base = rd(c), ec = rd(2); let off = 0, len = 0;
    for (let j = 0; j < ec; j++) { if (d > 0) rd(d); const o = rd(a), l = rd(b); if (j === 0) { off = o; len = l; } }
    if (iid === id) { const st = base + off; if (u.length < st + len) return { need: st + len }; return { k: st + 4 + u32(u, st) }; } }
  return null;
}
function locateExif(u) {
  if (u.length < 16) return { need: 262144 };
  if (u[0] === 0xff && u[1] === 0xd8) { let p = 2; while (p + 4 < u.length) { if (u[p] !== 0xff) return null; const m = u[p + 1], L = u16(u, p + 2);
    if (m === 0xe1 && t4(u, p + 4) === 'Exif') return u.length >= p + 2 + L ? { k: p + 10 } : { need: p + 2 + L }; if (m === 0xda) return null; p += 2 + L; } return { need: u.length + 65536 }; }
  if (t4(u, 4) === 'ftyp') { for (let p = 0; p + 8 <= u.length;) { let sz = u32(u, p), hs = 8; const ty = t4(u, p + 4); if (sz === 1) { sz = u32(u, p + 12); hs = 16; } if (!sz) sz = u.length - p;
    if (ty === 'meta') return u.length < p + sz ? { need: p + sz } : heifExif(u, p + hs + 4, p + sz); p += sz; } return { need: u.length + 65536 }; }
  return null;
}
async function exifOf(file) { // reads only the start of the file (HEIC/JPEG) until it finds the EXIF data
  try {
    const rd = (await fetch(file.url)).body.getReader(); let ch = [], tot = 0, want = 262144;
    for (;;) { const { done, value } = await rd.read(); if (value) { ch.push(value); tot += value.length; }
      if (tot >= want || done) { const buf = new Uint8Array(tot); let o = 0; for (const c of ch) { buf.set(c, o); o += c.length; } ch = [buf];
        const loc = locateExif(buf); if (!loc) { rd.cancel().catch(() => {}); return null; }
        if (loc.k != null) { rd.cancel().catch(() => {}); return parseTiff(buf.buffer, loc.k); }
        if (done) return null; want = loc.need; } }
  } catch (_) { return null; }
}
async function videoDate(file) { // creation date from the MOV/MP4 mvhd box
  if (file.size > 120e6) return null;
  try { const u = new Uint8Array(await lp.readFile(file.path));
    for (let p = 0; p + 8 <= u.length;) { let sz = u32(u, p), hs = 8; const ty = t4(u, p + 4); if (sz === 1) { sz = u32(u, p + 12); hs = 16; } if (!sz) sz = u.length - p;
      if (ty === 'moov') { for (let q = p + hs; q + 8 <= p + sz;) { const s2 = u32(u, q); if (t4(u, q + 4) === 'mvhd') { const ct = u[q + 8] === 1 ? u32(u, q + 12) * 4294967296 + u32(u, q + 16) : u32(u, q + 12); return ct ? new Date((ct - 2082844800) * 1000) : null; } if (s2 < 8) break; q += s2; } return null; }
      if (sz < 8) break; p += sz; } } catch (_) {}
  return null;
}
let dateRun = 0;
async function readDates(items) {
  if (!items.length) return; const run = ++dateRun; await new Promise((r) => setTimeout(r, 1500)); S.reading = true; subtitle.textContent += ' · reading dates…'; let i = 0;
  const work = async () => { while (i < items.length && run === dateRun) { const it = items[i++];
    try { if (it.img) { const x = await exifOf(it.img); if (x) { it.exif0 = x; if (x.dt) it.t = +x.dt; } } else { const d = await videoDate(it.vid); if (d) it.t = +d; } idbPut('meta', 'm|' + ckey(it.main), { t: it.t, x: it.exif0 || null }); } catch (_) {} } };
  await Promise.all([work(), work()]); if (run !== dateRun) return; S.reading = false; resort();
}
function resort() { if (S.open) { S.pendingSort = true; subtitle.textContent = subtitle.textContent.replace(' · reading dates…', ''); return; } S.items.sort((a, b) => b.t - a.t); applyFilter(); }
function vmeta(file) { return new Promise((res) => { const v = document.createElement('video'); v.preload = 'metadata'; v.src = file.url;
  const to = setTimeout(() => res({}), 4000); v.onloadedmetadata = () => { clearTimeout(to); res({ dur: v.duration, w: v.videoWidth, h: v.videoHeight }); v.removeAttribute('src'); v.load(); }; v.onerror = () => { clearTimeout(to); res({}); }; }); }
async function getMeta(it) {
  if (it.meta) return it.meta; const m = { exif: null, v: null };
  if (it.img) { try { m.exif = it.exif0 || await exifOf(it.img); } catch (_) {} }
  if (it.vid) m.v = await vmeta(it.vid);
  return (it.meta = m);
}

/* ---------- info sheet ---------- */
const row = (a, b) => `<div class="row"><span>${a}</span><span>${esc(b)}</span></div>`;
async function renderInfo() {
  const it = S.view[S.cur], body = $('#sheetBody'); if (!it) return;
  body.innerHTML = `<h2>${fmtDate(it.t)}</h2><p class="sub">${fmtTime(it.t)} · ${esc(it.main.name)}</p>`;
  const m = await getMeta(it); if (it !== S.view[S.cur]) return;
  const x = m.exif || {}, when = x.dt || it.t; let h = `<h2>${fmtDate(when)}</h2><p class="sub">${fmtTime(when)} · ${esc(it.main.name)}</p>`;
  if (x.model) {
    const dev = (x.model.startsWith(x.make || '#') ? x.model : [x.make, x.model].filter(Boolean).join(' ')), len = x.lens || '';
    const cam = /front/i.test(len) ? 'Front camera' : /back/i.test(len) ? 'Back camera' : 'Camera';
    const mm = Math.round(x.fl35 || x.fl || 0), W = x.w || (m.v && m.v.w), H = x.h || (m.v && m.v.h);
    h += `<div class="card"><div class="hd"><span>${esc(dev)}</span><span class="tag">${esc(it.main.ext.toUpperCase())}</span></div>`;
    h += `<div class="ln">${cam}${mm ? ` — ${mm} mm` : ''}${x.f ? ` ƒ${(+x.f).toFixed(2).replace(/\.?0+$/, '')}` : ''}</div>`;
    if (W && H) h += `<div class="ln">${(W * H / 1e6).toFixed(0)} MP · ${W} × ${H} · ${fmtSize(it.main.size)}</div>`;
    const ch = [[x.iso, 'ISO'], [mm && mm + ' mm', 'Focal'], [x.ev != null && (+x.ev).toFixed(0) + ' ev', 'Exposure'], [x.f && 'ƒ' + (+x.f).toFixed(1), 'Aperture'], [x.exp && (x.exp < 1 ? '1/' + Math.round(1 / x.exp) : x.exp) + ' s', 'Shutter']].filter((c) => c[0] || c[0] === 0);
    if (ch.length) h += `<div class="chips">${ch.map((c) => `<div><b>${esc(c[0])}</b><small>${c[1]}</small></div>`).join('')}</div>`;
    h += '</div>';
  }
  if (x.lat != null) h += `<div class="card"><div class="hd"><span>Location</span><span class="link" id="cpLoc">Copy</span></div><div class="ln">${Math.abs(x.lat).toFixed(5)}° ${x.lat < 0 ? 'S' : 'N'}, ${Math.abs(x.lon).toFixed(5)}° ${x.lon < 0 ? 'W' : 'E'}${x.alt != null ? ` · ${Math.round(x.alt)} m` : ''}</div></div>`;
  const kind = it.type === 'live' ? 'Live Photo' : it.type === 'video' ? 'Video' : 'Photo';
  h += `<div class="card">${row('Type', kind + ' · ' + it.main.ext.toUpperCase())}${row('Name', it.main.name)}${row('Size', fmtSize(it.main.size) + (it.vid && it.img ? ' + ' + fmtSize(it.vid.size) : ''))}`;
  if (it.type === 'video' && m.v && m.v.w) h += row('Resolution', `${m.v.w} × ${m.v.h}`) + row('Duration', fmtDur(m.v.dur));
  if (it.type === 'live' && m.v && m.v.dur) h += row('Live duration', m.v.dur.toFixed(1) + ' s');
  h += row('Folder', dirOf(it.main.path).replace(/[\\/]$/, '')) + '</div>';
  body.innerHTML = h; const c = $('#cpLoc'); if (c) c.onclick = () => { navigator.clipboard.writeText(`${x.lat.toFixed(6)}, ${x.lon.toFixed(6)}`).then(() => { c.textContent = 'Copied'; }); };
}
function openInfo() { if (!S.open || S.info) return; S.info = true; viewer.classList.add('info'); viewer.classList.remove('bare'); $('#sheetBody').scrollTop = 0; renderInfo(); }
function closeInfo() { if (!S.info) return; S.info = false; viewer.classList.remove('info'); }
$('#vInfo').onclick = () => (S.info ? closeInfo() : openInfo());
let gp = null; const grab = $('#grab');
grab.addEventListener('pointerdown', (e) => { grab.setPointerCapture(e.pointerId); gp = e.clientY; });
grab.addEventListener('pointerup', (e) => { if (gp != null && e.clientY - gp > 30) closeInfo(); gp = null; });

/* ---------- viewer ---------- */
let slides = [], playT = 0;
const vidOf = (i) => slides[i] && slides[i].querySelector('video');
function buildSlides() {
  track.textContent = ''; slides = S.view.map((it, i) => { const s = document.createElement('div'); s.className = 'slide ' + it.type; s.style.left = i * 100 + '%';
    s.innerHTML = it.type === 'video' ? '<video playsinline preload="metadata"></video><div class="bigplay"><svg class="i"><use href="#i-play"/></svg></div>' : '<img draggable="false" alt="">' + (it.vid ? '<video playsinline preload="none"></video>' : ''); track.append(s); return s; });
}
let stripBase = 0, sio = null, stripRebuilt = false;
function buildStrip(c = S.cur) {
  strip.textContent = ''; if (sio) sio.disconnect(); stripRebuilt = true;
  sio = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { sio.unobserve(e.target); thumbURL(S.view[+e.target.dataset.i]).then((u) => { e.target.firstChild.src = u; e.target.classList.add('ready'); }).catch(() => {}); } }, { root: strip, rootMargin: '0px 300px' });
  const a = Math.max(0, c - 250), b = Math.min(S.view.length - 1, c + 250); stripBase = a;
  for (let i = a; i <= b; i++) { const d = document.createElement('div'); d.className = 'st'; d.dataset.i = i; d.innerHTML = '<img draggable="false" alt="">'; d.onclick = () => show(i, true); strip.append(d); sio.observe(d); }
}
const setPos = (dx = 0, drag = false) => { track.classList.toggle('drag', drag); track.style.transform = `translateX(calc(${-S.cur * 100}% + ${dx}px))`; };
function ensure(i) { for (const k of [i, i - 1, i + 1]) { const s = slides[k], it = S.view[k]; if (!s || s.loaded) continue; s.loaded = true;
  if (it.type === 'video') { videoThumb(it).then((u) => { const v = s.querySelector('video'); if (v && !v.poster) v.poster = u; }).catch(() => {}); continue; }
  renderURL(it.img, 2600, .92, k === i).then((u) => { s.querySelector('img').src = u; }).catch(() => { s.loaded = false; toast('Could not read this photo.'); }); } }
function stop(i = S.cur) { clearTimeout(playT); const s = slides[i], v = vidOf(i); if (!v) return; v.pause(); if (S.view[i].type === 'live') s.classList.remove('playing'); $('#vLive').classList.remove('on'); }
function bindVideo(i, v) {
  const it = S.view[i], s = slides[i]; if (v.src) return; v.src = it.vid.url;
  v.onerror = () => { s.classList.remove('playing'); toast('The video will not start: install "HEVC Video Extensions" from the Microsoft Store.'); };
  v.onended = () => { s.classList.remove('playing'); $('#vLive').classList.remove('on'); };
  if (it.type === 'video') { v.onplay = () => s.classList.add('playing'); v.onpause = () => s.classList.remove('playing');
    v.ontimeupdate = () => { if (i !== S.cur) return; $('#tCur').textContent = fmtDur(v.currentTime); $('#tDur').textContent = fmtDur(v.duration); if (!rngDrag) $('#rng').value = (v.currentTime / (v.duration || 1)) * 1000; }; }
}
function play(i = S.cur) {
  const it = S.view[i], v = vidOf(i); if (!it || !v) return; bindVideo(i, v); v.muted = !S.sound; if (it.type === 'live') v.currentTime = 0;
  v.play().then(() => { if (i === S.cur && it.type === 'live') { slides[i].classList.add('playing'); $('#vLive').classList.add('on'); } }).catch(() => {});
}
let rngDrag = false; const rng = $('#rng');
rng.addEventListener('pointerdown', () => { rngDrag = true; }); addEventListener('pointerup', () => { rngDrag = false; });
rng.addEventListener('input', () => { const v = vidOf(S.cur); if (v && v.duration) v.currentTime = (rng.value / 1000) * v.duration; });
function show(i, auto = true) {
  stop(); S.cur = clamp(i, 0, S.view.length - 1); setPos(0); ensure(S.cur);
  const it = S.view[S.cur], when = it.t; $('#vTitle').innerHTML = `${fmtDate(when)}<small>${fmtTime(when)}</small>`;
  $('#vLive').classList.toggle('off', it.type !== 'live'); $('#vScrub').hidden = it.type !== 'video'; $('#rng').value = 0; $('#tCur').textContent = '0:00'; $('#tDur').textContent = it.dur ? fmtDur(it.dur) : '0:00';
  const sl = strip.children.length; stripRebuilt = false;
  if ((S.cur < stripBase + 30 && stripBase > 0) || (S.cur > stripBase + sl - 30 && stripBase + sl < S.view.length)) buildStrip(S.cur);
  strip.querySelectorAll('.st.on').forEach((e) => e.classList.remove('on')); const el = strip.children[S.cur - stripBase];
  if (el) { el.classList.add('on'); strip.scrollTo({ left: el.offsetLeft - strip.clientWidth / 2 + 22, behavior: stripRebuilt ? 'auto' : 'smooth' }); }
  if (S.info) renderInfo();
  if (auto && it.vid) playT = setTimeout(() => play(S.cur), it.type === 'video' ? 450 : 380);
}
function hero(el, r, inward) {
  const W = innerWidth, H = innerHeight, s = Math.max(r.width / W, r.height / H), small = `translate(${r.left + r.width / 2 - W / 2}px,${r.top + r.height / 2 - H / 2}px) scale(${s})`;
  const cs = getComputedStyle(el).transform; el.animate(inward ? [{ transform: small, borderRadius: '6px' }, { transform: 'none', borderRadius: '0px' }] : [{ transform: cs === 'none' ? 'none' : cs }, { transform: small, borderRadius: '6px' }], { duration: inward ? 480 : 360, easing: EASE, fill: inward ? 'none' : 'forwards' });
}
const chromes = () => viewer.querySelectorAll('.chrome');
function openViewer(i, tile) {
  $('#wc').classList.add('dark'); S.open = true; S.info = false; viewer.className = 'viewer'; viewer.hidden = false; buildSlides(); buildStrip(i); show(i, false);
  viewer.animate([{ backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: '#000' }], { duration: 380, easing: EASE });
  chromes().forEach((c) => c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, delay: 180, fill: 'backwards' }));
  if (tile) hero(stage, tile.getBoundingClientRect(), true);
  const it = S.view[S.cur]; if (it.vid) playT = setTimeout(() => play(S.cur), 560);
}
function closeViewer() {
  if (!S.open) return; S.open = false; stop(); closeInfo(); const tile = grid.querySelector(`.tile[data-i="${S.cur}"]`); let r = null;
  if (tile) { tile.scrollIntoView({ block: 'nearest' }); r = tile.getBoundingClientRect(); }
  viewer.style.pointerEvents = 'none'; const d = 360;
  if (r) hero(stage, r, false); else stage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: d, fill: 'forwards' });
  viewer.animate([{ backgroundColor: getComputedStyle(viewer).backgroundColor }, { backgroundColor: 'rgba(0,0,0,0)' }], { duration: d, fill: 'forwards' });
  chromes().forEach((c) => c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }));
  setTimeout(() => { viewer.hidden = true; viewer.className = 'viewer'; viewer.style.cssText = ''; [stage, viewer, ...chromes()].forEach((e) => e.getAnimations().forEach((a) => a.cancel())); stage.style.transform = ''; track.textContent = ''; strip.textContent = ''; $('#wc').classList.remove('dark'); if (S.pendingSort) { S.pendingSort = false; resort(); } }, d + 30);
}
$('#vBack').onclick = closeViewer;
$('#vSound').onclick = () => { S.sound = !S.sound; $('#vSoundUse').setAttribute('href', S.sound ? '#i-spk' : '#i-mute'); const v = vidOf(S.cur); if (v) v.muted = !S.sound; lp.setState({ sound: S.sound }); };

let p = null;
stage.addEventListener('pointerdown', (e) => { if (e.button) return; stage.setPointerCapture(e.pointerId);
  p = { x: e.clientX, y: e.clientY, t: performance.now(), mode: null, hold: false }; clearTimeout(playT);
  if (S.view[S.cur].type === 'live' && !S.info) p.timer = setTimeout(() => { if (p && !p.mode) { p.hold = true; play(S.cur); } }, 220); });
stage.addEventListener('pointermove', (e) => { if (!p) return; const dx = e.clientX - p.x, dy = e.clientY - p.y;
  if (!p.mode && !p.hold && Math.hypot(dx, dy) > 8) { clearTimeout(p.timer); p.mode = Math.abs(dx) > Math.abs(dy) && !S.info ? 'h' : 'v'; if (p.mode === 'h') stop(); stage.classList.add('drag'); }
  if (p.mode === 'h') { const edge = (S.cur === 0 && dx > 0) || (S.cur === S.view.length - 1 && dx < 0); setPos(edge ? dx / 3.5 : dx, true); }
  if (p.mode === 'v' && !S.info) { if (dy > 0) { stage.style.transform = `translateY(${dy}px) scale(${1 - dy / 1600})`; stage.style.borderRadius = Math.min(28, dy / 6) + 'px'; viewer.style.background = `rgba(0,0,0,${1 - dy / 520})`; chromes().forEach((c) => (c.style.opacity = Math.max(0, 1 - dy / 160))); } else stage.style.transform = `translateY(${dy / 3}px)`; } });
function end(e) { if (!p) return; const q = p; p = null; clearTimeout(q.timer); stage.classList.remove('drag');
  const dx = e.clientX - q.x, dy = e.clientY - q.y, v = dx / Math.max(1, performance.now() - q.t);
  if (q.hold) return stop();
  if (q.mode === 'h') return show(S.cur + (dx < -60 || v < -.5 ? 1 : dx > 60 || v > .5 ? -1 : 0), true);
  if (q.mode === 'v') {
    if (S.info) { if (dy > 40) closeInfo(); return; }
    chromes().forEach((c) => (c.style.opacity = '')); if (dy < -70) { stage.style.transform = ''; return openInfo(); }
    if (dy > 110) return closeViewer();
    stage.style.transform = ''; stage.style.borderRadius = ''; viewer.style.background = ''; return;
  }
  if (S.info) return closeInfo();
  const it = S.view[S.cur]; if (it.type === 'video') { const vv = vidOf(S.cur); bindVideo(S.cur, vv); vv.paused ? (vv.muted = !S.sound, vv.play().catch(() => {})) : vv.pause(); } else viewer.classList.toggle('bare');
}
stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
let wl = 0; stage.addEventListener('wheel', (e) => { e.preventDefault(); if (Date.now() - wl < 260 || S.info) return; const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; if (Math.abs(d) < 8) return; wl = Date.now(); show(S.cur + (d > 0 ? 1 : -1)); }, { passive: false });
addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); return pick(); }
  if (e.key === 'F11') { e.preventDefault(); return lp.win.full(); }
  if (!S.open) return;
  if (e.key === 'Escape') (S.info ? closeInfo() : closeViewer()); else if (e.key === 'ArrowRight') show(S.cur + 1); else if (e.key === 'ArrowLeft') show(S.cur - 1);
  else if (e.key.toLowerCase() === 'i') (S.info ? closeInfo() : openInfo());
  else if (e.key === ' ') { e.preventDefault(); const v = vidOf(S.cur); if (v && !v.paused) stop(); else play(); }
});
(async () => { const st = await lp.getState(); if (st.sound === false) { S.sound = false; $('#vSoundUse').setAttribute('href', '#i-mute'); } if (st.launch && st.launch.length) load(st.launch); })();
})();
