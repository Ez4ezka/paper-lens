// Private file storage for the library.
//   GET    /api/file?path=library/...            -> bytes (+ ETag)
//   PUT    /api/file?path=library/...            body = bytes; If-Match / If-None-Match: * for safe writes
//   DELETE /api/file?path=library/...
import { json, authed, denied, readFile, writeFile, deleteFile, Conflict } from './_lib.js';

const OK_PATH = /^library\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/;
const MAX = 4_400_000;

export default {
  async fetch(req) {
    if (!authed(req)) return denied();
    const url = new URL(req.url);
    const p = url.searchParams.get('path') || '';
    if (!OK_PATH.test(p) || p.includes('..') || p.includes('//')) return json({ error: 'Bad path.' }, 400);
    try {
      if (req.method === 'GET') {
        const r = await readFile(p, { fresh: url.searchParams.get('cache') !== '1' });
        if (!r) return json({ error: 'Not found.' }, 404);
        return new Response(r.body, { headers: { 'content-type': r.contentType, etag: r.etag, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
      }
      if (req.method === 'PUT') {
        const len = +(req.headers.get('content-length') || 0);
        if (len > MAX) return json({ error: 'Too large; send it in parts.' }, 413);
        const bytes = Buffer.from(await req.arrayBuffer());
        if (bytes.length > MAX) return json({ error: 'Too large; send it in parts.' }, 413);
        const ifMatch = req.headers.get('if-match') || undefined;
        const createOnly = req.headers.get('if-none-match') === '*';
        const r = await writeFile(p, bytes, { ifMatch, createOnly, contentType: req.headers.get('content-type') || undefined });
        return json({ etag: r.etag });
      }
      if (req.method === 'DELETE') { await deleteFile(p); return json({ ok: true }); }
      return json({ error: 'Method not allowed.' }, 405);
    } catch (e) {
      if (e instanceof Conflict) return json({ error: 'Changed on another device.' }, 412);
      const suspended = /suspend/i.test(e && e.message || '');
      return json({ error: suspended ? 'Cloud storage is paused because this month’s free storage quota was used up.' : 'Storage error: ' + (e && e.message || e) }, suspended ? 507 : 500);
    }
  },
};
