// The desk's session trace as text, one line per entry, for pasting into a diagnosis.
//
//   npx tsx apps/screen/scripts/desk-trace.ts --since 15m
//   npx tsx apps/screen/scripts/desk-trace.ts --session                 # since the latest voice session started
//   npx tsx apps/screen/scripts/desk-trace.ts --since 2026-10-06T14:00 --until 2026-10-06T14:20 --sources operator,hub
//   npx tsx apps/screen/scripts/desk-trace.ts --since 1h --kinds view,presentation,render --json
//
// Options:
//   --url <base>       the screen service (default $DESK_TRACE_URL, else http://127.0.0.1:9410)
//   --since <t>        15m | 2h | 1d | 14:00 (today) | epoch ms | ISO time (default 15m)
//   --until <t>        same forms
//   --session          start at the latest voice session (looks back 24 h unless --since is earlier)
//   --sources a,b      operator, desk, hub, screen, owner
//   --kinds a,b        a kind or its family ("presentation" matches presentation.changed, …)
//   --limit <n>        newest n entries in the window (default 2000)
//   --data             add each entry's data as compact JSON
//   --json             the raw entries as JSON
//
// Read-only: it only GETs /api/desk/trace.

interface Entry {
  seq: number;
  at: number;
  source: string;
  kind: string;
  summary: string;
  data: Record<string, unknown>;
  sessionId: string | null;
}

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (inline !== undefined) args.set(name, inline);
    else if (next !== undefined && !next.startsWith('--')) {
      args.set(name, next);
      i += 1;
    } else args.set(name, 'true');
  }
  return args;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function delta(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  return `+${Math.round(ms / 60_000)}m`;
}

function formatEntries(entries: Entry[], options: { data?: boolean } = {}): string {
  const lines: string[] = [];
  let day = '';
  entries.forEach((entry, index) => {
    const date = new Date(entry.at).toDateString();
    if (date !== day) {
      day = date;
      lines.push(`── ${date} ──`);
    }
    const prev = entries[index - 1];
    const gap = prev ? delta(entry.at - prev.at) : '';
    let line = `${clock(entry.at)} ${gap.padStart(7)} ${entry.source.padEnd(8)} ${entry.kind.padEnd(26)} ${entry.summary}`;
    if (options.data && Object.keys(entry.data).length) line += `  ${JSON.stringify(entry.data)}`;
    lines.push(line);
  });
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help') || args.has('h')) {
    console.log('usage: desk-trace.ts [--url http://127.0.0.1:9410] [--since 15m] [--until t] [--session] [--sources a,b] [--kinds a,b] [--limit n] [--data] [--json]');
    return;
  }
  const base = (args.get('url') ?? process.env.DESK_TRACE_URL ?? 'http://127.0.0.1:9410').replace(/\/$/, '');
  const query = new URLSearchParams();
  const session = args.has('session');
  query.set('since', args.get('since') ?? (session ? '24h' : '15m'));
  if (args.get('until')) query.set('until', args.get('until')!);
  if (session) query.set('session', 'latest');
  if (args.get('sources')) query.set('sources', args.get('sources')!);
  if (args.get('kinds')) query.set('kinds', args.get('kinds')!);
  query.set('limit', args.get('limit') ?? '2000');
  let response: Response;
  try {
    response = await fetch(`${base}/api/desk/trace?${query}`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    console.error(`desk-trace: ${base} did not answer (${(err as Error).message})`);
    process.exit(2);
  }
  if (response.status === 404) {
    console.error(`desk-trace: ${base} has no /api/desk/trace (is the desk on? SCREEN_DESK=v2)`);
    process.exit(2);
  }
  if (!response.ok) {
    console.error(`desk-trace: HTTP ${response.status} ${await response.text()}`);
    process.exit(2);
  }
  const body = (await response.json()) as { entries: Entry[]; since: number | null; sessionStart: number | null };
  if (args.has('json')) {
    console.log(JSON.stringify(body.entries, null, 2));
    return;
  }
  const from = body.since ? new Date(body.since).toISOString() : 'the beginning';
  console.log(`# desk trace from ${from}${session ? (body.sessionStart ? ' (latest voice session)' : ' (no voice session found; last 24 h)') : ''}: ${body.entries.length} entries`);
  if (body.entries.length) console.log(formatEntries(body.entries, { data: args.has('data') }));
}

void main();
