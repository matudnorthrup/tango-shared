#!/usr/bin/env node
// Measure Loom's Claude token burn from the transcripts Loom keeps under
// ~/.tango/loom/claude-projects, by day and by thread.
//
//   node scripts/loom-burn.mjs [--since 2026-10-10] [--days] [--threads N] [--json out.json] [--codex] [--accounts path]
//
// One model call is one requestId (a transcript writes a line per content
// block, so lines are deduplicated on it). "input" is every token the model
// read: uncached + cache creation + cache read. Threads are named from
// loom.sqlite; a transcript directory ending in loom-<8 hex> belongs to the
// thread whose id starts with those 8 characters.
import { createReadStream, readFileSync, existsSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const since = opt('--since', '2026-10-10');
const topThreads = Number(opt('--threads', '25'));
const jsonOut = opt('--json');
const codexTotals = [];

const root = opt('--root', join(homedir(), '.tango/loom/claude-projects'));
const db = opt('--db', join(homedir(), '.tango/loom/loom.sqlite'));
const sinceMs = Date.parse(`${since}T00:00:00`);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith('.jsonl') && s.mtimeMs >= sinceMs) out.push(p);
  }
  return out;
}

const titles = new Map();
try {
  const rows = execFileSync('sqlite3', ['-separator', '\t', db, 'select id, coalesce(title, ""), role from threads'], { encoding: 'utf8' });
  for (const line of rows.trim().split('\n')) {
    const [id, title, role] = line.split('\t');
    titles.set(id.slice(0, 8), { id, title, role });
  }
} catch {}

// Every run, so a model call can be charged to whatever started its run.
const runsByKey = new Map();
const classify = (source, text) => {
  if (source === 'wake') {
    if (text.startsWith('Loom: the trigger you set fired')) return /codex/i.test(text) ? 'wake:codex-review' : 'wake:trigger';
    if (text.startsWith('A background task finished')) return 'wake:background-task';
    if (text.startsWith('Loom: the wait timed out')) return 'wake:timeout';
    if (text.includes('"Next')) return 'wake:next-nudge';
    return 'wake:other';
  }
  if (source === 'user') {
    if (text.startsWith('✉️ Mail from')) return 'mail:in';
    if (text.startsWith('✉️ Reply from')) return 'mail:reply';
    return 'owner';
  }
  return source;
};
try {
  const rows = execFileSync('sqlite3', ['-separator', '\t', db,
    `select thread_id, source, replace(replace(substr(text,1,400),char(10),' '),char(9),' '), coalesce(started_at, created_at), coalesce(ended_at, 9e15) from runs where created_at >= ${sinceMs - 864e5} order by 4`],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  for (const line of rows.trim().split('\n')) {
    const [tid, source, text, start, end] = line.split('\t');
    const key = tid.slice(0, 8);
    if (!runsByKey.has(key)) runsByKey.set(key, []);
    runsByKey.get(key).push({ cause: classify(source, text), start: Number(start), end: Number(end) });
  }
} catch {}
const causeOf = (key, ms) => {
  const runs = runsByKey.get(key);
  if (!runs) return 'unattributed';
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].start <= ms) return ms <= runs[i].end + 60e3 ? runs[i].cause : 'unattributed';
  return 'unattributed';
};
const causes = new Map();

const threadKey = (file) => {
  const rel = file.slice(root.length + 1);
  const m = rel.match(/loom-([0-9a-f]{8})/);
  return m ? m[1] : rel.split('/')[0];
};
const localDay = (ms) => new Date(ms).toLocaleDateString('en-CA'); // YYYY-MM-DD, local tz

const seen = new Set();
const days = new Map();
const threads = new Map();
const blank = () => ({ calls: 0, uncached: 0, write: 0, read: 0, output: 0, maxCtx: 0 });
const add = (acc, u, ctx) => {
  acc.calls++;
  acc.uncached += u.input_tokens ?? 0;
  acc.write += u.cache_creation_input_tokens ?? 0;
  acc.read += u.cache_read_input_tokens ?? 0;
  acc.output += u.output_tokens ?? 0;
  acc.maxCtx = Math.max(acc.maxCtx, ctx);
};

for (const file of walk(root)) {
  const key = threadKey(file);
  const sub = file.includes('/subagents/');
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const u = d.message?.usage;
    if (!u || d.type !== 'assistant') continue;
    const id = d.requestId ?? d.message?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ms = Date.parse(d.timestamp);
    if (!(ms >= sinceMs)) continue;
    const day = localDay(ms);
    const ctx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (!days.has(day)) days.set(day, blank());
    add(days.get(day), u, ctx);
    if (!threads.has(key)) threads.set(key, { total: blank(), byDay: new Map(), sessions: new Set(), subCalls: 0 });
    const t = threads.get(key);
    add(t.total, u, ctx);
    if (!t.byDay.has(day)) t.byDay.set(day, blank());
    add(t.byDay.get(day), u, ctx);
    if (d.sessionId) t.sessions.add(d.sessionId);
    const cause = causeOf(key, ms);
    if (!causes.has(cause)) causes.set(cause, { total: blank(), byDay: new Map() });
    add(causes.get(cause).total, u, ctx);
    if (!causes.get(cause).byDay.has(day)) causes.get(cause).byDay.set(day, blank());
    add(causes.get(cause).byDay.get(day), u, ctx);
    if (sub) t.subCalls++;
  }
}

const inp = (a) => a.uncached + a.write + a.read;
const M = (n) => (n / 1e6).toFixed(1).padStart(7) + 'M';
const K = (n) => (n / 1e3).toFixed(0).padStart(5) + 'k';

console.log(`Loom Claude usage since ${since} (${seen.size} calls)\n`);
console.log('day          calls     input   cacheRd  cacheWr  uncached   output  ctx/call  read%');
for (const [day, a] of [...days].sort()) {
  console.log(`${day} ${String(a.calls).padStart(7)} ${M(inp(a))} ${M(a.read)} ${M(a.write)} ${M(a.uncached)} ${M(a.output)} ${K(inp(a) / a.calls)}  ${((100 * a.read) / inp(a)).toFixed(1)}%`);
}

console.log('\nWhat started the run each call belongs to (input M per day)\n');
console.log('cause                    total   calls  ctx/call  ' + [...days.keys()].sort().map((d) => d.slice(5).padStart(6)).join(''));
for (const [cause, c] of [...causes].sort((a, b) => inp(b[1].total) - inp(a[1].total))) {
  const perDay = [...days.keys()].sort().map((d) => (c.byDay.has(d) ? (inp(c.byDay.get(d)) / 1e6).toFixed(0) : '.').padStart(6));
  console.log(`${cause.padEnd(22)} ${M(inp(c.total))} ${String(c.total.calls).padStart(7)} ${K(inp(c.total) / c.total.calls)}  ${perDay.join('')}`);
}

const ranked = [...threads].sort((a, b) => inp(b[1].total) - inp(a[1].total));
const allDays = [...days.keys()].sort();
console.log(`\nTop ${topThreads} threads by input tokens (M per day; ctx = mean context per call)\n`);
console.log('thread    role         title                                       total  calls  ctx/call  maxCtx  sess  ' + allDays.map((d) => d.slice(5)).join('  '));
for (const [key, t] of ranked.slice(0, topThreads)) {
  const info = titles.get(key) ?? { title: key.replace(/^-Users-[^-]+-/, ''), role: '(dir)' };
  const perDay = allDays.map((d) => {
    const a = t.byDay.get(d);
    return a ? (inp(a) / 1e6).toFixed(0).padStart(5) : '    .';
  });
  console.log(`${key.slice(0, 8).padEnd(9)} ${String(info.role).padEnd(12)} ${String(info.title).slice(0, 42).padEnd(42)} ${M(inp(t.total))} ${String(t.total.calls).padStart(6)} ${K(inp(t.total) / t.total.calls)} ${K(t.total.maxCtx)} ${String(t.sessions.size).padStart(5)}  ${perDay.join(' ')}`);
}

if (args.includes('--codex')) {
  const accountsPath = opt('--accounts', join(homedir(), '.tango/loom/accounts.json'));
  const accounts = JSON.parse(readFileSync(accountsPath, 'utf8')).codex?.accounts ?? [];
  console.log(`\nCodex usage since ${since} (all rollouts in each configured account; cached input is included in input)\n`);
  console.log('account          day          calls       input      cached      output');
  // Homes may share or link one sessions folder: each physical rollout is charged once, to the first account listing it.
  const counted = new Set();
  for (const account of accounts) {
    const home = account.home.replace(/^~(?=\/|$)/, homedir());
    const sessions = join(home, 'sessions');
    const byDay = new Map();
    if (!existsSync(sessions)) continue;
    for (const file of walk(sessions)) {
      const real = realpathSync(file);
      if (counted.has(real)) continue;
      counted.add(real);
      let previous = null;
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
        const total = event.payload.info?.total_token_usage;
        if (!total) continue;
        // token_count can repeat after a quota update or resume: charge only cumulative growth.
        const delta = Object.fromEntries(['input_tokens', 'cached_input_tokens', 'output_tokens'].map(k => [k, Math.max(0, (total[k] ?? 0) - (previous?.[k] ?? 0))]));
        previous = total;
        const ms = Date.parse(event.timestamp);
        if (!(ms >= sinceMs) || !Object.values(delta).some(n => n > 0)) continue;
        const day = localDay(ms);
        const a = byDay.get(day) ?? { calls: 0, input: 0, cached: 0, output: 0 };
        a.calls++; a.input += delta.input_tokens; a.cached += delta.cached_input_tokens; a.output += delta.output_tokens;
        byDay.set(day, a);
      }
    }
    for (const [day, total] of [...byDay].sort()) {
      codexTotals.push({ account: account.name, day, ...total });
      console.log(`${account.name.padEnd(16)} ${day} ${String(total.calls).padStart(6)} ${String(total.input).padStart(11)} ${String(total.cached).padStart(11)} ${String(total.output).padStart(11)}`);
    }
  }
}

if (jsonOut) {
  const out = {
    since,
    ...(args.includes('--codex') ? { codex: codexTotals } : {}),
    causes: Object.fromEntries([...causes].map(([k, c]) => [k, { ...c.total, input: inp(c.total), byDay: Object.fromEntries([...c.byDay].map(([d, a]) => [d, { ...a, input: inp(a) }])) }])),
    days: Object.fromEntries([...days].map(([d, a]) => [d, { ...a, input: inp(a) }])),
    threads: ranked.map(([key, t]) => ({
      key,
      ...(titles.get(key) ?? {}),
      total: { ...t.total, input: inp(t.total) },
      sessions: [...t.sessions],
      subagentCalls: t.subCalls,
      byDay: Object.fromEntries([...t.byDay].map(([d, a]) => [d, { ...a, input: inp(a) }])),
    })),
  };
  writeFileSync(jsonOut, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${jsonOut}`);
}
