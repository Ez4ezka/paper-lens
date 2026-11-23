// Talk to Claude, ChatGPT or any OpenRouter model straight from the browser with the user's own key.
import { settings, saveSettings } from './store.js';
import { blobToDataURL } from './util.js';

export const PROVIDERS = {
  anthropic: {
    name: 'Claude', long: 'Claude (Anthropic API)', keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    starter: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  },
  openai: {
    name: 'ChatGPT', long: 'ChatGPT (OpenAI API)', keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    starter: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra'],
  },
  openrouter: {
    name: 'OpenRouter', long: 'OpenRouter (ChatGPT, Claude, Gemini and more with one key)', keyHint: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
    starter: [],
  },
};

export class AIError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

export const parseModel = v => { const i = (v || '').indexOf(':'); return i < 0 ? { provider: '', id: '' } : { provider: v.slice(0, i), id: v.slice(i + 1) }; };

// Models to show in the menu for one provider.
export function menuModels(p) {
  const fetched = settings.models[p] || [];
  const name = id => (fetched.find(m => m.id === id) || {}).name || id;
  let ids;
  if (p === 'openrouter') ids = [...settings.pins.openrouter];
  else ids = fetched.length ? fetched.map(m => m.id) : [...PROVIDERS[p].starter];
  for (const c of settings.custom[p] || []) if (!ids.includes(c)) ids.push(c);
  return ids.map(id => ({ id, name: name(id) }));
}
export function currentModel() {
  let { provider, id } = parseModel(settings.model);
  if (provider && settings.keys[provider] && id) return { provider, id };
  for (const p of Object.keys(PROVIDERS)) {
    if (!settings.keys[p]) continue;
    const m = menuModels(p)[0];
    if (m) return { provider: p, id: m.id };
  }
  return null;
}

const OPENAI_SKIP = /(audio|realtime|tts|transcri|whisper|embedding|moderation|image|dall-e|search|instruct|babbage|davinci|computer-use|codex|cyber|sora)/i;

export async function fetchModels(p) {
  const key = settings.keys[p];
  let list = [];
  try {
    if (p === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: anthHeaders(key) });
      if (!r.ok) throw await httpError(r, p);
      list = (await r.json()).data.map(m => ({ id: m.id, name: m.display_name || m.id }));
    } else if (p === 'openai') {
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + key } });
      if (!r.ok) throw await httpError(r, p);
      list = (await r.json()).data.map(m => m.id)
        .filter(id => /^(gpt-|o\d|chatgpt)/i.test(id) && !OPENAI_SKIP.test(id))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map(id => ({ id, name: id }));
    } else {
      const r = await fetch('https://openrouter.ai/api/v1/models');
      if (!r.ok) throw await httpError(r, p);
      list = (await r.json()).data
        .filter(m => !m.architecture || !m.architecture.input_modalities || m.architecture.input_modalities.includes('image'))
        .map(m => ({ id: m.id, name: m.name || m.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  } catch (e) {
    if (e instanceof AIError) throw e;
    throw new AIError(blockedMsg(p), 'network');
  }
  settings.models[p] = list;
  saveSettings();
  return list;
}

function anthHeaders(key) {
  return {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
}
function blockedMsg(p) {
  if (p === 'openai') return 'Couldn’t reach OpenAI from the browser. OpenAI sometimes blocks direct web calls; use OpenRouter to get the same ChatGPT models, or try again later.';
  return `Couldn’t reach ${PROVIDERS[p].name}. Check your connection and try again.`;
}
async function httpError(r, p) {
  let m = '';
  try { const j = await r.json(); m = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (e) {}
  if (typeof m !== 'string') m = JSON.stringify(m);
  if (r.status === 401 || r.status === 403) return new AIError(`${PROVIDERS[p].name} rejected the API key. Check it in Settings.${m ? ' (' + m + ')' : ''}`, 'auth');
  if (r.status === 404) return new AIError(`That model isn’t available on your ${PROVIDERS[p].name} account. Pick another in the model menu.${m ? ' (' + m + ')' : ''}`, 'model');
  if (r.status === 429) return new AIError(`${PROVIDERS[p].name} says you’ve hit a rate or spending limit. Wait a bit or check your billing.${m ? ' (' + m + ')' : ''}`, 'rate');
  if (r.status === 402) return new AIError(`${PROVIDERS[p].name} says your account is out of credit.${m ? ' (' + m + ')' : ''}`, 'credit');
  return new AIError(`${PROVIDERS[p].name} error ${r.status}${m ? ': ' + m : ''}`, 'http');
}

async function* sse(res, signal) {
  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
    }
    if (buf.trim()) {
      const data = buf.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  } finally { try { rd.releaseLock(); } catch (e) {} }
}

/**
 * Stream an answer.
 * system: instructions; turns: [{role:'user'|'assistant', content:string}] ending on user;
 * image: optional Blob attached to the last user turn.
 */
export async function chat({ system, turns, image, onText, signal, model }) {
  const m = model || currentModel();
  if (!m) throw new AIError('Pick a model and add an API key in Settings first.', 'setup');
  const key = settings.keys[m.provider];
  if (!key) throw new AIError(`Add your ${PROVIDERS[m.provider].name} API key in Settings.`, 'setup');
  const imgURL = image ? await blobToDataURL(image) : null;
  let text = '', truncated = false, res;

  try {
    if (m.provider === 'anthropic') {
      const messages = turns.map((t, i) => {
        if (i === turns.length - 1 && t.role === 'user' && imgURL) {
          const [, mime, data] = imgURL.match(/^data:([^;]+);base64,(.*)$/);
          return { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data } }, { type: 'text', text: t.content }] };
        }
        return { role: t.role, content: t.content };
      });
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal, headers: anthHeaders(key),
        body: JSON.stringify({ model: m.id, max_tokens: 4096, system, messages, stream: true }),
      });
    } else {
      const messages = [{ role: 'system', content: system }, ...turns.map((t, i) => {
        if (i === turns.length - 1 && t.role === 'user' && imgURL)
          return { role: 'user', content: [{ type: 'text', text: t.content }, { type: 'image_url', image_url: { url: imgURL } }] };
        return { role: t.role, content: t.content };
      })];
      const url = m.provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
      const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
      if (m.provider === 'openrouter') { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Paper Lens'; }
      const body = { model: m.id, messages, stream: true };
      if (m.provider === 'openai') body.max_completion_tokens = 8000; else body.max_tokens = 4096;
      res = await fetch(url, { method: 'POST', signal, headers, body: JSON.stringify(body) });
    }
  } catch (e) {
    if (e.name === 'AbortError') throw new AIError('Stopped.', 'cancelled');
    throw new AIError(blockedMsg(m.provider), 'network');
  }
  if (!res.ok) throw await httpError(res, m.provider);

  try {
    for await (const data of sse(res, signal)) {
      if (data === '[DONE]') break;
      let j; try { j = JSON.parse(data); } catch (e) { continue; }
      if (j.error) throw new AIError(`${PROVIDERS[m.provider].name}: ${j.error.message || JSON.stringify(j.error)}`, 'http');
      let d = '';
      if (m.provider === 'anthropic') {
        if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') d = j.delta.text;
        if (j.type === 'message_delta' && j.delta && j.delta.stop_reason === 'max_tokens') truncated = true;
      } else {
        const c = j.choices && j.choices[0];
        if (c && c.delta && typeof c.delta.content === 'string') d = c.delta.content;
        if (c && c.finish_reason === 'length') truncated = true;
      }
      if (d) { text += d; onText && onText(text); }
    }
  } catch (e) {
    if (e.name === 'AbortError') { const er = new AIError('Stopped.', 'cancelled'); er.partial = text; throw er; }
    if (e instanceof AIError) { e.partial = text; throw e; }
    const er = new AIError('The answer was interrupted. Try again.', 'network'); er.partial = text; throw er;
  }
  if (!text.trim()) throw new AIError('No answer came back. Try again or pick another model.', 'empty');
  return { text, truncated, model: m };
}
