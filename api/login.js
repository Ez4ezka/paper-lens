// POST {password} -> {token}. One shared password, set in the APP_PASSWORD environment variable.
import { json, configured, safeEqual, sessionToken } from './_lib.js';

export default {
  async fetch(req) {
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    if (!configured()) return json({ error: 'The server is missing APP_PASSWORD or SESSION_SECRET.' }, 500);
    let body = {};
    try { body = await req.json(); } catch (e) {}
    if (typeof body.password !== 'string' || !safeEqual(body.password, process.env.APP_PASSWORD)) {
      await new Promise(r => setTimeout(r, 800));
      return json({ error: 'That password isn’t right.' }, 401);
    }
    return json({ token: sessionToken() });
  },
};
