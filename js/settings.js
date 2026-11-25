// Settings dialog: AI keys (saved on the server) + models, highlight colors, account.
import { settings, saveSettings, DEFAULT_COLORS } from './store.js';
import { PROVIDERS, fetchModels, menuModels, menuPicks, saveKey, refreshKeys, hasKey } from './ai.js';
import { syncNow, syncState } from './sync.js';
import { DEFAULT_STYLE } from './reader.js';
import { setToken } from './api.js';
import { $, $$, esc, toast, idbClear, timeAgo } from './util.js';
import { renderModelSelect, confirmBox } from './ui.js';

let dlg; const pickQ = {};

export function initSettings() {
  dlg = $('#settings');
  $('#settingsBtn').onclick = () => openSettings();
  addEventListener('pl:open-settings', e => openSettings(e.detail || {}));
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  addEventListener('pl:sync', () => { const s = dlg.querySelector('#cloudStatus'); if (s && dlg.open) s.innerHTML = cloudStatusHTML(); });
}

export function openSettings(opts = {}) {
  render();
  if (!dlg.open) dlg.showModal();
  if (opts.section) { const s = dlg.querySelector('#' + opts.section); if (s) s.scrollIntoView({ block: 'start' }); }
  refreshKeys().then(() => { if (dlg.open && !dlg.contains(document.activeElement)) render(); }).catch(() => {});
}

function cloudStatusHTML() {
  const s = syncState.status;
  if (s === 'error') return `<span class="err">${esc(syncState.msg)}</span>`;
  if (s === 'syncing') return `<span class="muted">${esc(syncState.msg || 'Saving to your cloud library…')}</span>`;
  if (s === 'offline') return `<span class="muted">${esc(syncState.msg)}</span>`;
  if (s === 'idle') return `<span class="ok">Everything is saved to your cloud library${syncState.at ? ' (' + timeAgo(syncState.at) + ')' : ''}.</span>`;
  return '<span class="muted">Connecting…</span>';
}

function provHTML(p) {
  const P = PROVIDERS[p];
  const k = settings.serverKeys[p] || {};
  const n = (settings.models[p] || []).length;
  const inMenu = menuModels(p);
  return `<div class="prov" data-p="${p}">
    <div class="prow"><b>${esc(P.long)}</b><a href="${P.keyUrl}" target="_blank" rel="noopener">Get a key ↗</a></div>
    <div class="row">
      <input class="inp grow" type="password" data-key autocomplete="off" spellcheck="false" placeholder="${k.set ? 'Saved key ' + esc(k.hint) + ' · paste a new one to replace it' : esc(P.keyHint)}" aria-label="${esc(P.name)} API key">
      <button type="button" class="btn pri" data-save>Save</button>
      ${k.set ? '<button type="button" class="btn" data-remove>Remove</button>' : ''}
    </div>
    <div class="pstatus">${k.set ? `<span class="ok">Key saved ${esc(k.hint)}</span> · ` : ''}${n ? `${n} models found` : ''}${k.set || p === 'openrouter' ? ` <button type="button" class="linkbtn" data-load>${n ? 'Refresh model list' : 'Load model list'}</button>` : ''}${k.set && p !== 'openrouter' && inMenu.length && !n ? '<br>In the menu: ' + esc(inMenu.slice(0, 4).map(m => m.name).join(', ')) + (inMenu.length > 4 ? '…' : '') : ''}</div>
    ${p === 'openrouter' || n ? `<div class="orpick">${p === 'anthropic' && n ? `<p class="muted small">Tick the models for your menu. Untick everything to go back to the newest of each kind.</p>` : `<input class="inp" type="search" data-orq placeholder="${n ? 'Search ' + n + ' models' + (p === 'openrouter' ? ' (gpt, claude, gemini…)' : '') + ' and tick the ones for your menu' : 'Load the model list to choose which ones appear in your menu'}" value="${esc(pickQ[p] || '')}">`}<div class="orlist" data-orlist></div></div>` : ''}
    <details class="custom"><summary>Add a model by its exact ID</summary>
      <div class="row"><input class="inp grow" data-cid placeholder="${p === 'openrouter' ? 'e.g. openai/gpt-6.2-sol' : p === 'openai' ? 'e.g. gpt-6.2-sol' : 'e.g. claude-sonnet-5-5'}"><button type="button" class="btn" data-cadd>Add</button></div>
      <div class="cl">${(settings.custom[p] || []).map(id => `<span class="chip">${esc(id)}<button type="button" data-cdel="${esc(id)}" aria-label="Remove ${esc(id)}">✕</button></span>`).join('')}</div>
    </details>
  </div>`;
}

function pickListHTML(p) {
  const list = settings.models[p] || [];
  if (!list.length) return '';
  const all = p === 'anthropic';   // short list: show it whole
  const q = all ? '' : (pickQ[p] || '').trim().toLowerCase();
  const pins = new Set(menuPicks(p));
  const rows = list.filter(m => pins.has(m.id) || !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    .sort((a, b) => (pins.has(b.id) - pins.has(a.id)))
    .slice(0, all ? 200 : q ? 80 : 30);
  return rows.map(m => `<label class="orrow"><input type="checkbox" data-pin="${esc(m.id)}" ${pins.has(m.id) ? 'checked' : ''}><span>${esc(m.name)}</span><code>${esc(m.id)}</code></label>`).join('') +
    (!all && !q && rows.length < list.length ? '<p class="muted small">Search to see more models.</p>' : '');
}

function render() {
  dlg.innerHTML = `<div class="set">
  <header class="set-h"><h2>Settings</h2><nav class="set-nav"><a href="#" data-go="s-ai">AI models</a><a href="#" data-go="s-colors">Colors</a><a href="#" data-go="s-account">Account</a></nav><button type="button" class="ghost x" data-close aria-label="Close">✕</button></header>
  <div class="set-body">
  <section id="s-ai">
    <h3>AI models</h3>
    <p class="help">Paste an API key once and it’s saved privately on your Paper Lens server, so it works on every device you sign in on. The key is never sent back to your browser. API use is billed by the provider, separately from a ChatGPT Plus or Claude Pro subscription. Pick the model from the menu at the top of the page.</p>
    ${Object.keys(PROVIDERS).map(provHTML).join('')}
    <label class="lbl-b" for="effortSel">Effort (Claude models)</label>
    <select id="effortSel" class="inp">${[['low', 'Low: fastest and cheapest'], ['medium', 'Medium: balanced (recommended)'], ['high', 'High: thinks longer'], ['max', 'Max: deepest, slowest, most expensive']].map(([v, l]) => `<option value="${v}" ${settings.effort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <p class="muted small">How much Claude thinks before it answers. Higher effort can give better answers on hard parts of a paper but takes longer and costs more. ChatGPT and OpenRouter models ignore this.</p>
    <label class="lbl-b" for="styleTa">How answers should sound</label>
    <textarea id="styleTa" class="inp" rows="6" placeholder="${esc(DEFAULT_STYLE)}">${esc(settings.style)}</textarea>
    <p class="muted small">Leave empty to use the default shown above. This is sent with every question, whichever model you use.</p>
  </section>
  <section id="s-colors">
    <h3>Highlight colors</h3>
    <p class="help">Give each color a meaning. Labels show up on your highlights and as filters on the home page. Keys 1–5 pick a color while reading.</p>
    <div class="colors">${settings.colors.map((c, i) => `<div class="crow"><input type="color" value="${c.hex}" data-chex="${i}" aria-label="Color ${i + 1}"><input class="inp grow" value="${esc(c.label)}" data-clbl="${i}" aria-label="Label for color ${i + 1}"><kbd>${i + 1}</kbd></div>`).join('')}</div>
    <button type="button" class="btn" id="cReset">Reset colors</button>
  </section>
  <section id="s-account">
    <h3>Your cloud library</h3>
    <p class="help">Your papers, highlights, notes and settings are saved privately in your Vercel storage. To use Paper Lens on another device, open <b>${esc(location.origin + location.pathname)}</b> and sign in with your password.</p>
    <p id="cloudStatus" class="gstat">${cloudStatusHTML()}</p>
    <div class="row"><button type="button" class="btn" id="syncBtn">Sync now</button><button type="button" class="btn danger" id="signout">Sign out of this device</button></div>
    <p class="muted small">Signing out removes the copy on this device. Everything stays in your cloud library.</p>
  </section>
  </div></div>`;
  bind();
  $$('.prov', dlg).forEach(b => { const l = b.querySelector('[data-orlist]'); if (l) l.innerHTML = pickListHTML(b.dataset.p); });
}

function bind() {
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  $$('[data-go]', dlg).forEach(a => a.onclick = e => { e.preventDefault(); dlg.querySelector('#' + a.dataset.go).scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  $$('.prov', dlg).forEach(box => {
    const p = box.dataset.p;
    const st = () => box.querySelector('.pstatus');
    const key = box.querySelector('[data-key]');
    const doSave = async () => {
      const v = key.value.trim(); if (!v) { key.focus(); return; }
      st().textContent = 'Saving…';
      try {
        await saveKey(p, v); key.value = '';
        renderModelSelect();
        try { await loadModels(p); } catch (e) {}
        render(); toast(`${PROVIDERS[p].name} key saved.`);
      } catch (e) { st().innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    };
    box.querySelector('[data-save]').onclick = doSave;
    key.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
    const rm = box.querySelector('[data-remove]');
    if (rm) rm.onclick = async () => {
      if (!await confirmBox(`Remove the ${PROVIDERS[p].name} key?`, 'It will be deleted from your server. You can add a new one any time.', 'Remove', true)) return;
      try { await saveKey(p, ''); renderModelSelect(); render(); } catch (e) { toast(e.message); }
    };
    const ld = box.querySelector('[data-load]');
    if (ld) ld.onclick = async () => {
      st().textContent = 'Loading models…';
      try { const list = await loadModels(p); render(); dlg.querySelector(`.prov[data-p="${p}"] .pstatus`).insertAdjacentHTML('afterbegin', `<span class="ok">Loaded ${list.length} models.</span> `); }
      catch (e) { st().innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    };
    const orq = box.querySelector('[data-orq]');
    if (orq) orq.addEventListener('input', () => { pickQ[p] = orq.value; box.querySelector('[data-orlist]').innerHTML = pickListHTML(p); });
    const orl = box.querySelector('[data-orlist]');
    if (orl) orl.addEventListener('change', e => {
      const id = e.target.dataset.pin; if (!id) return;
      const s = new Set(menuPicks(p));
      if (e.target.checked) s.add(id); else s.delete(id);
      settings.pins = { ...settings.pins, [p]: [...s] }; saveSettings(); renderModelSelect();
      if (!s.size && p !== 'openrouter') { orl.innerHTML = pickListHTML(p); toast('Back to the newest model of each kind.'); }
    });
    box.querySelector('[data-cadd]').onclick = () => {
      const inp = box.querySelector('[data-cid]'); const id = inp.value.trim(); if (!id) return;
      if (!settings.custom[p].includes(id)) settings.custom[p] = [...settings.custom[p], id];
      settings.model = p + ':' + id; saveSettings(); renderModelSelect(); render();
      toast(`Added ${id}${hasKey(p) ? ' and selected it' : ''}.`);
    };
    box.querySelector('.cl').addEventListener('click', e => {
      const id = e.target.dataset.cdel; if (!id) return;
      settings.custom[p] = settings.custom[p].filter(x => x !== id); saveSettings(); renderModelSelect(); render();
    });
  });

  dlg.querySelector('#effortSel').addEventListener('change', e => { settings.effort = e.target.value; saveSettings(); toast('Effort: ' + e.target.value); });
  const sty = dlg.querySelector('#styleTa');
  let st = 0;
  sty.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { settings.style = sty.value; saveSettings(); }, 800); });

  $$('[data-chex]', dlg).forEach(i => i.addEventListener('change', () => { settings.colors = settings.colors.map((c, j) => j === +i.dataset.chex ? { ...c, hex: i.value } : c); saveSettings(); }));
  $$('[data-clbl]', dlg).forEach(i => i.addEventListener('change', () => { settings.colors = settings.colors.map((c, j) => j === +i.dataset.clbl ? { ...c, label: i.value || 'Color' } : c); saveSettings(); }));
  dlg.querySelector('#cReset').onclick = () => { settings.colors = DEFAULT_COLORS.map(c => ({ ...c })); saveSettings(); render(); };

  dlg.querySelector('#syncBtn').onclick = () => syncNow();
  dlg.querySelector('#signout').onclick = async () => {
    if (!await confirmBox('Sign out of this device?', 'The copy of your library on this device will be removed. Your cloud library is not touched.', 'Sign out', true)) return;
    await syncNow();
    for (const s of ['papers', 'data', 'pdfs', 'kv']) await idbClear(s);
    try { localStorage.clear(); } catch (e) {}
    setToken('');
    location.href = location.pathname;
  };
}

async function loadModels(p) {
  const list = await fetchModels(p);
  if (p === 'openrouter' && !settings.pins.openrouter.length) {
    const want = [/^openai\/gpt-6\.2-sol/, /^openai\/gpt-6/, /^anthropic\/claude-sonnet/, /^anthropic\/claude-opus/, /^google\/gemini.*pro/];
    const picks = [];
    for (const re of want) { const m = list.find(x => re.test(x.id) && !picks.includes(x.id)); if (m) picks.push(m.id); }
    settings.pins.openrouter = picks.slice(0, 4); saveSettings();
  }
  renderModelSelect();
  return list;
}
