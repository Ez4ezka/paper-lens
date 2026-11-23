// Settings dialog: API keys + models, GitHub sync, highlight colors, moving setup to another device.
import { settings, saveSettings, replaceSettings, DEFAULT_COLORS } from './store.js';
import { PROVIDERS, fetchModels, menuModels } from './ai.js';
import { syncOn, syncNow, testConnection, syncState } from './sync.js';
import { DEFAULT_STYLE } from './reader.js';
import { $, $$, esc, toast, copyText, bytesToB64, b64ToBytes, idbClear } from './util.js';
import { renderModelSelect, confirmBox } from './ui.js';

let dlg, orQuery = '';

export function initSettings() {
  dlg = $('#settings');
  $('#settingsBtn').onclick = () => openSettings();
  addEventListener('pl:open-settings', e => openSettings(e.detail));
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  addEventListener('pl:sync', () => { const s = dlg.querySelector('#ghStatus'); if (s && dlg.open) s.innerHTML = ghStatusHTML(); });
}

export function openSettings(opts = {}) {
  render(opts);
  if (!dlg.open) dlg.showModal();
  if (opts.section) { const s = dlg.querySelector('#' + opts.section); if (s) s.scrollIntoView({ block: 'start' }); }
}

function ghStatusHTML() {
  if (!syncOn()) return '<span class="muted">Not connected. Your library lives only on this device.</span>';
  const s = syncState.status;
  if (s === 'error') return `<span class="err">${esc(syncState.msg)}</span>`;
  if (s === 'syncing') return `<span class="muted">${esc(syncState.msg || 'Syncing…')}</span>`;
  if (s === 'idle') return '<span class="ok">Connected and synced.</span>';
  if (s === 'offline') return `<span class="muted">${esc(syncState.msg)}</span>`;
  return '<span class="muted">Connected.</span>';
}

function provHTML(p) {
  const P = PROVIDERS[p];
  const n = (settings.models[p] || []).length;
  return `<div class="prov" data-p="${p}">
    <div class="prow"><b>${esc(P.long)}</b><a href="${P.keyUrl}" target="_blank" rel="noopener">Get a key ↗</a></div>
    <div class="row">
      <input class="inp grow" type="password" data-key autocomplete="off" spellcheck="false" placeholder="${esc(P.keyHint)}" value="${esc(settings.keys[p])}" aria-label="${esc(P.name)} API key">
      <button type="button" class="btn" data-show>Show</button>
      <button type="button" class="btn" data-load ${settings.keys[p] || p === 'openrouter' ? '' : 'disabled'}>${n ? 'Reload models' : 'Load models'}</button>
    </div>
    <div class="pstatus">${n ? `${n} models available.` : (p === 'openai' ? 'Tip: if OpenAI blocks browser calls, use OpenRouter for the same GPT models.' : '')}${settings.keys[p] && p !== 'openrouter' ? ' In the menu: ' + esc(menuModels(p).slice(0, 4).map(m => m.name).join(', ')) + (menuModels(p).length > 4 ? '…' : '') : ''}</div>
    ${p === 'openrouter' ? `<div class="orpick"><input class="inp" type="search" data-orq placeholder="${n ? 'Search ' + n + ' models (gpt, claude, gemini…) and tick the ones for your menu' : 'Load models to choose which ones appear in your menu'}" value="${esc(orQuery)}"><div class="orlist" data-orlist></div></div>` : ''}
    <details class="custom"><summary>Add a model by its exact ID</summary>
      <div class="row"><input class="inp grow" data-cid placeholder="${p === 'openrouter' ? 'e.g. openai/gpt-6.2-sol' : p === 'openai' ? 'e.g. gpt-6.2-sol' : 'e.g. claude-sonnet-5-5'}"><button type="button" class="btn" data-cadd>Add</button></div>
      <div class="cl">${(settings.custom[p] || []).map(id => `<span class="chip">${esc(id)}<button type="button" data-cdel="${esc(id)}" aria-label="Remove ${esc(id)}">✕</button></span>`).join('')}</div>
    </details>
  </div>`;
}

function orListHTML() {
  const list = settings.models.openrouter || [];
  if (!list.length) return '';
  const q = orQuery.trim().toLowerCase();
  const pins = new Set(settings.pins.openrouter);
  const rows = list.filter(m => pins.has(m.id) || !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    .sort((a, b) => (pins.has(b.id) - pins.has(a.id)))
    .slice(0, q ? 80 : 30);
  return rows.map(m => `<label class="orrow"><input type="checkbox" data-pin="${esc(m.id)}" ${pins.has(m.id) ? 'checked' : ''}><span>${esc(m.name)}</span><code>${esc(m.id)}</code></label>`).join('') +
    (!q ? '<p class="muted small">Search to see more models.</p>' : '');
}

function render(opts) {
  dlg.innerHTML = `<div class="set">
  <header class="set-h"><h2>Settings</h2><nav class="set-nav"><a href="#" data-go="s-ai">AI models</a><a href="#" data-go="s-sync">Sync</a><a href="#" data-go="s-colors">Colors</a><a href="#" data-go="s-move">Other devices</a></nav><button type="button" class="ghost x" data-close aria-label="Close">✕</button></header>
  <div class="set-body">
  <section id="s-ai">
    <h3>AI models</h3>
    <p class="help">Paper Lens talks to the AI straight from your browser using <b>your own API key</b>. Keys stay on this device (use “Other devices” below to move them). API use is billed by the provider and is separate from a ChatGPT Plus or Claude Pro subscription. Add one or more keys, then pick the model from the menu at the top of the page.</p>
    ${Object.keys(PROVIDERS).map(provHTML).join('')}
    <label class="lbl-b" for="styleTa">How answers should sound</label>
    <textarea id="styleTa" class="inp" rows="6" placeholder="${esc(DEFAULT_STYLE)}">${esc(settings.style)}</textarea>
    <p class="muted small">Leave empty to use the default shown above. This is sent with every question, whichever model you use.</p>
  </section>
  <section id="s-sync">
    <h3>Sync across devices with GitHub</h3>
    <p class="help">Your papers, highlights and notes are saved on this device. To see them on your phone and other computers, Paper Lens can keep a copy in a <b>private GitHub repository</b> you own.</p>
    <ol class="steps">
      <li><a href="https://github.com/new?name=paper-lens-data&visibility=private" target="_blank" rel="noopener">Create a private repository ↗</a>, for example <code>paper-lens-data</code>.</li>
      <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a fine-grained token ↗</a>. Under <i>Repository access</i> pick <i>Only select repositories</i> and choose that repository. Under <i>Permissions → Repository permissions</i> set <i>Contents</i> to <i>Read and write</i>.</li>
      <li>Paste both below and press <i>Connect</i>.</li>
    </ol>
    <div class="grid2">
      <label>Repository<input class="inp" id="ghRepo" placeholder="your-name/paper-lens-data" value="${esc(settings.gh.repo)}" autocomplete="off" spellcheck="false"></label>
      <label>Token<input class="inp" id="ghToken" type="password" placeholder="github_pat_…" value="${esc(settings.gh.token)}" autocomplete="off" spellcheck="false"></label>
    </div>
    <label class="check"><input type="checkbox" id="ghPdfs" ${settings.gh.pdfs ? 'checked' : ''}> Also save the PDF files, so papers open on any device (files up to 45 MB)</label>
    <div class="row"><button type="button" class="btn pri" id="ghConnect">${syncOn() ? 'Sync now' : 'Connect'}</button>${syncOn() ? '<button type="button" class="btn" id="ghOff">Disconnect</button>' : ''}<span id="ghStatus" class="gstat">${ghStatusHTML()}</span></div>
  </section>
  <section id="s-colors">
    <h3>Highlight colors</h3>
    <p class="help">Give each color a meaning. Labels show up on your highlights and as filters on the home page. Shortcut keys 1–5 pick a color while reading.</p>
    <div class="colors">${settings.colors.map((c, i) => `<div class="crow"><input type="color" value="${c.hex}" data-chex="${i}" aria-label="Color ${i + 1}"><input class="inp grow" value="${esc(c.label)}" data-clbl="${i}" aria-label="Label for color ${i + 1}"><kbd>${i + 1}</kbd></div>`).join('')}</div>
    <button type="button" class="btn" id="cReset">Reset colors</button>
  </section>
  <section id="s-move">
    <h3>Set up another device</h3>
    <p class="help">Copy a setup code here, then paste it on your phone or another computer. It carries your API keys, model choices, sync settings and colors, locked with a passphrase you choose.</p>
    <div class="grid2">
      <div><label>Passphrase<input class="inp" id="mvPass" type="password" placeholder="Something you’ll remember" autocomplete="new-password"></label>
        <div class="row"><button type="button" class="btn pri" id="mvMake">Copy setup link</button></div>
        <textarea class="inp code" id="mvOut" rows="3" readonly hidden></textarea></div>
      <div><label>Paste a setup code or link<textarea class="inp code" id="mvIn" rows="3" placeholder="PL1.…">${esc(opts.setupCode || '')}</textarea></label>
        <label>Its passphrase<input class="inp" id="mvInPass" type="password" autocomplete="off"></label>
        <div class="row"><button type="button" class="btn" id="mvApply">Use this setup</button></div></div>
    </div>
  </section>
  <section id="s-data">
    <h3>This device</h3>
    <p class="help">Clearing removes the library, keys and settings from this browser only. Your GitHub copy is not touched.</p>
    <button type="button" class="btn danger" id="wipe">Clear this device</button>
  </section>
  </div></div>`;
  bind();
  const orl = dlg.querySelector('[data-orlist]'); if (orl) orl.innerHTML = orListHTML();
}

function bind() {
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  $$('[data-go]', dlg).forEach(a => a.onclick = e => { e.preventDefault(); dlg.querySelector('#' + a.dataset.go).scrollIntoView({ behavior: 'smooth', block: 'start' }); });

  $$('.prov', dlg).forEach(box => {
    const p = box.dataset.p;
    const key = box.querySelector('[data-key]');
    key.addEventListener('input', () => {
      settings.keys[p] = key.value.trim(); saveSettings(); renderModelSelect();
      box.querySelector('[data-load]').disabled = !settings.keys[p] && p !== 'openrouter';
    });
    box.querySelector('[data-show]').onclick = e => { key.type = key.type === 'password' ? 'text' : 'password'; e.target.textContent = key.type === 'password' ? 'Show' : 'Hide'; };
    box.querySelector('[data-load]').onclick = async e => {
      const st = box.querySelector('.pstatus');
      e.target.disabled = true; st.textContent = 'Loading models…';
      try {
        const list = await fetchModels(p);
        if (p === 'openrouter' && !settings.pins.openrouter.length) {
          const want = [/^openai\/gpt-6\.2-sol/, /^openai\/gpt-6/, /^anthropic\/claude-sonnet/, /^anthropic\/claude-opus/, /^google\/gemini.*pro/];
          const picks = [];
          for (const re of want) { const m = list.find(x => re.test(x.id) && !picks.includes(x.id)); if (m) picks.push(m.id); }
          settings.pins.openrouter = picks.slice(0, 4); saveSettings();
        }
        renderModelSelect();
        render({}); dlg.querySelector(`.prov[data-p="${p}"] .pstatus`).textContent = `Loaded ${list.length} models.` + (p === 'openrouter' ? ' Tick the ones you want in your menu.' : '');
      } catch (err) { st.innerHTML = `<span class="err">${esc(err.message)}</span>`; e.target.disabled = false; }
    };
    const orq = box.querySelector('[data-orq]');
    if (orq) orq.addEventListener('input', () => { orQuery = orq.value; box.querySelector('[data-orlist]').innerHTML = orListHTML(); });
    const orl = box.querySelector('[data-orlist]');
    if (orl) orl.addEventListener('change', e => {
      const id = e.target.dataset.pin; if (!id) return;
      const s = new Set(settings.pins.openrouter);
      e.target.checked ? s.add(id) : s.delete(id);
      settings.pins.openrouter = [...s]; saveSettings(); renderModelSelect();
    });
    box.querySelector('[data-cadd]').onclick = () => {
      const inp = box.querySelector('[data-cid]'); const id = inp.value.trim(); if (!id) return;
      if (!settings.custom[p].includes(id)) settings.custom[p].push(id);
      settings.model = p + ':' + id; saveSettings(); renderModelSelect(); render({});
      toast(`Added ${id} and selected it.`);
    };
    box.querySelector('.cl').addEventListener('click', e => {
      const id = e.target.dataset.cdel; if (!id) return;
      settings.custom[p] = settings.custom[p].filter(x => x !== id); saveSettings(); renderModelSelect(); render({});
    });
  });

  const sty = dlg.querySelector('#styleTa');
  sty.addEventListener('input', () => { settings.style = sty.value; saveSettings(); });

  const repo = dlg.querySelector('#ghRepo'), tok = dlg.querySelector('#ghToken');
  const saveGh = () => {
    let r = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (r !== settings.gh.repo) settings.gh.branch = '';
    settings.gh.repo = r; settings.gh.token = tok.value.trim(); saveSettings();
  };
  repo.addEventListener('change', saveGh); tok.addEventListener('change', saveGh);
  dlg.querySelector('#ghPdfs').onchange = e => { settings.gh.pdfs = e.target.checked; saveSettings(); };
  dlg.querySelector('#ghConnect').onclick = async e => {
    saveGh();
    const st = dlg.querySelector('#ghStatus');
    if (!syncOn()) { st.innerHTML = '<span class="err">Enter the repository as owner/name and paste a token.</span>'; return; }
    e.target.disabled = true; st.innerHTML = '<span class="muted">Checking…</span>';
    try {
      const r = await testConnection();
      st.innerHTML = `<span class="muted">Connected to ${esc(r.name)}${r.private ? '' : ' (warning: this repository is public)'}. Syncing…</span>`;
      await syncNow();
      st.innerHTML = ghStatusHTML();
      dispatchEvent(new CustomEvent('pl:pulled'));
    } catch (err) { st.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
    e.target.disabled = false;
    e.target.textContent = 'Sync now';
  };
  const off = dlg.querySelector('#ghOff');
  if (off) off.onclick = () => { settings.gh.token = ''; saveSettings(); syncNow(); render({}); toast('Sync turned off on this device. Your GitHub copy is kept.'); };

  $$('[data-chex]', dlg).forEach(i => i.addEventListener('input', () => { settings.colors[+i.dataset.chex].hex = i.value; saveSettings(); }));
  $$('[data-clbl]', dlg).forEach(i => i.addEventListener('input', () => { settings.colors[+i.dataset.clbl].label = i.value || 'Color'; saveSettings(); }));
  dlg.querySelector('#cReset').onclick = () => { settings.colors = DEFAULT_COLORS.map(c => ({ ...c })); saveSettings(); render({}); };

  dlg.querySelector('#mvMake').onclick = async () => {
    const pass = dlg.querySelector('#mvPass').value;
    if (pass.length < 6) { toast('Use a passphrase of at least 6 characters.'); return; }
    const models = {}; for (const p of Object.keys(PROVIDERS)) models[p] = settings.keys[p] ? menuModels(p) : [];
    const pack = { keys: settings.keys, models, custom: settings.custom, pins: settings.pins, model: settings.model, gh: { repo: settings.gh.repo, token: settings.gh.token, pdfs: settings.gh.pdfs }, colors: settings.colors, style: settings.style };
    const code = await encrypt(pack, pass);
    const link = location.origin + location.pathname + '#/setup/' + code;
    const out = dlg.querySelector('#mvOut'); out.hidden = false; out.value = link;
    toast(await copyText(link) ? 'Setup link copied. Open it on your other device and enter the passphrase.' : 'Copy the link from the box.');
  };
  dlg.querySelector('#mvApply').onclick = async () => {
    let code = dlg.querySelector('#mvIn').value.trim();
    const m = code.match(/PL1\.[A-Za-z0-9+/=]+/); code = m ? m[0] : code;
    try {
      const pack = await decrypt(code, dlg.querySelector('#mvInPass').value);
      replaceSettings({ ...settings, ...pack, gh: { ...settings.gh, ...pack.gh, branch: '' } });
      renderModelSelect(); render({}); toast('Setup applied. Syncing your library…');
      if (location.hash.startsWith('#/setup/')) history.replaceState(null, '', location.pathname + '#/');
      await syncNow(); dispatchEvent(new CustomEvent('pl:pulled'));
    } catch (e) { toast('That code or passphrase didn’t work.'); }
  };
  dlg.querySelector('#wipe').onclick = async () => {
    if (!await confirmBox('Clear this device?', 'This removes your library, keys and settings from this browser. Anything synced to GitHub stays there.', 'Clear', true)) return;
    for (const s of ['papers', 'data', 'pdfs', 'kv']) await idbClear(s);
    localStorage.clear();
    location.href = location.pathname;
  };
}

/* ---------- passphrase-locked setup code ---------- */
async function keyFrom(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(pass, salt), new TextEncoder().encode(JSON.stringify(obj))));
  const all = new Uint8Array(28 + ct.length); all.set(salt, 0); all.set(iv, 16); all.set(ct, 28);
  return 'PL1.' + bytesToB64(all);
}
async function decrypt(code, pass) {
  if (!code.startsWith('PL1.')) throw new Error('bad code');
  const all = b64ToBytes(code.slice(4));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(16, 28) }, await keyFrom(pass, all.slice(0, 16)), all.slice(28));
  return JSON.parse(new TextDecoder().decode(pt));
}
