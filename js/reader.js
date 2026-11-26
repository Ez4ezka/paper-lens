// The paper reader: PDF pages, Ask + Highlight tools, notes panel, per-paper highlight list.
import { settings, saveSettings, colorOf, getPaper, getData, saveData, getPdf, putPdf, touchOpened, mergeData, tombstone, listPapers } from './store.js';
import { EXPLAIN, tagQuestions, needsTopic, threadTitle, firstAnswer } from './topics.js';
import { ROLES, roleOf, buildBlocks, dissectRequest, parseDissection, summarySystem } from './structure.js';
import { syncOn, downloadPdf } from './sync.js';
import { chat, currentModel, PROVIDERS } from './ai.js';
import { md, typeset } from './md.js';
import { $, $$, esc, uid, toast, inPoly, canvasToBlob, canvasThumb, copyText, sha256Hex } from './util.js';
import { swatchesHTML, hlCardHTML, renderModelSelect } from './ui.js';
import { initRefPane, onRefsTab, renderRefs, drawCiteMarks, refsTeardown, showCitedSpot } from './refpane.js';

const NS = 'http://www.w3.org/2000/svg';
const R = {
  paper: null, data: null, doc: null, pages: [], scale: 1.25, fitMode: true,
  active: null, live: new Set(), views: new Map(), imgCache: new Map(),
  fullText: null, loadToken: 0, hlFilter: 'all', tab: 'notes', refreshLater: false,
};
let viewer, pagesEl, threadsEl, qEl, sendBtn;
let pending = null, menu = null;

export const DEFAULT_STYLE = `- Plain, conversational language, like explaining to a smart friend from another field. No walls of jargon.
- Spell out every abbreviation the first time you use it, e.g. "MPC (model predictive control)".
- Lead with one or two sentences saying what the thing is and what job it does in this paper.
- Then explain it with a concrete everyday analogy. Where numbers or equations appear, add a tiny worked example with made-up numbers.
- Equation: go symbol by symbol (what each symbol stands for), then say what the whole equation means in words.
- Figure or table: say what is plotted or listed, how to read it, and the one takeaway.
- A single word or symbol: define it, then say what it means in this paper specifically.
- Answer only what was asked; do not wander into side topics.
- Keep it tight: usually 120 to 250 words unless asked for more. Short paragraphs, a few bullets if they help, **bold** for key terms.`;

/* ================= setup ================= */
export function initReader() {
  viewer = $('#viewer'); pagesEl = $('#pages'); threadsEl = $('#threads'); qEl = $('#q'); sendBtn = $('#send');
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

  $$('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $$('[data-shape]').forEach(b => b.addEventListener('click', () => setShape(b.dataset.shape)));
  $('#swatches').addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b) setColor(b.dataset.color); });
  $('#z-in').onclick = () => { R.fitMode = false; setScale(R.scale * 1.15); };
  $('#z-out').onclick = () => { R.fitMode = false; setScale(R.scale / 1.15); };
  $('#z-fit').onclick = fit;
  let lastW = 0;
  new ResizeObserver(() => { const w = viewer.clientWidth; if (R.fitMode && w && Math.abs(w - lastW) > 30) { lastW = w; fit(); } }).observe(viewer);

  $('#ask').addEventListener('submit', e => { e.preventDefault(); if (R.live.size) { for (const c of R.live) c.abort(); return; } submitAsk(qEl.value); });
  qEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!R.live.size) submitAsk(qEl.value); } });
  qEl.addEventListener('input', autosize);
  $('#chips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (!R.active) { toast('Select something on the page first, or type your own question.'); return; }
    submitAsk(b.dataset.q);
  });
  $$('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $$('[data-mv]').forEach(b => b.addEventListener('click', () => setMobileView(b.dataset.mv)));
  $('#copyall').onclick = copyAll;
  $('#ovwPane').addEventListener('click', onOverviewClick);
  initRefPane({ R, pageText, scrollToShape, setTab, setMobileView, persist: () => persist() });
  $('#hlFilters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { R.hlFilter = b.dataset.f; renderHlList(); } });
  $('#hlList').addEventListener('click', onHlListClick);

  // resizable panel
  const d = $('#divider'); let on = false;
  d.addEventListener('pointerdown', e => { on = true; d.setPointerCapture(e.pointerId); });
  d.addEventListener('pointermove', e => { if (!on) return; const w = Math.max(300, Math.min(innerWidth - 320, innerWidth - e.clientX)); document.documentElement.style.setProperty('--panelW', w + 'px'); });
  d.addEventListener('pointerup', () => { on = false; });

  bindDrawing();
  bindTouch();
  addEventListener('keydown', onKey);
  addEventListener('pl:pulled', refreshFromStore);
  setTool(settings.tool || 'ask', true); setShape(settings.shape || 'box', true); renderSwatches();
  addEventListener('pl:settings', renderSwatches);
}

function onKey(e) {
  if ($('#reader').hidden) return;
  if (e.key === 'Escape') { if (menu) { closeMenu(); return; } if (pending) { cancelPending(); return; } }
  if (e.target.closest('textarea,input,select,dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'a') setTool('ask'); else if (k === 'm') setTool('mark'); else if (k === 'h') setTool('hand');
  else if (k === 'b') setShape('box'); else if (k === 'f') setShape('lasso');
  else if (/^[1-9]$/.test(k) && settings.colors[+k - 1]) setColor(settings.colors[+k - 1].id);
  else if (k === '+' || k === '=') { R.fitMode = false; setScale(R.scale * 1.15); }
  else if (k === '-') { R.fitMode = false; setScale(R.scale / 1.15); }
}

function setTool(t, quiet) {
  settings.tool = t; if (!quiet) saveSettings();
  $$('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === t));
  pagesEl.classList.toggle('draw', t !== 'hand');
  pagesEl.classList.toggle('marking', t === 'mark');
  $('#swatches').hidden = t !== 'mark';
  showHint();
  const touch = matchMedia('(pointer:coarse)').matches;
  $('#hint').innerHTML = touch
    ? (t === 'mark' ? 'Drag over text to highlight it · two fingers to scroll or zoom'
      : t === 'ask' ? 'Draw around anything to ask about it · two fingers to scroll or zoom'
      : 'Scroll mode · tap a highlight or note to open it · pinch to zoom')
    : t === 'mark'
    ? 'Drag over text, a formula or a figure to highlight it · <kbd>1</kbd>–<kbd>5</kbd> change color · click a highlight to add a note'
    : t === 'ask' ? 'Draw around anything, type your question, press <kbd>Enter</kbd> · <kbd>M</kbd> highlighter · <kbd>F</kbd> freehand'
    : 'Scroll mode · click a highlight or note to open it';
}
let hintTimer = 0;
function showHint() {
  if (!R.pages.length) return;
  $('#hint').hidden = false;
  clearTimeout(hintTimer); hintTimer = setTimeout(() => { $('#hint').hidden = true; }, 9000);
}
function setShape(s, quiet) {
  settings.shape = s; if (!quiet) saveSettings();
  $$('[data-shape]').forEach(b => b.setAttribute('aria-pressed', b.dataset.shape === s));
}
function setColor(id) {
  settings.hlColor = id; saveSettings();
  if (settings.tool !== 'mark') setTool('mark');
  renderSwatches();
}
function renderSwatches() {
  $('#swatches').innerHTML = swatchesHTML(settings.hlColor);
  document.documentElement.style.setProperty('--mark', colorOf(settings.hlColor).hex);
  if (R.paper) { drawMarks(); renderHlList(); }
}
function setTab(t) {
  R.tab = t;
  $$('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  $('#threads').hidden = t !== 'notes';
  $('#hlPane').hidden = t !== 'hls';
  $('#ovwPane').hidden = t !== 'ovw';
  $('#refPane').hidden = t !== 'refs';
  $('#ask').hidden = t !== 'notes';
  if (t === 'refs') onRefsTab();
}
function setMobileView(v) {
  document.body.classList.toggle('mv-notes', v === 'notes');
  $$('[data-mv]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mv === v));
}

/* ================= open / close ================= */
export async function openReader(id, focus) {
  const tok = ++R.loadToken;
  if (R.paper && R.paper.id === id && R.doc) { $('#fname').textContent = R.paper.title; document.title = R.paper.title + ' · Paper Lens'; applyFocus(focus); return; }
  teardown();
  const meta = await getPaper(id);
  if (!meta || meta.deleted) { toast('That paper isn’t in your library.'); location.hash = '#/'; return; }
  R.paper = meta;
  updateCtx();
  $('#fname').textContent = meta.title;
  document.title = meta.title + ' · Paper Lens';
  const data = await getData(id);
  if (tok !== R.loadToken) return;
  R.data = data;
  setTab('notes'); setMobileView('paper');
  showLoader('Opening the paper…');
  let blob = await getPdf(id);
  if (!blob && syncOn() && meta.pdfRemote) {
    showLoader('Downloading the PDF from your cloud library…');
    try { blob = await downloadPdf(id); if (blob) await putPdf(id, blob); } catch (e) { toast(e.message); }
  }
  if (tok !== R.loadToken) return;
  if (!blob) { showMissing(meta); renderThreads(); renderHlList(); renderOverview(); renderRefs(); return; }
  let doc;
  try { doc = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise; }
  catch (e) { showLoader('This PDF couldn’t be opened.'); return; }
  if (tok !== R.loadToken) { doc.destroy(); return; }
  R.doc = doc;
  pagesEl.innerHTML = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    if (tok !== R.loadToken) return;
    const vp = page.getViewport({ scale: 1 });
    const wrap = document.createElement('div'); wrap.className = 'pw'; wrap.dataset.n = i;
    const cv = document.createElement('canvas'); cv.className = 'pc';
    const hl = document.createElementNS(NS, 'svg'); hl.setAttribute('class', 'hlv'); hl.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`); hl.setAttribute('preserveAspectRatio', 'none');
    const ov = document.createElementNS(NS, 'svg'); ov.setAttribute('class', 'ov'); ov.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`); ov.setAttribute('preserveAspectRatio', 'none');
    const dv = document.createElementNS(NS, 'svg'); dv.setAttribute('class', 'disv'); dv.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`); dv.setAttribute('preserveAspectRatio', 'none');
    const pn = document.createElement('span'); pn.className = 'pn'; pn.textContent = 'Page ' + i;
    wrap.append(cv, dv, hl, ov, pn); pagesEl.append(wrap);
    R.pages.push({ n: i, page, w: vp.width, h: vp.height, wrap, hl, dis: dv, svg: ov, canvas: cv, rendered: 0, busy: false, visible: false });
  }
  hideLoader();
  showHint();
  R.fitMode = true; fit();
  renderThreads(); renderHlList(); drawMarks(); drawDissection(); renderOverview(); drawCiteMarks(); renderRefs();
  touchOpened(id);
  pageText(R.pages[0]);
  viewer.scrollTop = 0;
  applyFocus(focus);
}
export function leaveReader() { cancelPending(); closeMenu(); }
function teardown() {
  cancelPending(); closeMenu();
  for (const k of ['sum', 'dis']) if (OV[k]) { OV[k].ctl.abort(); OV[k] = null; }
  refsTeardown();
  for (const c of R.live) c.abort();
  R.live.clear();
  if (R.doc) { try { R.doc.destroy(); } catch (e) {} }
  for (const p of R.pages) io.unobserve(p.wrap);
  Object.assign(R, { paper: null, data: null, doc: null, pages: [], active: null, fullText: null, hlFilter: 'all' });
  R.views.clear(); R.imgCache.clear();
  pagesEl.innerHTML = '';
  threadsEl.querySelectorAll('.card').forEach(n => n.remove());
  busy(); updateCtx();
}
function showLoader(msg) { const l = $('#loader'); l.hidden = false; l.innerHTML = `<div class="spin"></div><p>${esc(msg)}</p>`; $('#hint').hidden = true; }
function hideLoader() { $('#loader').hidden = true; }
function showMissing(meta) {
  const l = $('#loader'); l.hidden = false;
  l.innerHTML = `<div class="missing"><h2>This PDF isn’t on this device yet</h2>
    <p>Your highlights and notes for <b>${esc(meta.title)}</b> are here, but the PDF file itself isn’t in your cloud library yet. It may still be uploading from the device where you opened it. Try again in a minute, or choose the file below.</p>
    <label class="btn pri" for="refind">Choose the PDF file</label><input type="file" id="refind" accept="application/pdf,.pdf" hidden></div>`;
  $('#refind').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    const buf = await f.arrayBuffer();
    const id = (await sha256Hex(buf)).slice(0, 24);
    if (id !== meta.id) { toast('That’s a different file from the one in your library.'); return; }
    await putPdf(id, new Blob([buf], { type: 'application/pdf' }));
    R.paper = null; openReader(id);
  };
}
function applyFocus(focus) {
  if (!focus) return;
  if (focus.h) { const h = R.data.highlights.find(x => x.id === focus.h && !x.deleted); if (h) { setTab('hls'); scrollToShape(h.page, h.sh, 'h' + h.id); } }
  if (focus.t) { const t = R.data.threads.find(x => x.id === focus.t); if (t) { activate(t, true); if (t.sh) scrollToShape(t.page, t.sh, 't' + t.id); } }
  if (focus.x && R.pages.length) showCitedSpot(focus.x);
}
function scrollToShape(page, sh, key) {
  const p = R.pages[page - 1]; if (!p) return;
  setMobileView('paper');
  const top = p.wrap.offsetTop + sh.bb[1] * R.scale - 90;
  viewer.scrollTo({ top, behavior: 'smooth' });
  setTimeout(() => {
    const el = p.wrap.querySelector(`[data-key="${key}"]`);
    if (el) { el.classList.remove('flash'); void el.getBoundingClientRect(); el.classList.add('flash'); }
  }, 350);
}
async function refreshFromStore() {
  if (!R.paper || !R.data) return;
  if (R.live.size || pending || menu) { R.refreshLater = true; return; }
  R.refreshLater = false;
  const d = await getData(R.paper.id);
  const merged = mergeData(R.data, d);
  if (JSON.stringify(merged) === JSON.stringify(R.data)) return;
  R.data = merged;
  const activeId = R.active && R.active.id;
  renderThreads(); renderHlList(); drawMarks(); drawDissection(); renderOverview(); drawCiteMarks(); renderRefs();
  if (activeId) { const t = R.data.threads.find(x => x.id === activeId); if (t) activate(t); }
}
const persist = () => R.data && saveData(R.data);

/* ================= rendering + zoom ================= */
const io = new IntersectionObserver(es => {
  for (const e of es) {
    const p = R.pages[+e.target.dataset.n - 1]; if (!p) continue;
    p.visible = e.isIntersecting; if (p.visible) renderPage(p);
  }
}, { root: document.getElementById('viewer'), rootMargin: '900px 0px' });

async function renderPage(p) {
  if (p.rendered === R.scale || p.busy) return;
  p.busy = true;
  const want = R.scale, dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = p.page.getViewport({ scale: want * dpr });
  const c = document.createElement('canvas'); c.className = 'pc';
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  try { await p.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; }
  catch (e) { p.busy = false; return; }
  p.busy = false;
  if (want !== R.scale) { if (p.visible) renderPage(p); return; }
  if (!p.wrap.isConnected) return;
  p.canvas.replaceWith(c); p.canvas = c; p.rendered = want;
}
function setScale(s) {
  if (!R.pages.length) return;
  s = Math.max(.4, Math.min(4, s));
  const ratio = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  R.scale = s; $('#zv').textContent = Math.round(s * 100) + '%';
  for (const p of R.pages) { p.wrap.style.width = p.w * s + 'px'; p.wrap.style.height = p.h * s + 'px'; io.unobserve(p.wrap); io.observe(p.wrap); }
  viewer.scrollTop = ratio * viewer.scrollHeight;
  placePop();
  if (menu) placeAt(menu.el, menu.p, menu.h.sh);
}
function fit() {
  R.fitMode = true;
  if (!R.pages.length) return;
  const w = Math.max(...R.pages.map(p => p.w));
  setScale(Math.min(2.2, (viewer.clientWidth - (innerWidth < 600 ? 16 : 40)) / w));
}

/* ================= touch: two fingers scroll and pinch-zoom, whatever tool is on ================= */
function bindTouch() {
  let g = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = t => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  const reset = () => { pagesEl.style.transform = ''; pagesEl.style.transformOrigin = ''; };
  viewer.addEventListener('touchstart', e => {
    if (e.touches.length !== 2 || !R.pages.length) { if (e.touches.length > 2 && g) { reset(); g = null; } return; }
    dispatchEvent(new CustomEvent('pl:multitouch'));
    const pr = pagesEl.getBoundingClientRect(), m = mid(e.touches);
    g = { d0: dist(e.touches) || 1, m0: m, m: m, k: 1, o: [m[0] - pr.left, m[1] - pr.top], sl: viewer.scrollLeft, st: viewer.scrollTop };
    pagesEl.style.transformOrigin = `${g.o[0]}px ${g.o[1]}px`;
  }, { passive: true });
  viewer.addEventListener('touchmove', e => {
    if (!g || e.touches.length !== 2) return;
    if (!e.cancelable) { reset(); g = null; return; }   // the browser is already scrolling; let it
    e.preventDefault();
    g.m = mid(e.touches);
    g.k = Math.max(.4 / R.scale, Math.min(4 / R.scale, dist(e.touches) / g.d0));
    pagesEl.style.transform = `translate(${g.m[0] - g.m0[0]}px, ${g.m[1] - g.m0[1]}px) scale(${g.k})`;
  }, { passive: false });
  const end = e => {
    if (!g || e.touches.length >= 2) return;
    const { k, m, m0, o, sl, st } = g; g = null;
    reset();
    if (Math.abs(k - 1) > .02) {
      R.fitMode = false;
      setScale(R.scale * k);
      // keep the spot between your fingers under your fingers
      viewer.scrollLeft = sl + o[0] * (k - 1) - (m[0] - m0[0]);
      viewer.scrollTop = st + o[1] * (k - 1) - (m[1] - m0[1]);
    } else {
      viewer.scrollLeft = sl - (m[0] - m0[0]);
      viewer.scrollTop = st - (m[1] - m0[1]);
    }
  };
  viewer.addEventListener('touchend', end);
  viewer.addEventListener('touchcancel', end);
  viewer.addEventListener('gesturestart', e => e.preventDefault());   // iOS: don't zoom the whole page
}

/* ================= drawing ================= */
function bindDrawing() {
  let cur = null;
  const fingers = new Set();   // touch points on the pages; two or more = scroll / zoom, not a selection
  const dropCur = () => { if (cur && cur.el) cur.el.remove(); cur = null; };
  pagesEl.addEventListener('pointerup', e => fingers.delete(e.pointerId), true);
  pagesEl.addEventListener('pointercancel', e => fingers.delete(e.pointerId), true);
  addEventListener('pl:multitouch', dropCur);
  const pt = (p, e) => { const r = p.wrap.getBoundingClientRect(); return [Math.max(0, Math.min(p.w, (e.clientX - r.left) / R.scale)), Math.max(0, Math.min(p.h, (e.clientY - r.top) / R.scale))]; };
  const pageOf = w => R.pages[+w.dataset.n - 1];
  pagesEl.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') { fingers.add(e.pointerId); if (fingers.size > 1) { dropCur(); return; } }
    if (e.button !== 0 || e.target.closest('.pop,.tag')) return;
    const w = e.target.closest('.pw'); if (!w) return;
    const p = pageOf(w); if (!p) return;
    if (menu) closeMenu();
    const a = pt(p, e);
    if (settings.tool === 'hand') { cur = { p, a, hand: true, id: e.pointerId, x: e.clientX, y: e.clientY }; return; }
    e.preventDefault();
    w.setPointerCapture(e.pointerId);
    const el = document.createElementNS(NS, 'polygon');
    el.setAttribute('class', settings.tool === 'mark' ? 'draft mark' : 'draft');
    p.svg.append(el);
    cur = { p, el, type: settings.shape, a, pts: [a], id: e.pointerId, mode: settings.tool, x: e.clientX, y: e.clientY };
  });
  pagesEl.addEventListener('pointermove', e => {
    if (!cur || cur.hand || e.pointerId !== cur.id) return;
    const b = pt(cur.p, e);
    if (cur.type === 'box') {
      cur.b = b; const [x0, y0] = cur.a;
      cur.el.setAttribute('points', `${x0},${y0} ${b[0]},${y0} ${b[0]},${b[1]} ${x0},${b[1]}`);
    } else {
      const l = cur.pts[cur.pts.length - 1];
      if (Math.hypot(b[0] - l[0], b[1] - l[1]) * R.scale > 3) { cur.pts.push(b); cur.el.setAttribute('points', cur.pts.map(q => q.join(',')).join(' ')); }
    }
  });
  const end = e => {
    if (!cur || e.pointerId !== cur.id) return;
    const c = cur; cur = null;
    const moved = Math.hypot(e.clientX - c.x, e.clientY - c.y);
    if (c.hand) { if (moved < 6) clickAt(c.p, c.a); return; }
    c.el.remove();
    let shape = null;
    if (c.type === 'box') {
      const b = c.b || c.a;
      const x0 = Math.min(c.a[0], b[0]), y0 = Math.min(c.a[1], b[1]), x1 = Math.max(c.a[0], b[0]), y1 = Math.max(c.a[1], b[1]);
      if ((x1 - x0) * R.scale >= 6 && (y1 - y0) * R.scale >= 6) shape = { type: 'box', pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], bb: [x0, y0, x1, y1] };
    } else if (c.pts.length >= 4) {
      const xs = c.pts.map(q => q[0]), ys = c.pts.map(q => q[1]);
      const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if ((bb[2] - bb[0]) * R.scale >= 8 && (bb[3] - bb[1]) * R.scale >= 8) shape = { type: 'lasso', pts: c.pts, bb };
    }
    if (!shape) { if (moved < 6) clickAt(c.p, c.a); return; }
    shape = compact(shape);
    if (c.mode === 'mark') createHighlight(c.p, shape);
    else startPending(c.p, shape);
  };
  pagesEl.addEventListener('pointerup', end);
  pagesEl.addEventListener('pointercancel', e => { if (cur && e.pointerId === cur.id) { if (cur.el) cur.el.remove(); cur = null; } });
}
const r1 = v => Math.round(v * 10) / 10;
const compact = sh => ({ type: sh.type, pts: sh.pts.map(([x, y]) => [r1(x), r1(y)]), bb: sh.bb.map(r1) });

function clickAt(p, [x, y]) {
  const hs = R.data.highlights.filter(h => !h.deleted && h.page === p.n && inPoly(x, y, h.sh.pts));
  if (hs.length) { openMenu(hs[hs.length - 1], p); return; }
  const ts = R.data.threads.filter(t => !t.deleted && t.sh && t.page === p.n && inPoly(x, y, t.sh.pts));
  if (ts.length) { activate(ts[ts.length - 1], true); return; }
  if (pending && !pending.pop.querySelector('textarea').value.trim()) cancelPending();
}

/* ================= text from the PDF ================= */
async function pageText(p) {
  if (!p) return [];
  if (p.items) return p.items;
  try {
    const tc = await p.page.getTextContent();
    const T = p.page.getViewport({ scale: 1 }).transform;
    p.items = tc.items.filter(it => typeof it.str === 'string').map(it => {
      const m = pdfjsLib.Util.transform(T, it.transform);
      const h = Math.hypot(m[2], m[3]) || 8;
      return { s: it.str, eol: it.hasEOL, x: m[4], y: m[5] - h, w: it.width || it.str.length * h * .5, h };
    });
  } catch (e) { p.items = []; }
  let s = '';
  for (const it of p.items) { s += it.s; if (it.eol) s += '\n'; }
  p.text = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return p.items;
}
async function textIn(p, sh) {
  const items = await pageText(p);
  const [x0, y0, x1, y1] = sh.bb;
  const inside = (x, y) => sh.type === 'box' ? x >= x0 && x <= x1 && y >= y0 && y <= y1 : inPoly(x, y, sh.pts);
  const out = [];
  for (const it of items) {
    if (!it.s.trim()) continue;
    // the line must sit mostly inside the selection vertically
    const iy = Math.min(y1, it.y + it.h) - Math.max(y0, it.y);
    if (iy < .45 * it.h || it.x > x1 || it.x + it.w < x0) continue;
    // PDF text comes in whole lines, so keep only the words whose middle is inside the selection
    const cw = it.w / Math.max(1, it.s.length), cy = it.y + it.h / 2;
    for (const m of it.s.matchAll(/\S+/g)) {
      const cx = it.x + (m.index + m[0].length / 2) * cw;
      if (inside(cx, cy)) out.push(m[0]);
    }
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}
async function paperText() {
  let s = '';
  for (const p of R.pages) { await pageText(p); s += `\n\n[Page ${p.n}]\n` + p.text; if (s.length > 90000) break; }
  return s.slice(0, 90000);
}

/* ================= picture of a selection ================= */
async function crop(p, sh, { mask = true, outline = true, maxSide = 1500 } = {}) {
  const pad = sh.type === 'box' ? 0 : 6;   // a box is cut exactly; a freehand shape keeps a faded margin for context
  const x0 = Math.max(0, sh.bb[0] - pad), y0 = Math.max(0, sh.bb[1] - pad), x1 = Math.min(p.w, sh.bb[2] + pad), y1 = Math.min(p.h, sh.bb[3] + pad);
  const bw = x1 - x0, bh = y1 - y0;
  let rs = Math.min(6, Math.max(2, maxSide / Math.max(bw, bh)));
  while (bw * rs * bh * rs > 9e6) rs *= .85;
  const W = Math.ceil(bw * rs), H = Math.ceil(bh * rs);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  await p.page.render({ canvasContext: ctx, viewport: p.page.getViewport({ scale: rs, offsetX: -x0 * rs, offsetY: -y0 * rs }) }).promise;
  if (mask && sh.type === 'lasso') {
    const path = new Path2D();
    sh.pts.forEach((q, i) => { const X = (q[0] - x0) * rs, Y = (q[1] - y0) * rs; i ? path.lineTo(X, Y) : path.moveTo(X, Y); });
    path.closePath();
    const outside = new Path2D(); outside.rect(0, 0, W, H); outside.addPath(path);
    ctx.fillStyle = 'rgba(255,255,255,.82)'; ctx.fill(outside, 'evenodd');
    if (outline) { ctx.strokeStyle = '#1f8cff'; ctx.lineWidth = Math.max(2, rs * .8); ctx.stroke(path); }
  }
  return c;
}

/* ================= marks on the pages ================= */
function drawMarks() {
  for (const p of R.pages) { p.hl.innerHTML = ''; p.svg.querySelectorAll('.mk').forEach(n => n.remove()); }
  for (const h of R.data ? R.data.highlights : []) {
    if (h.deleted) continue;
    const p = R.pages[h.page - 1]; if (!p) continue;
    const el = document.createElementNS(NS, 'polygon');
    el.setAttribute('points', h.sh.pts.map(q => q.join(',')).join(' '));
    el.setAttribute('class', 'hlm' + (h.sh.type === 'lasso' ? ' round' : ''));
    el.style.setProperty('--c', colorOf(h.color).hex);
    el.dataset.key = 'h' + h.id;
    p.hl.append(el);
    if (h.note) {
      const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'mk notedot'); g.dataset.key = 'n' + h.id;
      g.innerHTML = `<circle cx="${h.sh.bb[2]}" cy="${h.sh.bb[1]}" r="4.5" style="fill:${colorOf(h.color).hex}"/><text x="${h.sh.bb[2]}" y="${h.sh.bb[1] + .4}">✎</text>`;
      p.svg.append(g);
    }
  }
  for (const t of R.data ? R.data.threads : []) {
    if (t.deleted || !t.sh) continue;
    const p = R.pages[t.page - 1]; if (!p) continue;
    const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'mk'); g.dataset.id = t.id;
    const s = document.createElementNS(NS, 'polygon');
    s.setAttribute('points', t.sh.pts.map(q => q.join(',')).join(' '));
    s.setAttribute('class', 'sel' + (R.active === t ? ' on' : ''));
    s.dataset.key = 't' + t.id;
    const tg = document.createElementNS(NS, 'g'); tg.setAttribute('class', 'tag');
    const cx = t.sh.bb[0], cy = t.sh.bb[1];
    tg.innerHTML = `<circle cx="${cx}" cy="${cy}" r="7"/><text x="${cx}" y="${cy + .5}">${t.n}</text>`;
    tg.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); activate(t, true); if (innerWidth < 860) setMobileView('notes'); });
    g.append(s, tg); p.svg.append(g);
  }
}

/* ================= highlights ================= */
async function createHighlight(p, sh) {
  const now = Date.now();
  const h = { id: uid(), page: p.n, sh, color: settings.hlColor, text: '', img: '', note: '', createdAt: now, updatedAt: now };
  R.data.highlights.push(h);
  drawMarks(); renderHlList();
  await persist();
  try {
    const [text, c] = await Promise.all([textIn(p, sh), crop(p, sh, { maxSide: 900, outline: false })]);
    h.text = text; h.img = canvasThumb(c, 520, .74); h.updatedAt = Date.now();
  } catch (e) {}
  if (h.deleted) return;
  renderHlList(); await persist();
  const lbl = colorOf(h.color).label;
  toast(`Highlighted as “${lbl}”. Click it to add a note.`, 2200);
}

function openMenu(h, p) {
  closeMenu(); cancelPending();
  const el = document.createElement('div');
  el.className = 'pop hmenu';
  el.innerHTML = `<div class="sws">${swatchesHTML(h.color, 'data-hc')}</div>
    <textarea rows="2" placeholder="Add a note to this highlight…" aria-label="Note">${esc(h.note || '')}</textarea>
    <div class="poprow"><button type="button" class="ghost" data-a="del">Delete</button><button type="button" class="ghost" data-a="copy">Copy text</button><button type="button" class="btn pri" data-a="ask">Ask about this</button></div>`;
  p.wrap.append(el);
  menu = { el, h, p };
  placeAt(el, p, h.sh);
  const ta = el.querySelector('textarea');
  let tmr = 0;
  const saveNote = () => { clearTimeout(tmr); if ((h.note || '') !== ta.value) { h.note = ta.value; h.updatedAt = Date.now(); persist(); drawMarks(); renderHlList(); } };
  ta.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(saveNote, 600); });
  ta.addEventListener('blur', saveNote);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); saveNote(); closeMenu(); } });
  el.querySelector('.sws').addEventListener('click', e => {
    const b = e.target.closest('[data-hc]'); if (!b) return;
    h.color = b.dataset.hc; h.updatedAt = Date.now(); persist(); drawMarks(); renderHlList();
    el.querySelectorAll('[data-hc]').forEach(x => x.setAttribute('aria-pressed', x === b));
  });
  el.addEventListener('click', async e => {
    const a = e.target.closest('[data-a]'); if (!a) return;
    if (a.dataset.a === 'del') { saveNote(); deleteHighlight(h); closeMenu(); }
    else if (a.dataset.a === 'copy') { toast(await copyText(h.text || '') ? 'Copied the highlighted text.' : 'Couldn’t copy.'); }
    else if (a.dataset.a === 'ask') { saveNote(); closeMenu(); startPending(p, h.sh); }
  });
}
function closeMenu() { if (!menu) return; const m = menu; menu = null; const ta = m.el.querySelector('textarea'); if (ta) ta.blur(); m.el.remove(); if (R.refreshLater) refreshFromStore(); }
function deleteHighlight(h) {
  const i = R.data.highlights.indexOf(h);
  if (i < 0) return;
  const tomb = tombstone(h);
  R.data.highlights[i] = tomb; h.deleted = true;
  drawMarks(); renderHlList(); persist();
  toast('Highlight deleted.');
}
function placeAt(el, p, sh) {
  const s = R.scale, W = p.w * s, H = p.h * s;
  const pw = Math.min(360, W - 16); el.style.width = pw + 'px';
  el.style.left = Math.max(8, Math.min(sh.bb[0] * s, W - pw - 8)) + 'px';
  const ph = el.offsetHeight || 140;
  let top = sh.bb[3] * s + 10;
  if (top + ph > H - 8) top = Math.max(8, sh.bb[1] * s - ph - 10);
  el.style.top = top + 'px';
}

function renderHlList() {
  if (!R.data) return;
  const all = R.data.highlights.filter(h => !h.deleted);
  $('#hCount').textContent = all.length || '';
  const cnt = id => all.filter(h => h.color === id).length;
  $('#hlFilters').innerHTML = `<button type="button" class="fchip" data-f="all" aria-pressed="${R.hlFilter === 'all'}">All ${all.length}</button>` +
    settings.colors.map(c => `<button type="button" class="fchip" data-f="${c.id}" aria-pressed="${R.hlFilter === c.id}" style="--c:${c.hex}"><span class="dot"></span>${esc(c.label)} ${cnt(c.id)}</button>`).join('');
  const shown = all.filter(h => R.hlFilter === 'all' || h.color === R.hlFilter).sort((a, b) => a.page - b.page || a.sh.bb[1] - b.sh.bb[1]);
  $('#hlList').innerHTML = shown.length ? shown.map(h => hlCardHTML(h, R.paper, { showPaper: false })).join('')
    : `<div class="empty-s"><p><b>No highlights${R.hlFilter === 'all' ? '' : ' in this color'} yet.</b></p><p>Pick the highlighter (<kbd>M</kbd>), choose a color, and drag over text, a formula or a figure.</p></div>`;
}
async function onHlListClick(e) {
  const card = e.target.closest('.hc'); if (!card) return;
  const h = R.data.highlights.find(x => x.id === card.dataset.hid); if (!h) return;
  if (e.target.closest('[data-copy]')) { toast(await copyText(h.text || '') ? 'Copied.' : 'Couldn’t copy.'); return; }
  scrollToShape(h.page, h.sh, 'h' + h.id);
}

/* ================= ask: the question box beside a selection ================= */
function cancelPending() {
  if (!pending) return '';
  const pd = pending; pending = null; pd.el.remove(); pd.pop.remove();
  if (R.refreshLater) refreshFromStore();
  return pd.pop.querySelector('textarea').value;
}
function placePop() { if (pending) placeAt(pending.pop, pending.p, pending.sh); }
function startPending(p, sh) {
  const carry = cancelPending();
  closeMenu();
  const el = document.createElementNS(NS, 'polygon');
  el.setAttribute('points', sh.pts.map(q => q.join(',')).join(' '));
  el.setAttribute('class', 'sel on'); p.svg.append(el);
  const prep = Promise.all([crop(p, sh).catch(() => null), textIn(p, sh).catch(() => '')]);
  const pop = document.createElement('form');
  pop.className = 'pop'; pop.setAttribute('aria-label', 'Ask about this selection');
  const m = currentModel();
  pop.innerHTML = `<textarea rows="2" placeholder="What do you want to know about this? Press Enter to ask." aria-label="Your question about the selection"></textarea>
    <div class="poprow"><span class="pm">${m ? esc(m.id) : '<a href="#" data-set>Set up a model</a>'}</span><button type="button" class="ghost px" title="Esc">Cancel</button><button type="button" class="btn pex">Just explain</button><button class="btn pri">Ask</button></div>`;
  p.wrap.append(pop);
  const ta = pop.querySelector('textarea');
  ta.value = carry || qEl.value.trim();
  if (!carry && qEl.value.trim()) { qEl.value = ''; autosize(); }
  pending = { p, sh, el, pop, prep };
  placePop(); $('#hint').hidden = true;
  pop.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  setTimeout(() => ta.focus({ preventScroll: true }), 0);
  const go = q => { if (pending && pending.pop === pop) { pending = null; el.remove(); pop.remove(); newThread(p, sh, q.trim(), prep); } };
  pop.addEventListener('submit', e => { e.preventDefault(); go(ta.value); });
  pop.querySelector('.pex').onclick = () => go('');
  pop.querySelector('.px').onclick = () => cancelPending();
  const st = pop.querySelector('[data-set]'); if (st) st.onclick = e => { e.preventDefault(); dispatchEvent(new CustomEvent('pl:open-settings')); };
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(ta.value); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelPending(); }
  });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight + 2) + 'px'; placePop(); });
}

/* ================= overview: AI summary + AI dissection ================= */
const OV = { sum: null, dis: null };   // running jobs: { ctl, status }

function renderOverview() {
  const box = $('#ovwPane'); if (!box) return;
  const d = R.data || {}, sum = d.summary, dis = d.dissection;
  const canDissect = !!R.pages.length;
  const head = (what, it) => `<div class="ovh"><h3>${what}</h3><span class="muted small">${it.model ? esc(it.model.split(':').slice(1).join(':')) + ' · ' : ''}${esc(new Date(it.updatedAt || it.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</span></div>`;
  box.innerHTML = `
    <div class="ovw-actions">
      <button type="button" class="btn pri ovb" data-ov="sum" ${OV.sum ? 'disabled' : ''}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M5 10h14M5 15h9M5 20h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m18 14 1 2.4 2.4 1-2.4 1L18 21l-1-2.6-2.4-1 2.4-1Z" fill="currentColor"/></svg>
        <span><b>${sum ? 'New summary' : 'AI summary'}</b><small>The whole paper and its main parts</small></span></button>
      <button type="button" class="btn ovb" data-ov="dis" ${OV.dis || !canDissect ? 'disabled' : ''} ${canDissect ? '' : 'title="Open the PDF first"'}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="6" rx="1.5" fill="none" stroke="#e11d48" stroke-width="2"/><rect x="3" y="11" width="8" height="10" rx="1.5" fill="none" stroke="#2563eb" stroke-width="2"/><rect x="13" y="11" width="8" height="10" rx="1.5" fill="none" stroke="#16a34a" stroke-width="2"/></svg>
        <span><b>${dis ? 'New dissection' : 'AI dissection'}</b><small>Boxes over the paper: thesis, method, results…</small></span></button>
    </div>
    ${OV.sum ? `<div class="ovs"><span class="think">${esc(OV.sum.status)}</span><button type="button" class="ghost" data-ov="stop-sum">Stop</button></div>` : ''}
    ${OV.sum && OV.sum.text ? `<section class="ovsec"><div class="msg a sumtext">${md(OV.sum.text)}</div></section>` : ''}
    ${!OV.sum && sum ? `<section class="ovsec">${head('Summary', sum)}<div class="msg a sumtext">${md(sum.text)}</div><div class="row"><button type="button" class="mini" data-ov="copy-sum">Copy</button></div></section>` : ''}
    ${OV.dis ? `<div class="ovs"><span class="think">${esc(OV.dis.status)}</span><button type="button" class="ghost" data-ov="stop-dis">Stop</button></div>` : ''}
    ${!OV.dis && dis && dis.parts.length ? `<section class="ovsec">${head('How this paper is built', dis)}
      <label class="ovtoggle"><input type="checkbox" data-ov="show" ${settings.showParts ? 'checked' : ''}> Show the boxes on the paper</label>
      <ol class="parts">${dis.parts.map((p, i) => `<li><button type="button" class="part" data-part="${i}" style="--c:${roleOf(p.role).color}">
        <span class="prole">${esc(roleOf(p.role).label)}</span>
        <span class="plabel">${esc(p.label.replace(new RegExp('^' + roleOf(p.role).label + ':\\s*', 'i'), ''))}</span>
        ${p.note ? `<span class="pnote">${esc(p.note)}</span>` : ''}
        ${p.quote ? `<span class="pquote">“${esc(p.quote)}”</span>` : ''}
        <span class="ppage">${p.from === p.to ? 'p. ' + p.from : 'pp. ' + p.from + '–' + p.to}</span></button></li>`).join('')}</ol></section>` : ''}
    ${!sum && !dis && !OV.sum && !OV.dis ? `<div class="ovempty"><p><b>Get the big picture before you dive in.</b></p><p><b>AI summary</b> explains what the paper is about, its main claim and each of its main parts.</p><p><b>AI dissection</b> draws see-through colored boxes over the pages, so you can see where the thesis, background, method, results and conclusion are.</p></div>` : ''}`;
  typeset(box);
}

async function onOverviewClick(e) {
  const b = e.target.closest('[data-ov],[data-part]'); if (!b) return;
  const v = b.dataset.ov;
  if (v === 'sum') runSummary();
  else if (v === 'dis') runDissection();
  else if (v === 'stop-sum' && OV.sum) OV.sum.ctl.abort();
  else if (v === 'stop-dis' && OV.dis) OV.dis.ctl.abort();
  else if (v === 'copy-sum') toast(await copyText(R.data.summary.text) ? 'Copied the summary.' : 'Couldn’t copy.');
  else if (v === 'show') { settings.showParts = b.checked; saveSettings(); drawDissection(); }
  else if (b.dataset.part != null) {
    const p = R.data.dissection.parts[+b.dataset.part]; if (!p) return;
    if (!settings.showParts) { settings.showParts = true; saveSettings(); drawDissection(); renderOverview(); }
    const r = (p.key && p.key[0]) || p.regions[0];
    if (r) scrollToShape(r.page, { bb: r.bb }, 'd' + p.id);
  }
}

async function runSummary() {
  if (!R.paper || OV.sum) return;
  if (!currentModel()) { toast('Pick an AI model in Settings first.'); dispatchEvent(new CustomEvent('pl:open-settings')); return; }
  const pid = R.paper.id, ctl = new AbortController();
  OV.sum = { ctl, status: 'Reading the whole paper…', text: '' };
  renderOverview();
  let raf = 0;
  try {
    if (R.fullText == null && R.pages.length) R.fullText = await paperText();
    if (!R.fullText) throw new Error('This paper has no readable text (it may be a scanned image).');
    if (OV.sum && OV.sum.ctl === ctl) { OV.sum.status = 'Writing the summary…'; renderOverview(); }
    const r = await chat({
      system: summarySystem(R.paper.title, R.fullText), signal: ctl.signal,
      turns: [{ role: 'user', content: 'Summarize this paper.' }],
      onText: t => { if (!OV.sum || OV.sum.ctl !== ctl) return; OV.sum.text = t; if (!raf) raf = requestAnimationFrame(() => { raf = 0; const el = $('#ovwPane .sumtext'); if (el) el.innerHTML = md(OV.sum.text); else renderOverview(); }); },
    });
    if (!R.paper || R.paper.id !== pid) return;
    const now = Date.now();
    R.data.summary = { text: r.text, model: r.model.provider + ':' + r.model.id, createdAt: now, updatedAt: now };
    await persist();
  } catch (e) {
    if (e.code !== 'cancelled') toast(e.message || 'Couldn’t write the summary.', 4500);
  } finally {
    cancelAnimationFrame(raf); if (OV.sum && OV.sum.ctl === ctl) OV.sum = null;
    if (R.paper && R.paper.id === pid) renderOverview();
  }
}

async function runDissection() {
  if (!R.paper || OV.dis || !R.pages.length) return;
  if (!currentModel()) { toast('Pick an AI model in Settings first.'); dispatchEvent(new CustomEvent('pl:open-settings')); return; }
  const pid = R.paper.id, ctl = new AbortController();
  OV.dis = { ctl, status: 'Reading every page…' };
  renderOverview();
  try {
    for (const p of R.pages) await pageText(p);
    const blocks = buildBlocks(R.pages.map(p => ({ n: p.n, w: p.w, h: p.h, items: p.items })));
    if (!blocks.length) throw new Error('This paper has no readable text (it may be a scanned image).');
    if (OV.dis && OV.dis.ctl === ctl) { OV.dis.status = 'Finding the thesis, method, results… (about 20 to 60 seconds)'; renderOverview(); }
    const req = dissectRequest(R.paper.title, blocks);
    const r = await chat({ system: req.system, turns: [{ role: 'user', content: req.user }], signal: ctl.signal });
    const parts = parseDissection(r.text, blocks);
    if (!parts.length) throw new Error('The AI’s answer couldn’t be read. Try again, or pick a stronger model.');
    if (!R.paper || R.paper.id !== pid) return;
    const now = Date.now();
    R.data.dissection = { v: 1, parts, model: r.model.provider + ':' + r.model.id, createdAt: now, updatedAt: now };
    settings.showParts = true; saveSettings();
    await persist();
    drawDissection();
    toast(`Found ${parts.length} parts. Click one to jump to it.`);
  } catch (e) {
    if (e.code !== 'cancelled') toast(e.message || 'Couldn’t dissect the paper.', 4500);
  } finally {
    if (OV.dis && OV.dis.ctl === ctl) OV.dis = null;
    if (R.paper && R.paper.id === pid) renderOverview();
  }
}

// See-through colored boxes over the pages, one per part, labeled with its role.
// Labels never cover text: above the box if there is room, else in the page margin, else a vertical tab in the gutter.
let disTok = 0;
async function drawDissection() {
  const tok = ++disTok;
  for (const p of R.pages) p.dis.innerHTML = '';
  const dis = R.data && R.data.dissection;
  if (!dis || !settings.showParts || !R.pages.length) return;
  const pages = new Set(dis.parts.flatMap(pt => pt.regions.map(r => r.page)));
  for (const n of pages) if (R.pages[n - 1]) await pageText(R.pages[n - 1]);
  if (tok !== disTok) return;
  const FS = 7, H = FS + 4;
  const taken = new Map();   // page -> rects already used by text or labels
  const blockers = p => {
    if (!taken.has(p.n)) taken.set(p.n, (p.items || []).filter(it => it.s.trim()).map(it => [it.x + .5, it.y + .5, it.x + it.w - .5, it.y + it.h - .5]));
    return taken.get(p.n);
  };
  const free = (p, r) => r[0] >= 0 && r[1] >= 0 && r[2] <= p.w && r[3] <= p.h && !blockers(p).some(b => r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1]);
  dis.parts.forEach((part, i) => {
    const c = roleOf(part.role).color, seen = new Set();
    for (const r of [...part.regions.map(x => ({ ...x, k: false })), ...(part.key || []).map(x => ({ ...x, k: true }))]) {
      const p = R.pages[r.page - 1]; if (!p) continue;
      const [x0, y0, x1, y1] = r.bb;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'dpart' + (r.k ? ' dkey' : '') + (part.role === 'thesis' ? ' dthesis' : ''));
      g.style.setProperty('--c', c);
      const box = document.createElementNS(NS, 'rect');
      Object.entries({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 3 }).forEach(([k, v]) => box.setAttribute(k, v));
      box.dataset.key = 'd' + part.id;
      g.append(box);
      if (!r.k && !seen.has(r.page)) {
        seen.add(r.page);
        const name = roleOf(part.role).label, W = name.length * FS * .64 + 8;
        const spots = [
          { rect: [x0, y0 - H - .5, x0 + W, y0 - .5] },                    // above the box
          { rect: [x0 - W - 2, y0, x0 - 2, y0 + H] },                      // in the margin to the left
          { rect: [x0 - H - 1.5, y0, x0 - 1.5, y0 + W], vertical: true },  // a tab in the gutter
          { rect: [x0, y0 - H - .5, x0 + W, y0 - .5] },                    // nothing is free: above anyway
        ];
        const spot = spots.find((sp, k) => k === spots.length - 1 || free(p, sp.rect));
        blockers(p).push(spot.rect);
        const [a, b, cc, d] = spot.rect;
        const lab = document.createElementNS(NS, 'g'); lab.setAttribute('class', 'dlab');
        lab.innerHTML = `<rect x="${a}" y="${b}" width="${cc - a}" height="${d - b}" rx="2.5"/>` + (spot.vertical
          ? `<text x="${(a + cc) / 2}" y="${(b + d) / 2}" transform="rotate(-90 ${(a + cc) / 2} ${(b + d) / 2})" text-anchor="middle">${esc(name)}</text>`
          : `<text x="${a + 4}" y="${(b + d) / 2 + .3}">${esc(name)}</text>`) + `<title>${esc(part.label)}${part.note ? ' — ' + esc(part.note) : ''}</title>`;
        lab.addEventListener('pointerdown', ev => {
          ev.stopPropagation(); ev.preventDefault();
          setTab('ovw'); if (innerWidth < 860) setMobileView('notes');
          const el = $(`#ovwPane [data-part="${i}"]`);
          if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
        });
        g.append(lab);
      }
      p.dis.append(g);
    }
  });
}

/* ================= notes (AI threads) ================= */
const nextN = () => 1 + Math.max(0, ...R.data.threads.map(t => t.n || 0));

async function newThread(p, sh, typed, prep) {
  const now = Date.now();
  const t = { id: uid(), n: nextN(), page: p.n, sh, sel: '', turns: [], thumb: '', createdAt: now, updatedAt: now };
  R.data.threads.push(t);
  makeCard(t); drawMarks(); activate(t, true); updateCounts();
  if (innerWidth < 860) setMobileView('notes');
  const v = R.views.get(t.id);
  if (typed) addMsg(v, 'u', esc(typed));
  const bubble = addMsg(v, 'a', '<span class="think">Scanning your selection…</span>');
  const [c, sel] = await prep;
  t.sel = sel || '';
  if (c) {
    R.imgCache.set(t.id, await canvasToBlob(c));
    t.thumb = canvasThumb(c, 600, .74);
    const img = v.card.querySelector('.thumb img'); if (img) img.src = t.thumb;
  }
  bubble.remove();
  ask(t, typed || EXPLAIN, { show: false });
}

function systemFor(t) {
  const style = (settings.style || '').trim() || DEFAULT_STYLE;
  const head = `You are a patient tutor helping someone read a research paper in an interactive reader. ${t.sh ? 'They drew a ' + (t.sh.type === 'box' ? 'box' : 'freehand outline') + ' around part of a page and are asking about what is inside it.' : 'They are asking about the paper as a whole.'}

How to answer:
${style}
- Write math in LaTeX: $...$ inline, $$...$$ on its own line.
- Answer about what is inside the selection. The page text below is only background, so don't explain parts of the page they didn't select unless it's needed to make sense of the selection.
- If the selection is unclear or cut off, say what you can see and make your best reading.

Paper title: ${R.paper.title}`;
  if (!t.sh) return head + `\n\nFull text of the paper (extracted from the PDF, so figures and some math may be garbled):\n"""\n${R.fullText || ''}\n"""`;
  const p = R.pages[t.page - 1], prev = R.pages[t.page - 2], first = R.pages[0];
  return head + `\n\nOpening of the paper, for context:\n"""\n${(first && first.text || '').slice(0, 3500)}\n"""` +
    (prev && prev.text && t.page > 2 ? `\n\nEnd of page ${t.page - 1}, for context:\n"""\n${prev.text.slice(-2500)}\n"""` : '') +
    `\n\nText of page ${t.page}, where the selection is:\n"""\n${(p && p.text || '').slice(0, 7000)}\n"""\n\nTHE SELECTION (page ${t.page}): the attached image shows exactly what they selected${t.sh.type === 'lasso' ? '; the region inside the blue outline is the selection, the faded area around it is only nearby context' : ''}. Text the PDF reports inside the selection (may be empty or garbled for math, figures and images): """${t.sel || '(none)'}"""`;
}

async function ask(t, question, { show = true } = {}) {
  const v = R.views.get(t.id) || makeCard(t);
  if (show) addMsg(v, 'u', esc(question));
  const el = addMsg(v, 'a', '<span class="think">Thinking…</span>');
  v.msgs.lastElementChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  let image = null;
  if (t.sh) {
    const p = R.pages[t.page - 1];
    if (p) {
      await Promise.all([pageText(R.pages[0]), pageText(p), pageText(R.pages[t.page - 2])]);
      image = R.imgCache.get(t.id);
      if (!image) { try { image = await canvasToBlob(await crop(p, t.sh)); R.imgCache.set(t.id, image); } catch (e) {} }
    }
  } else if (R.fullText == null && R.pages.length) R.fullText = await paperText();
  const turns = [...t.turns.map(x => ({ role: x.role, content: x.content })), { role: 'user', content: question }];
  const ctl = new AbortController(); v.ctl = ctl; R.live.add(ctl); busy();
  let raf = 0, latest = '';
  try {
    const r = await chat({
      system: systemFor(t), turns, image, signal: ctl.signal,
      onText: txt => { latest = txt; if (!raf) raf = requestAnimationFrame(() => { raf = 0; el.innerHTML = md(latest); }); },
    });
    cancelAnimationFrame(raf);
    t.turns = [...t.turns, { role: 'user', content: question }, { role: 'assistant', content: r.text, model: r.model.provider + ':' + r.model.id }];
    t.updatedAt = Date.now();
    el.innerHTML = md(r.text) + modelTag(t.turns[t.turns.length - 1].model);
    typeset(el);
    if (r.truncated) el.insertAdjacentHTML('beforeend', '<div class="note">The answer hit the length limit. Ask “continue” for the rest.</div>');
    await persist();
    autoTag(t.id);
  } catch (e) {
    cancelAnimationFrame(raf);
    const part = e.partial ? md(e.partial) : '';
    if (e.code === 'cancelled') {
      el.innerHTML = part + '<div class="note">Stopped.</div>';
      if (e.partial) { t.turns = [...t.turns, { role: 'user', content: question }, { role: 'assistant', content: e.partial }]; t.updatedAt = Date.now(); persist(); }
    } else {
      el.innerHTML = part + `<div class="note err">${esc(e.message || 'Something went wrong.')} <button type="button" data-retry>Retry</button>${['setup', 'auth', 'model', 'network'].includes(e.code) ? '<button type="button" data-settings>Settings</button>' : ''}</div>`;
      el.querySelector('[data-retry]').onclick = () => { el.remove(); ask(t, question, { show: false }); };
      const sb = el.querySelector('[data-settings]'); if (sb) sb.onclick = () => dispatchEvent(new CustomEvent('pl:open-settings'));
    }
    if (part) typeset(el);
  } finally {
    R.live.delete(ctl); if (v.ctl === ctl) v.ctl = null; busy();
    if (!R.live.size && R.refreshLater) refreshFromStore();
  }
}
// Give a newly answered question a topic in the background, so it is already sorted on the home page.
const tagging = new Set();
async function autoTag(id) {
  const pid = R.paper && R.paper.id;
  const t = R.data && R.data.threads.find(x => x.id === id);
  if (!pid || !t || !needsTopic(t) || tagging.has(id)) return;
  tagging.add(id);
  try {
    const existing = new Set();
    for (const p of await listPapers()) for (const x of (await getData(p.id)).threads) if (x.topic && !x.deleted) existing.add(x.topic);
    const r = await tagQuestions([{ key: id, paper: R.paper.title, question: threadTitle(t), sel: t.sel, answer: firstAnswer(t) }], [...existing]);
    const topic = r[id];
    if (!topic) return;
    if (R.paper && R.paper.id === pid) {
      const cur = R.data.threads.find(x => x.id === id);
      if (!cur || cur.deleted || cur.topic) return;
      cur.topic = topic; cur.updatedAt = Date.now();
      const v = R.views.get(id); if (v) { const s = v.card.querySelector('.topic'); s.textContent = topic; s.hidden = false; }
      await persist();
    } else {
      const d = await getData(pid); const cur = d.threads.find(x => x.id === id);
      if (cur && !cur.deleted && !cur.topic) { cur.topic = topic; cur.updatedAt = Date.now(); await saveData(d); }
    }
  } catch (e) { /* not important enough to interrupt reading; "Sort with AI" on the home page catches up */ }
  finally { tagging.delete(id); }
}
const modelTag = id => id ? `<div class="mtag">${esc(id.split(':').slice(1).join(':'))}</div>` : '';

function makeCard(t) {
  const a = document.createElement('article'); a.className = 'card'; a.dataset.id = t.id;
  a.innerHTML = `<div class="ch"><span class="num">${t.n}</span><span class="meta">${t.sh ? `Page ${t.page} · ${t.sh.type === 'box' ? 'box' : 'freehand'} selection` : 'Question about the paper'}</span>
    <span class="topic" ${t.topic ? '' : 'hidden'}>${esc(t.topic || '')}</span>
    <button class="ghost star" type="button" aria-pressed="${!!t.starred}" title="Save for later" aria-label="Save note ${t.n} for later">${t.starred ? '★' : '☆'}</button>
    ${t.sh ? '<button class="ghost hlit" type="button" title="Save this selection as a highlight">Highlight</button>' : ''}<button class="ghost del" type="button" aria-label="Delete note ${t.n}">✕</button></div>` +
    (t.sh ? `<button class="thumb" type="button" title="Show on the page"><img alt="Your selection from page ${t.page}" ${t.thumb ? `src="${t.thumb}"` : ''}></button>` : '') + '<div class="msgs"></div>';
  a.querySelector('.ch').addEventListener('click', e => { if (!e.target.closest('button')) activate(t); });
  a.querySelector('.del').onclick = () => removeThread(t);
  a.querySelector('.star').onclick = () => {
    t.starred = !t.starred; t.updatedAt = Date.now();
    const b = a.querySelector('.star'); b.textContent = t.starred ? '★' : '☆'; b.setAttribute('aria-pressed', t.starred);
    toast(t.starred ? 'Saved for later. Find it under Questions on the home page.' : 'Removed from saved.');
    persist();
  };
  const hb = a.querySelector('.hlit');
  if (hb) hb.onclick = () => { const p = R.pages[t.page - 1]; if (p) { createHighlight(p, t.sh); } };
  const th = a.querySelector('.thumb');
  if (th) th.onclick = () => { activate(t); scrollToShape(t.page, t.sh, 't' + t.id); };
  threadsEl.append(a);
  const v = { card: a, msgs: a.querySelector('.msgs'), ctl: null };
  R.views.set(t.id, v);
  return v;
}
function addMsg(v, role, html) { const d = document.createElement('div'); d.className = 'msg ' + role; d.innerHTML = html; v.msgs.append(d); return d; }

function renderThreads() {
  threadsEl.querySelectorAll('.card').forEach(n => n.remove());
  R.views.clear();
  for (const t of R.data ? R.data.threads : []) {
    if (t.deleted) continue;
    const v = makeCard(t);
    t.turns.forEach((m, i) => {
      if (m.role === 'user') { if (!(i === 0 && m.content === EXPLAIN)) addMsg(v, 'u', esc(m.content)); }
      else { const el = addMsg(v, 'a', md(m.content) + modelTag(m.model)); typeset(el); }
    });
  }
  updateCounts();
}
function removeThread(t) {
  const v = R.views.get(t.id);
  if (v && v.ctl) v.ctl.abort();
  const i = R.data.threads.indexOf(t);
  if (i >= 0) R.data.threads[i] = tombstone(t);
  if (v) v.card.remove();
  R.views.delete(t.id); R.imgCache.delete(t.id);
  if (R.active === t) R.active = null;
  drawMarks(); activate(R.active); updateCounts(); persist();
}
function activate(t, scrollCard) {
  R.active = t || null;
  for (const [id, v] of R.views) v.card.classList.toggle('on', !!t && id === t.id);
  for (const p of R.pages) p.svg.querySelectorAll('.sel').forEach(n => n.classList.toggle('on', !!t && n.parentNode.dataset.id === t.id));
  if (t && scrollCard) { setTab('notes'); const v = R.views.get(t.id); if (v) v.card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  updateCtx();
}
function updateCtx() {
  const t = R.active;
  $('#ctx').innerHTML = t ? `Asking about <span class="num">${t.n}</span>${t.sh ? 'page ' + t.page : 'the whole paper'} <button type="button" id="clr" title="Ask about the whole paper instead">✕ clear</button>` : 'Asking about the whole paper';
  const b = $('#clr'); if (b) b.onclick = () => activate(null);
  qEl.placeholder = !R.paper ? 'Open a paper first…' : t ? 'Ask a follow-up…' : 'Ask anything about this paper…';
}
function updateCounts() {
  const n = R.data ? R.data.threads.filter(t => !t.deleted).length : 0;
  $('#nCount').textContent = n || '';
  $('#mcount').textContent = n ? '(' + n + ')' : '';
  $('#howto').hidden = !!n;
}
function busy() {
  const b = R.live.size > 0;
  sendBtn.classList.toggle('stop', b);
  sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send');
  sendBtn.innerHTML = b ? '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 9h11M9.5 4.5 14 9l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function autosize() { qEl.style.height = 'auto'; qEl.style.height = Math.min(140, qEl.scrollHeight + 2) + 'px'; }

function submitAsk(text) {
  text = (text || '').trim(); if (!text) return;
  if (!R.paper) { toast('Open a PDF first.'); return; }
  let t = R.active;
  if (!t) {
    const now = Date.now();
    t = { id: uid(), n: nextN(), page: 0, sh: null, sel: '', turns: [], thumb: '', createdAt: now, updatedAt: now };
    R.data.threads.push(t); makeCard(t); activate(t); updateCounts();
  }
  qEl.value = ''; autosize();
  ask(t, text, { show: true });
}

async function copyAll() {
  if (!R.data) return;
  const notes = R.data.threads.filter(t => !t.deleted).map(t => `## ${t.n}. ${t.sh ? 'Page ' + t.page + ' selection' : 'Question about the paper'}\n` +
    (t.sel ? `> ${t.sel.slice(0, 300)}\n\n` : '') +
    t.turns.filter((m, i) => !(i === 0 && m.content === EXPLAIN)).map(m => (m.role === 'user' ? '**Q:** ' : '') + m.content).join('\n\n')).join('\n\n---\n\n');
  const hls = R.data.highlights.filter(h => !h.deleted).sort((a, b) => a.page - b.page)
    .map(h => `- **${colorOf(h.color).label}** (p.${h.page}): ${(h.text || '[figure or formula]').replace(/\s+/g, ' ')}${h.note ? `\n  - Note: ${h.note}` : ''}`).join('\n');
  const out = `# ${R.paper.title}\n\n` + (hls ? `## Highlights\n\n${hls}\n\n` : '') + (notes ? `## Notes\n\n${notes}\n` : '');
  toast(await copyText(out) ? 'Copied highlights and notes as Markdown.' : 'Couldn’t copy.');
}
