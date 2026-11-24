// Shared helpers for the API functions: sign-in token, JSON responses, private storage.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

/* ---------- sign-in ---------- */
// SESSION_SECRET is optional: without it the token is derived from the password,
// so changing APP_PASSWORD signs every device out.
export function configured() { return !!process.env.APP_PASSWORD; }
function secret() { return process.env.SESSION_SECRET || 'pl-derived:' + process.env.APP_PASSWORD; }
export function sessionToken() {
  return crypto.createHmac('sha256', secret()).update('paperlens-session-v1').digest('base64url');
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function authed(req) {
  if (!configured()) return false;
  const t = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return !!t && safeEqual(t, sessionToken());
}
export const denied = () => json({ error: 'Please sign in again.' }, 401);

/* ---------- private storage (Vercel Blob, or a folder when testing locally) ---------- */
const LOCAL = process.env.PL_LOCAL_STORE;
export class Conflict extends Error { constructor() { super('conflict'); this.status = 412; } }
let blobMod;
const blob = async () => (blobMod ||= await import('@vercel/blob'));

export async function readFile(pathname, { fresh = true } = {}) {
  if (LOCAL) {
    try {
      const bytes = await fs.readFile(path.join(LOCAL, pathname));
      return { body: bytes, etag: '"' + crypto.createHash('sha1').update(bytes).digest('hex') + '"', contentType: guessType(pathname), size: bytes.length };
    } catch (e) { return null; }
  }
  const { get } = await blob();
  const r = await get(pathname, { access: 'private', useCache: !fresh });
  if (!r || r.statusCode !== 200) return null;
  return { body: r.stream, etag: r.blob.etag, contentType: r.blob.contentType || guessType(pathname), size: r.blob.size };
}

export async function writeFile(pathname, bytes, { ifMatch, createOnly, contentType } = {}) {
  if (LOCAL) {
    const p = path.join(LOCAL, pathname);
    const cur = await readFile(pathname);
    if (createOnly && cur) throw new Conflict();
    if (ifMatch && (!cur || cur.etag !== ifMatch)) throw new Conflict();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, bytes);
    return { etag: '"' + crypto.createHash('sha1').update(bytes).digest('hex') + '"' };
  }
  const { put, BlobPreconditionFailedError, BlobError } = await blob();
  try {
    const r = await put(pathname, bytes, {
      access: 'private', addRandomSuffix: false, allowOverwrite: !createOnly,
      contentType: contentType || guessType(pathname), cacheControlMaxAge: 60,
      ...(ifMatch ? { ifMatch } : {}),
    });
    return { etag: r.etag };
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError) throw new Conflict();
    if (createOnly && e instanceof BlobError && /exist/i.test(e.message)) throw new Conflict();
    throw e;
  }
}

export async function deleteFile(pathname) {
  if (LOCAL) { try { await fs.unlink(path.join(LOCAL, pathname)); } catch (e) {} return; }
  const { del } = await blob();
  try { await del(pathname); } catch (e) {}
}

function guessType(p) {
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

/* ---------- AI keys, kept only on the server ---------- */
const SECRETS = 'config/secrets.json';
let cache = null, cacheAt = 0;
export async function getSecrets(force = false) {
  if (!force && cache && Date.now() - cacheAt < 60_000) return cache;
  const r = await readFile(SECRETS);
  let data = {};
  if (r) { try { data = JSON.parse(Buffer.from(await new Response(r.body).arrayBuffer()).toString('utf8')); } catch (e) {} }
  cache = { keys: {}, ...data }; cacheAt = Date.now();
  return cache;
}
export async function setKeys(updates) {
  const cur = await getSecrets(true);
  const keys = { ...cur.keys };
  for (const [k, v] of Object.entries(updates || {})) {
    if (!['anthropic', 'openai', 'openrouter'].includes(k)) continue;
    if (typeof v !== 'string') continue;
    if (v.trim()) keys[k] = v.trim(); else delete keys[k];
  }
  const next = { ...cur, keys };
  await writeFile(SECRETS, Buffer.from(JSON.stringify(next)), { contentType: 'application/json' });
  cache = next; cacheAt = Date.now();
  return next;
}
export const keyHint = k => (k ? '…' + k.slice(-4) : '');
