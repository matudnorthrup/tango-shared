// The catch-up in the owner's words (docs/specs/catch-up.md "Collapsing", rule 7): no bare reference ids. The owner
// doesn't track D-n, R-n, E-n, #PR or TGO-n numbers, so a title, headline, status or plan line names the thing instead.
// An id may still ride along as a link label inside an opened line's detail. Shared by the server and the desk.

// Only the trackers' issue keys: GPT-4, HTTP-2 or ISO-27001 are names, not tickets.
const TEAM = String.raw`\b(?:TGO|ACM|ENG)-\d+\b`;
const ANY_ID = String.raw`(?:\b[DRE]-\d+\b|(?:PR\s*)?#\d+\b|${TEAM})`;
// A revision tag on its own ("Plan r6", "(r3)"): which revision is the plan's bookkeeping, not the owner's.
const REVISION = /\s*\(r\d+\)|(?<=\S)\s+r\d+\b(?![-.]\d)|^r\d+\b(?![-.]\d)\s*/g;

/** A text with its bare reference ids taken out or named in words. */
export function plainWords(text) {
  if (typeof text !== 'string' || !text) return text ?? '';
  if (!new RegExp(ANY_ID).test(text) && !new RegExp(REVISION.source).test(text)) return text;
  const urls = [];
  const held = text.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)[^\s<>"']+/gi, (url) => `\uE002${urls.push(url) - 1}\uE003`);
  const out = held
    .replace(REVISION, '')
    // "(D-12)", "(#864, TGO-1105)": a parenthesis of ids alone goes.
    .replace(new RegExp(String.raw`\s*\((?:\s*${ANY_ID}\s*[,/;]?)+\)`, 'g'), '')
    // "R-15:" or "D-94 —" leading a line: the words after it say it.
    .replace(/^\s*(?:[DRE]-\d+|#\d+)\s*[:·—–-]\s*/, '')
    // Acting under a standing rule: which rule is a link inside the line, not words in its title.
    .replace(/\b(under|per|citing|by)\s+(?:standing\s+)?rule\s+R-\d+\b/gi, '$1 a standing rule')
    .replace(/\b(under|per|citing|by)\s+R-\d+\b/gi, '$1 a standing rule')
    .replace(/\brules?\s+R-\d+(?:\s*(?:,|and)\s*R-\d+)*/gi, (m) => (/,|and/.test(m) ? 'rules' : 'a rule'))
    .replace(/\bR-\d+(?:\s*(?:,|and)\s*R-\d+)+/g, 'rules')
    .replace(/\bR-\d+\b/g, 'a rule')
    .replace(/\b(?:decision|brief)\s+D-\d+\b/gi, 'the decision')
    .replace(/\bD-\d+\b/g, 'a decision')
    .replace(/\bE-\d+\b/g, '')
    .replace(/\b(?:the\s+)?PRs?\s+#\d+(?:\s*(?:,|and)\s*#\d+)*/gi, (m) => (/,|and/.test(m) ? 'the PRs' : 'the PR'))
    .replace(/(^|[\s(])#\d+\b/g, '$1the PR')
    .replace(new RegExp(String.raw`\s*${TEAM}`, 'g'), '')
    // What the replacements left behind.
    .replace(/\b(the PR|a decision|a rule)(?:\s*(?:and|,)\s*\1)+/gi, (_, noun) => /PR/i.test(noun) ? 'the PRs' : /decision/i.test(noun) ? 'the decisions' : 'the rules')
    .replace(/\b(a|the) (a|the) /gi, '$1 ')
    .replace(/\(\s*\)/g, '')
    .replace(/(^|[.!?;]\s+)[.!?;]+(?=\s|$)/g, '$1')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(?<!\.)\.\.(?!\.)/g, '.')
    .replace(/([,;:])\1+/g, '$1')
    // A label whose id was all it named ("Next: TGO-1068."): the clause goes. The boundary before it isn't consumed,
    // so two such clauses in a row both go.
    .replace(/(?<=^|[.!?;]\s*)[^.!?;:]+:\s*(?=[.!?;]|$)[.!?;]?/g, '')
    // A sentence that was only an id leaves its period behind.
    .replace(/(^|[.!?;]\s+)[.!?;]+(?=\s|$)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:·—–-]+/, '')
    // A sentence that now starts with "a rule" or "the PR" starts with a capital.
    .replace(/([.!?]\s+)(a|an|the)\b/g, (_, end, word) => `${end}${word[0].toUpperCase()}${word.slice(1)}`)
    .trim();
  return (out ? out[0].toUpperCase() + out.slice(1) : '').replace(/\uE002(\d+)\uE003/g, (_, i) => urls[Number(i)]);
}

/**
 * An opened line's detail in plain words: an id stays only where `keep(id)` says the desk can make it a link (a known
 * decision, a PR the line links to); every other id is named in words, as in a title.
 */
export function plainDetail(text, keep) {
  if (typeof text !== 'string' || !text) return text ?? '';
  const kept = [];
  const held = text.replace(new RegExp(ANY_ID, 'g'), (id) => (keep(id) ? `\uE000${kept.push(id) - 1}\uE001` : id));
  return plainWords(held).replace(/\uE000(\d+)\uE001/g, (_, i) => kept[Number(i)]);
}

/** At most `n` sentences of a text. */
export function sentences(text, n) {
  if (typeof text !== 'string') return '';
  return sentenceList(text).slice(0, n).join(' ');
}

/** A text's sentences. A period ends one only before a space or the end, so an address or a version stays whole. */
function sentenceList(text) {
  return (text.match(/\S[\s\S]*?(?:[.!?]+["”’)]*(?=\s|$)|$)/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

const count = (text) => text.split(/\s+/).filter(Boolean).length;

/**
 * At most `n` sentences and about `max` words: whole sentences first, fewer when they run long, and a cut at a word
 * only when the first sentence alone is too long.
 */
export function fit(text, n, max) {
  if (typeof text !== 'string') return '';
  const list = sentenceList(text);
  for (let k = Math.min(n, list.length); k > 0; k--) {
    const kept = list.slice(0, k).join(' ');
    if (count(kept) <= max) return kept;
  }
  return words(list[0] ?? text, max);
}

/** About `n` words: a title longer than that is cut at a word, with an ellipsis. */
export function words(text, n) {
  if (typeof text !== 'string') return '';
  const all = text.trim().split(/\s+/);
  if (all.length <= n) return text.trim();
  const kept = all.slice(0, n);
  // Not cut on a word that leads into the next ("left for the…").
  while (kept.length > 1 && /^(a|an|the|and|or|for|to|of|with|in|on|at|by|from|its|their|your)$/i.test(kept.at(-1))) kept.pop();
  return `${kept.join(' ').replace(/[,;:·—–.!?-]+$/, '')}…`;
}

/** Internal bookkeeping labels, not product versions (1.2.3) or model names (GPT-4). */
export function jargonWords(text) {
  return [...new Set(String(text ?? '').match(/\bv\d+\b(?!\.\d)|\bversion (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\b(?!\.\d)|\b(?:phase|round|step) \d+\b|\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi) ?? [])];
}
