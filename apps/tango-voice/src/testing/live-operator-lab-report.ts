/**
 * Renders a live-operator-lab output directory as one HTML page:
 *   node --import tsx apps/tango-voice/src/testing/live-operator-lab-report.ts <dir> [title]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const title = process.argv[3] ?? 'Live operator lab';
if (!dir) throw new Error('usage: live-operator-lab-report.ts <dir> [title]');

interface TimelineEvent {
  t: number;
  kind: string;
  [key: string]: unknown;
}

const esc = (value: unknown) =>
  String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function row(event: TimelineEvent): string | null {
  const at = `<td class="t">${secs(event.t)}</td>`;
  switch (event.kind) {
    case 'user.says':
      return `<tr class="user">${at}<td>You</td><td>${esc(event.text)}</td></tr>`;
    case 'operator.said':
      return `<tr class="op">${at}<td>Operator</td><td>${esc(event.text)}</td></tr>`;
    case 'delegation':
      return `<tr class="sys">${at}<td>delegation</td><td>GPT-Live asked for help · heard: “${esc(event.latestUserSpeech)}”</td></tr>`;
    case 'extracted':
      return `<tr class="sys">${at}<td>routed</td><td>${esc(JSON.stringify(event.actions))} <span class="dim">(${event.ms} ms)</span></td></tr>`;
    case 'agent.update':
      return `<tr class="agent">${at}<td>${esc(event.agent)} → ${esc(event.updateKind ?? event.kind)}</td><td>${esc(event.text)}</td></tr>`;
    case 'queue':
      return `<tr class="sys">${at}<td>queued</td><td>${esc(event.taskId)} waiting for the floor (depth ${event.depth})</td></tr>`;
    case 'release':
      return `<tr class="sys">${at}<td>released</td><td>${esc(event.agent)} update after waiting ${secs(Number(event.waitedMs))}${event.requested ? ' (user asked)' : ''}</td></tr>`;
    case 'append':
      return `<tr class="sys">${at}<td>→ ${esc(event.channel)}${event.delegationId ? '' : ' (session)'}</td><td class="dim">${esc(event.content)} <i>ack ${esc(event.ackMs)} ms</i></td></tr>`;
    case 'append.error':
    case 'extractor.error':
    case 'live.error':
    case 'scenario.error':
    case 'wait.timeout':
      return `<tr class="err">${at}<td>${esc(event.kind)}</td><td>${esc(JSON.stringify(event))}</td></tr>`;
    case 'delivered':
      return `<tr class="sys">${at}<td>delivered</td><td>${esc(event.agent)} update heard (${esc(event.how)}, ${secs(Number(event.afterMs))} after release)</td></tr>`;
    case 'delivery.retry':
    case 'delivery.dropped':
      return `<tr class="err">${at}<td>${esc(event.kind)}</td><td>${esc(event.agent)}: ${esc(event.reason ?? '')} ${esc(event.heard ?? '')}</td></tr>`;
    case 'note':
      return `<tr class="note">${at}<td>note</td><td>${esc(event.text)}</td></tr>`;
    default:
      return null;
  }
}

const files = readdirSync(dir).filter((file) => file.endsWith('.events.json')).sort();
const sections = files.map((file) => {
  const id = file.replace('.events.json', '');
  const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
    events: TimelineEvent[];
    checks: Array<{ name: string; pass: boolean; detail: string }>;
  };
  const started = data.events.find((event) => event.kind === 'live.started');
  const passed = data.checks.filter((check) => check.pass).length;
  const rows = data.events
    .map(row)
    .filter(Boolean)
    .join('\n');
  const checks = data.checks
    .map((check) => `<li class="${check.pass ? 'pass' : 'fail'}"><b>${check.pass ? 'PASS' : 'FAIL'}</b> ${esc(check.name)}<div class="dim">${esc(check.detail)}</div></li>`)
    .join('');
  return `<section id="${esc(id)}">
<h2>${esc(id)} <span class="badge ${passed === data.checks.length ? 'ok' : 'bad'}">${passed}/${data.checks.length}</span> <span class="dim">policy: ${esc(started?.policy)}</span></h2>
<audio controls preload="none" src="${esc(id)}.wav"></audio>
<p class="dim">Left channel = scripted user, right = GPT-Live operator.</p>
<ul class="checks">${checks}</ul>
<details><summary>Timeline</summary><div class="wrap"><table>${rows}</table></div></details>
</section>`;
});

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b675f;--card:#fff;--line:#e6e2d9;--ok:#2f6f5e;--bad:#a23b2c;--user:#eef4ff;--op:#eef8f3;--agent:#fff6e8}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#171614;--fg:#ece9e2;--muted:#a19c92;--card:#211f1c;--line:#34312c;--ok:#7cc4ad;--bad:#e58a7b;--user:#1d2633;--op:#1b2a24;--agent:#2d2618}}
:root[data-theme="dark"]{--bg:#171614;--fg:#ece9e2;--muted:#a19c92;--card:#211f1c;--line:#34312c;--ok:#7cc4ad;--bad:#e58a7b;--user:#1d2633;--op:#1b2a24;--agent:#2d2618}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:28px 16px 60px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:18px 0}
h2{font-size:1.1rem;margin:0 0 8px}.dim{color:var(--muted);font-size:.9em}
.badge{font-size:.8rem;padding:1px 8px;border-radius:999px;color:#fff}.badge.ok{background:var(--ok)}.badge.bad{background:var(--bad)}
audio{width:100%}.checks{padding-left:18px}.pass b{color:var(--ok)}.fail b{color:var(--bad)}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.88rem;margin-top:8px}
td{padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}td.t{color:var(--muted);white-space:nowrap}
tr.user{background:var(--user)}tr.op{background:var(--op)}tr.agent{background:var(--agent)}tr.err td{color:var(--bad)}tr.note td{font-style:italic}
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="dim">Real GPT-Live sessions (gpt-live-1, client delegation) with a synthesized user and simulated agents.</p>
${sections.join('\n')}
</main></body></html>`;

writeFileSync(join(dir, 'index.html'), html);
console.log(`wrote ${join(dir, 'index.html')} (${files.length} scenarios)`);
