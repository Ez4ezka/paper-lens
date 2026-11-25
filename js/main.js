// App shell: routing between home and reader, opening PDFs, model menu, sync status.
import { settings, saveSettings } from './store.js';
import { addPdf } from './library.js';
import { syncNow, syncOn } from './sync.js';
import { getToken, login } from './api.js';
import { refreshKeys } from './ai.js';
import { initReader, openReader, leaveReader } from './reader.js';
import { initHome, renderHome } from './home.js';
import { initSettings, openSettings } from './settings.js';
import { renderModelSelect, renderSyncPill } from './ui.js';
import { $, toast } from './util.js';

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

initReader();
initHome();
initSettings();
renderModelSelect();
renderSyncPill();

const onModel = e => {
  const v = e.target.value;
  if (v === '__settings' || !v) { renderModelSelect(); openSettings({ section: 's-ai' }); return; }
  settings.model = v; saveSettings();
  renderModelSelect();
  toast('Answers will now come from ' + v.split(':').slice(1).join(':'));
};
/* ---------- light / dark theme: follows the device unless you pick one ---------- */
const THEMES = {
  auto: ['Theme: match this device', '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor"/></svg>'],
  light: ['Theme: light', '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'],
  dark: ['Theme: dark', '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'],
};
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const b = $('#themeBtn'), [label, icon] = THEMES[t] || THEMES.auto;
  b.innerHTML = icon; b.title = label + ' (click to change)'; b.setAttribute('aria-label', label);
}
let theme = 'auto';
try { theme = localStorage.getItem('paperlens.theme') || 'auto'; } catch (e) {}
applyTheme(theme);
$('#themeBtn').addEventListener('click', () => {
  theme = { auto: 'dark', dark: 'light', light: 'auto' }[theme] || 'auto';
  try { localStorage.setItem('paperlens.theme', theme); } catch (e) {}
  applyTheme(theme);
  toast(THEMES[theme][0]);
});

$('#modelSel').addEventListener('change', onModel);
$('#modelSel2').addEventListener('change', onModel);
$('#syncPill').addEventListener('click', () => { if (syncOn()) syncNow(); else showGate(); });
addEventListener('pl:sync', renderSyncPill);
addEventListener('pl:settings', renderModelSelect);
addEventListener('pl:pulled', () => { if (!$('#home').hidden) renderHome(); });

/* ---------- opening PDFs ---------- */
$('#file').addEventListener('change', e => { addPdfFile(e.target.files[0]); e.target.value = ''; });
let dragN = 0;
addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragN++; document.body.classList.add('dropping'); } });
addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('dropping'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault(); dragN = 0; document.body.classList.remove('dropping');
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) addPdfFile(f);
});

async function addPdfFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('That isn’t a PDF.'); return; }
  toast('Adding to your library…', 1500);
  try { location.hash = '#/paper/' + await addPdf(file); }
  catch (e) { toast(e.message); }
}

/* ---------- routing ---------- */
async function route() {
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/paper\/([\w-]+)(?:\/([htx])\/([\w.,-]+))?$/))) {
    show('reader');
    let focus = m[2] === 'h' ? { h: m[3] } : m[2] === 't' ? { t: m[3] } : null;
    if (m[2] === 'x') { const v = m[3].split(',').map(Number); if ((v.length === 5 || v.length === 9) && v.every(isFinite)) focus = { x: { page: v[0], bb: v.slice(1, 5), key: v.length === 9 ? v.slice(5) : null } }; }
    await openReader(m[1], focus);
    return;
  }
  show('home');
  await renderHome();
}
function show(which) {
  const home = which === 'home';
  if (home && !$('#reader').hidden) leaveReader();
  $('#home').hidden = !home;
  $('#reader').hidden = home;
  $('#readerTools').hidden = home;
  document.body.dataset.view = which;
  if (home) { $('#fname').textContent = ''; document.title = 'Paper Lens'; }
}
/* ---------- sign-in ---------- */
function showGate(msg) {
  const g = $('#gate'); g.hidden = false;
  $('#gateMsg').textContent = msg || '';
  setTimeout(() => $('#gatePw').focus(), 50);
}
$('#gateForm').addEventListener('submit', async e => {
  e.preventDefault();
  const b = $('#gateBtn'); b.disabled = true; $('#gateMsg').textContent = '';
  try { await login($('#gatePw').value); $('#gatePw').value = ''; $('#gate').hidden = true; start(); }
  catch (err) { $('#gateMsg').textContent = err.message; }
  b.disabled = false;
});
addEventListener('pl:signed-out', () => showGate('Please sign in again.'));

let started = false;
function start() {
  if (!started) { started = true; addEventListener('hashchange', route); }
  route();
  refreshKeys().then(renderModelSelect).catch(() => {});
  syncNow();
}
if (getToken()) start(); else showGate();
