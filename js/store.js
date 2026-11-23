// Local-first storage: settings in localStorage, library in IndexedDB.
import { idbGet, idbPut, idbAll, idbDel } from './util.js';

const SKEY = 'paperlens.settings.v1';

export const DEFAULT_COLORS = [
  { id: 'y', hex: '#ffd60a', label: 'Key idea' },
  { id: 'g', hex: '#4ade80', label: 'Definition' },
  { id: 'b', hex: '#5cc8ff', label: 'Formula' },
  { id: 'p', hex: '#ff7eb6', label: 'Question' },
  { id: 'o', hex: '#ff9f43', label: 'Result' },
];

const DEFAULTS = {
  model: '',                       // "provider:model-id"
  keys: { anthropic: '', openai: '', openrouter: '' },
  models: { anthropic: [], openai: [], openrouter: [] }, // fetched lists [{id,name}]
  pins: { openrouter: [] },        // OpenRouter models shown in the menu
  custom: { anthropic: [], openai: [], openrouter: [] },
  gh: { token: '', repo: '', branch: '', pdfs: true },
  colors: DEFAULT_COLORS,
  style: '',
  hlColor: 'y',
  shape: 'box',
  tool: 'ask',
};

function merge(def, val) {
  if (Array.isArray(def)) return Array.isArray(val) ? val : def;
  if (def && typeof def === 'object') {
    const o = {};
    for (const k of Object.keys(def)) o[k] = merge(def[k], val ? val[k] : undefined);
    return o;
  }
  return val === undefined ? def : val;
}

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) {}
  return merge(DEFAULTS, raw || {});
}
export const settings = load();
export function saveSettings() {
  try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (e) {}
  dispatchEvent(new CustomEvent('pl:settings'));
}
export function replaceSettings(obj) {
  const n = merge(DEFAULTS, obj || {});
  for (const k of Object.keys(settings)) delete settings[k];
  Object.assign(settings, n);
  saveSettings();
}
export const colorOf = id => settings.colors.find(c => c.id === id) || settings.colors[0];

/* ---------- papers + their highlights / notes ---------- */
export async function listPapers(includeDeleted = false) {
  const all = await idbAll('papers');
  return all.filter(p => includeDeleted || !p.deleted)
    .sort((a, b) => (b.openedAt || b.addedAt || 0) - (a.openedAt || a.addedAt || 0));
}
export const getPaper = id => idbGet('papers', id);
export async function savePaperMeta(p, dirty = true) {
  if (dirty) p.updatedAt = Date.now();
  await idbPut('papers', p.id, p);
  if (dirty) await markDirty(p.id);
}
export async function touchOpened(id) {
  const p = await getPaper(id);
  if (p) { p.openedAt = Date.now(); await idbPut('papers', id, p); }
}
export const emptyData = id => ({ id, highlights: [], threads: [] });
export async function getData(id) { return (await idbGet('data', id)) || emptyData(id); }
export function counts(d) {
  return {
    h: d.highlights.filter(x => !x.deleted).length,
    t: d.threads.filter(x => !x.deleted).length,
  };
}
export async function saveData(d) {
  await idbPut('data', d.id, d);
  const p = await getPaper(d.id);
  if (p) { p.counts = counts(d); p.updatedAt = Date.now(); await idbPut('papers', p.id, p); }
  await markDirty(d.id);
}
export const getPdf = id => idbGet('pdfs', id);
export const putPdf = (id, blob) => idbPut('pdfs', id, blob);
export const delPdf = id => idbDel('pdfs', id);

// Union of two copies of a paper's data, item by item; newest edit wins, deletions are kept as markers.
export function mergeData(a, b) {
  const m = (x = [], y = []) => {
    const map = new Map();
    for (const it of [...x, ...y]) {
      const o = map.get(it.id);
      if (!o || (it.updatedAt || 0) > (o.updatedAt || 0)) map.set(it.id, it);
    }
    return [...map.values()].sort((p, q) => (p.createdAt || 0) - (q.createdAt || 0));
  };
  return { id: a.id || b.id, highlights: m(a.highlights, b.highlights), threads: m(a.threads, b.threads) };
}
export const tombstone = it => ({ id: it.id, deleted: true, createdAt: it.createdAt, updatedAt: Date.now() });

/* ---------- what still needs syncing ---------- */
export async function markDirty(id) {
  const d = (await idbGet('kv', 'dirty')) || {};
  d[id] = Date.now() + Math.random();
  await idbPut('kv', 'dirty', d);
  dispatchEvent(new CustomEvent('pl:dirty'));
}
export const getDirty = async () => (await idbGet('kv', 'dirty')) || {};
export async function clearDirty(snapshot) {
  const d = (await idbGet('kv', 'dirty')) || {};
  for (const [k, v] of Object.entries(snapshot)) if (d[k] === v) delete d[k];
  await idbPut('kv', 'dirty', d);
}
