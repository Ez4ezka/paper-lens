// Small shared helpers: DOM, text, encoding, IndexedDB.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function toast(msg, ms = 2800) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

export function timeAgo(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' d ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToB64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64.replace(/\s/g, ''));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
export const utf8B64 = str => bytesToB64(new TextEncoder().encode(str));
export const b64Utf8 = b64 => new TextDecoder().decode(b64ToBytes(b64));

export function blobToDataURL(b) {
  return new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(f.error); f.readAsDataURL(b); });
}
export function canvasToBlob(c, type = 'image/png', q) {
  return new Promise(r => c.toBlob(b => r(b), type, q));
}
// Shrink a canvas to a small JPEG data URL (for thumbnails stored in the library).
export function canvasThumb(c, maxSide = 560, q = 0.78) {
  const k = Math.min(1, maxSide / Math.max(c.width, c.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(c.width * k));
  t.height = Math.max(1, Math.round(c.height * k));
  const x = t.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, t.width, t.height);
  x.imageSmoothingQuality = 'high';
  x.drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', q);
}

export function inPoly(x, y, pts) {
  let ins = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove(); return ok;
  }
}

export function download(name, text, type = 'text/markdown') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------- IndexedDB (local copy of everything) ---------- */
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('paperlens', 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of ['papers', 'data', 'pdfs', 'kv']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const q = fn(tx.objectStore(store));
    tx.oncomplete = () => res(q && q.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}
export const idbGet = (s, k) => req(s, 'readonly', o => o.get(k));
export const idbPut = (s, k, v) => req(s, 'readwrite', o => o.put(v, k));
export const idbDel = (s, k) => req(s, 'readwrite', o => o.delete(k));
export const idbAll = s => req(s, 'readonly', o => o.getAll());
export const idbKeys = s => req(s, 'readonly', o => o.getAllKeys());
export const idbClear = s => req(s, 'readwrite', o => o.clear());
