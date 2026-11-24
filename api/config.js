// AI keys live only on the server.
//   GET  /api/config  -> which providers have a key (last 4 characters only)
//   POST /api/config  {keys:{anthropic?:string, openai?:string, openrouter?:string}}  ('' removes a key)
import { json, authed, denied, getSecrets, setKeys, keyHint } from './_lib.js';

const view = s => ({
  keys: Object.fromEntries(['anthropic', 'openai', 'openrouter'].map(p => [p, { set: !!s.keys[p], hint: keyHint(s.keys[p]) }])),
});

export default {
  async fetch(req) {
    if (!authed(req)) return denied();
    try {
      if (req.method === 'GET') return json(view(await getSecrets(true)));
      if (req.method === 'POST') {
        let body = {}; try { body = await req.json(); } catch (e) {}
        return json(view(await setKeys(body.keys)));
      }
      return json({ error: 'Method not allowed.' }, 405);
    } catch (e) { return json({ error: 'Storage error: ' + (e && e.message || e) }, 500); }
  },
};
