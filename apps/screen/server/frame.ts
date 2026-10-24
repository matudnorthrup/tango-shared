import { agentColor } from './hub.js';
import { parseGoogleUrl, type GoogleRef, type GoogleSnapshot } from './google.js';
import { LINEAR_APP, parseLinearUrl, type LinearIssueRow, type LinearSnapshot, type LinearState } from './linear.js';
import type { Scene } from './store.js';

// Every scene renders as its own document at /frame/:id, inside a sandboxed
// iframe in the shell (and with a CSP sandbox header, so it stays sandboxed
// even when opened directly). Agents write whatever they like; this module adds
// a base stylesheet they can override and the `tango` bridge for live state,
// choices, and commands.

/**
 * Applied to every frame response: scripts run, but in an opaque origin. A link
 * a scene opens in a new tab escapes the sandbox, so the page it opens (a Google
 * Doc, a tshare report) gets its own origin and cookies like any other tab.
 */
export const FRAME_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-pointer-lock';

export function baseStyles(accent: string): string {
  return `
:root {
  color-scheme: dark light;
  --bg: #0e1015; --fg: #f1f3f6; --muted: #9aa3b2; --card: #181b23; --line: #2a2f3b;
  --accent: ${accent}; --good: #3ecf8e; --warn: #f5a524; --bad: #f25f5c;
  --radius: 18px;
  --font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: light) {
  :root { --bg: #f5f6f8; --fg: #14171c; --muted: #5b6474; --card: #ffffff; --line: #dde1e8; }
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--fg); }
body { font-family: var(--font); font-size: clamp(17px, 2.1vw, 30px); line-height: 1.35; padding: 3vh 4vw; }
h1 { font-size: 2em; line-height: 1.1; margin: 0 0 0.4em; }
h2 { font-size: 1.4em; margin: 0.6em 0 0.3em; }
p { margin: 0.3em 0 0.6em; }
img, video, svg, canvas, iframe { max-width: 100%; }
img, video { height: auto; }
pre { overflow-x: auto; }
body { overflow-wrap: break-word; }
/* Phones: whatever still runs wide scrolls inside itself instead of the whole page. */
@media (max-width: 640px) {
  body { padding: 2vh 4vw; }
  table { display: block; max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
}
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 1em; }
.muted { color: var(--muted); }
[data-choice] { cursor: pointer; }
.tango-choices { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 0.5em; justify-content: center; padding: 0.6em; background: linear-gradient(transparent, var(--bg) 40%); }
.tango-choices button { font: inherit; font-size: 0.9em; padding: 0.5em 1.1em; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
.tango-choices button:active { background: var(--accent); color: #000; }
.tango-link { min-height: 90vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 0.4em; }
.tango-link .tango-open { display: inline-block; margin-top: 0.8em; padding: 0.55em 1.4em; border-radius: 999px; background: var(--accent); color: #000; font-weight: 600; text-decoration: none; }
.tango-full { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; object-fit: contain; background: #000; }
`;
}

/** Safe to embed inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function bridgeScript(scene: Pick<Scene, 'id' | 'state' | 'choices'>): string {
  return `
(function () {
  var sceneId = ${scriptJson(scene.id)};
  var stateListeners = [];
  var commandListeners = [];
  function post(message) { message.sceneId = sceneId; parent.postMessage(message, '*'); }
  function report(err) { post({ type: 'error', message: String(err && err.message || err) }); }
  var tango = {
    sceneId: sceneId,
    state: ${scriptJson(scene.state)},
    choices: ${scriptJson(scene.choices)},
    onState: function (fn) { stateListeners.push(fn); try { fn(tango.state); } catch (err) { report(err); } },
    onCommand: function (fn) { commandListeners.push(fn); },
    choose: function (choiceId, label) { post({ type: 'input', input: { type: 'choice', data: { choiceId: String(choiceId), label: label } } }); },
    emit: function (type, data) { post({ type: 'input', input: { type: String(type), data: data || {} } }); }
  };
  window.tango = tango;

  // Built in for every scene: the operator scrolls it by voice ("scroll down", "back to the top").
  function scroller() {
    var root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 2) return root;
    var best = null;
    // The body counts too: app-style pages scroll it inside a fixed-height html.
    Array.prototype.forEach.call([document.body].concat(Array.prototype.slice.call(document.querySelectorAll('body *'))), function (el) {
      var style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 2) return;
      if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
    });
    return best || root;
  }
  function scrollScene(name) {
    var el = scroller();
    var page = Math.max(120, el.clientHeight * 0.8);
    var top = name === 'scroll_top' ? 0 : name === 'scroll_bottom' ? el.scrollHeight : el.scrollTop + (name === 'scroll_up' ? -page : page);
    el.scrollTo({ top: top, behavior: 'smooth' });
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var message = event.data || {};
    if (message.type === 'state') {
      tango.state = message.state;
      stateListeners.forEach(function (fn) { try { fn(message.state); } catch (err) { report(err); } });
    } else if (message.type === 'command') {
      if (/^scroll_(down|up|top|bottom)$/.test(message.name)) scrollScene(message.name);
      commandListeners.forEach(function (fn) { try { fn(message.name); } catch (err) { report(err); } });
    }
  });
  window.addEventListener('error', function (event) { report(event.message); });
  // Escape the scene didn't use for itself goes to the desk: focus in a frame keeps keys from reaching it.
  // Decided once the event has been through every handler, the scene's own included (they may be added later),
  // and never when the browser itself takes it (a modal <dialog>, a popover, full screen) without saying so.
  function nativeEscape() { if (document.fullscreenElement) return true; try { return !!document.querySelector(':modal, :popover-open:not([popover="manual"])'); } catch (_) { return false; } }
  window.addEventListener('keydown', function (event) { if (event.key !== 'Escape' || nativeEscape()) return; setTimeout(function () { if (!event.defaultPrevented) post({ type: 'key', key: 'Escape' }); }, 0); });
  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target.closest('[data-choice]') : null;
    if (!el) return;
    var heading = el.querySelector('h1, h2, h3, h4, strong, b');
    var label = (el.getAttribute('data-label') || (heading || el).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    tango.choose(el.getAttribute('data-choice'), label);
  });
})();
`;
}

function choiceBar(scene: Pick<Scene, 'choices'>): string {
  if (scene.choices.length === 0) return '';
  const buttons = scene.choices
    .map((choice) => `<button data-choice="${escapeHtml(choice.id)}" data-label="${escapeHtml(choice.label)}">${escapeHtml(choice.label)}</button>`)
    .join('');
  return `<div class="tango-choices">${buttons}</div>`;
}

/** Asset bodies are stored as "assets/<hash>.<ext>"; frames live one level down. */
export function mediaUrl(body: string): string {
  return body.startsWith('assets/') || body.startsWith('bundles/') ? `../${body}` : body;
}

function document_(scene: Scene, head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(scene.title || scene.summary)}</title>
<style>${baseStyles(agentColor(scene.agentId))}</style>
<script>${bridgeScript(scene)}</script>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

/** Shown when a Google file couldn't be read: what it is, why, and a way to open it. */
function linkCard(scene: Scene, app: string, reason?: string): string {
  const heading = scene.title || scene.summary;
  const detail = scene.title && scene.summary && scene.summary !== scene.title ? `<p class="muted">${escapeHtml(scene.summary)}</p>` : '';
  const why = reason ? `<p class="muted">Couldn't load it here: ${escapeHtml(reason)}</p>` : '';
  return `<main class="tango-link">
<p class="muted">${escapeHtml(app)}</p>
<h1>${escapeHtml(heading)}</h1>
${detail}${why}
<a class="tango-open" href="${escapeHtml(scene.body)}" target="_blank" rel="noopener">Open in ${escapeHtml(app)}</a>
</main>${choiceBar(scene)}`;
}

const GOOGLE_STYLES = `
.tango-gbar { position: fixed; top: 10px; right: 10px; z-index: 2147483647; display: flex; gap: 0.6em; align-items: center; padding: 6px 8px 6px 14px; border-radius: 999px; background: rgba(20, 23, 28, 0.82); color: #f1f3f6; font: 500 13px/1.2 ui-sans-serif, system-ui, -apple-system, sans-serif; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); }
.tango-gbar a { color: #000; background: #f1f3f6; text-decoration: none; padding: 4px 10px; border-radius: 999px; font-weight: 600; }
`;

function googleBar(scene: Scene, ref: GoogleRef, snapshot: GoogleSnapshot): string {
  const edited = new Date(snapshot.modifiedTime);
  const when = Number.isNaN(edited.getTime())
    ? ''
    : ` · edited ${edited.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  const note = snapshot.note ? ` · ${snapshot.note}` : '';
  return `<div class="tango-gbar"><span>${escapeHtml(ref.app)}${escapeHtml(when)}${escapeHtml(note)}</span><a href="${escapeHtml(scene.body)}" target="_blank" rel="noopener">Open ↗</a></div>`;
}

/**
 * A Google file read through the owner's accounts (see google.ts): a Doc as its
 * own exported page, anything else as a column of page images. On failure it
 * falls back to the open-in-Google card with the reason.
 */
export function renderGoogleFrame(scene: Scene, ref: GoogleRef, result: { snapshot: GoogleSnapshot } | { error: string }): string {
  if ('error' in result) return document_(scene, '', linkCard(scene, ref.app, result.error));
  const { snapshot } = result;
  const bar = googleBar(scene, ref, snapshot);
  if (snapshot.html !== undefined) {
    // The export is a full document with its own class styles; keep them, add the bridge and a reading layout.
    const head = `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(scene.title || snapshot.name)}</title><script>${bridgeScript(scene)}</script>
<style>${GOOGLE_STYLES}
html { background: #e8eaed; }
body.doc-content { margin: 0 auto !important; max-width: 816px !important; min-height: 100vh; box-sizing: border-box; padding: 56px 64px !important; background: #fff; }
body.doc-content img { max-width: 100% !important; height: auto !important; }
@media (max-width: 700px) { body.doc-content { padding: 52px 16px 24px !important; } }
@media (min-width: 1400px) { html { zoom: 1.35; } }
.tango-choices { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 0.5em; justify-content: center; padding: 0.6em; background: linear-gradient(transparent, #e8eaed 40%); }
.tango-choices button { font: 600 16px ui-sans-serif, system-ui, sans-serif; padding: 0.5em 1.1em; border-radius: 999px; border: 1px solid #c4c7cc; background: #fff; color: #14171c; cursor: pointer; }
</style>`;
    let html = snapshot.html;
    html = /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}${head}`) : `<head>${head}</head>${html}`;
    html = /<body(\s[^>]*)?>/i.test(html) ? html.replace(/<body(\s[^>]*)?>/i, (tag) => `${tag}${bar}`) : `${bar}${html}`;
    const tail = choiceBar(scene);
    return tail ? (/<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${tail}</body>`) : html + tail) : html;
  }
  if (snapshot.tables) {
    const numeric = /^[-+(]?[$€£¥]?\s?[\d.,]+%?\)?$/;
    const tabs = snapshot.tables
      .map((tab) => {
        const width = Math.max(1, ...tab.rows.map((row) => row.length));
        const rows = tab.rows
          .map((row, r) => {
            const cells = Array.from({ length: width }, (_, i) => row[i] ?? '');
            const tag = r === 0 ? 'th' : 'td';
            return `<tr>${cells.map((cell) => `<${tag}${numeric.test(cell.trim()) ? ' class="n"' : ''}>${escapeHtml(cell)}</${tag}>`).join('')}</tr>`;
          })
          .join('');
        const heading = tab.title && snapshot.tables!.length > 1 ? `<h2>${escapeHtml(tab.title)}</h2>` : '';
        return `<section>${heading}<div class="tango-table"><table>${rows}</table></div></section>`;
      })
      .join('\n');
    return document_(
      scene,
      `<style>${GOOGLE_STYLES}
body { padding: 56px 2vw 2vh; font-size: clamp(13px, 1.2vw, 20px); }
h2 { font-size: 1.1em; margin: 1.2em 0 0.4em; }
.tango-table { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--line); border-radius: 8px; }
.tango-table table { border-collapse: collapse; width: max-content; min-width: 100%; }
.tango-table th, .tango-table td { padding: 0.3em 0.7em; border-bottom: 1px solid var(--line); white-space: nowrap; text-align: left; }
.tango-table th { position: sticky; top: 0; background: var(--card); font-weight: 600; }
.tango-table td.n, .tango-table th.n { text-align: right; font-variant-numeric: tabular-nums; }
.tango-table tr:nth-child(even) td { background: color-mix(in srgb, var(--card) 55%, transparent); }
</style>`,
      `${bar}<main>${tabs || '<p class="muted">This sheet is empty.</p>'}</main>${choiceBar(scene)}`,
    );
  }
  const pages = (snapshot.pages ?? [])
    .map((src, i) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(`${snapshot.name}, page ${i + 1}`)}" >`)
    .join('\n');
  return document_(
    scene,
    `<style>${GOOGLE_STYLES}
body { padding: 2vh 2vw; }
.tango-pages { display: flex; flex-direction: column; align-items: center; gap: 2vh; }
.tango-pages img { width: 100%; max-width: 1600px; background: #fff; border-radius: 6px; box-shadow: 0 2px 14px rgba(0, 0, 0, 0.35); }
</style>`,
    `${bar}<main class="tango-pages">${pages}</main>${choiceBar(scene)}`,
  );
}

const LINEAR_STYLES = `
body { padding: 56px 3vw 4vh; font-size: clamp(15px, 1.3vw, 24px); }
a { color: inherit; }
.lin-eyebrow { display: flex; flex-wrap: wrap; gap: 0.35em 0.8em; align-items: center; color: var(--muted); font-size: 0.85em; margin-bottom: 0.3em; }
.lin-eyebrow a { text-decoration: none; }
h1.lin-title { font-size: 1.9em; margin: 0 0 0.35em; }
.lin-summary { color: var(--muted); font-size: 1.05em; margin: 0 0 0.8em; max-width: 50em; }
.lin-chips { display: flex; flex-wrap: wrap; gap: 0.4em; margin: 0 0 1.1em; }
.lin-chip { display: inline-flex; align-items: center; gap: 0.4em; padding: 0.2em 0.7em; border-radius: 999px; background: var(--card); border: 1px solid var(--line); font-size: 0.85em; white-space: nowrap; }
.lin-dot { width: 0.7em; height: 0.7em; border-radius: 50%; flex: none; background: var(--muted); }
.lin-dot.ring { background: transparent; border: 2px solid var(--muted); }
.lin-dot.half { background: conic-gradient(currentColor 0 50%, transparent 50% 100%); border: 2px solid currentColor; }
.lin-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(16em, 0.55fr); gap: 1.4em 2.4em; align-items: start; }
@media (max-width: 900px) { .lin-grid { grid-template-columns: minmax(0, 1fr); } }
.lin-section { margin: 0 0 1.4em; }
.lin-section > h2 { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 0.6em; }
.lin-progress { display: flex; align-items: center; gap: 0.8em; margin: 0 0 1.2em; }
.lin-bar { flex: 1; height: 0.55em; border-radius: 999px; background: var(--line); overflow: hidden; }
.lin-bar > span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
.lin-progress .lin-bar { max-width: 28em; height: 0.75em; }
.lin-pct { font-variant-numeric: tabular-nums; font-weight: 600; }
.lin-update { border-left: 4px solid var(--muted); }
.lin-update.onTrack { border-left-color: var(--good); }
.lin-update.atRisk { border-left-color: var(--warn); }
.lin-update.offTrack { border-left-color: var(--bad); }
.lin-update .lin-by { color: var(--muted); font-size: 0.85em; margin-bottom: 0.4em; }
.lin-milestone { display: grid; grid-template-columns: minmax(0, 1fr) 6em 3em; gap: 0.6em; align-items: center; padding: 0.3em 0; }
.lin-milestone .lin-pct { text-align: right; font-size: 0.85em; color: var(--muted); }
.lin-group h3 { display: flex; align-items: center; gap: 0.45em; font-size: 0.9em; margin: 0.9em 0 0.3em; }
.lin-group h3 .muted { font-weight: 400; }
.lin-rows { list-style: none; margin: 0; padding: 0; }
.lin-rows li { display: flex; align-items: baseline; gap: 0.6em; padding: 0.28em 0; border-bottom: 1px solid var(--line); font-size: 0.92em; }
.lin-rows li .lin-dot { align-self: center; }
.lin-rows .lin-id { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 0.85em; flex: none; }
.lin-rows a { text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.lin-rows .lin-who { color: var(--muted); font-size: 0.8em; flex: none; }
.lin-more { color: var(--muted); font-size: 0.85em; padding: 0.3em 0; }
details.lin-group > summary { cursor: pointer; list-style: none; }
details.lin-group > summary::-webkit-details-marker { display: none; }
.lin-comment { margin: 0 0 0.8em; }
.lin-comment .lin-by { color: var(--muted); font-size: 0.85em; margin-bottom: 0.3em; }
.md { max-width: 46em; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md h1 { font-size: 1.5em; } .md h2 { font-size: 1.25em; } .md h3 { font-size: 1.08em; }
.md ul, .md ol { padding-left: 1.4em; margin: 0.3em 0 0.6em; }
.md li { margin: 0.15em 0; }
.md code { background: var(--card); border: 1px solid var(--line); padding: 0.05em 0.3em; border-radius: 6px; font-size: 0.88em; }
.md pre { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0.8em 1em; }
.md pre code { background: none; border: 0; padding: 0; }
.md blockquote { margin: 0.5em 0; padding-left: 1em; border-left: 3px solid var(--line); color: var(--muted); }
.md table { border-collapse: collapse; } .md td, .md th { border: 1px solid var(--line); padding: 0.3em 0.6em; }
.md img { border-radius: 8px; }
.md a { color: var(--accent); }
.md details { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 0.5em 0.9em; margin: 0.5em 0; }
.md summary { cursor: pointer; font-weight: 600; }
.lin-doc { max-width: 46em; margin: 0 auto; }
.lin-doc .md { font-size: 1.08em; }
`;

/** A color from Linear, or nothing (it goes into a style attribute). */
function safeColor(color: string | undefined): string | undefined {
  return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined;
}

const STATE_ORDER = ['started', 'unstarted', 'triage', 'backlog', 'completed', 'canceled'];
const STATE_GROUP: Record<string, string> = { started: 'In progress', unstarted: 'Todo', triage: 'Triage', backlog: 'Backlog', completed: 'Done', canceled: 'Canceled' };
const GROUP_ROWS = 12;

/** Linear's state glyph, roughly: a ring for not started, half for in progress, filled for done. */
function stateDot(state: LinearState | undefined): string {
  const color = safeColor(state?.color);
  const shape = state?.type === 'started' ? ' half' : state && ['backlog', 'unstarted', 'triage'].includes(state.type) ? ' ring' : '';
  const style = color ? (shape ? ` style="color:${color};border-color:${color}"` : ` style="background:${color}"`) : '';
  return `<span class="lin-dot${shape}"${style}></span>`;
}

function shortDate(iso: string | undefined, withTime = false): string {
  if (!iso) return '';
  // Bare dates (2026-10-09) are calendar days, not UTC midnight.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', withTime ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

function external(url: string, text: string, cls = ''): string {
  return `<a${cls ? ` class="${cls}"` : ''} href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`;
}

function chip(inner: string): string {
  return `<span class="lin-chip">${inner}</span>`;
}

function issueRows(rows: LinearIssueRow[], limit = GROUP_ROWS): string {
  const items = rows
    .slice(0, limit)
    .map(
      (row) =>
        `<li>${stateDot(row.state)}<span class="lin-id">${escapeHtml(row.identifier)}</span>${external(row.url, row.title)}${row.assignee ? `<span class="lin-who">${escapeHtml(row.assignee)}</span>` : ''}</li>`,
    )
    .join('');
  const more = rows.length > limit ? `<div class="lin-more">+${rows.length - limit} more</div>` : '';
  return `<ul class="lin-rows">${items}</ul>${more}`;
}

/** Issues grouped by state type, active work first; Done and Canceled start collapsed. */
function groupedIssues(rows: LinearIssueRow[]): string {
  const groups = new Map<string, LinearIssueRow[]>();
  for (const row of rows) {
    const type = STATE_ORDER.includes(row.state?.type ?? '') ? row.state!.type : 'backlog';
    groups.set(type, [...(groups.get(type) ?? []), row]);
  }
  return STATE_ORDER.filter((type) => groups.has(type))
    .map((type) => {
      const list = groups.get(type)!.sort((a, b) => (a.priority || 5) - (b.priority || 5));
      const heading = `${stateDot(list[0]!.state)}${escapeHtml(STATE_GROUP[type]!)} <span class="muted">${list.length}</span>`;
      return type === 'completed' || type === 'canceled'
        ? `<details class="lin-group"><summary><h3>${heading}</h3></summary>${issueRows(list, 50)}</details>`
        : `<div class="lin-group"><h3>${heading}</h3>${issueRows(list)}</div>`;
    })
    .join('');
}

/** A markdown block, rendered in the page by marked (like markdown scenes). */
function markdownBlock(source: string, sources: string[]): string {
  if (!source.trim()) return '';
  sources.push(source);
  return `<div class="md" data-md="${sources.length - 1}"></div>`;
}

/** One line of inline markdown (a project's summary). */
function markdownLine(source: string, sources: string[], cls: string): string {
  if (!source.trim()) return '';
  sources.push(source);
  return `<p class="${cls}" data-md="${sources.length - 1}" data-inline>${escapeHtml(source)}</p>`;
}

const HEALTH: Record<string, string> = { onTrack: 'On track', atRisk: 'At risk', offTrack: 'Off track' };

function linearBody(snapshot: LinearSnapshot, md: string[]): string {
  if (snapshot.kind === 'document') {
    const eyebrow = [
      'Document',
      snapshot.project ? `in ${external(snapshot.project.url, snapshot.project.name)}` : '',
      snapshot.author ? escapeHtml(`updated by ${snapshot.author}`) : '',
    ].filter(Boolean);
    return `<main class="lin-doc"><div class="lin-eyebrow">${eyebrow.join('<span>·</span>')}</div><h1 class="lin-title">${escapeHtml(snapshot.title)}</h1>${markdownBlock(snapshot.content, md) || '<p class="muted">This document is empty.</p>'}</main>`;
  }
  if (snapshot.kind === 'issue') {
    const where = [snapshot.project ? external(snapshot.project.url, snapshot.project.name) : '', snapshot.milestone ? escapeHtml(snapshot.milestone) : ''].filter(Boolean).join(' › ');
    const chips = [
      snapshot.state ? chip(`${stateDot(snapshot.state)}${escapeHtml(snapshot.state.name)}`) : '',
      snapshot.priority > 0 ? chip(escapeHtml(snapshot.priorityLabel)) : '',
      snapshot.assignee ? chip(escapeHtml(snapshot.assignee)) : chip('<span class="muted">Unassigned</span>'),
      ...snapshot.labels.map((label) => chip(`<span class="lin-dot"${safeColor(label.color) ? ` style="background:${safeColor(label.color)}"` : ''}></span>${escapeHtml(label.name)}`)),
      snapshot.dueDate ? chip(escapeHtml(`Due ${shortDate(snapshot.dueDate)}`)) : '',
      snapshot.cycle ? chip(escapeHtml(snapshot.cycle)) : '',
    ].join('');
    const description = markdownBlock(snapshot.description, md);
    const comments = snapshot.comments
      .map((c) => `<div class="lin-comment card"><div class="lin-by">${escapeHtml(`${c.author} · ${shortDate(c.createdAt, true)}`)}</div>${markdownBlock(c.body, md)}</div>`)
      .join('');
    const side = [
      snapshot.parent ? `<section class="lin-section"><h2>Parent</h2>${issueRows([snapshot.parent])}</section>` : '',
      snapshot.children.length ? `<section class="lin-section"><h2>Sub-issues</h2>${issueRows(snapshot.children, 30)}</section>` : '',
      snapshot.links.length
        ? `<section class="lin-section"><h2>Links</h2><ul class="lin-rows">${snapshot.links.map((l) => `<li>${external(l.url, l.title)}</li>`).join('')}</ul></section>`
        : '',
    ].join('');
    return `<main>
<div class="lin-eyebrow"><span>${escapeHtml(snapshot.identifier)}</span>${where ? `<span>·</span><span>${where}</span>` : ''}</div>
<h1 class="lin-title">${escapeHtml(snapshot.title)}</h1>
<div class="lin-chips">${chips}</div>
<div${side ? ' class="lin-grid"' : ''}><div>
<section class="lin-section">${description || '<p class="muted">No description.</p>'}</section>
${comments ? `<section class="lin-section"><h2>Activity</h2>${comments}</section>` : ''}
</div>${side ? `<aside>${side}</aside>` : ''}</div>
</main>`;
  }
  const counted = snapshot.issues.filter((row) => row.state?.type !== 'canceled');
  const done = counted.filter((row) => row.state?.type === 'completed').length;
  const pct = Math.round(snapshot.progress * 100);
  const update = snapshot.latestUpdate;
  const health = update?.health ?? snapshot.health;
  const chips = [
    snapshot.status ? chip(`${stateDot(snapshot.status)}${escapeHtml(snapshot.status.name)}`) : '',
    health && HEALTH[health] ? chip(`<span class="lin-dot" style="background:var(--${health === 'onTrack' ? 'good' : health === 'atRisk' ? 'warn' : 'bad'})"></span>${HEALTH[health]}`) : '',
    snapshot.lead ? chip(escapeHtml(`Lead: ${snapshot.lead}`)) : '',
    snapshot.startDate || snapshot.targetDate
      ? chip(escapeHtml([shortDate(snapshot.startDate) || 'No start', shortDate(snapshot.targetDate) || 'no target'].join(' → ')))
      : '',
  ].join('');
  const summary = markdownLine(snapshot.summary, md, 'lin-summary');
  const updateBody = update ? markdownBlock(update.body, md) : '';
  const overview = markdownBlock(snapshot.content, md);
  const milestones = snapshot.milestones
    .map(
      (m) =>
        `<div class="lin-milestone"><span>${escapeHtml(m.name)}${m.targetDate ? ` <span class="muted">${escapeHtml(shortDate(m.targetDate))}</span>` : ''}</span><span class="lin-bar"><span style="width:${Math.max(0, Math.min(100, Math.round(m.progress)))}%"></span></span><span class="lin-pct">${Math.round(m.progress)}%</span></div>`,
    )
    .join('');
  const docs = snapshot.documents.map((d) => `<li>${external(d.url, d.title)}</li>`).join('');
  return `<main>
<div class="lin-eyebrow"><span>Project</span></div>
<h1 class="lin-title">${escapeHtml(snapshot.name)}</h1>
${summary}
<div class="lin-chips">${chips}</div>
<div class="lin-progress"><span class="lin-bar"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></span><span class="lin-pct">${pct}%</span><span class="muted">${done} of ${counted.length}${snapshot.moreIssues ? '+' : ''} issues done</span></div>
<div class="lin-grid"><div>
${update ? `<section class="lin-section"><h2>Latest update</h2><div class="card lin-update ${escapeHtml(update.health ?? '')}"><div class="lin-by">${escapeHtml(`${update.author} · ${shortDate(update.createdAt, true)}`)}</div>${updateBody}</div></section>` : ''}
${overview ? `<section class="lin-section"><h2>Overview</h2>${overview}</section>` : ''}
</div><aside>
${milestones ? `<section class="lin-section"><h2>Milestones</h2>${milestones}</section>` : ''}
${counted.length || snapshot.issues.length ? `<section class="lin-section"><h2>Issues</h2>${groupedIssues(snapshot.issues)}</section>` : ''}
${docs ? `<section class="lin-section"><h2>Documents</h2><ul class="lin-rows">${docs}</ul></section>` : ''}
</aside></div>
</main>`;
}

/**
 * A Linear issue, project, or document read through the owner's API keys (see
 * linear.ts), laid out in the screen's own design. On failure it falls back to
 * the open-in-Linear card with the reason.
 */
export function renderLinearFrame(scene: Scene, result: { snapshot: LinearSnapshot } | { error: string }): string {
  if ('error' in result) return document_(scene, '', linkCard(scene, LINEAR_APP, result.error));
  const { snapshot } = result;
  const md: string[] = [];
  const body = linearBody(snapshot, md);
  // Upload images are served per scene, so a cleared scene's links stop working.
  const sources = md.map((source) => source.replaceAll('](../linear/upload/', `](../linear/upload/${encodeURIComponent(scene.id)}/`));
  const edited = shortDate(snapshot.updatedAt, true);
  const bar = `<div class="tango-gbar"><span>${escapeHtml(`Linear${edited ? ` · edited ${edited}` : ''}`)}</span><a href="${escapeHtml(scene.body)}" target="_blank" rel="noopener">Open ↗</a></div>`;
  return document_(
    scene,
    `<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script><style>${GOOGLE_STYLES}${LINEAR_STYLES}</style>`,
    `${bar}${body}${choiceBar(scene)}
<script>
var sources = ${scriptJson(sources)};
// Linear text is anyone's in the workspace: keep only plain formatting, never raw HTML's scripts or handlers.
var ALLOWED = /^(P|BR|HR|H[1-6]|STRONG|B|EM|I|U|S|DEL|CODE|PRE|BLOCKQUOTE|UL|OL|LI|A|IMG|TABLE|THEAD|TBODY|TR|TH|TD|DETAILS|SUMMARY|SPAN|DIV|INPUT|SUP|SUB)$/;
function clean(node) {
  Array.prototype.slice.call(node.childNodes).forEach(function (child) {
    if (child.nodeType === 3) return;
    if (child.nodeType !== 1) { child.remove(); return; }
    if (!ALLOWED.test(child.tagName)) {
      // Unknown tags keep their text (escaped); script-bearing ones go entirely.
      if (/^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|SVG|MATH|TEMPLATE|NOSCRIPT|LINK|META|BASE|FORM)$/.test(child.tagName)) child.remove();
      else child.replaceWith(document.createTextNode(child.textContent || ''));
      return;
    }
    Array.prototype.slice.call(child.attributes).forEach(function (attr) {
      var name = attr.name.toLowerCase(), value = attr.value.trim();
      var keep = (name === 'href' && child.tagName === 'A' && /^(https?:|mailto:)/i.test(value))
        || (name === 'src' && child.tagName === 'IMG' && /^(https:|\\.\\.\\/linear\\/upload\\/)/i.test(value))
        || ((name === 'alt' || name === 'title') && !/^on/.test(name))
        || (child.tagName === 'INPUT' && (name === 'type' && value === 'checkbox' || name === 'checked' || name === 'disabled'))
        || (name === 'align' && /^(TH|TD)$/.test(child.tagName));
      if (!keep) child.removeAttribute(attr.name);
    });
    if (child.tagName === 'INPUT' && child.getAttribute('type') !== 'checkbox') { child.remove(); return; }
    clean(child);
  });
}
document.querySelectorAll('[data-md]').forEach(function (el) {
  // Linear's collapsible sections: "+++ Title" … "+++", outside code fences.
  var fence = null;
  var text = sources[Number(el.getAttribute('data-md'))].split('\\n').map(function (line) {
    var mark = /^\\s*(\x60{3,}|~{3,})/.exec(line);
    if (mark) { if (!fence) fence = mark[1].charAt(0); else if (mark[1].charAt(0) === fence) fence = null; return line; }
    if (fence) return line;
    var open = /^\\+\\+\\+[ \\t]+(.+)$/.exec(line);
    if (open) return '<details><summary>' + open[1] + '</summary>\\n';
    return /^\\+\\+\\+[ \\t]*$/.test(line) ? '\\n</details>' : line;
  }).join('\\n');
  if (!window.marked) { el.style.whiteSpace = 'pre-wrap'; el.textContent = text; }
  else {
    var parsed = new DOMParser().parseFromString('<body>' + (el.hasAttribute('data-inline') ? window.marked.parseInline(text) : window.marked.parse(text)), 'text/html').body;
    clean(parsed);
    el.replaceChildren.apply(el, Array.prototype.slice.call(parsed.childNodes));
  }
});
// Links leave the sandbox in a new tab instead of loading inside the scene.
document.querySelectorAll('.md a[href]').forEach(function (a) { a.target = '_blank'; a.rel = 'noopener'; });
</script>`,
  );
}

export function renderFrame(scene: Scene): string {
  switch (scene.kind) {
    case 'html': {
      const injected = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${baseStyles(agentColor(scene.agentId))}</style><script>${bridgeScript(scene)}</script>`;
      // A full document gets the base styles and bridge first in <head>, so its own styles win.
      if (/<head[\s>]/i.test(scene.body)) return scene.body.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}${injected}`);
      if (/<html[\s>]/i.test(scene.body)) return scene.body.replace(/<html(\s[^>]*)?>/i, (tag) => `${tag}<head>${injected}</head>`);
      return document_(scene, '', scene.body);
    }
    case 'markdown':
      return document_(
        scene,
        '<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script><style>body{max-width:60em;margin:0 auto} table{border-collapse:collapse} td,th{border:1px solid var(--line);padding:.3em .6em} code{background:var(--card);padding:.1em .3em;border-radius:6px}</style>',
        `<main id="md"></main>${choiceBar(scene)}
<script>
var source = ${scriptJson(scene.body)};
var target = document.getElementById('md');
if (window.marked) target.innerHTML = window.marked.parse(source); else { target.style.whiteSpace = 'pre-wrap'; target.textContent = source; }
</script>`,
      );
    case 'image':
      return document_(scene, '', `<img class="tango-full" src="${escapeHtml(mediaUrl(scene.body))}" alt="${escapeHtml(scene.summary)}">${choiceBar(scene)}`);
    case 'video':
      return document_(
        scene,
        '',
        `<video id="v" class="tango-full" src="${escapeHtml(mediaUrl(scene.body))}" playsinline muted controls preload="auto"></video>${choiceBar(scene)}
<script>
var video = document.getElementById('v');
tango.onCommand(function (name) {
  if (name === 'play') {
    video.muted = false;
    video.play().catch(function () { video.muted = true; return video.play(); }).catch(function () {});
  } else if (name === 'pause') video.pause();
  else if (name === 'restart') { video.currentTime = 0; video.play().catch(function () {}); }
});
</script>`,
      );
    case 'url': {
      // Without the Google reader (see renderGoogleFrame) a signed-in Google file can only be a card.
      const google = parseGoogleUrl(scene.body);
      if (google) return document_(scene, '', linkCard(scene, google.app));
      // Likewise Linear (see renderLinearFrame): linear.app refuses to be framed.
      if (parseLinearUrl(scene.body)) return document_(scene, '', linkCard(scene, LINEAR_APP));
      return document_(scene, '', `<iframe class="tango-full" src="${escapeHtml(mediaUrl(scene.body))}" allow="autoplay; fullscreen"></iframe>${choiceBar(scene)}`);
    }
  }
}
