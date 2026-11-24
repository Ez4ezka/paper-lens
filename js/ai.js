// Ask Claude, ChatGPT or any OpenRouter model. Requests go through /api/ai, which adds your saved key.
import { settings, saveSettings } from './store.js';
import { blobToDataURL } from './util.js';
import { api, apiJSON, errorFrom } from './api.js';

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

export const hasKey = p => !!(settings.serverKeys[p] && settings.serverKeys[p].set);
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
  if (provider && hasKey(provider) && id) return { provider, id };
  for (const p of Object.keys(PROVIDERS)) {
    if (!hasKey(p)) continue;
    const m = menuModels(p)[0];
    if (m) return { provider: p, id: m.id };
  }
  return null;
}


export async function refreshKeys() {
  const j = await apiJSON('api/config');
  settings.serverKeys = j.keys; saveSettings();
  return j.keys;
}
export async function saveKey(p, key) {
  const j = await apiJSON('api/config', { method: 'POST', body: JSON.stringify({ keys: { [p]: key } }) });
  settings.serverKeys = j.keys; saveSettings();
  return j.keys;
}

export async function fetchModels(p) {
  let j;
  try { j = await apiJSON('api/models?provider=' + p); }
  catch (e) { throw new AIError(e.message, e.code || 'http'); }
  settings.models[p] = j.models;
  saveSettings();
  return j.models;
}

async function* sse(res) {
  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const take = chunk => chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
  try {
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = take(buf.slice(0, i)); buf = buf.slice(i + 2);
        if (data) yield data;
      }
    }
    if (buf.trim()) { const data = take(buf); if (data) yield data; }
  } finally { try { rd.releaseLock(); } catch (e) {} }
}

function friendly(status, msg, provider) {
  const n = PROVIDERS[provider] ? PROVIDERS[provider].name : provider;
  if (status === 401 || status === 403) return new AIError(`${n} rejected the saved API key. Replace it in Settings.${msg ? ' (' + msg + ')' : ''}`, 'auth');
  if (status === 404) return new AIError(`That model isn’t available on your ${n} account. Pick another in the model menu.${msg ? ' (' + msg + ')' : ''}`, 'model');
  if (status === 429) return new AIError(`${n} says you’ve hit a rate or spending limit. Wait a bit or check your billing.${msg ? ' (' + msg + ')' : ''}`, 'rate');
  if (status === 402) return new AIError(`${n} says your account is out of credit.${msg ? ' (' + msg + ')' : ''}`, 'credit');
  return new AIError(msg || `${n} error ${status}`, 'http');
}

/**
 * Stream an answer.
 * system: instructions; turns: [{role:'user'|'assistant', content:string}] ending on user;
 * image: optional Blob attached to the last user turn.
 */
export async function chat({ system, turns, image, onText, signal, model }) {
  const m = model || currentModel();
  if (!m) throw new AIError('Pick a model and save an API key in Settings first.', 'setup');
  if (!hasKey(m.provider)) throw new AIError(`Save your ${PROVIDERS[m.provider].name} API key in Settings.`, 'setup');
  const img = image ? await blobToDataURL(image) : null;
  let text = '', truncated = false, res;
  try {
    res = await api('api/ai', {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: m.provider, model: m.id, system, turns: turns.map(t => ({ role: t.role, content: t.content })), image: img }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new AIError('Stopped.', 'cancelled');
    throw new AIError(e.message, e.code || 'network');
  }
  if (!res.ok) {
    const er = await errorFrom(res);
    if (er.code === 'setup') throw new AIError(er.message, 'setup');
    throw friendly(res.status === 424 ? 401 : res.status, er.message, m.provider);
  }
  try {
    for await (const data of sse(res)) {
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
