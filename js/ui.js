// Shared UI bits: model menu, sync status pill, highlight cards, small dialogs.
import { settings, saveSettings, colorOf } from './store.js';
import { PROVIDERS, menuModels, currentModel } from './ai.js';
import { syncState, syncOn } from './sync.js';
import { $, esc, timeAgo } from './util.js';

export function renderModelSelect() {
  fillModelSelect($('#modelSel'));
  const s2 = $('#modelSel2'); if (s2) fillModelSelect(s2);
}
function fillModelSelect(sel) {
  const cur = currentModel();
  const groups = Object.keys(PROVIDERS).filter(p => settings.keys[p]);
  if (!groups.length) {
    sel.innerHTML = '<option value="">Choose an AI model…</option>';
    sel.classList.add('warn');
    return;
  }
  sel.classList.remove('warn');
  sel.innerHTML = groups.map(p => {
    const ms = menuModels(p);
    if (!ms.length) return `<optgroup label="${esc(PROVIDERS[p].name)}"><option value="" disabled>Pick models in Settings</option></optgroup>`;
    return `<optgroup label="${esc(PROVIDERS[p].name)}">` + ms.map(m => `<option value="${esc(p + ':' + m.id)}">${esc(m.name)}</option>`).join('') + '</optgroup>';
  }).join('') + '<option value="__settings">Manage models…</option>';
  if (cur) sel.value = cur.provider + ':' + cur.id;
  if (cur && settings.model !== cur.provider + ':' + cur.id) { settings.model = cur.provider + ':' + cur.id; saveSettings(); }
}

export function renderSyncPill() {
  const b = $('#syncPill');
  const s = syncOn() ? syncState.status : 'off';
  const map = {
    off: ['Sync off', 'Your library is only on this device. Turn on sync in Settings to use it everywhere.'],
    idle: ['Synced', 'Saved to your GitHub library' + (syncState.at ? ' · ' + timeAgo(syncState.at) : '')],
    syncing: ['Syncing…', syncState.msg || 'Saving to GitHub'],
    error: ['Sync problem', syncState.msg],
    offline: ['Offline', syncState.msg],
  };
  const [label, title] = map[s] || map.off;
  b.hidden = false;
  b.dataset.s = s;
  b.innerHTML = `<span class="sd"></span><span class="lbl">${esc(label)}</span>`;
  b.title = title;
  b.setAttribute('aria-label', label + '. ' + title);
}

export function swatchesHTML(selected, attr = 'data-color') {
  return settings.colors.map(c => `<button type="button" class="sw" ${attr}="${c.id}" aria-pressed="${c.id === selected}" title="${esc(c.label)}" style="--c:${c.hex}"><span class="sr">${esc(c.label)}</span></button>`).join('');
}

// One highlight as a card (used on the home page and in the reader's list).
export function hlCardHTML(h, paper, { showPaper = true } = {}) {
  const c = colorOf(h.color);
  const text = (h.text || '').trim();
  return `<article class="hc" data-pid="${esc(paper.id)}" data-hid="${esc(h.id)}" style="--c:${c.hex}">
    ${h.img ? `<button type="button" class="hc-img" data-open title="Open in the paper"><img src="${h.img}" alt="Highlight from page ${h.page}" loading="lazy"></button>` : ''}
    ${text ? `<p class="hc-text${h.img ? ' small' : ''}">${esc(text.length > 420 ? text.slice(0, 420) + '…' : text)}</p>` : (h.img ? '' : '<p class="hc-text small">Capturing…</p>')}
    ${h.note ? `<p class="hc-note">${esc(h.note)}</p>` : ''}
    <footer><span class="dot"></span><span class="hc-meta">${esc(c.label)}${showPaper ? ' · <b>' + esc(paper.title) + '</b>' : ''} · p.${h.page}</span>
      <span class="hc-act"><button type="button" class="mini" data-copy>Copy</button><button type="button" class="mini" data-open>Open</button></span></footer>
  </article>`;
}

/* ---------- small dialogs (prompt / confirm replacements) ---------- */
export function askText(title, value = '', okLabel = 'Save') {
  return new Promise(res => {
    const d = document.createElement('dialog');
    d.className = 'mini-dlg';
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><input class="inp" value="${esc(value)}"><div class="row end"><button value="" class="btn">Cancel</button><button value="ok" class="btn pri">${esc(okLabel)}</button></div></form>`;
    document.body.append(d);
    d.addEventListener('close', () => { res(d.returnValue === 'ok' ? d.querySelector('input').value.trim() : null); d.remove(); });
    d.showModal();
    d.querySelector('input').select();
  });
}
export function confirmBox(title, body, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    const d = document.createElement('dialog');
    d.className = 'mini-dlg';
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3><p>${esc(body)}</p><div class="row end"><button value="" class="btn">Cancel</button><button value="ok" class="btn ${danger ? 'danger' : 'pri'}">${esc(okLabel)}</button></div></form>`;
    document.body.append(d);
    d.addEventListener('close', () => { res(d.returnValue === 'ok'); d.remove(); });
    d.showModal();
  });
}
