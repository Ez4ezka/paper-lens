// Cited papers: look them up in public paper indexes, and fetch their free PDFs.
//   POST /api/refs  {refs:[{key, title, first, year, doi, arxiv}]}  -> {found: {key: paper | null}, busy?: true}
//   GET  /api/refs?pdf=<url>&part=N                                  -> PDF bytes in 3.5 MB parts (x-parts, x-size headers)
// Lookups use Semantic Scholar (free; set S2_API_KEY for a private rate limit) with arXiv as a backup.
import dns from 'node:dns/promises';
import net from 'node:net';
import { json, authed, denied } from './_lib.js';

const S2 = () => process.env.PL_S2_URL || 'https://api.semanticscholar.org';
const ARXIV = () => process.env.PL_ARXIV_URL || 'https://export.arxiv.org';
const FIELDS = 'title,year,authors,venue,externalIds,openAccessPdf,abstract,url';
const UA = 'PaperLens/1.0 (personal research-paper reader)';
const PART = 3_500_000, MAX_PDF = 60_000_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- matching titles ---------- */
const words = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) || [];
export function sameTitle(a, b) {
  const x = words(a), y = new Set(words(b));
  if (!x.length || !y.size) return false;
  const hit = x.filter(w => y.has(w)).length;
  return hit / Math.max(x.length, y.size) >= .72 || (hit === x.length && x.length >= 4 && hit / y.size >= .55);
}
const yearOk = (a, b) => !a || !b || Math.abs(+String(a).slice(0, 4) - +b) <= 1;

/* ---------- Semantic Scholar ---------- */
class Busy extends Error {}
async function s2(path, opts = {}) {
  const headers = { 'user-agent': UA, ...(process.env.S2_API_KEY ? { 'x-api-key': process.env.S2_API_KEY } : {}), ...(opts.headers || {}) };
  for (let i = 0; i < 3; i++) {
    const r = await fetch(S2() + path, { ...opts, headers, signal: AbortSignal.timeout(12000) }).catch(() => null);
    if (r && r.ok) return r.json();
    if (r && (r.status === 404 || r.status === 400)) return null;
    if (r && r.status !== 429 && r.status < 500) return null;
    if (i < 2) await sleep(1100 * (i + 1) + Math.random() * 400);
  }
  throw new Busy();
}
function fromS2(p) {
  if (!p || !p.title) return null;
  const ids = p.externalIds || {};
  const arxiv = ids.ArXiv || '';
  const pdf = arxiv ? `https://arxiv.org/pdf/${arxiv}` : (p.openAccessPdf && p.openAccessPdf.url) || '';
  return {
    title: p.title, year: p.year || '', venue: p.venue || '',
    authors: (p.authors || []).slice(0, 6).map(a => a.name).join(', ') + ((p.authors || []).length > 6 ? ', …' : ''),
    doi: ids.DOI || '', arxiv, abstract: (p.abstract || '').slice(0, 4000),
    pdf: pdf.replace(/^http:\/\/(export\.)?arxiv\.org/, 'https://arxiv.org'),
    url: p.url || (ids.DOI ? 'https://doi.org/' + ids.DOI : ''), source: 'Semantic Scholar',
  };
}

/* ---------- arXiv (backup) ---------- */
const unxml = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const STOP = new Set('a an and are as at be by for from in into is it of on or the to via with its this that we our using towards toward'.split(' '));
let lastArxiv = 0;
async function arxivSearch(title, id) {
  const q = words(title).filter(w => w.length > 1 && !STOP.has(w)).slice(0, 9).map(w => 'ti:' + w).join('+AND+');
  if (!q && !id) return null;
  // arXiv asks for at most one request every 3 seconds
  const wait = lastArxiv + 3000 - Date.now(); if (wait > 0) await sleep(wait);
  lastArxiv = Date.now();
  const r = await fetch(`${ARXIV()}/api/query?` + (id ? `id_list=${encodeURIComponent(id)}` : `search_query=${q}&max_results=5`), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) }).catch(() => null);
  if (!r || !r.ok) return null;
  const xml = await r.text();
  for (const e of xml.split('<entry>').slice(1)) {
    const t = unxml((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    if (!id && !sameTitle(title, t)) continue;
    if (id && title && !sameTitle(title, t)) continue;
    const aid = ((e.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/) || [])[1] || '').replace(/v\d+$/, '');
    if (!aid) continue;
    const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => unxml(m[1]));
    return {
      title: t, year: ((e.match(/<published>(\d{4})/) || [])[1]) || '', venue: 'arXiv',
      authors: authors.slice(0, 6).join(', ') + (authors.length > 6 ? ', …' : ''),
      doi: unxml((e.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/) || [])[1]), arxiv: aid,
      abstract: unxml((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]).slice(0, 4000),
      pdf: `https://arxiv.org/pdf/${aid}`, url: `https://arxiv.org/abs/${aid}`, source: 'arXiv',
    };
  }
  return null;
}

/* ---------- Crossref (metadata for anything with a DOI) ---------- */
async function crossref(r) {
  const base = process.env.PL_CROSSREF_URL || 'https://api.crossref.org';
  const sel = 'select=DOI,title,issued,author,container-title,abstract,URL';
  const res = await fetch(r.doi ? `${base}/works/${encodeURIComponent(r.doi)}` : `${base}/works?query.bibliographic=${encodeURIComponent((r.title + ' ' + (r.year || '')).slice(0, 300))}&rows=3&${sel}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) }).catch(() => null);
  if (!res || !res.ok) return null;
  const j = await res.json().catch(() => null); if (!j) return null;
  const items = r.doi ? [j.message] : (j.message && j.message.items) || [];
  for (const w of items) {
    const t = (w.title || [])[0] || '';
    const y = (((w.issued || {})['date-parts'] || [[]])[0] || [])[0] || '';
    if (!t || (r.title && !sameTitle(r.title, t)) || !yearOk(r.year, y)) continue;
    const au = (w.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean);
    return {
      title: t, year: y, venue: (w['container-title'] || [])[0] || '',
      authors: au.slice(0, 6).join(', ') + (au.length > 6 ? ', …' : ''),
      doi: w.DOI || '', arxiv: '', abstract: unxml(String(w.abstract || '').replace(/<[^>]+>/g, ' ')).replace(/^Abstract\s*/i, '').slice(0, 4000),
      pdf: '', url: w.DOI ? 'https://doi.org/' + w.DOI : w.URL || '', source: 'Crossref',   // publisher PDF links are usually paywalled
    };
  }
  return null;
}

async function lookup(refs) {
  const found = {};
  let busy = false;
  // 1. references that carry a DOI or arXiv id: one batch request
  const withId = refs.filter(r => r.doi || r.arxiv);
  if (withId.length) {
    try {
      const ids = withId.map(r => r.arxiv ? 'ARXIV:' + r.arxiv : 'DOI:' + r.doi);
      const list = await s2(`/graph/v1/paper/batch?fields=${FIELDS}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }) });
      (list || []).forEach((p, i) => { const f = fromS2(p); if (f && (!withId[i].title || sameTitle(withId[i].title, f.title))) found[withId[i].key] = f; });
    } catch (e) { if (e instanceof Busy) busy = true; }
  }
  // 2. the rest by title
  for (const r of refs) {
    if (found[r.key] || ((!r.title || words(r.title).length < 2) && !r.arxiv && !r.doi)) continue;
    let f = null;
    if (!busy) {
      try {
        const j = !r.title ? null : await s2(`/graph/v1/paper/search/match?query=${encodeURIComponent(r.title.slice(0, 300))}&fields=${FIELDS}`);
        const p = j && j.data && j.data[0];
        if (p && sameTitle(r.title, p.title) && yearOk(r.year, p.year)) f = fromS2(p);
      } catch (e) { if (e instanceof Busy) busy = true; }
    }
    if (!f && r.arxiv) f = await arxivSearch(r.title, r.arxiv).catch(() => null);
    if (!f) f = await arxivSearch(r.title).catch(() => null);
    if (!f) f = await crossref(r).catch(() => null);
    if (f) found[r.key] = f;
  }
  // not found anywhere: final, unless Semantic Scholar was too busy to ask (then the browser asks again later)
  for (const r of refs) if (!(r.key in found)) found[r.key] = busy ? undefined : null;
  return { found, busy };
}

/* ---------- PDF download, only from public web addresses ---------- */
function privateIP(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return privateIP(l.slice(7));
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('64:ff9b') || l.startsWith('2001:db8');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}
export async function publicUrl(u) {
  let url; try { url = new URL(u); } catch (e) { return null; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  if (url.port && !['80', '443'].includes(url.port)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|localdomain|home|lan)$/i.test(host)) return null;
  if (process.env.PL_ALLOW_HOSTS && process.env.PL_ALLOW_HOSTS.split(',').includes(host)) return url;   // tests only
  let addrs; try { addrs = await dns.lookup(host, { all: true }); } catch (e) { return null; }
  if (!addrs.length || addrs.some(a => privateIP(a.address))) return null;
  if (/(^|\.)arxiv\.org$/.test(host)) url.protocol = 'https:';
  return url;
}
async function fetchPdf(u) {
  let url = await publicUrl(u);
  for (let hop = 0; hop < 6 && url; hop++) {
    const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'application/pdf,*/*;q=0.5' }, signal: AbortSignal.timeout(40000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = await publicUrl(new URL(r.headers.get('location'), url).href); continue; }
    if (!r.ok) return { error: `The PDF’s website answered ${r.status}.`, status: 502 };
    if (+(r.headers.get('content-length') || 0) > MAX_PDF) return { error: 'That PDF is too large.', status: 413 };
    const rd = r.body.getReader(), chunks = []; let n = 0;
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      n += value.length; if (n > MAX_PDF) { rd.cancel().catch(() => {}); return { error: 'That PDF is too large.', status: 413 }; }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF')) return { error: 'That link leads to a web page, not a PDF.', status: 415 };
    return { bytes };
  }
  return { error: 'That PDF link isn’t allowed.', status: 400 };
}

export default {
  async fetch(req) {
    if (!authed(req)) return denied();
    const url = new URL(req.url);
    if (req.method === 'GET' && url.searchParams.get('pdf')) {
      const part = Math.max(0, parseInt(url.searchParams.get('part') || '0', 10) || 0);
      let r;
      try { r = await fetchPdf(url.searchParams.get('pdf')); }
      catch (e) { return json({ error: 'Couldn’t download that PDF.' }, 502); }
      if (r.error) return json({ error: r.error }, r.status);
      const parts = Math.ceil(r.bytes.length / PART);
      if (part >= parts) return json({ error: 'No such part.' }, 416);
      return new Response(r.bytes.subarray(part * PART, (part + 1) * PART), {
        headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-parts': String(parts), 'x-size': String(r.bytes.length) },
      });
    }
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    let b; try { b = await req.json(); } catch (e) { return json({ error: 'Bad request.' }, 400); }
    const refs = (Array.isArray(b.refs) ? b.refs : []).slice(0, 12).map(r => ({
      key: String(r.key || '').slice(0, 40), title: String(r.title || '').slice(0, 400), year: String(r.year || '').slice(0, 8),
      doi: String(r.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().slice(0, 200),
      arxiv: String(r.arxiv || '').replace(/^arxiv:/i, '').replace(/v\d+$/, '').trim().slice(0, 40),
    })).filter(r => r.key).map(r => { const m = r.doi.match(/^10\.48550\/arxiv\.(.+)$/i); return m && !r.arxiv ? { ...r, arxiv: m[1] } : r; });
    return json(await lookup(refs));
  },
};
