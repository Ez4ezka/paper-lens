// The paper reader: PDF pages, Ask + Highlight tools, notes panel, per-paper highlight list.
import { settings, saveSettings, colorOf, getPaper, getData, saveData, getPdf, putPdf, touchOpened, mergeData, tombstone } from './store.js';
import { syncOn, downloadPdf } from './sync.js';
import { chat, currentModel, PROVIDERS } from './ai.js';
import { md, typeset } from './md.js';
import { $, $$, esc, uid, toast, inPoly, canvasToBlob, canvasThumb, copyText, sha256Hex } from './util.js';
import { swatchesHTML, hlCardHTML, renderModelSelect } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const EXPLAIN = 'Explain what I selected.';
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
  $('#hlFilters').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { R.hlFilter = b.dataset.f; renderHlList(); } });
  $('#hlList').addEventListener('click', onHlListClick);

  // resizable panel
  const d = $('#divider'); let on = false;
  d.addEventListener('pointerdown', e => { on = true; d.setPointerCapture(e.pointerId); });
  d.addEventListener('pointermove', e => { if (!on) return; const w = Math.max(300, Math.min(innerWidth - 320, innerWidth - e.clientX)); document.documentElement.style.setProperty('--panelW', w + 'px'); });
  d.addEventListener('pointerup', () => { on = false; });

  bindDrawing();
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
  $('#hint').innerHTML = t === 'mark'
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
  $('#ask').hidden = t !== 'notes';
}
function setMobileView(v) {
  document.body.classList.toggle('mv-notes', v === 'notes');
  $$('[data-mv]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mv === v));
}

/* ================= open / close ================= */
export async function openReader(id, focus) {
  const tok = ++R.loadToken;
  if (R.paper && R.paper.id === id && R.doc) { applyFocus(focus); return; }
  teardown();
  const meta = await getPaper(id);
  if (!meta || meta.deleted) { toast('That paper isn’t in your library.'); location.hash = '#/'; return; }
  R.paper = meta;
  $('#fname').textContent = meta.title;
  document.title = meta.title + ' · Paper Lens';
  const data = await getData(id);
  if (tok !== R.loadToken) return;
  R.data = data;
  setTab('notes'); setMobileView('paper');
  showLoader('Opening the paper…');
  let blob = await getPdf(id);
  if (!blob && syncOn() && meta.pdfRemote) {
    showLoader('Downloading the PDF from your GitHub library…');
    try { blob = await downloadPdf(id); if (blob) await putPdf(id, blob); } catch (e) { toast(e.message); }
  }
  if (tok !== R.loadToken) return;
  if (!blob) { showMissing(meta); renderThreads(); renderHlList(); return; }
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
    const pn = document.createElement('span'); pn.className = 'pn'; pn.textContent = 'Page ' + i;
    wrap.append(cv, hl, ov, pn); pagesEl.append(wrap);
    R.pages.push({ n: i, page, w: vp.width, h: vp.height, wrap, hl, svg: ov, canvas: cv, rendered: 0, busy: false, visible: false });
  }
  hideLoader();
  showHint();
  R.fitMode = true; fit();
  renderThreads(); renderHlList(); drawMarks();
  touchOpened(id);
  pageText(R.pages[0]);
  viewer.scrollTop = 0;
  applyFocus(focus);
}
export function leaveReader() { cancelPending(); closeMenu(); }
function teardown() {
  cancelPending(); closeMenu();
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
    <p>Your highlights and notes for <b>${esc(meta.title)}</b> are here, but the PDF file itself isn’t. ${syncOn() ? 'It wasn’t uploaded to your GitHub library (maybe “Save PDFs” is off, or it’s still uploading from another device).' : 'Turn on sync in Settings so PDFs follow you to every device.'}</p>
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
  renderThreads(); renderHlList(); drawMarks();
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

/* ================= drawing ================= */
function bindDrawing() {
  let cur = null;
  const pt = (p, e) => { const r = p.wrap.getBoundingClientRect(); return [Math.max(0, Math.min(p.w, (e.clientX - r.left) / R.scale)), Math.max(0, Math.min(p.h, (e.clientY - r.top) / R.scale))]; };
  const pageOf = w => R.pages[+w.dataset.n - 1];
  pagesEl.addEventListener('pointerdown', e => {
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
  const got = items.filter(it => {
    if (!it.s.trim()) return false;
    const ix = Math.max(0, Math.min(x1, it.x + it.w) - Math.max(x0, it.x)), iy = Math.max(0, Math.min(y1, it.y + it.h) - Math.max(y0, it.y));
    if (ix * iy < .35 * Math.max(1, it.w * it.h) && !(ix > 0 && iy > .5 * it.h && ix > 8)) return false;
    if (sh.type === 'box') return true;
    const cy = it.y + it.h / 2, cx = Math.max(x0, Math.min(x1, it.x + it.w / 2));
    return inPoly(cx, cy, sh.pts) || inPoly(Math.max(it.x, x0) + 2, cy, sh.pts) || inPoly(Math.min(it.x + it.w, x1) - 2, cy, sh.pts);
  });
  return got.map(it => it.s).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}
async function paperText() {
  let s = '';
  for (const p of R.pages) { await pageText(p); s += `\n\n[Page ${p.n}]\n` + p.text; if (s.length > 90000) break; }
  return s.slice(0, 90000);
}

/* ================= picture of a selection ================= */
async function crop(p, sh, { mask = true, outline = true, maxSide = 1500 } = {}) {
  const pad = 6;
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
    if (outline) { ctx.strokeStyle = '#ff9500'; ctx.lineWidth = Math.max(2, rs * .8); ctx.stroke(path); }
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
    h.text = text; h.img = canvasThumb(c, 640, .8); h.updatedAt = Date.now();
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
    t.thumb = canvasThumb(c, 700, .8);
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
- If the selection is unclear or cut off, say what you can see and make your best reading.

Paper title: ${R.paper.title}`;
  if (!t.sh) return head + `\n\nFull text of the paper (extracted from the PDF, so figures and some math may be garbled):\n"""\n${R.fullText || ''}\n"""`;
  const p = R.pages[t.page - 1], prev = R.pages[t.page - 2], first = R.pages[0];
  return head + `\n\nOpening of the paper, for context:\n"""\n${(first && first.text || '').slice(0, 3500)}\n"""` +
    (prev && prev.text && t.page > 2 ? `\n\nEnd of page ${t.page - 1}, for context:\n"""\n${prev.text.slice(-2500)}\n"""` : '') +
    `\n\nText of page ${t.page}, where the selection is:\n"""\n${(p && p.text || '').slice(0, 7000)}\n"""\n\nTHE SELECTION (page ${t.page}): the attached image shows exactly what they selected${t.sh.type === 'lasso' ? '; the region inside the orange outline is the selection, the faded area around it is only nearby context' : ''}. Text the PDF reports inside the selection (may be empty or garbled for math, figures and images): """${t.sel || '(none)'}"""`;
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
const modelTag = id => id ? `<div class="mtag">${esc(id.split(':').slice(1).join(':'))}</div>` : '';

function makeCard(t) {
  const a = document.createElement('article'); a.className = 'card'; a.dataset.id = t.id;
  a.innerHTML = `<div class="ch"><span class="num">${t.n}</span><span class="meta">${t.sh ? `Page ${t.page} · ${t.sh.type === 'box' ? 'box' : 'freehand'} selection` : 'Question about the paper'}</span>
    ${t.sh ? '<button class="ghost hlit" type="button" title="Save this selection as a highlight">Highlight</button>' : ''}<button class="ghost del" type="button" aria-label="Delete note ${t.n}">✕</button></div>` +
    (t.sh ? `<button class="thumb" type="button" title="Show on the page"><img alt="Your selection from page ${t.page}" ${t.thumb ? `src="${t.thumb}"` : ''}></button>` : '') + '<div class="msgs"></div>';
  a.querySelector('.ch').addEventListener('click', e => { if (!e.target.closest('button')) activate(t); });
  a.querySelector('.del').onclick = () => removeThread(t);
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
