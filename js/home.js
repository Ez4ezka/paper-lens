// Home page: the library of papers plus every highlight across all of them.
import { settings, listPapers, getData, saveData, colorOf, savePaperMeta, delPdf } from './store.js';
import { EXPLAIN, askedIn, threadTitle, firstAnswer, plain, needsTopic, tagQuestions } from './topics.js';
import { currentModel } from './ai.js';
import { syncOn } from './sync.js';
import { $, esc, timeAgo, copyText, toast, download } from './util.js';
import { hlCardHTML, askText, confirmBox } from './ui.js';

const H = { filter: new Set(), q: '', sort: 'paper', papers: [], datas: {} };
// Questions section state: search text, sort, filters (topic, paper, saved only).
const Q = { q: '', sort: 'topic', topic: '', paper: '', starred: false, sorting: false };
let root, renderTok = 0;

export function initHome() {
  root = $('#home');
  root.addEventListener('click', onClick);
  root.addEventListener('input', e => {
    if (e.target.id === 'hq') { H.q = e.target.value; renderHighlights(); }
    if (e.target.id === 'qq') { Q.q = e.target.value; renderQuestions(); }
  });
  root.addEventListener('change', e => {
    if (e.target.id === 'hsort') { H.sort = e.target.value; renderHighlights(); }
    if (e.target.id === 'qsort') { Q.sort = e.target.value; renderQuestions(); }
    if (e.target.id === 'qpaper') { Q.paper = e.target.value; renderQuestions(); }
  });
}

export async function renderHome() {
  const tok = ++renderTok;
  const papers = await listPapers();
  const datas = {};
  await Promise.all(papers.map(async p => { datas[p.id] = await getData(p.id); }));
  if (tok !== renderTok) return;
  H.papers = papers; H.datas = datas;
  const allH = allHighlights();
  const notes = H.papers.reduce((s, p) => s + H.datas[p.id].threads.filter(t => !t.deleted).length, 0);
  const tips = [];
  if (!currentModel()) tips.push(`<div class="tip"><b>Add an AI model.</b> Paste a Claude, ChatGPT or OpenRouter API key in Settings once, and it works on every device you sign in on. <button type="button" class="btn" data-settings>Open settings</button></div>`);
  tips.push(`<div class="tip quiet"><b>Your library lives in the cloud.</b> Open this site on your phone or any computer and sign in with your password to see the same papers, highlights and notes.</div>`);

  root.innerHTML = `
  <section class="hero band">
    <div class="hero-text">
      <h1>Your reading desk</h1>
      <p class="stats">${H.papers.length} ${H.papers.length === 1 ? 'paper' : 'papers'} · ${allH.length} ${allH.length === 1 ? 'highlight' : 'highlights'} · ${notes} ${notes === 1 ? 'question' : 'questions'}</p>
      <p class="sub">Open a PDF, highlight text and formulas in colors, and draw around anything to ask AI about it.</p>
      <div class="row"><label class="btn pri big" for="file">Open a PDF</label><span class="drophint">or drop one anywhere</span></div>
    </div>
    ${tips.length ? `<div class="tips">${tips.join('')}</div>` : ''}
  </section>
  <section class="band shelf-band">
    <h2>Papers</h2>
    ${H.papers.length ? `<div class="shelf">${H.papers.map(paperCard).join('')}</div>` :
      `<div class="empty-s wide"><p><b>No papers yet.</b> Open your first PDF and it will live here, on every device once sync is on.</p></div>`}
  </section>
  <section class="band" id="hlBand">
    <div class="hl-head">
      <h2>All highlights</h2>
      <div class="hl-tools">
        <input id="hq" class="inp" type="search" placeholder="Search highlights and notes" value="${esc(H.q)}" aria-label="Search highlights">
        <select id="hsort" class="btn" aria-label="Group highlights">
          <option value="paper" ${H.sort === 'paper' ? 'selected' : ''}>By paper</option>
          <option value="new" ${H.sort === 'new' ? 'selected' : ''}>Newest first</option>
          <option value="color" ${H.sort === 'color' ? 'selected' : ''}>By color</option>
        </select>
        <button type="button" class="btn" data-export>Export</button>
      </div>
    </div>
    <div class="fchips" id="hfilters"></div>
    <div id="hlOut"></div>
  </section>
  <section class="band" id="qBand">
    <div class="hl-head">
      <h2>Questions</h2>
      <div class="hl-tools">
        <input id="qq" class="inp" type="search" placeholder="Search questions and answers" value="${esc(Q.q)}" aria-label="Search questions">
        <select id="qpaper" class="btn" aria-label="Filter by paper"><option value="">All papers</option>${H.papers.map(p => `<option value="${esc(p.id)}" ${Q.paper === p.id ? 'selected' : ''}>${esc(p.title.length > 50 ? p.title.slice(0, 50) + '…' : p.title)}</option>`).join('')}</select>
        <select id="qsort" class="btn" aria-label="Group questions">
          <option value="topic" ${Q.sort === 'topic' ? 'selected' : ''}>By topic</option>
          <option value="new" ${Q.sort === 'new' ? 'selected' : ''}>Newest first</option>
          <option value="old" ${Q.sort === 'old' ? 'selected' : ''}>Oldest first</option>
          <option value="paper" ${Q.sort === 'paper' ? 'selected' : ''}>By paper</option>
        </select>
        <button type="button" class="btn" data-qsort>Sort with AI</button>
        <button type="button" class="btn" data-qexport>Export</button>
      </div>
    </div>
    <div class="fchips" id="qfilters"></div>
    <div id="qOut"></div>
  </section>`;
  if (!H.papers.some(p => p.id === Q.paper)) Q.paper = '';
  renderHighlights();
  renderQuestions();
}

function allHighlights() {
  const out = [];
  for (const p of H.papers) for (const h of H.datas[p.id].highlights) if (!h.deleted) out.push({ h, p });
  return out;
}

function paperCard(p) {
  const c = p.counts || { h: 0, t: 0 };
  return `<article class="pc-card" data-pid="${esc(p.id)}">
    <a class="cover" href="#/paper/${esc(p.id)}" aria-label="Open ${esc(p.title)}">${p.thumb ? `<img src="${p.thumb}" alt="" loading="lazy">` : '<span class="nocover"></span>'}</a>
    <div class="pc-body">
      <a class="pc-title" href="#/paper/${esc(p.id)}">${esc(p.title)}</a>
      <p class="pc-meta">${p.pages ? p.pages + ' pages · ' : ''}${c.h} highlights · ${c.t} questions</p>
      <p class="pc-meta">${p.openedAt ? 'Opened ' + timeAgo(p.openedAt) : 'Added ' + timeAgo(p.addedAt)}${!p.pdfRemote ? ' · uploading PDF…' : ''}</p>
      <div class="pc-act"><button type="button" class="mini" data-rename>Rename</button><button type="button" class="mini" data-remove>Remove</button></div>
    </div>
  </article>`;
}

function renderHighlights() {
  if (!root.querySelector('#hlOut')) return;
  const all = allHighlights();
  const cnt = id => all.filter(x => x.h.color === id).length;
  root.querySelector('#hfilters').innerHTML = settings.colors.map(c =>
    `<button type="button" class="fchip" data-hf="${c.id}" aria-pressed="${H.filter.has(c.id)}" style="--c:${c.hex}"><span class="dot"></span>${esc(c.label)} <span class="n">${cnt(c.id)}</span></button>`).join('') +
    (H.filter.size ? '<button type="button" class="fchip ghosty" data-hf="__clear">Show all colors</button>' : '');
  const q = H.q.trim().toLowerCase();
  let items = all.filter(({ h, p }) => (!H.filter.size || H.filter.has(h.color)) &&
    (!q || (h.text || '').toLowerCase().includes(q) || (h.note || '').toLowerCase().includes(q) || p.title.toLowerCase().includes(q)));
  const out = root.querySelector('#hlOut');
  if (!all.length) {
    out.innerHTML = `<div class="empty-s wide hl-empty">
      <svg viewBox="0 0 220 90" aria-hidden="true"><rect x="10" y="14" width="200" height="12" rx="3" fill="var(--line)"/><rect x="10" y="38" width="160" height="12" rx="3" fill="#ffd60a" opacity=".75"/><rect x="10" y="62" width="120" height="12" rx="3" fill="#5cc8ff" opacity=".75"/></svg>
      <p><b>Every highlight from every paper shows up here.</b></p><p>In a paper, pick the highlighter, choose a color, and drag over text, a formula or a figure.</p></div>`;
    return;
  }
  if (!items.length) { out.innerHTML = '<div class="empty-s wide"><p>No highlights match.</p></div>'; return; }
  if (H.sort === 'new') {
    items.sort((a, b) => (b.h.createdAt || 0) - (a.h.createdAt || 0));
    out.innerHTML = `<div class="hgrid">${items.map(({ h, p }) => hlCardHTML(h, p)).join('')}</div>`;
  } else if (H.sort === 'color') {
    out.innerHTML = settings.colors.map(c => {
      const g = items.filter(x => x.h.color === c.id).sort((a, b) => (b.h.createdAt || 0) - (a.h.createdAt || 0));
      return g.length ? `<div class="hgroup"><h3><span class="dot" style="--c:${c.hex}"></span>${esc(c.label)} <span class="n">${g.length}</span></h3><div class="hgrid">${g.map(({ h, p }) => hlCardHTML(h, p)).join('')}</div></div>` : '';
    }).join('');
  } else {
    out.innerHTML = H.papers.map(p => {
      const g = items.filter(x => x.p === p).sort((a, b) => a.h.page - b.h.page || a.h.sh.bb[1] - b.h.sh.bb[1]);
      return g.length ? `<div class="hgroup"><h3><a href="#/paper/${esc(p.id)}">${esc(p.title)}</a> <span class="n">${g.length}</span></h3><div class="hgrid">${g.map(({ h }) => hlCardHTML(h, p, { showPaper: false })).join('')}</div></div>` : '';
    }).join('');
  }
}

/* ---------- questions ---------- */
function allQuestions() {
  const out = [];
  for (const p of H.papers) for (const t of H.datas[p.id].threads) if (!t.deleted && (t.turns || []).length) out.push({ t, p });
  return out;
}
const topicsIn = qs => [...new Set(qs.map(x => x.t.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b));

function qCardHTML({ t, p }, { showPaper = true } = {}) {
  const more = askedIn(t).length - 1;
  const ans = plain(firstAnswer(t), 260);
  return `<article class="qc" data-pid="${esc(p.id)}" data-tid="${esc(t.id)}">
    <header>
      <button type="button" class="ghost star" data-qstar aria-pressed="${!!t.starred}" title="${t.starred ? 'Saved for later' : 'Save for later'}" aria-label="${t.starred ? 'Remove from saved' : 'Save for later'}">${t.starred ? '★' : '☆'}</button>
      <button type="button" class="topic ${t.topic ? '' : 'none'}" data-qtopic title="Change topic">${esc(t.topic || 'No topic')}</button>
      <span class="qc-when">${esc(timeAgo(t.createdAt))}</span>
    </header>
    ${t.thumb ? `<button type="button" class="qc-img" data-qopen title="Open in the paper"><img src="${t.thumb}" alt="Your selection from page ${t.page}" loading="lazy"></button>` : ''}
    <p class="qc-q">${esc(threadTitle(t))}</p>
    ${ans ? `<p class="qc-a">${esc(ans)}</p>` : ''}
    <footer><span class="hc-meta">${showPaper ? '<b>' + esc(p.title) + '</b> · ' : ''}${t.sh ? 'p.' + t.page : 'whole paper'}${more > 0 ? ` · ${more} follow-up${more > 1 ? 's' : ''}` : ''}</span>
      <span class="hc-act"><button type="button" class="mini" data-qcopy>Copy</button><button type="button" class="mini" data-qopen>Open</button></span></footer>
  </article>`;
}

function renderQuestions() {
  const out = root.querySelector('#qOut'); if (!out) return;
  const all = allQuestions();
  const untagged = all.filter(x => needsTopic(x.t)).length;
  const sb = root.querySelector('[data-qsort]');
  sb.disabled = Q.sorting || !all.length;
  sb.textContent = Q.sorting ? 'Sorting…' : untagged ? `Sort with AI (${untagged})` : 'Sort with AI';
  sb.title = untagged ? `Give the ${untagged} unsorted question${untagged > 1 ? 's' : ''} a topic` : 'Every question has a topic. Click to sort them all again from scratch.';
  const topics = topicsIn(all);
  if (Q.topic && Q.topic !== '__none' && !topics.includes(Q.topic)) Q.topic = '';
  const stars = all.filter(x => x.t.starred).length;
  const noTopic = all.filter(x => !x.t.topic).length;
  root.querySelector('#qfilters').innerHTML = all.length ? (
    `<button type="button" class="fchip" data-qf="__star" aria-pressed="${Q.starred}"><span class="st">★</span>Saved for later <span class="n">${stars}</span></button>` +
    topics.map(tp => `<button type="button" class="fchip" data-qf="${esc(tp)}" aria-pressed="${Q.topic === tp}">${esc(tp)} <span class="n">${all.filter(x => x.t.topic === tp).length}</span></button>`).join('') +
    (noTopic && topics.length ? `<button type="button" class="fchip" data-qf="__none" aria-pressed="${Q.topic === '__none'}">No topic <span class="n">${noTopic}</span></button>` : '') +
    (Q.topic || Q.starred ? '<button type="button" class="fchip ghosty" data-qf="__clear">Show all</button>' : '')) : '';
  if (!all.length) {
    out.innerHTML = `<div class="empty-s wide"><p><b>Every question you ask shows up here.</b></p><p>In a paper, draw around something and ask about it. Each question gets a topic automatically, so related questions from different papers end up side by side.</p></div>`;
    return;
  }
  const q = Q.q.trim().toLowerCase();
  const items = all.filter(({ t, p }) =>
    (!Q.starred || t.starred) && (!Q.paper || p.id === Q.paper) &&
    (!Q.topic || (Q.topic === '__none' ? !t.topic : t.topic === Q.topic)) &&
    (!q || p.title.toLowerCase().includes(q) || (t.topic || '').toLowerCase().includes(q) || (t.sel || '').toLowerCase().includes(q) ||
      t.turns.some(m => m.content.toLowerCase().includes(q))));
  if (!items.length) { out.innerHTML = `<div class="empty-s wide"><p>No questions match${Q.starred ? '. Star a question (☆) to save it for later' : ''}.</p></div>`; return; }
  const newest = (a, b) => (b.t.createdAt || 0) - (a.t.createdAt || 0);
  const grid = (g, o) => `<div class="hgrid">${g.map(x => qCardHTML(x, o)).join('')}</div>`;
  if (Q.sort === 'new' || Q.sort === 'old') {
    items.sort(Q.sort === 'new' ? newest : (a, b) => -newest(a, b));
    out.innerHTML = grid(items);
  } else if (Q.sort === 'paper') {
    out.innerHTML = H.papers.map(p => {
      const g = items.filter(x => x.p === p).sort((a, b) => (a.t.n || 0) - (b.t.n || 0));
      return g.length ? `<div class="hgroup"><h3><a href="#/paper/${esc(p.id)}">${esc(p.title)}</a> <span class="n">${g.length}</span></h3>${grid(g, { showPaper: false })}</div>` : '';
    }).join('');
  } else {
    const groups = [...topicsIn(items).map(tp => [tp, items.filter(x => x.t.topic === tp)]), ['No topic yet', items.filter(x => !x.t.topic)]]
      .filter(([, g]) => g.length).sort((a, b) => (a[0] === 'No topic yet') - (b[0] === 'No topic yet') || b[1].length - a[1].length || a[0].localeCompare(b[0]));
    out.innerHTML = groups.map(([tp, g]) => `<div class="hgroup"><h3>${esc(tp)} <span class="n">${g.length}</span></h3>${grid(g.sort(newest))}</div>`).join('');
  }
}

// Change threads of one paper. Re-reads the stored copy first, so a sync that landed meanwhile isn't overwritten.
async function editThreads(pid, changes) {
  const d = await getData(pid);
  const now = Date.now();
  for (const [tid, patch] of Object.entries(changes)) {
    const t = d.threads.find(x => x.id === tid);
    if (t && !t.deleted) Object.assign(t, patch, { updatedAt: now });
  }
  await saveData(d);
  H.datas[pid] = d;
}
const saveThread = (p, t, patch) => editThreads(p.id, { [t.id]: patch });

async function sortWithAI() {
  const all = allQuestions();
  let todo = all.filter(x => needsTopic(x.t));
  let keep = topicsIn(all);
  if (!todo.length) {
    const ok = await confirmBox('Sort every question again?', `All ${all.length} questions already have a topic. AI can sort them again from scratch, which replaces the topics you have now, including any you changed by hand.`, 'Sort again');
    if (!ok) return;
    todo = all.filter(x => x.t.turns.some(m => m.role === 'assistant')); keep = [];
  }
  if (!currentModel()) { toast('Pick an AI model in Settings first.'); dispatchEvent(new CustomEvent('pl:open-settings')); return; }
  Q.sorting = true; renderQuestions();
  try {
    const keyed = todo.map((x, i) => ({ ...x, key: 'q' + i }));
    const r = await tagQuestions(keyed.map(x => ({ key: x.key, paper: x.p.title, question: threadTitle(x.t), sel: x.t.sel, answer: firstAnswer(x.t) })), keep);
    const byPaper = {}; let n = 0;
    for (const x of keyed) if (r[x.key]) { (byPaper[x.p.id] ||= {})[x.t.id] = { topic: r[x.key] }; n++; }
    for (const [pid, ch] of Object.entries(byPaper)) await editThreads(pid, ch);
    toast(n ? `Sorted ${n} question${n > 1 ? 's' : ''} into topics.` : 'The AI didn’t return any topics. Try again or pick another model.');
  } catch (e) {
    toast(e.message || 'Couldn’t sort the questions.', 4500);
  } finally { Q.sorting = false; renderQuestions(); }
}

function exportQuestions() {
  const items = allQuestions();
  if (!items.length) { toast('No questions to export yet.'); return; }
  let out = `# Questions\n\nExported from Paper Lens on ${new Date().toLocaleDateString()}\n`;
  for (const tp of [...topicsIn(items), '']) {
    const g = items.filter(x => (x.t.topic || '') === tp).sort((a, b) => (a.t.createdAt || 0) - (b.t.createdAt || 0));
    if (!g.length) continue;
    out += `\n## ${tp || 'No topic'}\n`;
    for (const { t, p } of g) {
      out += `\n### ${t.starred ? '★ ' : ''}${threadTitle(t).replace(/\s+/g, ' ')}\n\n*${p.title}${t.sh ? ', page ' + t.page : ''} · ${new Date(t.createdAt).toLocaleDateString()}*\n\n`;
      out += t.turns.filter((m, i) => !(i === 0 && m.content === EXPLAIN)).map(m => (m.role === 'user' ? '**Q:** ' : '') + m.content).join('\n\n') + '\n';
    }
  }
  download('paper-lens-questions.md', out);
  toast('Downloaded your questions as Markdown.');
}

async function onClick(e) {
  if (e.target.closest('[data-settings]')) { dispatchEvent(new CustomEvent('pl:open-settings')); return; }
  const qf = e.target.closest('[data-qf]');
  if (qf) {
    const v = qf.dataset.qf;
    if (v === '__clear') { Q.topic = ''; Q.starred = false; }
    else if (v === '__star') Q.starred = !Q.starred;
    else Q.topic = Q.topic === v ? '' : v;
    renderQuestions(); return;
  }
  if (e.target.closest('[data-qsort]')) { sortWithAI(); return; }
  if (e.target.closest('[data-qexport]')) { exportQuestions(); return; }
  const qc = e.target.closest('.qc');
  if (qc) {
    const p = H.papers.find(x => x.id === qc.dataset.pid);
    const t = p && H.datas[p.id].threads.find(x => x.id === qc.dataset.tid);
    if (!t) return;
    if (e.target.closest('[data-qstar]')) { const on = !t.starred; await saveThread(p, t, { starred: on }); renderQuestions(); toast(on ? 'Saved for later.' : 'Removed from saved.'); return; }
    if (e.target.closest('[data-qtopic]')) {
      const v = await askText('Topic for this question', t.topic || '', 'Save');
      if (v !== null) { await saveThread(p, t, { topic: v.slice(0, 40) }); renderQuestions(); }
      return;
    }
    if (e.target.closest('[data-qcopy]')) {
      const txt = t.turns.filter((m, i) => !(i === 0 && m.content === EXPLAIN)).map(m => (m.role === 'user' ? 'Q: ' : '') + m.content).join('\n\n');
      toast(await copyText(txt) ? 'Copied the question and answer.' : 'Couldn’t copy.'); return;
    }
    if (e.target.closest('[data-qopen]')) location.hash = `#/paper/${p.id}/t/${t.id}`;
    return;
  }
  const hf = e.target.closest('[data-hf]');
  if (hf) { const id = hf.dataset.hf; if (id === '__clear') H.filter.clear(); else H.filter.has(id) ? H.filter.delete(id) : H.filter.add(id); renderHighlights(); return; }
  if (e.target.closest('[data-export]')) { exportMd(); return; }
  const hc = e.target.closest('.hc');
  if (hc) {
    const p = H.papers.find(x => x.id === hc.dataset.pid);
    const h = p && H.datas[p.id].highlights.find(x => x.id === hc.dataset.hid);
    if (!h) return;
    if (e.target.closest('[data-copy]')) { toast(await copyText(h.text || '') ? 'Copied the highlighted text.' : 'Couldn’t copy.'); return; }
    if (e.target.closest('[data-open]')) location.hash = `#/paper/${p.id}/h/${h.id}`;
    return;
  }
  const pc = e.target.closest('.pc-card');
  if (pc) {
    const p = H.papers.find(x => x.id === pc.dataset.pid); if (!p) return;
    if (e.target.closest('[data-rename]')) {
      const t = await askText('Rename paper', p.title);
      if (t) { p.title = t; await savePaperMeta(p); renderHome(); }
    } else if (e.target.closest('[data-remove]')) {
      const ok = await confirmBox('Remove this paper?', `“${p.title}” and its highlights and notes will disappear from your library on every device.`, 'Remove', true);
      if (ok) { p.deleted = true; await savePaperMeta(p); await delPdf(p.id); renderHome(); toast('Removed.'); }
    }
  }
}

function exportMd() {
  const items = allHighlights();
  if (!items.length) { toast('No highlights to export yet.'); return; }
  let out = `# Highlights\n\nExported from Paper Lens on ${new Date().toLocaleDateString()}\n`;
  for (const p of H.papers) {
    const g = items.filter(x => x.p === p).sort((a, b) => a.h.page - b.h.page);
    if (!g.length) continue;
    out += `\n## ${p.title}\n\n` + g.map(({ h }) => `- **${colorOf(h.color).label}** (p.${h.page}): ${(h.text || '[figure or formula]').replace(/\s+/g, ' ')}${h.note ? `\n  - Note: ${h.note}` : ''}`).join('\n') + '\n';
  }
  download('paper-lens-highlights.md', out);
  toast('Downloaded your highlights as Markdown.');
}
