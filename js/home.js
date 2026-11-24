// Home page: the library of papers plus every highlight across all of them.
import { settings, listPapers, getData, colorOf, savePaperMeta, delPdf } from './store.js';
import { currentModel } from './ai.js';
import { syncOn } from './sync.js';
import { $, esc, timeAgo, copyText, toast, download } from './util.js';
import { hlCardHTML, askText, confirmBox } from './ui.js';

const H = { filter: new Set(), q: '', sort: 'paper', papers: [], datas: {} };
let root, renderTok = 0;

export function initHome() {
  root = $('#home');
  root.addEventListener('click', onClick);
  root.addEventListener('input', e => {
    if (e.target.id === 'hq') { H.q = e.target.value; renderHighlights(); }
  });
  root.addEventListener('change', e => {
    if (e.target.id === 'hsort') { H.sort = e.target.value; renderHighlights(); }
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
      <p class="stats">${H.papers.length} ${H.papers.length === 1 ? 'paper' : 'papers'} · ${allH.length} ${allH.length === 1 ? 'highlight' : 'highlights'} · ${notes} ${notes === 1 ? 'note' : 'notes'}</p>
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
  </section>`;
  renderHighlights();
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
      <p class="pc-meta">${p.pages ? p.pages + ' pages · ' : ''}${c.h} highlights · ${c.t} notes</p>
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

async function onClick(e) {
  if (e.target.closest('[data-settings]')) { dispatchEvent(new CustomEvent('pl:open-settings')); return; }
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
