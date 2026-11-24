// GET /api/models?provider=anthropic|openai|openrouter -> [{id, name}] using the saved key.
import { json, authed, denied, getSecrets } from './_lib.js';

const OPENAI_SKIP = /(audio|realtime|tts|transcri|whisper|embedding|moderation|image|dall-e|search|instruct|babbage|davinci|computer-use|codex|cyber|sora)/i;

export default {
  async fetch(req) {
    if (!authed(req)) return denied();
    const p = new URL(req.url).searchParams.get('provider');
    const key = (await getSecrets()).keys[p];
    try {
      let list;
      if (p === 'anthropic') {
        if (!key) return json({ error: 'Save a Claude key first.' }, 400);
        const r = await fetch((process.env.PL_ANTHROPIC_URL || 'https://api.anthropic.com') + '/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
        if (!r.ok) return json({ error: `Claude rejected the request (${r.status}). Check the key.` }, r.status === 401 || r.status === 403 ? 424 : r.status);
        list = (await r.json()).data.map(m => ({ id: m.id, name: m.display_name || m.id }));
      } else if (p === 'openai') {
        if (!key) return json({ error: 'Save an OpenAI key first.' }, 400);
        const r = await fetch((process.env.PL_OPENAI_URL || 'https://api.openai.com') + '/v1/models', { headers: { Authorization: 'Bearer ' + key } });
        if (!r.ok) return json({ error: `OpenAI rejected the request (${r.status}). Check the key.` }, r.status === 401 || r.status === 403 ? 424 : r.status);
        list = (await r.json()).data.map(m => m.id)
          .filter(id => /^(gpt-|o\d|chatgpt)/i.test(id) && !OPENAI_SKIP.test(id))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          .map(id => ({ id, name: id }));
      } else if (p === 'openrouter') {
        const r = await fetch((process.env.PL_OPENROUTER_URL || 'https://openrouter.ai') + '/api/v1/models');
        if (!r.ok) return json({ error: `OpenRouter error ${r.status}.` }, r.status);
        list = (await r.json()).data
          .filter(m => !m.architecture || !m.architecture.input_modalities || m.architecture.input_modalities.includes('image'))
          .map(m => ({ id: m.id, name: m.name || m.id }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } else return json({ error: 'Unknown provider.' }, 400);
      return json({ models: list });
    } catch (e) {
      return json({ error: `Couldn’t reach ${p}.` }, 502);
    }
  },
};
