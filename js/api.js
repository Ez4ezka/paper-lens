// Talking to the Paper Lens server: sign-in token + authenticated requests.
const TKEY = 'paperlens.token';
export function getToken() { try { return localStorage.getItem(TKEY) || ''; } catch (e) { return ''; } }
export function setToken(t) { try { t ? localStorage.setItem(TKEY, t) : localStorage.removeItem(TKEY); } catch (e) {} }

export class ApiError extends Error {
  constructor(msg, status, code) { super(msg); this.status = status; this.code = code; }
}

export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  let r;
  try {
    r = await fetch(path, { method, body, signal, cache: 'no-store', headers: { Authorization: 'Bearer ' + getToken(), ...headers } });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('Can’t reach Paper Lens. Check your internet connection.', 0, 'network');
  }
  if (r.status === 401) {
    setToken('');
    dispatchEvent(new CustomEvent('pl:signed-out'));
    throw new ApiError('Please sign in again.', 401, 'signin');
  }
  return r;
}

export async function errorFrom(r) {
  let j = null;
  try { j = await r.json(); } catch (e) {}
  const m = j && (typeof j.error === 'string' ? j.error : j.error && j.error.message);
  return new ApiError(m || `Server error ${r.status}`, r.status, j && j.code);
}

export async function apiJSON(path, opts = {}) {
  const r = await api(path, { ...opts, headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (!r.ok) throw await errorFrom(r);
  return r.json();
}

export async function login(password) {
  let r;
  try {
    r = await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  } catch (e) { throw new Error('Can’t reach Paper Lens. Check your internet connection.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Sign-in failed.');
  setToken(j.token);
}
