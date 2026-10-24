// A small, safe markdown renderer for agent messages in the Conversation view. Everything is
// escaped first; only the shapes agents actually write become markup: paragraphs, ## headings,
// bullet and numbered lists (one nesting level), pipe tables, fenced code, quotes, **bold**,
// *italic*, `code`, and http(s) links (which open in a new tab). Each code block carries a Wrap
// and a Copy button (as Loom's do); a block that reads like a prompt for another agent also gets
// Start, which opens Start work with it filled in. The Conversation view handles their clicks (`data-code`).

import { linkDecisionsInHtml } from './decision-links.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ESC[c]);

/** Inline markup on an already-escaped line. */
function inline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => `\u0000${codes.push(code) - 1}\u0000`);
  out = out
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></svg>';
const WRAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18" /><path d="M3 12h15a3 3 0 1 1 0 6h-4" /><path d="m16 16-2 2 2 2" /><path d="M3 18h7" /></svg>';
const START_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>';

/** Fence languages a prompt is written in; anything else (bash, ts, json…) is code, not a prompt. */
const PROSE_LANGS = new Set(['', 'text', 'txt', 'plaintext', 'markdown', 'md', 'prompt']);

/**
 * A fenced block reads like a prompt for a new thread: no code language, more than a one-liner, and
 * mostly plain words (an untagged command and its output is flags, paths and numbers).
 */
export function promptLike(lang, code) {
  if (!PROSE_LANGS.has(String(lang || '').toLowerCase())) return false;
  const tokens = String(code).trim().split(/\s+/);
  const words = tokens.filter((t) => /^[(\["']?[A-Za-z][a-z'’-]*[)\]"',.:;!?]*$/.test(t)).length;
  return words >= 12 && words >= tokens.length * 0.6;
}

/** A fenced block (already escaped) with its toolbar. A prompt is prose, so it starts wrapped. */
function codeBlock(code, lang = '') {
  const prompt = promptLike(lang, code.replace(/&(amp|lt|gt|quot|#39);/g, (e) => Object.keys(ESC).find((c) => ESC[c] === e)));
  return `<div class="md-code${prompt ? ' wrap' : ''}"><div class="md-code-bar">${
    prompt ? `<button type="button" class="md-code-btn" data-code="start" title="Start a new thread with this prompt" aria-label="Start work with this prompt">${START_ICON}<span>Start</span></button>` : ''
  }<button type="button" class="md-code-btn" data-code="wrap" aria-pressed="${prompt}" title="Wrap lines" aria-label="Wrap lines">${WRAP_ICON}</button><button type="button" class="md-code-btn" data-code="copy" title="Copy" aria-label="Copy">${COPY_ICON}<span class="md-code-done">Copied</span></button></div><pre><code>${code}</code></pre></div>`;
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => inline(cell.trim()));

/** Markdown text → an HTML string that is safe to set as innerHTML. */
export function renderMarkdown(source) {
  const lines = escape(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    // Fenced code. A longer fence (````) holds shorter ones, as a prompt that carries its own code block does.
    const fence = line.match(/^\s*(`{3,})\s*([^\s`]*)/);
    if (fence) {
      const [, ticks, lang] = fence;
      const closes = new RegExp(`^\\s*\`{${ticks.length},}\\s*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !closes.test(lines[i])) body.push(lines[i++]);
      i += 1;
      out.push(codeBlock(body.join('\n'), lang));
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length + 1);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    // Pipe table: a header row followed by a rule row.
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) body.push(inline(lines[i++].replace(/^\s*&gt;\s?/, '')));
      out.push(`<blockquote>${body.join('<br>')}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      out.push(list(lines, i, (next) => (i = next)));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^\s*(#{1,6}\s|```|&gt;)/.test(lines[i]) && !(lines[i].includes('|') && TABLE_RULE.test(lines[i + 1] ?? ''))) para.push(inline(lines[i++].trim()));
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return linkDecisionsInHtml(out.join(''));
}

/** A list starting at `start`; items indented deeper than the first become a nested list. */
function list(lines, start, advance) {
  const first = lines[start].match(LIST);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST);
    if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
      items.push({ text: inline(m[3]), children: [] });
      i += 1;
    } else if (m && m[1].length === indent) {
      break;
    } else if (m && m[1].length > indent && items.length) {
      const nested = list(lines, i, (next) => (i = next));
      items[items.length - 1].children.push(nested);
    } else if (!m && lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
      // A wrapped continuation line.
      items[items.length - 1].text += ` ${inline(lines[i].trim())}`;
      i += 1;
    } else break;
  }
  advance(i);
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map((item) => `<li>${item.text}${item.children.join('')}</li>`).join('')}</${tag}>`;
}
