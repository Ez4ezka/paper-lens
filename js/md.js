// Tiny Markdown renderer that leaves LaTeX untouched for MathJax.
import { esc } from './util.js';

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>');
}

export function md(src) {
  const math = [];
  src = String(src || '').replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$/g, m => { math.push(m); return '\u0001' + (math.length - 1) + '\u0002'; });
  const out = [];
  let list = null, para = [], code = null;
  const flushP = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushL = () => { if (list) { out.push(`<${list.t}>` + list.items.map(i => '<li>' + inline(i) + '</li>').join('') + `</${list.t}>`); list = null; } };
  for (const raw of esc(src).split('\n')) {
    if (code !== null) {
      if (/^\s*```/.test(raw)) { out.push('<pre><code>' + code.join('\n') + '</code></pre>'); code = null; }
      else code.push(raw);
      continue;
    }
    const l = raw.trim();
    let m;
    if (/^```/.test(l)) { flushP(); flushL(); code = []; continue; }
    if (!l) { flushP(); flushL(); continue; }
    if ((m = l.match(/^#{1,6}\s+(.*)/))) { flushP(); flushL(); out.push('<h4>' + inline(m[1]) + '</h4>'); continue; }
    if ((m = l.match(/^(?:[-*•])\s+(.*)/))) { flushP(); if (!list || list.t !== 'ul') { flushL(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = l.match(/^\d+[.)]\s+(.*)/))) { flushP(); if (!list || list.t !== 'ol') { flushL(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if (/^\u0001\d+\u0002$/.test(l)) { flushP(); flushL(); out.push('<div class="eq">' + l + '</div>'); continue; }
    flushL(); para.push(l);
  }
  if (code !== null) out.push('<pre><code>' + code.join('\n') + '</code></pre>');
  flushP(); flushL();
  return out.join('').replace(/\u0001(\d+)\u0002/g, (_, i) => esc(math[+i]));
}

export function typeset(el) {
  const M = window.MathJax;
  if (M && M.typesetPromise) M.typesetPromise([el]).catch(() => {});
  else setTimeout(() => { const M2 = window.MathJax; if (M2 && M2.typesetPromise) M2.typesetPromise([el]).catch(() => {}); }, 1500);
}
