// Keeps the library in your private cloud storage (Vercel Blob, through /api/file).
// Layout:
//   library/index.json          list of papers (title, small cover, version of their notes)
//   library/papers/<id>.json    highlights + notes for one paper
//   library/pdfs/<id>.pdf       the PDF itself
//   library/prefs.json          model choices, colors, answer style
// Files over 3.5 MB are stored in parts with a small manifest at the main path.
import { settings, mergeData, getDirty, clearDirty, counts, emptyData, sharedPrefs, applySharedPrefs } from './store.js';
import { idbGet, idbPut, idbAll, uid } from './util.js';
import { api, getToken, errorFrom } from './api.js';

export const syncState = { status: 'off', msg: '', at: 0 };
let running = false, again = false, timer = 0;
const PART = 3_500_000;
const enc = new TextEncoder(), dec = new TextDecoder();

function set(status, msg = '') {
  Object.assign(syncState, { status, msg });
  if (status === 'idle') syncState.at = Date.now();
  dispatchEvent(new CustomEvent('pl:sync', { detail: syncState }));
}
export const syncOn = () => !!getToken();

class Conflict extends Error { constructor() { super('conflict'); this.conflict = true; } }
const fileURL = (p, cache) => `api/file?path=${encodeURIComponent(p)}${cache ? '&cache=1' : ''}`;

async function getFile(path, { cache = false } = {}) {
  const r = await api(fileURL(path, cache));
  if (r.status === 404) return null;
  if (!r.ok) throw await errorFrom(r);
  return { bytes: new Uint8Array(await r.arrayBuffer()), etag: r.headers.get('etag'), type: r.headers.get('content-type') || '' };
}
async function putFile(path, bytes, { ifMatch, createOnly, type = 'application/octet-stream' } = {}) {
  const headers = { 'content-type': type };
  if (ifMatch) headers['if-match'] = ifMatch; else if (createOnly) headers['if-none-match'] = '*';
  const r = await api(fileURL(path), { method: 'PUT', body: bytes, headers });
  if (r.status === 412) throw new Conflict();
  if (!r.ok) throw await errorFrom(r);
  return (await r.json()).etag;
}

export async function readBig(path, opts) {
  const f = await getFile(path, opts);
  if (!f) return null;
  if (f.bytes.length < 4000 && f.bytes[0] === 123) {
    let m = null; try { m = JSON.parse(dec.decode(f.bytes)); } catch (e) {}
    if (m && m.__chunks) {
      const parts = [];
      for (let i = 0; i < m.__chunks; i++) {
        const p = await getFile(`${path}.${m.ver}.${i}`, { cache: true });
        if (!p) throw new Error('Part of a file is missing in cloud storage.');
        parts.push(p.bytes);
      }
      const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      return { bytes: all, etag: f.etag };
    }
  }
  return f;
}
export async function writeBig(path, bytes, { ifMatch, createOnly, type } = {}) {
  if (bytes.length <= PART) return putFile(path, bytes, { ifMatch, createOnly, type });
  const ver = uid(), n = Math.ceil(bytes.length / PART);
  for (let i = 0; i < n; i++) await putFile(`${path}.${ver}.${i}`, bytes.subarray(i * PART, (i + 1) * PART));
  return putFile(path, enc.encode(JSON.stringify({ __chunks: n, ver, size: bytes.length, type })), { ifMatch, createOnly, type: 'application/json' });
}
async function readJSON(path) {
  const f = await readBig(path);
  if (!f) return null;
  return { data: JSON.parse(dec.decode(f.bytes)), etag: f.etag };
}
const writeJSON = (path, data, etag) => writeBig(path, enc.encode(JSON.stringify(data)), { ifMatch: etag || undefined, createOnly: !etag, type: 'application/json' });

export async function downloadPdf(id) {
  const f = await readBig(`library/pdfs/${id}.pdf`, { cache: true });
  return f ? new Blob([f.bytes], { type: 'application/pdf' }) : null;
}

/* ---------- one sync pass ---------- */
async function syncOnce() {
  const dirty = await getDirty();
  const tags = (await idbGet('kv', 'synced')) || {};
  let changedLocal = false;

  // shared preferences (models, colors, answer style)
  const rp = await readJSON('library/prefs.json');
  if (rp && (rp.data.updatedAt || 0) > (settings.prefsAt || 0)) { applySharedPrefs(rp.data); changedLocal = true; }
  else if (!rp || (settings.prefsAt || 0) > (rp.data.updatedAt || 0)) {
    try { await writeJSON('library/prefs.json', { ...sharedPrefs(), updatedAt: settings.prefsAt || Date.now() }, rp && rp.etag); }
    catch (e) { if (!e.conflict) throw e; again = true; }
  }

  const remoteIdx = await readJSON('library/index.json');
  let rPapers = (remoteIdx && remoteIdx.data.papers) || {};
  let idxTag = remoteIdx && remoteIdx.etag;
  const local = Object.fromEntries((await idbAll('papers')).map(p => [p.id, p]));
  const ids = new Set([...Object.keys(rPapers), ...Object.keys(local)]);

  for (const id of ids) {
    const rm = rPapers[id], lm = local[id];
    let meta = lm;
    if (rm && (!lm || (rm.updatedAt || 0) > (lm.updatedAt || 0))) {
      meta = { ...(lm || {}), ...rm, openedAt: Math.max((lm && lm.openedAt) || 0, rm.openedAt || 0) };
      changedLocal = true;
    }
    const needPull = rm && rm.dataTag && rm.dataTag !== tags[id];
    const needPush = id in dirty || (lm && (!rm || !rm.dataTag));
    if (needPull || needPush) {
      let localData = (await idbGet('data', id)) || emptyData(id);
      for (let attempt = 0; ; attempt++) {
        const rf = await readJSON(`library/papers/${id}.json`);
        const merged = rf ? mergeData(localData, rf.data) : localData;
        const same = rf && JSON.stringify(merged) === JSON.stringify(rf.data);
        if (rf && JSON.stringify(merged) !== JSON.stringify(localData)) changedLocal = true;
        await idbPut('data', id, merged);
        localData = merged;
        if (same) { tags[id] = rf.etag; break; }
        try { tags[id] = await writeJSON(`library/papers/${id}.json`, merged, rf && rf.etag); break; }
        catch (e) { if (!e.conflict || attempt >= 2) throw e; }
      }
      meta = { ...meta, counts: counts(localData) };
    }
    if (!meta) continue;
    meta = { ...meta, pdfRemote: !!(meta.pdfRemote || (rm && rm.pdfRemote)), dataTag: tags[id] || meta.dataTag };
    if (!meta.pdfRemote && !meta.deleted) {
      const blob = await idbGet('pdfs', id);
      if (blob) {
        set('syncing', 'Uploading ' + (meta.title || 'PDF').slice(0, 40) + '…');
        try { await writeBig(`library/pdfs/${id}.pdf`, new Uint8Array(await blob.arrayBuffer()), { createOnly: true, type: 'application/pdf' }); }
        catch (e) { if (!e.conflict) throw e; }
        meta.pdfRemote = true;
      }
    }
    await idbPut('papers', id, meta);
    local[id] = meta;
  }

  // write the index if anything changed
  for (let attempt = 0; ; attempt++) {
    const merged = { ...rPapers };
    for (const [id, m] of Object.entries(local)) {
      const r = merged[id];
      if (!r || (m.updatedAt || 0) >= (r.updatedAt || 0)) merged[id] = { ...m, pdfRemote: !!(m.pdfRemote || (r && r.pdfRemote)) };
      else merged[id] = { ...r, dataTag: m.dataTag || r.dataTag, pdfRemote: !!(r.pdfRemote || m.pdfRemote) };
    }
    if (remoteIdx && JSON.stringify(merged) === JSON.stringify(rPapers)) break;
    try { await writeJSON('library/index.json', { version: 1, papers: merged }, idxTag); break; }
    catch (e) {
      if (!e.conflict || attempt >= 2) throw e;
      const re = await readJSON('library/index.json');
      rPapers = (re && re.data.papers) || {}; idxTag = re && re.etag;
    }
  }
  await idbPut('kv', 'synced', tags);
  await clearDirty(dirty);
  return changedLocal;
}

export async function syncNow() {
  clearTimeout(timer); timer = 0;
  if (!syncOn()) { set('off'); return; }
  if (!navigator.onLine) { set('offline', 'You’re offline. Changes are saved on this device and will upload when you’re back online.'); return; }
  if (running) { again = true; return; }
  running = true; set('syncing');
  try {
    do {
      again = false;
      if (await syncOnce()) dispatchEvent(new CustomEvent('pl:pulled'));
    } while (again);
    set('idle');
  } catch (e) {
    set('error', e.message || String(e));
  } finally { running = false; }
}
// Writes are batched: the free storage plan allows about 2,000 writes a month.
let due = 0;
export function scheduleSync(ms = 45000) {
  if (!syncOn()) { set('off'); return; }
  const t = Date.now() + ms;
  if (timer && due <= t) return;           // an earlier sync is already planned
  clearTimeout(timer); due = t;
  timer = setTimeout(() => { timer = 0; syncNow(); }, ms);
}
addEventListener('pl:dirty', e => scheduleSync(e.detail && e.detail.soon ? 3000 : 45000));
addEventListener('online', () => scheduleSync(1000));
document.addEventListener('visibilitychange', () => { if (syncOn()) syncNow(); });
