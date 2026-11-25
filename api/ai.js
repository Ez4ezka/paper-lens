// POST {provider, model, system, turns, image?} -> the provider's streamed answer, passed straight through.
// The API key is added here on the server, so it never reaches the browser.
import { json, authed, denied, getSecrets } from './_lib.js';

const URLS = {
  anthropic: () => (process.env.PL_ANTHROPIC_URL || 'https://api.anthropic.com') + '/v1/messages',
  openai: () => (process.env.PL_OPENAI_URL || 'https://api.openai.com') + '/v1/chat/completions',
  openrouter: () => (process.env.PL_OPENROUTER_URL || 'https://openrouter.ai') + '/api/v1/chat/completions',
};

const EFFORT_MODELS = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|haiku-5|fable|mythos)/;
const XHIGH_MODELS = /^claude-(opus-(4-[7-9]|5)|sonnet-5|haiku-5|fable|mythos)/;
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5|mythos-5)/;

export default {
  async fetch(req) {
    if (!authed(req)) return denied();
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    let b = {};
    try { b = await req.json(); } catch (e) { return json({ error: 'Bad request.' }, 400); }
    const { provider, model, system = '', turns = [], image } = b;
    const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(b.effort) ? b.effort : null;
    if (!URLS[provider] || typeof model !== 'string' || !model) return json({ error: 'Pick a model first.' }, 400);
    if (!Array.isArray(turns) || !turns.length) return json({ error: 'Nothing to ask.' }, 400);
    const key = (await getSecrets()).keys[provider];
    if (!key) return json({ error: { message: `No ${provider} API key saved yet. Add one in Settings.` }, code: 'setup' }, 400);

    const clean = turns.map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.content || '') }));
    let img = null;
    if (typeof image === 'string') { const m = image.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/); if (m) img = { mime: m[1], data: m[2], url: image }; }

    let upstream;
    try {
      if (provider === 'anthropic') {
        const messages = clean.map((t, i) => (i === clean.length - 1 && t.role === 'user' && img)
          ? { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }, { type: 'text', text: t.content }] }
          : t);
        // Thinking counts toward max_tokens on current Claude models, so leave room for it (streaming, so no timeout risk).
        const body = { model, max_tokens: 32000, system, messages, stream: true };
        const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
        // How hard the model thinks. Only models that support effort get it; older ones would reject the field.
        if (effort && EFFORT_MODELS.test(model)) body.output_config = { effort: effort === 'xhigh' && !XHIGH_MODELS.test(model) ? 'high' : effort };
        // If Claude's safety check declines a request, let Anthropic retry it on its recommended fallback model.
        if (FALLBACK_MODELS.test(model)) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
        upstream = await fetch(URLS.anthropic(), { method: 'POST', signal: req.signal, headers, body: JSON.stringify(body) });
      } else {
        const messages = [{ role: 'system', content: system }, ...clean.map((t, i) => (i === clean.length - 1 && t.role === 'user' && img)
          ? { role: 'user', content: [{ type: 'text', text: t.content }, { type: 'image_url', image_url: { url: img.url } }] }
          : t)];
        const body = { model, messages, stream: true };
        if (provider === 'openai') body.max_completion_tokens = 8000; else body.max_tokens = 4096;
        const headers = { Authorization: 'Bearer ' + key, 'content-type': 'application/json' };
        if (provider === 'openrouter') { headers['HTTP-Referer'] = new URL(req.url).origin; headers['X-Title'] = 'Paper Lens'; }
        upstream = await fetch(URLS[provider](), { method: 'POST', signal: req.signal, headers, body: JSON.stringify(body) });
      }
    } catch (e) {
      return json({ error: { message: `Couldn’t reach ${provider}. Try again in a moment.` } }, 502);
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      let msg = '';
      try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (e) { msg = text.slice(0, 300); }
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
      const status = upstream.status === 401 || upstream.status === 403 ? 424 : upstream.status;
      return json({ error: { message: msg || `${provider} error ${upstream.status}` } }, status);
    }
    return new Response(upstream.body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  },
};
