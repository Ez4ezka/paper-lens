// Sync the library to a private GitHub repository the user owns.
// Layout in the repo:
//   library/index.json          list of papers (title, counts, small cover)
//   library/papers/<id>.json    highlights + notes for one paper
//   library/pdfs/<id>.pdf       the PDF itself (optional)
import { settings, saveSettings, mergeData, getDirty, clearDirty, counts, emptyData } from './store.js';
import { idbGet, idbPut, idbAll, utf8B64, b64Utf8, bytesToB64 } from './util.js';

const API = 'https://api.github.com';
export const syncState = { status: 'off', msg: '', at: 0 };
let running = false, again = false, timer = 0;

function set(status, msg = '') {
  Object.assign(syncState, { status, msg });
  if (status === 'idle') syncState.at = Date.now();
  dispatchEvent(new CustomEvent('pl:sync', { detail: syncState }));
}
export const syncOn = () => !!(settings.gh.token && /^[\w.-]+\/[\w.-]+$/.test(settings.gh.repo.trim()));

class GhError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function gh(path, opts = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      method: opts.method || 'GET',
      body: opts.body,
      cache: 'no-store',
      headers: {
        Authorization: 'Bearer ' + settings.gh.token.trim(),
        Accept: opts.accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (e) { throw new GhError('Could not reach GitHub. Check your connection.', 0); }
  return r;
}
async function fail(r) {
  let m = '';
  try { m = (await r.json()).message || ''; } catch (e) {}
  if (r.status === 401) return new GhError('GitHub rejected the token. Make a new one in Settings.', 401);
  if (r.status === 403 && /rate limit/i.test(m)) return new GhError('GitHub rate limit hit. Sync will try again later.', 403);
  if (r.status === 403) return new GhError('The token can’t write to that repository. Give it “Contents: Read and write”.', 403);
  if (r.status === 404) return new GhError('Repository not found, or the token can’t see it.', 404);
  return new GhError(`GitHub error ${r.status}${m ? ': ' + m : ''}`, r.status);
}
const R = () => settings.gh.repo.trim();
const B = () => settings.gh.branch || 'main';

async function ensureBranch() {
  const r = await gh(`/repos/${R()}`);
  if (!r.ok) throw await fail(r);
  const j = await r.json();
  if (!j.permissions || !(j.permissions.push || j.permissions.admin || j.permissions.maintain)) {
    // fine-grained tokens report permissions per repo; continue and let the write tell us
  }
  const b = j.default_branch || 'main';
  if (settings.gh.branch !== b) { settings.gh.branch = b; saveSettings(); }
  return j;
}

async function getJSON(path) {
  const r = await gh(`/repos/${R()}/contents/${path}?ref=${encodeURIComponent(B())}`);
  if (r.status === 404) return null;
  if (!r.ok) throw await fail(r);
  const j = await r.json();
  let text;
  if (j.content && j.encoding === 'base64') text = b64Utf8(j.content);
  else {
    const r2 = await gh(`/repos/${R()}/contents/${path}?ref=${encodeURIComponent(B())}`, { accept: 'application/vnd.github.raw+json' });
    if (!r2.ok) throw await fail(r2);
    text = await r2.text();
  }
  return { data: JSON.parse(text), sha: j.sha };
}

async function putB64(path, b64, sha, message) {
  const r = await gh(`/repos/${R()}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: b64, branch: B(), ...(sha ? { sha } : {}) }),
  });
  if (r.status === 409 || r.status === 422) {
    let m = ''; try { m = (await r.json()).message || ''; } catch (e) {}
    const e = new GhError(r.status === 409 || /sha/i.test(m) ? 'conflict: ' + m : `GitHub refused the file: ${m}`, r.status);
    e.conflict = r.status === 409 || /sha/i.test(m);
    throw e;
  }
  if (!r.ok) throw await fail(r);
  const j = await r.json();
  return j.content && j.content.sha;
}

export async function testConnection() {
  if (!syncOn()) throw new GhError('Add a repository (owner/name) and a token first.', 0);
  const repo = await ensureBranch();
  return { name: repo.full_name, private: repo.private };
}

export async function downloadPdf(id) {
  const r = await gh(`/repos/${R()}/contents/library/pdfs/${id}.pdf?ref=${encodeURIComponent(B())}`, { accept: 'application/vnd.github.raw+json' });
  if (r.status === 404) return null;
  if (!r.ok) throw await fail(r);
  return new Blob([await r.arrayBuffer()], { type: 'application/pdf' });
}

const strip = m => { const { thumbLocal, ...rest } = m; return rest; };

async function syncOnce() {
  await ensureBranch();
  const dirty = await getDirty();
  const synced = (await idbGet('kv', 'synced')) || {};
  const remoteIdx = await getJSON('library/index.json');
  let rPapers = (remoteIdx && remoteIdx.data && remoteIdx.data.papers) || {};
  let idxSha = remoteIdx && remoteIdx.sha;

  const localList = await idbAll('papers');
  const local = Object.fromEntries(localList.map(p => [p.id, p]));
  const ids = new Set([...Object.keys(rPapers), ...Object.keys(local)]);
  let changedLocal = false;

  for (const id of ids) {
    const rm = rPapers[id], lm = local[id];
    // 1. paper details: newest wins
    let meta = lm;
    if (rm && (!lm || (rm.updatedAt || 0) > (lm.updatedAt || 0))) {
      meta = { ...(lm || {}), ...rm, openedAt: Math.max((lm && lm.openedAt) || 0, rm.openedAt || 0) };
      changedLocal = true;
    }
    // 2. highlights + notes
    const needPull = rm && rm.dataSha && rm.dataSha !== synced[id];
    const needPush = id in dirty || (lm && (!rm || !rm.dataSha));
    if (needPull || needPush) {
      let localData = (await idbGet('data', id)) || emptyData(id);
      for (let attempt = 0; ; attempt++) {
        const rf = await getJSON(`library/papers/${id}.json`);
        const merged = rf ? mergeData(localData, rf.data) : localData;
        const same = rf && JSON.stringify(merged) === JSON.stringify(rf.data);
        if (rf && JSON.stringify(merged) !== JSON.stringify(localData)) changedLocal = true;
        await idbPut('data', id, merged);
        localData = merged;
        if (same) { synced[id] = rf.sha; break; }
        try {
          synced[id] = await putB64(`library/papers/${id}.json`, utf8B64(JSON.stringify(merged)), rf && rf.sha, `Update notes: ${(meta && meta.title || id).slice(0, 60)}`);
          break;
        } catch (e) { if (!e.conflict || attempt >= 2) throw e; }
      }
      meta = { ...meta, counts: counts(localData) };
    }
    if (!meta) continue;
    meta = { ...meta, pdfRemote: !!(meta.pdfRemote || (rm && rm.pdfRemote)) };
    meta.dataSha = synced[id] || meta.dataSha;
    // 3. the PDF itself
    if (settings.gh.pdfs && !meta.pdfRemote && !meta.deleted) {
      const blob = await idbGet('pdfs', id);
      if (blob && !meta.pdfTooBig) {
        if (blob.size > 45 * 1024 * 1024) meta.pdfTooBig = true;
        else {
          set('syncing', 'Uploading ' + (meta.title || 'PDF').slice(0, 40) + '…');
          try {
            await putB64(`library/pdfs/${id}.pdf`, bytesToB64(new Uint8Array(await blob.arrayBuffer())), null, `Add PDF: ${(meta.title || id).slice(0, 60)}`);
            meta.pdfRemote = true;
          } catch (e) {
            if (e.conflict) meta.pdfRemote = true;            // already uploaded from another device
            else if (e.status === 413 || e.status === 422 || e.status === 400) meta.pdfTooBig = true;
            else throw e;
          }
        }
      }
    }
    await idbPut('papers', id, meta);
    local[id] = meta;
  }

  // 4. write the index if it changed
  for (let attempt = 0; ; attempt++) {
    const next = {};
    for (const [id, m] of Object.entries(local)) next[id] = strip(m);
    const merged = { ...rPapers };
    for (const [id, m] of Object.entries(next)) {
      const r = merged[id];
      if (!r || (m.updatedAt || 0) >= (r.updatedAt || 0)) merged[id] = { ...m, pdfRemote: !!(m.pdfRemote || (r && r.pdfRemote)) };
      else merged[id] = { ...r, dataSha: m.dataSha || r.dataSha, pdfRemote: !!(r.pdfRemote || m.pdfRemote) };
    }
    if (remoteIdx && JSON.stringify(merged) === JSON.stringify(rPapers)) break;
    try {
      await putB64('library/index.json', utf8B64(JSON.stringify({ version: 1, papers: merged }, null, 0)), idxSha, 'Update library index');
      break;
    } catch (e) {
      if (!e.conflict || attempt >= 2) throw e;
      const again = await getJSON('library/index.json');
      rPapers = (again && again.data && again.data.papers) || {};
      idxSha = again && again.sha;
    }
  }
  await idbPut('kv', 'synced', synced);
  await clearDirty(dirty);
  return changedLocal;
}

export async function syncNow() {
  if (!syncOn()) { set('off'); return; }
  if (!navigator.onLine) { set('offline', 'You’re offline. Changes are saved on this device and will sync later.'); return; }
  if (running) { again = true; return; }
  running = true; set('syncing');
  try {
    do {
      again = false;
      const changed = await syncOnce();
      if (changed) dispatchEvent(new CustomEvent('pl:pulled'));
    } while (again);
    set('idle');
  } catch (e) {
    set('error', e.message || String(e));
  } finally { running = false; }
}
export function scheduleSync(ms = 2500) {
  clearTimeout(timer);
  if (!syncOn()) { set('off'); return; }
  timer = setTimeout(syncNow, ms);
}
addEventListener('pl:dirty', () => scheduleSync());
addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(800); });
