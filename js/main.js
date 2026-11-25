// App shell: routing between home and reader, opening PDFs, model menu, sync status.
import { settings, saveSettings, getPaper, savePaperMeta, putPdf } from './store.js';
import { syncNow, syncOn } from './sync.js';
import { getToken, login } from './api.js';
import { refreshKeys } from './ai.js';
import { initReader, openReader, leaveReader } from './reader.js';
import { initHome, renderHome } from './home.js';
import { initSettings, openSettings } from './settings.js';
import { renderModelSelect, renderSyncPill } from './ui.js';
import { $, toast, sha256Hex, canvasThumb } from './util.js';

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

function guessTitle(meta, items, fileName) {
  const t = (meta && meta.info && meta.info.Title || '').trim();
  if (t.length > 4 && !/^(untitled|microsoft word|title|document)\b/i.test(t) && !/\.(docx?|tex|pdf)$/i.test(t)) return t;
  // biggest text near the top of page 1
  const big = items.filter(i => i.str.trim() && i.y > 0.45);
  if (big.length) {
    const maxH = Math.max(...big.map(i => i.h));
    const s = big.filter(i => i.h >= maxH * 0.88).map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
    if (s.length > 4) return s.slice(0, 180);
  }
  return fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
}

async function addPdfFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('That isn’t a PDF.'); return; }
  if (!window.pdfjsLib) { toast('The PDF reader didn’t load. Reload the page.'); return; }
  toast('Adding to your library…', 1500);
  const buf = await file.arrayBuffer();
  const id = (await sha256Hex(buf)).slice(0, 24);
  let meta = await getPaper(id);
  await putPdf(id, new Blob([buf], { type: 'application/pdf' }));
  if (!meta || meta.deleted) {
    let doc;
    try { doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise; }
    catch (e) { toast('Couldn’t open that PDF.'); return; }
    let info = null, items = [], thumb = '';
    try { info = await doc.getMetadata(); } catch (e) {}
    try {
      const pg = await doc.getPage(1);
      const vp1 = pg.getViewport({ scale: 1 });
      const tc = await pg.getTextContent();
      items = tc.items.map(it => ({ str: it.str || '', h: Math.hypot(it.transform[2], it.transform[3]), y: it.transform[5] / vp1.height }));
      const vp = pg.getViewport({ scale: 320 / vp1.width });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      thumb = canvasThumb(c, 320, .72);
    } catch (e) {}
    const now = Date.now();
    meta = {
      ...(meta || {}), id, deleted: false,
      title: (meta && meta.title) || guessTitle(info, items, file.name),
      fileName: file.name, pages: doc.numPages, size: file.size,
      addedAt: (meta && meta.addedAt) || now, openedAt: now,
      counts: (meta && meta.counts) || { h: 0, t: 0 }, thumb, pdfRemote: !!(meta && meta.pdfRemote),
    };
    doc.destroy();
    await savePaperMeta(meta, true, true);
  }
  location.hash = '#/paper/' + id;
}

/* ---------- routing ---------- */
async function route() {
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/paper\/([\w-]+)(?:\/([ht])\/([\w-]+))?$/))) {
    show('reader');
    const focus = m[2] === 'h' ? { h: m[3] } : m[2] === 't' ? { t: m[3] } : null;
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
