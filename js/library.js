// Adding a PDF to the library: from a file you pick, or a cited paper found by the References tab.
import { getPaper, savePaperMeta, putPdf } from './store.js';
import { sha256Hex, canvasThumb } from './util.js';

export function guessTitle(meta, items, fileName) {
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

// Returns the paper's id, or throws with a message for the reader.
export async function addPdf(file, { name = file.name || 'paper.pdf', title = '', citedBy = null } = {}) {
  if (!window.pdfjsLib) throw new Error('The PDF reader didn’t load. Reload the page.');
  const buf = await file.arrayBuffer();
  const id = (await sha256Hex(buf)).slice(0, 24);
  let meta = await getPaper(id);
  await putPdf(id, new Blob([buf], { type: 'application/pdf' }));
  if (!meta || meta.deleted) {
    let doc;
    try { doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise; }
    catch (e) { throw new Error('Couldn’t open that PDF.'); }
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
      title: (meta && meta.title) || title || guessTitle(info, items, name),
      fileName: name, pages: doc.numPages, size: file.size,
      addedAt: (meta && meta.addedAt) || now, openedAt: now,
      counts: (meta && meta.counts) || { h: 0, t: 0 }, thumb, pdfRemote: !!(meta && meta.pdfRemote),
      ...(citedBy ? { citedBy } : {}),
    };
    doc.destroy();
    await savePaperMeta(meta, true, true);
  }
  return id;
}
