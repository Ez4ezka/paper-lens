// Questions across papers: what was asked, and AI topic tags so similar questions group together.
import { chat, currentModel, menuModels } from './ai.js';

// The question sent when someone selects something and presses "Just explain".
export const EXPLAIN = 'Explain what I selected.';

// The questions the person actually typed in a thread (skipping the automatic "explain" prompt).
export function askedIn(t) {
  return (t.turns || []).filter((m, i) => m.role === 'user' && !(i === 0 && m.content === EXPLAIN)).map(m => m.content);
}
// One line that names the thread: its first typed question, or what was selected.
export function threadTitle(t) {
  const q = askedIn(t)[0];
  if (q) return q;
  const sel = (t.sel || '').replace(/\s+/g, ' ').trim();
  return sel ? `Explain: “${sel.length > 120 ? sel.slice(0, 120) + '…' : sel}”` : (t.sh ? `Explain a selection on page ${t.page}` : 'Question about the paper');
}
export function firstAnswer(t) {
  const a = (t.turns || []).find(m => m.role === 'assistant');
  return a ? a.content : '';
}
// Markdown and LaTeX to a short plain-text preview.
export function plain(s, n = 240) {
  const t = String(s || '').replace(/\$\$[\s\S]*?\$\$/g, ' [equation] ').replace(/\$([^$\n]+)\$/g, '$1')
    .replace(/[#*_`>]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n).replace(/\s\S*$/, '') + '…' : t;
}
export const needsTopic = t => !t.deleted && !t.topic && (t.turns || []).some(m => m.role === 'assistant');

// Tagging is a tiny job, so use a small, cheap model from the same provider when one is in the menu.
function taggingModel() {
  const m = currentModel();
  if (!m) return null;
  const cheap = menuModels(m.provider).find(x => /haiku|mini|flash|nano|lite/i.test(x.id));
  return cheap ? { provider: m.provider, id: cheap.id } : m;
}

/**
 * Give each question a short topic. items: [{ key, paper, question, sel, answer }].
 * existing: topics already in use, so new questions reuse them. Returns { key: topic }.
 */
export async function tagQuestions(items, existing = []) {
  const model = taggingModel();
  if (!model) throw new Error('Pick an AI model in Settings first.');
  const out = {};
  for (let i = 0; i < items.length; i += 30) {
    const batch = items.slice(i, i + 30);
    const known = [...new Set([...existing, ...Object.values(out)])];
    const list = batch.map(it => ({
      key: it.key, paper: it.paper.slice(0, 120), question: it.question.slice(0, 400),
      selection: (it.sel || '').slice(0, 200), answer_start: plain(it.answer, 300),
    }));
    const system = `You sort a reader's questions about research papers into topics, so related questions from different papers end up together.

Rules:
- Give every question exactly one topic: 1 to 3 words, Title Case, naming the concept or subject it is about (for example "Attention", "Loss Functions", "Kalman Filters", "Experimental Setup", "Notation").
- Broad enough that several questions can share a topic, specific enough to be useful. Not the paper's title.
- Reuse an existing topic whenever it fits, spelled exactly the same.${known.length ? `\n- Existing topics: ${known.map(t => JSON.stringify(t)).join(', ')}` : ''}
- Reply with only a JSON object mapping each key to its topic, nothing else.`;
    const r = await chat({ system, model, turns: [{ role: 'user', content: JSON.stringify(list) }] });
    const m = r.text.match(/\{[\s\S]*\}/);
    let j = {};
    try { j = m ? JSON.parse(m[0]) : {}; } catch (e) {}
    for (const it of batch) {
      const t = typeof j[it.key] === 'string' ? j[it.key].replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      if (t) out[it.key] = t;
    }
  }
  return out;
}
