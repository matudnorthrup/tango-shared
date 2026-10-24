#!/usr/bin/env node
// Compare the proposed diff with recent PR history; declarations require human review.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function declarations(body) {
  const clean = body.replace(/<!--[\s\S]*?-->/g, '');
  const section = clean.match(/^## Changes earlier work\s*\r?\n([\s\S]*?)(?=^#{1,2} |$(?![\s\S]))/m)?.[1] ?? '';
  return new Set([...section.matchAll(/^[ \t]*[-*] #([0-9]+):[ \t]*(\S[^\r\n]*)$/gm)].map(m => Number(m[1])));
}

function patchLines(patch) {
  const added = [], removed = [];
  let oldLine = 0, inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (hunk) { oldLine = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push({ text: line.slice(1), line: oldLine++ });
    else if (line.startsWith(' ')) oldLine++;
  }
  return { added, removed };
}
// Mark assertion spans, including expected values on subsequent lines. Mask
// comments, quoted text and expression-position regex literals so brackets do not
// affect balancing. This is deliberately a lexical heuristic, not a JS parser.
function assertionLines(source) {
  // The expression prefix distinguishes regex literals from division. Keep it
  // in a lookbehind so surrounding assertion brackets remain visible.
  const masked = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|(?<=(?:^|[([=,:!&|?;{}]|=>|\breturn)\s*)\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+\/[dgimsuvy]*/gm,
    text => text.replace(/[^\n]/g, ' '));
  const lines = masked.split('\n');
  const marked = new Set();
  let depth = 0, active = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = line.search(/\bexpect(?:\s*\.\s*(?:poll|soft))*\s*\(|\bassert(?:\s*\(|\s*\.)/);
    if (!active && start < 0) continue;
    const fragment = active ? line : line.slice(start);
    active = true;
    marked.add(i + 1);
    for (const char of fragment) {
      if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char)) depth--;
    }
    // A chained matcher can start on the following line after expect(...).
    const chained = lines.slice(i + 1).find(next => next.trim())?.trimStart().startsWith('.');
    if (depth <= 0 && !chained) { active = false; depth = 0; }
  }
  return marked;
}
const meaningful = line => line.trim().length >= 12 && /[\p{L}\p{N}]/u.test(line);
const normalized = lines => new Set(lines.filter(meaningful).map(line => line.trim()));
const intersection = (a, b) => [...a].filter(line => b.has(line));
const prNumber = subject => Number(subject.match(/\(#(\d+)\)$/)?.[1] ?? subject.match(/^Merge pull request #(\d+)\b/)?.[1]) || null;

export function inspect({ cwd = process.cwd(), base = 'origin/main', head = 'HEAD', body = '', number,
  windowDays = 7, now = Date.now(), eventName, author } = {}) {
  if (eventName === 'push' || author === 'dependabot[bot]') return { findings: [], missing: [], skipped: eventName === 'push' ? 'push event' : 'Dependabot PR' };
  if (!Number.isFinite(windowDays) || windowDays < 0 || !Number.isFinite(now)) throw new Error('Invalid window or clock');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } });
  const mb = git('merge-base', base, head).trim();
  const cache = new Map();
  function commit(hash) {
    if (!cache.has(hash)) {
      const [sha, time, ...subject] = git('show', '-s', '--format=%H%n%ct%n%s', hash).trimEnd().split('\n');
      const title = subject.join('\n');
      cache.set(hash, { sha, time: Number(time) * 1000, title, pr: prNumber(title) });
    }
    return cache.get(hash);
  }
  if (commit(head).title.startsWith('Revert "')) return { findings: [], missing: [], skipped: 'Revert commit' };
  const cutoff = now - windowDays * 86400000;
  const eligible = c => c.pr && c.pr !== number && c.time >= cutoff && c.time <= now && !c.title.startsWith('Revert "');
  const findings = [];
  const add = (kind, c, file, sample) => findings.push({ kind, pr: c.pr, title: c.title, file, sample });
  const changes = git('diff', '--name-status', '-z', '--no-renames', mb, head, '--').split('\0');
  for (let i = 0; i < changes.length - 1; i += 2) {
    const [status, file] = changes.slice(i, i + 2);
    const current = patchLines(git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', mb, head, '--', file));
    if (status === 'D') {
      const hash = git('log', '--first-parent', '--diff-merges=first-parent', '--no-patch', '--diff-filter=A', '-1', '--format=%H', mb, '--', file).trim();
      if (hash && eligible(commit(hash))) add('A — Deleted recent file', commit(hash), file, current.removed[0]?.text ?? '(file deleted)');
    }
    const added = normalized(current.added), removed = normalized(current.removed.map(l => l.text));
    const hashes = git('log', '--first-parent', '--diff-merges=first-parent', '--no-patch', '--since-as-filter=' + new Date(cutoff).toISOString(), '--format=%H', mb, '--', file).trim().split('\n').filter(Boolean);
    for (const hash of hashes) {
      const c = commit(hash);
      if (!eligible(c)) continue;
      // First parent also makes merge commits comparable to the mainline before their PR.
      const parents = git('rev-list', '--parents', '-n', '1', hash).trim().split(' ');
      if (parents.length < 2) continue;
      const earlier = patchLines(git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', parents[1], hash, '--', file));
      const ea = normalized(earlier.added), er = normalized(earlier.removed.map(l => l.text));
      const restored = intersection(added, er).filter(l => !ea.has(l));
      const undone = intersection(removed, ea).filter(l => !er.has(l));
      if (restored.length >= 2 && undone.length >= 2 && restored.length + undone.length >= 6) {
        add('B — Restored pre-PR lines', c, file, restored[0]);
      }
    }
    if (/(^|\/)test\//.test(file) || /\.test\.[^/]+$/.test(file)) {
      if (!current.removed.length) continue;
      const spans = assertionLines(git('show', `${mb}:${file}`));
      const assertions = current.removed.filter(l => spans.has(l.line));
      if (!assertions.length) continue;
      const blame = git('blame', '--first-parent', '--line-porcelain', mb, '--', file);
      const owners = new Map();
      for (const match of blame.matchAll(/^([a-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/gm)) owners.set(Number(match[2]), match[1]);
      const seen = new Set();
      for (const line of assertions) {
        const hash = owners.get(line.line);
        if (!hash) throw new Error(`No blame for ${file}:${line.line}`);
        const c = commit(hash);
        if (eligible(c) && !seen.has(c.pr)) { add('C — Changed recent assertions', c, file, line.text); seen.add(c.pr); }
      }
    }
  }
  const declared = declarations(body);
  return { findings, missing: [...new Set(findings.map(f => f.pr))].filter(pr => !declared.has(pr)) };
}

export function report(result) {
  if (result.skipped) return `Overwrite guard: skipped (${result.skipped}).\n`;
  const lines = ['## Overwrite guard', ''];
  for (const f of result.findings) lines.push(`- ${f.kind}: #${f.pr} — ${f.title}`, `  - File: ${JSON.stringify(f.file)}`, `  - Sample: ${JSON.stringify(f.sample.trim())}`);
  if (!result.findings.length) lines.push('No changes to earlier work found.');
  else if (!result.missing.length) lines.push('', 'All earlier PRs are declared. Review each reason against the earlier PR and its owner decision.');
  if (result.missing.length) lines.push('', 'Missing declarations. Paste and complete this section in the PR body:', '', '```markdown', '## Changes earlier work', '', ...result.missing.map(pr => `- #${pr}: <!-- Explain why, and cite the owner decision or brief that allows it. -->`), '```');
  return lines.join('\n') + '\n';
}

export function main() {
  const { values } = parseArgs({ options: { base: { type: 'string', default: 'origin/main' }, head: { type: 'string', default: 'HEAD' },
    'window-days': { type: 'string', default: '7' }, now: { type: 'string' } } });
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const result = inspect({ base: values.base, head: values.head, windowDays: Number(values['window-days']),
    now: values.now ? Date.parse(values.now) : Date.now(), body: event.pull_request?.body ?? '',
    number: event.pull_request?.number ?? event.number, author: event.pull_request?.user?.login, eventName: process.env.GITHUB_EVENT_NAME });
  const output = report(result);
  console.log(output);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, output);
  process.exitCode = result.missing.length ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`Overwrite guard failed: ${error.message}`); process.exitCode = 2; }
}
