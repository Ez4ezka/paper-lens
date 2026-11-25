// References: read the paper's reference list, find where each one is cited, look the cited papers up,
// and find the passage of a cited paper that a citing sentence points to.
import { chat, currentModel, cheapModel } from './ai.js';
import { api, apiJSON, errorFrom } from './api.js';
import { buildBlocks, quoteRegions } from './structure.js';
import { idbGet, idbPut } from './util.js';

const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const r1 = v => Math.round(v * 10) / 10;
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Page text with each character's source item, so a match can be turned back into a box on the page.
// pages: [{ n, items: [{ s, eol, x, y, w, h }] }]
function pageString(pg) {
  let s = ''; const spans = [];
  for (const it of pg.items || []) {
    spans.push([s.length, s.length + it.s.length, it]);
    s += it.s;
    if (it.eol) s += '\n';
  }
  return { s, spans };
}
function boxOf(ps, a, b) {
  let bb = null;
  for (const [s0, s1, it] of ps.spans) {
    if (s1 <= a || s0 >= b) continue;
    const cw = it.w / Math.max(1, it.s.length);
    const x0 = it.x + (Math.max(a, s0) - s0) * cw, x1 = it.x + (Math.min(b, s1) - s0) * cw;
    const r = [x0, it.y, Math.max(x1, x0 + 2), it.y + it.h];
    bb = bb ? union(bb, r) : r;
  }
  return bb && bb.map(r1);
}
const ABBR = /\b(?:al|e\.g|i\.e|etc|fig|figs|eq|eqs|vs|cf|sec|secs|no|ref|refs|resp|approx|ch|tab|thm|def|dr|prof)\.$/i;
const endsSentence = (s, k) => /[.!?]/.test(s[k]) && /\s/.test(s[k + 1] || ' ') && !ABBR.test(s.slice(Math.max(0, k - 7), k + 1)) && !/\d/.test(s[k + 1] || '');
function sentenceAt(s, a, b) {
  let i = a, j = b;
  const lo = Math.max(0, a - 450), hi = Math.min(s.length, b + 450);
  while (i > lo && !endsSentence(s, i - 2)) i--;
  while (j < hi && !endsSentence(s, j)) j++;
  return s.slice(i, Math.min(j + 1, s.length)).replace(/-\n(?=[a-z])/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^\d+(\.\d+)*\.?\s+[A-Z][a-z]+(\s+[A-Z]?[a-z]+){0,4}\s+(?=[A-Z])/, '');   // a section heading run into the sentence
}

/* ---------- 1. where the reference list is ---------- */
const HEAD = /(^|\n)[ \t]*(?:[\dIVX]+\.?[ \t]*)?(references|bibliography|works cited|literature cited|reference list|cited literature)[ \t]*:?[ \t]*(?=\n|$)/gi;
const AFTER = /(^|\n)[ \t]*(?:[A-Z]\.?[ \t]+)?(appendix|appendices|supplementary (?:material|information)|acknowledg(?:e)?ments)\b[^\n]{0,60}(?=\n|$)/i;
export function findReferenceList(pages) {
  let at = null;
  pages.forEach(pg => { const s = pageString(pg).s; for (const m of s.matchAll(HEAD)) at = { page: pg.n, off: m.index + m[1].length, len: m[0].length - m[1].length }; });
  let text = '';
  if (at) {
    for (const pg of pages) {
      if (pg.n < at.page) continue;
      const s = pageString(pg).s;
      text += '\n' + (pg.n === at.page ? s.slice(at.off + at.len) : s);
      if (text.length > 70000) break;
    }
    const end = text.search(AFTER);
    if (end > 400) text = text.slice(0, end);
  } else {
    // no heading found: the reference list is usually on the last pages
    text = pages.slice(-Math.max(2, Math.ceil(pages.length / 4))).map(pg => pageString(pg).s).join('\n').slice(-60000);
  }
  return { at, text: text.slice(0, 60000) };
}

/* ---------- 2. the AI turns the list into data ---------- */
const PARSE_SYSTEM = `You turn the reference list of a research paper into JSON. The text was extracted from a PDF, so lines may be broken, hyphenated or merged, and some page headers or footnotes may be mixed in.

Reply with JSON only, in this shape:
{"style":"numeric","refs":[{"n":"1","first":"Shazeer","authors":"N. Shazeer, A. Mirhoseini, et al.","year":"2017","title":"Outrageously large neural networks: the sparsely-gated mixture-of-experts layer","venue":"ICLR","doi":"","arxiv":"1701.06538"}]}

Rules:
- style is "numeric" if references are numbered or labelled ([1], 1., [Smi17]) and cited that way, otherwise "author-year".
- One entry per reference, in the order listed. Skip anything that is not a reference.
- n: the label exactly as printed, without brackets or the trailing dot ("1", "12", "Smi17"); empty for unlabelled lists.
- first: the first author's surname only (or the organisation's name). authors: up to three names, then "et al." if there are more.
- title: the work's title, exactly as printed but with broken lines and hyphenation joined. For a book, the book title.
- year: four digits plus any letter suffix ("2017b"). venue: journal, conference or publisher, short.
- doi: without "https://doi.org/". arxiv: the id, like "1701.06538" or "hep-th/9901001", if one appears (also inside an arxiv.org URL).
- Leave a field empty rather than guessing.`;

export async function parseReferences(title, text, signal) {
  const model = cheapModel() || currentModel();
  const r = await chat({
    system: PARSE_SYSTEM, model, effort: 'low', signal,
    turns: [{ role: 'user', content: `Paper: ${title}\n\nReference list:\n"""\n${text}\n"""` }],
  });
  const m = r.text.match(/\{[\s\S]*\}/);
  let j; try { j = JSON.parse(m ? m[0] : ''); } catch (e) { throw new Error('The reference list couldn’t be read. Try again, or pick a stronger model.'); }
  const refs = (Array.isArray(j.refs) ? j.refs : []).filter(x => x && (x.title || x.first)).slice(0, 400).map((x, i) => ({
    key: 'r' + (i + 1),
    n: String(x.n || '').replace(/^\[|\]$|\.$/g, '').trim().slice(0, 20),
    first: String(x.first || '').trim().slice(0, 60),
    authors: String(x.authors || '').trim().slice(0, 200),
    year: String(x.year || '').trim().slice(0, 8),
    title: String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    venue: String(x.venue || '').trim().slice(0, 120),
    doi: String(x.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().slice(0, 200),
    arxiv: String(x.arxiv || '').replace(/^arxiv:/i, '').trim().slice(0, 40),
  }));
  return { style: j.style === 'author-year' ? 'author-year' : 'numeric', refs, model: r.model.provider + ':' + r.model.id };
}

/* ---------- 3. where each reference is cited in the paper ---------- */
function expandLabels(inner) {
  const out = [];
  for (let part of inner.split(/[,;]|\band\b/)) {
    part = part.trim();
    const rg = part.match(/^(\d{1,3})\s*[-–—]\s*(\d{1,3})$/);
    if (rg) { const a = +rg[1], b = +rg[2]; if (b >= a && b - a < 60) for (let k = a; k <= b; k++) out.push(String(k)); }
    else if (part) out.push(part.replace(/^\[|\]$/g, ''));
  }
  return out;
}
// pages: [{ n, items }]; listAt: where the reference list starts (citations after it are ignored)
export function findCitations(pages, refs, style, listAt) {
  const cites = Object.fromEntries(refs.map(r => [r.key, []]));
  const byLabel = new Map(refs.filter(r => r.n).map(r => [r.n.toLowerCase(), r.key]));
  const add = (key, c) => { const l = cites[key]; if (l && l.length < 15 && !l.some(x => x.page === c.page && x.text === c.text && Math.abs(x.bb[1] - c.bb[1]) < 2)) l.push(c); };
  for (const pg of pages) {
    if (listAt && pg.n > listAt.page) break;
    const ps = pageString(pg);
    const s = listAt && pg.n === listAt.page ? ps.s.slice(0, listAt.off) : ps.s;
    if (style === 'numeric' && byLabel.size) {
      for (const m of s.matchAll(/\[([^\[\]\n]{1,80})\]/g)) {
        const labels = expandLabels(m[1]);
        if (!labels.length || !labels.every(l => byLabel.has(l.toLowerCase()))) continue;   // e.g. a math interval [0, 1]
        const keys = [...new Set(labels.map(l => byLabel.get(l.toLowerCase())))];
        const bb = boxOf(ps, m.index, m.index + m[0].length); if (!bb) continue;
        const text = sentenceAt(s, m.index, m.index + m[0].length);
        for (const k of keys) add(k, { page: pg.n, bb, text });
      }
    } else {
      for (const r of refs) {
        const y = (r.year.match(/\d{4}/) || [])[0];
        if (!r.first || !y || r.first.length < 2) continue;
        const re = new RegExp(reEsc(r.first) + '[^()\\d\\n]{0,60}?[\\s,(]\\s*' + y + (r.year.slice(4) ? reEsc(r.year.slice(4)) : '[a-z]?') + '\\b', 'g');
        for (const m of s.matchAll(re)) {
          const bb = boxOf(ps, m.index, m.index + m[0].length); if (!bb) continue;
          add(r.key, { page: pg.n, bb, text: sentenceAt(s, m.index, m.index + m[0].length) });
        }
      }
    }
  }
  return cites;
}

/* ---------- 4. look the cited papers up ---------- */
export async function lookupRefs(refs, { signal, onBatch } = {}) {
  const todo = refs.filter(r => r.found === undefined && (r.title || r.doi || r.arxiv));
  let busy = false;
  for (let i = 0; i < todo.length; i += 5) {
    if (signal && signal.aborted) break;
    const batch = todo.slice(i, i + 5);
    const j = await apiJSON('api/refs', { method: 'POST', signal, body: JSON.stringify({ refs: batch.map(r => ({ key: r.key, title: r.title, year: r.year, doi: r.doi, arxiv: r.arxiv })) }) });
    for (const r of batch) if (r.key in j.found) r.found = j.found[r.key];
    if (onBatch) onBatch(Math.min(todo.length, i + 5), todo.length);
    if (j.busy) busy = true;
  }
  for (const r of refs) if (r.found === undefined && !(r.title || r.doi || r.arxiv)) r.found = null;
  return { busy };
}

/* ---------- 5. the cited paper's own PDF ---------- */
export async function citedPdf(url, signal) {
  const key = 'refpdf:' + url;
  const have = await idbGet('kv', key).catch(() => null);
  if (have) return have;
  const parts = [];
  let n = 1;
  for (let i = 0; i < n; i++) {
    const r = await api('api/refs?pdf=' + encodeURIComponent(url) + '&part=' + i, { signal });
    if (!r.ok) throw await errorFrom(r);
    n = +(r.headers.get('x-parts') || 1);
    parts.push(await r.arrayBuffer());
  }
  const blob = new Blob(parts, { type: 'application/pdf' });
  idbPut('kv', key, blob).catch(() => {});
  return blob;
}
export async function pdfPages(blob) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const pages = [];
  try {
    for (let i = 1; i <= Math.min(doc.numPages, 80); i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 }), T = vp.transform;
      const tc = await page.getTextContent();
      const items = tc.items.filter(it => typeof it.str === 'string').map(it => {
        const m = pdfjsLib.Util.transform(T, it.transform);
        const h = Math.hypot(m[2], m[3]) || 8;
        return { s: it.str, eol: it.hasEOL, x: m[4], y: m[5] - h, w: it.width || it.str.length * h * .5, h };
      });
      pages.push({ n: i, w: vp.width, h: vp.height, items });
    }
  } finally { doc.destroy(); }
  return pages;
}

/* ---------- 6. which passage of the cited paper is meant ---------- */
const STOP = new Set('this that with from have were been their there these those which while where when then than into onto also such only other more most some many much very about after before between both each over under using used use show shows shown paper work works model models method methods approach based results result large small given first second third further however because through within without across'.split(' '));
const kw = t => (String(t).toLowerCase().match(/[a-z][a-z-]{3,}/g) || []).filter(w => !STOP.has(w));
export async function matchCitations({ mainTitle, ref, cites, pages, signal }) {
  const blocks = pages ? buildBlocks(pages) : [];
  const full = blocks.length > 3;
  const f = ref.found || {};
  // The blocks most related to the citing sentences go in full; the rest are cut short so the AI still sees the layout.
  const want = new Set(cites.flatMap(c => kw(c.text)));
  const score = b => { const w = kw(b.text); return w.length ? new Set(w.filter(x => want.has(x))).size / Math.sqrt(w.length) : 0; };
  const top = new Set(full ? [...blocks].sort((a, b) => score(b) - score(a)).slice(0, 45).map(b => b.id) : []);
  const short = Math.max(50, Math.min(160, Math.floor(30000 / Math.max(1, blocks.length))));
  const body = full
    ? blocks.map(b => { const n = top.has(b.id) ? 900 : short; return `${b.id} [p${b.page}] ${b.text.length > n ? b.text.slice(0, n) + '…' : b.text}`; }).join('\n')
    : `abs ${f.abstract || '(no abstract available)'}`;
  const system = `You connect citations to the passages they point to. The reader is studying paper A, "${mainTitle}". Paper A cites paper B, "${f.title || ref.title}"${f.year ? ' (' + f.year + ')' : ''}, in the sentences listed below. ${full
    ? 'Paper B is given as numbered text blocks in reading order, with page numbers; long blocks are cut short.'
    : 'Only paper B\'s abstract is available, as block "abs".'}

For each citing sentence, find where paper B says the thing that paper A is drawing on: the specific result, method, claim, dataset or definition. When A cites B only in general, point to where B states its main contribution.

Reply with JSON only:
{"matches":[{"cite":1,"from":"b12","to":"b13","quote":"...","why":"..."}]}
- cite: the number of the citing sentence.
- from, to: block ids (inclusive), at most 4 blocks apart.${full ? '' : ' Use "abs" for both.'}
- quote: the single sentence from those blocks (prefer blocks shown in full) that best shows it, copied word for word (at most 50 words).
- why: one plain-language sentence saying what A takes from B here, and whether B actually supports A's sentence.`;
  const user = `Citing sentences in paper A:\n${cites.map((c, i) => `${i + 1}. (p. ${c.page}) ${c.text}`).join('\n')}\n\nPaper B:\n${body}`;
  const r = await chat({ system, signal, turns: [{ role: 'user', content: user }] });
  const m = r.text.match(/\{[\s\S]*\}/);
  let j; try { j = JSON.parse(m ? m[0] : ''); } catch (e) { throw new Error('The AI’s answer couldn’t be read. Try again.'); }
  const idx = new Map(blocks.map(b => [b.id, b.i]));
  const items = [];
  for (const x of Array.isArray(j.matches) ? j.matches : []) {
    const ci = +x.cite - 1; if (!(ci >= 0 && ci < cites.length)) continue;
    const it = { cite: ci, quote: String(x.quote || '').slice(0, 500), why: String(x.why || '').slice(0, 400), page: 0, regions: [], key: [] };
    let a = idx.get(String(x.from || '').trim()), z = idx.get(String(x.to || x.from || '').trim());
    if (a != null && z != null) {
      if (z < a) [a, z] = [z, a];
      z = Math.min(z, a + 4);
      const span = blocks.slice(a, z + 1);
      for (const b of span) {
        const last = it.regions[it.regions.length - 1];
        if (last && last.page === b.page && last.col === b.col) last.bb = union(last.bb, b.bb);
        else it.regions.push({ page: b.page, col: b.col, bb: [...b.bb] });
      }
      it.regions = it.regions.map(g => ({ page: g.page, bb: g.bb.map(v => r1(v)) }));
      it.page = span[0].page;
      if (it.quote) it.key = quoteRegions(it.quote, span);
    }
    items.push(it);
  }
  return { items, fullText: full, model: r.model.provider + ':' + r.model.id };
}
