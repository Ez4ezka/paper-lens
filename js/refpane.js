// The References tab: every paper this one cites, where it is cited, and the part of the cited paper it points to.
import { currentModel } from './ai.js';
import { findReferenceList, parseReferences, findCitations, lookupRefs, citedPdf, pdfPages, matchCitations } from './refs.js';
import { addPdf } from './library.js';
import { $, esc, toast } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const MAX_CITES = 8;   // citing sentences sent to the AI per reference
let C;                 // reader hooks: { R, pageText, scrollToShape, setTab, setMobileView, persist }
const RF = { job: null, open: new Set(), matching: new Map(), order: 'list', q: '' };
let pane, statEl, listEl;

export function initRefPane(ctx) {
  C = ctx;
  pane = $('#refPane');
  pane.innerHTML = `<div class="rtools">
      <input class="inp" type="search" data-rf="q" placeholder="Search references" aria-label="Search references">
      <select class="inp" data-rf="order" aria-label="Order"><option value="list">As listed</option><option value="cited">Most cited here</option></select>
    </div>
    <div class="rstat"></div>
    <ol class="rlist"></ol>`;
  statEl = pane.querySelector('.rstat'); listEl = pane.querySelector('.rlist');
  pane.querySelector('[data-rf=q]').addEventListener('input', e => { RF.q = e.target.value; renderList(); });
  pane.querySelector('[data-rf=order]').addEventListener('change', e => { RF.order = e.target.value; renderList(); });
  pane.addEventListener('click', onClick);
}

const refs = () => (C.R.data && C.R.data.refs) || null;
const stale = pid => !C.R.paper || C.R.paper.id !== pid;
const touch = () => { const d = refs(); if (d) d.updatedAt = Date.now(); return C.persist(); };

export function refsTeardown() {
  if (RF.job) { RF.job.ctl.abort(); RF.job = null; }
  for (const m of RF.matching.values()) m.ctl.abort();
  RF.matching.clear(); RF.open.clear(); RF.q = '';
  if (pane) pane.querySelector('[data-rf=q]').value = '';
}

// Called when the tab opens: read the list the first time, and finish lookups that didn't complete.
export function onRefsTab() {
  const d = refs();
  if (!d) { if (C.R.pages.length && !RF.job) runRefs(); }
  else if (d.list.some(r => r.found === undefined) && !RF.job) runLookups();
  renderRefs();
}

/* ---------- jobs ---------- */
async function runRefs() {
  const { R } = C;
  if (!R.paper || RF.job || !R.pages.length) return;
  if (!currentModel()) { statEl.innerHTML = '<p class="muted">Pick an AI model in Settings to read the reference list.</p>'; return; }
  const pid = R.paper.id, ctl = new AbortController();
  RF.job = { ctl, status: 'Reading the reference list…' };
  renderRefs();
  try {
    for (const p of R.pages) await C.pageText(p);
    const pages = R.pages.map(p => ({ n: p.n, w: p.w, h: p.h, items: p.items || [] }));
    const { at, text } = findReferenceList(pages);
    if (text.replace(/\s+/g, '').length < 60) throw new Error('This paper doesn’t seem to have a reference list.');
    const parsed = await parseReferences(R.paper.title, text, ctl.signal);
    if (stale(pid)) return;
    if (!parsed.refs.length) throw new Error('No references were found in the reference list.');
    const cites = findCitations(pages, parsed.refs, parsed.style, at);
    const old = new Map(((refs() || {}).list || []).map(r => [r.title.toLowerCase(), r]));
    for (const r of parsed.refs) {
      r.cites = cites[r.key] || [];
      const o = old.get(r.title.toLowerCase());
      if (o) { if (o.found !== undefined) r.found = o.found; if (o.match) r.match = o.match; }
    }
    const now = Date.now();
    R.data.refs = { v: 1, style: parsed.style, list: parsed.refs, model: parsed.model, createdAt: now, updatedAt: now };
    await C.persist();
    drawCiteMarks();
    RF.job = null;
    runLookups();
  } catch (e) {
    if (e.code !== 'cancelled' && e.name !== 'AbortError') statEl.innerHTML = `<p class="err">${esc(e.message || 'Couldn’t read the reference list.')}</p>`;
    if (RF.job && RF.job.ctl === ctl) RF.job = null;
    if (!stale(pid)) { renderList(); updateCount(); }
  }
}

async function runLookups() {
  const d = refs(); if (!d || RF.job) return;
  const pid = C.R.paper.id, ctl = new AbortController();
  RF.job = { ctl, status: 'Finding the cited papers…' };
  renderRefs();
  try {
    // Semantic Scholar's free service is often busy; papers it couldn't check are asked again a few times.
    for (let round = 0; round < 4; round++) {
      const { busy } = await lookupRefs(d.list, {
        signal: ctl.signal,
        onBatch: (done, n) => { if (stale(pid)) return; RF.job.status = `Finding the cited papers (${done} of ${n})…`; touch(); renderRefs(); },
      });
      if (stale(pid)) return;
      await touch();
      if (!busy || !d.list.some(r => r.found === undefined)) break;
      if (round === 3) { toast('The paper search service is busy. The rest will be looked up next time you open this tab.', 5000); break; }
      for (let s = 20; s > 0 && !ctl.signal.aborted; s--) { RF.job.status = `The paper search service is busy. Trying the rest again in ${s} s…`; renderRefs(); await new Promise(r => setTimeout(r, 1000)); }
      if (ctl.signal.aborted) break;
    }
  } catch (e) {
    if (e.name !== 'AbortError' && !stale(pid)) toast(e.message || 'Couldn’t look up the cited papers.', 4500);
  } finally {
    if (RF.job && RF.job.ctl === ctl) RF.job = null;
    if (!stale(pid)) renderRefs();
  }
}

async function runMatch(r) {
  const { R } = C;
  if (RF.matching.has(r.key) || !r.found || !r.cites.length) return;
  if (!currentModel()) { toast('Pick an AI model in Settings first.'); return; }
  const pid = R.paper.id, ctl = new AbortController(), f = r.found;
  const job = { ctl, status: f.pdf ? 'Downloading the cited paper…' : 'Reading the abstract…' };
  RF.matching.set(r.key, job); renderList();
  let note = '';
  try {
    let pages = null;
    if (f.pdf) {
      try { pages = await pdfPages(await citedPdf(f.pdf, ctl.signal)); }
      catch (e) { if (e.name === 'AbortError') throw e; note = `The free PDF couldn’t be downloaded (${e.message}), so this match uses only the abstract.`; }
    }
    if (pages && !pages.some(p => p.items.length)) { pages = null; note = 'The cited PDF has no readable text (it may be scanned), so this match uses only the abstract.'; }
    if (!pages && !f.abstract) throw new Error('Neither the cited paper’s text nor its abstract is available.');
    job.status = 'Finding the part of the cited paper…'; renderList();
    const res = await matchCitations({ mainTitle: R.paper.title, ref: r, cites: r.cites.slice(0, MAX_CITES), pages, signal: ctl.signal });
    if (stale(pid)) return;
    if (!pages && !note) note = 'No free PDF of this paper was found, so this match uses only the abstract.';
    r.match = { ...res, note, updatedAt: Date.now() };
    await touch();
  } catch (e) {
    if (e.code !== 'cancelled' && e.name !== 'AbortError' && !stale(pid)) toast(e.message || 'Couldn’t match the citation.', 4500);
  } finally {
    if (RF.matching.get(r.key) === job) RF.matching.delete(r.key);
    if (!stale(pid)) renderList();
  }
}

async function openCited(r, i) {
  const f = r.found; if (!f || !f.pdf) return;
  const it = r.match && r.match.items.find(x => x.cite === i);
  // the paragraph, plus the quoted sentence inside it when it is on the same page
  const reg = it && it.regions[0], key = it && it.key && it.key[0];
  const spot = reg ? [reg.page, ...reg.bb, ...(key && key.page === reg.page ? key.bb : [])] : key ? [key.page, ...key.bb] : null;
  toast('Adding the cited paper to your library…', 1800);
  try {
    const blob = await citedPdf(f.pdf);
    const name = (f.arxiv ? 'arXiv ' + f.arxiv.replace(/\//g, '-') : f.title.replace(/[^\w\- ]+/g, '').slice(0, 60)) + '.pdf';
    const id = await addPdf(blob, { name, title: f.title, citedBy: { id: C.R.paper.id, title: C.R.paper.title } });
    location.hash = `#/paper/${id}` + (spot ? `/x/${spot.map(v => Math.round(v * 10) / 10).join(',')}` : '');
  } catch (e) { toast(e.message || 'Couldn’t open the cited paper.', 4500); }
}

/* ---------- clicks ---------- */
function onClick(e) {
  const b = e.target.closest('[data-rf]'); if (!b) return;
  const d = refs(), act = b.dataset.rf;
  if (act === 'start') { runRefs(); return; }
  if (act === 'stop') { if (RF.job) RF.job.ctl.abort(); return; }
  if (act === 'redo') { if (!RF.job) runRefs(); return; }
  if (act === 'retry-lookup') { if (d) { d.list.forEach(r => { if (r.found === null) r.found = undefined; }); runLookups(); } return; }
  const li = b.closest('[data-key]'); if (!li || !d) return;
  const r = d.list.find(x => x.key === li.dataset.key); if (!r) return;
  if (act === 'toggle') {
    if (RF.open.has(r.key)) RF.open.delete(r.key);
    else { RF.open.add(r.key); if (!r.match) runMatch(r); }
    renderList();
  } else if (act === 'jump') {
    const c = r.cites[+b.dataset.i]; if (!c) return;
    const mark = [...C.R.pages[c.page - 1].svg.querySelectorAll('.citem')].find(el => +el.getAttribute('x') === c.bb[0] - 1 && +el.getAttribute('y') === c.bb[1] - .5);
    C.scrollToShape(c.page, { bb: c.bb }, mark ? mark.dataset.key : '');
  } else if (act === 'open') openCited(r, +b.dataset.i);
  else if (act === 'rematch') { r.match = null; runMatch(r); }
  else if (act === 'stop-match') { const m = RF.matching.get(r.key); if (m) m.ctl.abort(); }
}

/* ---------- rendering ---------- */
export function updateCount() { const d = refs(), el = $('#rCount'); if (el) el.textContent = d && d.list.length ? d.list.length : ''; }

export function renderRefs() {
  if (!pane) return;
  updateCount();
  const d = refs();
  const job = RF.job ? `<div class="ovs"><span class="think">${esc(RF.job.status)}</span><button type="button" class="ghost" data-rf="stop">Stop</button></div>` : '';
  if (!d) {
    statEl.innerHTML = job || `<div class="ovempty"><p><b>Every paper this one cites, in one place.</b></p><p>Paper Lens reads the reference list, finds each cited paper online (title, abstract and a free PDF when there is one), and marks where each is cited on the page.</p><p>Open a reference to see the exact part of the cited paper that this paper is talking about.</p>${C.R.pages.length ? '<button type="button" class="btn pri" data-rf="start">Find the cited papers</button>' : ''}</div>`;
    listEl.innerHTML = '';
    return;
  }
  const n = d.list.length, found = d.list.filter(r => r.found).length, pdfs = d.list.filter(r => r.found && r.found.pdf).length;
  const missing = d.list.filter(r => r.found === null).length, cited = d.list.filter(r => r.cites.length).length;
  statEl.innerHTML = job + `<p class="rsum"><b>${n}</b> references · <b>${found}</b> found online · <b>${pdfs}</b> with a free PDF · <b>${cited}</b> located in the text
    ${!RF.job ? `<span class="rlinks">${missing ? '<button type="button" class="linkbtn" data-rf="retry-lookup">Search again for the missing ones</button> · ' : ''}<button type="button" class="linkbtn" data-rf="redo">Read the list again</button></span>` : ''}</p>`;
  renderList();
}

function badge(r) {
  if (r.found === undefined) return '<span class="rb wait">Looking up…</span>';
  if (!r.found) return '<span class="rb no">Not found online</span>';
  return r.found.pdf ? '<span class="rb ok">Free PDF</span>' : '<span class="rb">Abstract only</span>';
}

function renderList() {
  const d = refs(); if (!d) return;
  const q = RF.q.trim().toLowerCase();
  let list = d.list.filter(r => !q || [r.title, r.authors, r.year, r.venue, r.n, r.found && r.found.title].join(' ').toLowerCase().includes(q));
  if (RF.order === 'cited') list = [...list].sort((a, b) => b.cites.length - a.cites.length);
  listEl.innerHTML = list.map(r => {
    const f = r.found, open = RF.open.has(r.key);
    const meta = [f ? f.authors : r.authors, f && f.year || r.year, f && f.venue || r.venue].filter(Boolean).join(' · ');
    return `<li class="ref${open ? ' open' : ''}" data-key="${esc(r.key)}">
      <button type="button" class="rhd" data-rf="toggle" aria-expanded="${open}">
        ${r.n ? `<span class="rn">${esc(r.n)}</span>` : ''}
        <span class="rt">${esc(f ? f.title : r.title || r.authors)}</span>
        ${meta ? `<span class="rm">${esc(meta)}</span>` : ''}
        <span class="rbs">${badge(r)}<span class="rb ${r.cites.length ? 'c' : ''}">${r.cites.length ? `Cited ${r.cites.length}× · p. ${[...new Set(r.cites.map(c => c.page))].join(', ')}` : 'Not located in the text'}</span></span>
      </button>
      ${open ? bodyHTML(r) : ''}
    </li>`;
  }).join('') || (q ? '<p class="muted">No references match.</p>' : '');
}

function bodyHTML(r) {
  const f = r.found, job = RF.matching.get(r.key), m = r.match;
  const links = f
    ? [f.url && `<a href="${esc(f.url)}" target="_blank" rel="noopener">Paper page ↗</a>`, f.pdf && `<a href="${esc(f.pdf)}" target="_blank" rel="noopener">PDF ↗</a>`].filter(Boolean).join(' · ')
    : r.found === null ? `<a href="https://scholar.google.com/scholar?q=${encodeURIComponent(r.title || r.authors)}" target="_blank" rel="noopener">Search Google Scholar ↗</a>` : '';
  const shown = r.cites.slice(0, MAX_CITES);
  const cites = shown.map((c, i) => {
    const it = m && m.items.find(x => x.cite === i);
    return `<div class="rcite">
      <button type="button" class="rsent" data-rf="jump" data-i="${i}" title="Show it on the page"><span class="rlab">This paper, p. ${c.page}</span>${esc(c.text)}</button>
      ${it ? `<div class="rmatch"><span class="rlab">${it.page ? `In the cited paper, p. ${it.page}` : 'In the cited paper'}</span>
        ${it.quote ? `<div class="rq">“${esc(it.quote)}”</div>` : ''}${it.why ? `<div class="rwhy">${esc(it.why)}</div>` : ''}
        ${f && f.pdf ? `<button type="button" class="mini" data-rf="open" data-i="${i}">${it.page ? 'Open the cited paper here' : 'Open the cited paper'}</button>` : ''}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="rbody">
    ${links ? `<div class="rlinks">${links}</div>` : ''}
    ${f && f.abstract ? `<details class="rabs"><summary>Abstract</summary><p>${esc(f.abstract)}</p></details>` : ''}
    ${!r.cites.length ? '<p class="muted small">This reference wasn’t found in the text. It may be cited in a figure, a table or a footnote.</p>' : ''}
    ${job ? `<div class="ovs"><span class="think">${esc(job.status)}</span><button type="button" class="ghost" data-rf="stop-match">Stop</button></div>` : ''}
    ${m && m.note ? `<p class="muted small">${esc(m.note)}</p>` : ''}
    ${cites}
    ${r.cites.length > MAX_CITES ? `<p class="muted small">Showing the first ${MAX_CITES} of ${r.cites.length} places it is cited.</p>` : ''}
    ${!f && r.cites.length && r.found === null ? '<p class="muted small">The cited paper wasn’t found online, so its matching part can’t be shown.</p>' : ''}
    ${m && !job ? `<button type="button" class="linkbtn" data-rf="rematch">Match again</button>` : ''}
  </div>`;
}

/* ---------- citation marks on the page ---------- */
export function drawCiteMarks() {
  const { R } = C;
  for (const p of R.pages) p.svg.querySelectorAll('.citem').forEach(n => n.remove());
  const d = refs(); if (!d) return;
  const spots = new Map();
  for (const r of d.list) r.cites.forEach((c, i) => {
    const k = c.page + ':' + c.bb.join(',');
    if (!spots.has(k)) spots.set(k, { c, keys: [], first: `c${r.key}_${i}` });
    spots.get(k).keys.push(r.key);
  });
  for (const { c, keys, first } of spots.values()) {
    const p = R.pages[c.page - 1]; if (!p) continue;
    const el = document.createElementNS(NS, 'rect');
    const [x0, y0, x1, y1] = c.bb;
    Object.entries({ x: x0 - 1, y: y0 - .5, width: x1 - x0 + 2, height: y1 - y0 + 1, rx: 2 }).forEach(([k, v]) => el.setAttribute(k, v));
    el.setAttribute('class', 'citem'); el.dataset.key = first;
    // every reference in a grouped citation like [2, 5] shares the mark
    const t = document.createElementNS(NS, 'title');
    t.textContent = keys.map(k => { const r = d.list.find(x => x.key === k); return (r.n ? '[' + r.n + '] ' : '') + ((r.found && r.found.title) || r.title); }).join('\n');
    el.append(t);
    el.addEventListener('pointerdown', ev => {
      ev.stopPropagation(); ev.preventDefault();
      C.setTab('refs'); if (innerWidth < 860) C.setMobileView('notes');
      keys.forEach(k => RF.open.add(k));
      const r0 = d.list.find(x => x.key === keys[0]);
      keys.forEach(k => { const r = d.list.find(x => x.key === k); if (r && !r.match) runMatch(r); });
      renderList();
      const li = listEl.querySelector(`[data-key="${r0.key}"]`);
      if (li) { li.scrollIntoView({ block: 'start', behavior: 'smooth' }); li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash'); }
    });
    p.svg.append(el);
  }
}

// Opened from another paper's References tab: box the cited part.
export function showCitedSpot(x) {
  const { R } = C;
  const p = R.pages[x.page - 1]; if (!p) return;
  p.svg.querySelectorAll('.citefocus').forEach(n => n.remove());
  const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'citefocus');
  const [x0, y0, x1, y1] = x.bb;
  const by = R.paper.citedBy && R.paper.citedBy.title;
  const k = x.key;
  g.innerHTML = `<rect x="${x0 - 3}" y="${y0 - 3}" width="${x1 - x0 + 6}" height="${y1 - y0 + 6}" rx="3" data-key="xfocus"/>` +
    (k ? `<rect class="ck" x="${k[0] - 1.5}" y="${k[1] - 1.5}" width="${k[2] - k[0] + 3}" height="${k[3] - k[1] + 3}" rx="2"/>` : '') +
    `<title>${esc(by ? 'The part cited by “' + by + '”' : 'The cited part')}</title>`;
  g.addEventListener('pointerdown', ev => { ev.stopPropagation(); g.remove(); });
  p.svg.append(g);
  C.scrollToShape(x.page, { bb: x.bb }, 'xfocus');
  if (by) toast(`Showing the part that “${by.length > 60 ? by.slice(0, 60) + '…' : by}” cites. Click the box to hide it.`, 5000);
}
