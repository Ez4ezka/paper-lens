// Whole-paper AI: the summary, and the "dissection" that labels each part of the paper (thesis, method, results…).
// The AI never guesses coordinates. We split every page into text blocks ourselves, the AI only says which
// blocks form which part, and the boxes drawn on the page come from the blocks' real positions.

export const ROLES = {
  title:       { label: 'Title',        color: '#64748b' },
  abstract:    { label: 'Abstract',     color: '#6366f1' },
  motivation:  { label: 'Problem',      color: '#f97316' },
  thesis:      { label: 'Thesis',       color: '#e11d48' },
  background:  { label: 'Background',   color: '#0d9488' },
  method:      { label: 'Method',       color: '#2563eb' },
  setup:       { label: 'Setup',        color: '#7c3aed' },
  results:     { label: 'Results',      color: '#16a34a' },
  discussion:  { label: 'Discussion',   color: '#ca8a04' },
  limitations: { label: 'Limitations',  color: '#dc2626' },
  conclusion:  { label: 'Conclusion',   color: '#0891b2' },
  references:  { label: 'References',   color: '#94a3b8' },
  appendix:    { label: 'Appendix',     color: '#a3a3a3' },
  other:       { label: 'Other',        color: '#78716c' },
};
export const roleOf = r => ROLES[r] || ROLES.other;

/* ---------- 1. split pages into text blocks (paragraphs, headings, captions) ---------- */
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

// pages: [{ n, w, h, items: [{ s, x, y, w, h }] }]   (y is the top of the text, in page units)
export function buildBlocks(pages) {
  const blocks = [];
  for (const pg of pages) {
    const its = (pg.items || []).filter(it => it.s && it.s.trim() && it.h > 2 && it.w > 0)
      .map(it => ({ ...it, cy: it.y + it.h / 2 })).sort((a, b) => a.cy - b.cy || a.x - b.x);
    // rows of text at the same height
    const rows = [];
    for (const it of its) {
      const r = rows.find(r => Math.abs(r.cy - it.cy) < .45 * Math.min(r.h, it.h));
      if (r) { r.items.push(it); r.h = Math.max(r.h, it.h); } else rows.push({ cy: it.cy, h: it.h, items: [it] });
    }
    // split each row at wide gaps (column gutters) into line fragments
    const frags = [];
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let cur = null;
      for (const it of r.items) {
        const gap = cur ? it.x - cur.bb[2] : 0;
        if (!cur || gap > Math.max(1.4 * r.h, 10)) {
          if (cur) frags.push(cur);
          cur = { bb: [it.x, it.y, it.x + it.w, it.y + it.h], h: it.h, text: it.s };
        } else {
          cur.bb = union(cur.bb, [it.x, it.y, it.x + it.w, it.y + it.h]);
          cur.h = Math.max(cur.h, it.h);
          cur.text += (/\s$/.test(cur.text) || /^\s/.test(it.s) || gap < .12 * it.h ? '' : ' ') + it.s;
        }
      }
      if (cur) frags.push(cur);
    }
    frags.sort((a, b) => a.bb[1] - b.bb[1] || a.bb[0] - b.bb[0]);
    // stack fragments into blocks: next line just below, same column, same font size, previous line not a paragraph end
    const pageBlocks = [];
    for (const f of frags) {
      let best = null, bestGap = Infinity;
      for (const b of pageBlocks) {
        const gap = f.bb[1] - b.bb[3];
        if (gap < -.35 * f.h || gap > .95 * f.h) continue;
        if (Math.abs(f.h - b.h) > .25 * b.h) continue;
        const ov = Math.min(f.bb[2], b.bb[2]) - Math.max(f.bb[0], b.bb[0]);
        if (ov < .5 * Math.min(f.bb[2] - f.bb[0], b.bb[2] - b.bb[0])) continue;
        const last = b.lines[b.lines.length - 1].bb, bw = b.bb[2] - b.bb[0];
        if (b.lines.length > 1 && last[2] < b.bb[2] - .18 * bw) continue;   // short last line: the paragraph ended
        if (gap < bestGap) { best = b; bestGap = gap; }
      }
      if (best) { best.bb = union(best.bb, f.bb); best.lines.push(f); }
      else pageBlocks.push({ page: pg.n, bb: [...f.bb], h: f.h, lines: [f] });
    }
    // reading order: full-width blocks split the page into bands; inside a band, left column then right column
    const full = b => b.bb[2] - b.bb[0] > .58 * pg.w;
    const fulls = pageBlocks.filter(full).sort((a, b) => a.bb[1] - b.bb[1]);
    for (const b of pageBlocks) {
      const band = fulls.filter(f => f !== b && f.bb[1] < b.bb[1]).length;
      b.col = full(b) ? 3 : ((b.bb[0] + b.bb[2]) / 2 < pg.w / 2 ? 1 : 2);
      b.key = [band, b.col, b.bb[1]];
    }
    pageBlocks.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
    for (const b of pageBlocks) {
      b.text = b.lines.map(l => l.text).join(' ').replace(/-\s+(?=[a-z])/g, '').replace(/\s+/g, ' ').trim();
      if (!b.text) continue;
      // drop running headers, footers and lone page numbers
      if (b.lines.length === 1 && b.text.length < 4 && /^[\divxlc.]+$/i.test(b.text)) continue;
      blocks.push(b);
    }
  }
  blocks.forEach((b, i) => { b.id = 'b' + (i + 1); b.i = i; });
  return blocks;
}

/* ---------- 2. ask the AI which blocks form which part ---------- */
export function dissectRequest(title, blocks) {
  const per = Math.max(70, Math.min(240, Math.floor(42000 / Math.max(1, blocks.length))));
  const list = blocks.map(b => `${b.id} [p${b.page}] ${b.text.length > per ? b.text.slice(0, per) + '…' : b.text}`).join('\n');
  const system = `You show a reader how a research paper is built. You get the paper as numbered text blocks in reading order. Each block is a paragraph, heading, caption, equation or similar, and long blocks are cut short. Split the paper into its structural parts.

Reply with JSON only, in this shape:
{"parts":[{"role":"thesis","label":"Thesis: attention replaces recurrence","note":"States the paper's central claim.","from":"b7","to":"b8","quote":"..."}]}

Rules:
- role is exactly one of: ${Object.keys(ROLES).filter(r => r !== 'other').join(', ')}.
- from and to are block ids, inclusive. Parts follow reading order and do not overlap, except the thesis part, which may reuse blocks that also belong to the abstract or introduction.
- Always include exactly one "thesis" part: the 1 to 3 blocks that state the paper's central claim or contribution most directly. Give it "quote": the single sentence that best states the thesis, copied word for word from the block text (at most 40 words).
- Cover the paper from start to end. Leave out page headers, footers and page numbers.
- A role can appear more than once (for example two separate experiments); use the label to tell them apart.
- label: 2 to 6 words saying what this specific part is about, starting with the role name, like "Method: the Transformer architecture".
- note: one plain-language sentence on what this part does for the paper's argument.
- Aim for 6 to 20 parts. Headings belong to the part they introduce.`;
  return { system, user: `Paper title: ${title}\n\nBlocks:\n${list}` };
}

const words = s => (s.toLowerCase().normalize('NFKD').match(/[a-z0-9]+/g) || []);

// Find the lines that hold a quoted sentence, so it can get its own box.
export function quoteRegions(quote, blocks) {
  const q = new Set(words(quote));
  if (q.size < 3) return [];
  let best = null;
  for (const b of blocks) {
    const ls = b.lines.map(l => { const w = words(l.text); const hit = w.filter(x => q.has(x)).length; return { l, hit, ok: w.length && hit / w.length >= .6 && hit >= Math.min(2, w.length) }; });
    for (let i = 0; i < ls.length; i++) {
      if (!ls[i].ok) continue;
      let j = i, sum = 0;
      while (j < ls.length && ls[j].ok) { sum += ls[j].hit; j++; }
      if (!best || sum > best.sum) best = { sum, page: b.page, lines: ls.slice(i, j).map(x => x.l) };
      i = j;
    }
  }
  if (!best || best.sum < Math.min(6, q.size * .5)) return [];
  const bb = best.lines.reduce((a, l) => union(a, l.bb), [...best.lines[0].bb]);
  return [{ page: best.page, bb: pad(bb, 2) }];
}
const pad = (bb, d) => [bb[0] - d, bb[1] - d, bb[2] + d, bb[3] + d].map(v => Math.round(v * 10) / 10);

// Turn the AI's answer into parts with boxes on the pages.
export function parseDissection(text, blocks) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  let j; try { j = JSON.parse(m ? m[0] : ''); } catch (e) { return []; }
  const idx = new Map(blocks.map(b => [b.id, b.i]));
  const parts = [];
  for (const p of (j && Array.isArray(j.parts) ? j.parts : [])) {
    let a = idx.get(String(p.from || '').trim()), z = idx.get(String(p.to || p.from || '').trim());
    if (a == null || z == null) continue;
    if (z < a) [a, z] = [z, a];
    const role = ROLES[p.role] ? p.role : 'other';
    const span = blocks.slice(a, z + 1);
    // merge neighbouring blocks in the same column of the same page into one box
    const regions = [];
    for (const b of span) {
      const r = regions[regions.length - 1];
      if (r && r.page === b.page && r.col === b.col && r.band === b.key[0]) r.bb = union(r.bb, b.bb);
      else regions.push({ page: b.page, col: b.col, band: b.key[0], bb: [...b.bb] });
    }
    parts.push({
      id: 'p' + (parts.length + 1), role,
      label: String(p.label || roleOf(role).label).slice(0, 80),
      note: String(p.note || '').slice(0, 300),
      quote: role === 'thesis' ? String(p.quote || '').slice(0, 400) : '',
      from: blocks[a].page, to: blocks[z].page,
      regions: regions.map(r => ({ page: r.page, bb: pad(r.bb, 3) })),
      key: role === 'thesis' && p.quote ? quoteRegions(p.quote, span.length ? span : blocks) : [],
    });
  }
  return parts;
}

/* ---------- the summary ---------- */
export function summarySystem(title, fullText) {
  return `You summarize a research paper for someone about to read it. Be accurate: only say what the paper says, and say so when you are inferring.

Use Markdown with exactly these headings:
## In a nutshell
Two or three sentences: the problem, what the authors did, what they found.
## Main claim
The paper's thesis in one or two sentences.
## The main parts
One bullet per major section, in order: **Section name** (p. N–M): what it covers and what it adds to the argument, in one or two sentences.
## Key results
Three to six bullets, with the concrete numbers the paper reports.
## Limitations and open questions
Two to four bullets. Say whether the authors state each one or you are inferring it.
## Terms to know
Three to six key terms, each with a one-line plain definition.

Write in plain, conversational language, spell out each abbreviation the first time, and write math in LaTeX ($...$). About 350 to 600 words.

Paper title: ${title}

Full text of the paper (extracted from the PDF, so figures and some math may be garbled; [Page N] marks page starts):
"""
${fullText}
"""`;
}
