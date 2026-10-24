// Replays the router's addressed judgment ("For me?", addressee.ts) on real utterances labeled by
// scripts/voice-operator/review-addressee.mjs: how often the router would ask on speech that was
// meant for the operator, and how much of the stray speech it would stop.
//
//   npx tsx src/testing/replay-addressee.ts [--review DIR] [--operator ID] [--concurrency 6] [--limit N]
//
// The router sees the speech, the seven utterances before it and how long the owner had been quiet;
// not the tasks, threads or desk of the time (the logs don't keep them).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOperatorProfiles, resolveProfileAgents, selectOperatorProfile } from '../live/operator-profile.js';
import { chiefOfStaff } from '../live/live-operator.js';
import { createCodexResponsesCaller } from '../live/responses-caller.js';
import { createTaskExtractor, type OperatorAction } from '../live/task-extractor.js';
import { addresseeNames, isUnsureMarker, namesSomeone } from '../live/addressee.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1]! : fallback;
};
const reviewDir = flag('review', path.join(os.homedir(), '.agentic-workflow/artifacts/live-operator-lab/addressee-review'));
const concurrency = Number(flag('concurrency', '6'));
const limit = Number(flag('limit', '0'));

interface Turn {
  session: string;
  n: number;
  text: string;
  reply: string;
  actions: string[];
  quietMs: number | null;
  ownerQuietMs: number | null;
}
interface Label {
  session: string;
  n: number;
  addressed: string;
  kind: string;
  harm: string;
}

const readJsonl = <T>(file: string): T[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
const turns = readJsonl<Turn>(path.join(reviewDir, 'turns.jsonl'));
const labels = new Map(readJsonl<Label>(path.join(reviewDir, 'labels.jsonl')).map((label) => [`${label.session}#${label.n}`, label]));
const bySession = new Map<string, Turn[]>();
for (const turn of turns) (bySession.get(turn.session) ?? bySession.set(turn.session, []).get(turn.session)!).push(turn);

// The only configured operator, or the one named with --operator.
const profile = selectOperatorProfile(loadOperatorProfiles(), flag('operator', '') || undefined);
const { agents } = resolveProfileAgents(profile);
const names = addresseeNames(agents);
const extractor = createTaskExtractor(createCodexResponsesCaller(), { people: profile.people });

let cases = turns.filter((turn) => turn.actions.length > 0 && labels.has(`${turn.session}#${turn.n}`));
if (limit) cases = cases.slice(0, limit);
console.log(`${cases.length} routed utterances to replay`);

type Outcome = 'acts' | 'asks' | 'quiet' | 'error';
const results: Array<{ turn: Turn; label: Label; outcome: Outcome; actions: OperatorAction[] }> = [];

async function replay(turn: Turn): Promise<void> {
  const label = labels.get(`${turn.session}#${turn.n}`)!;
  const before = bySession.get(turn.session)!.filter((other) => other.n < turn.n).slice(-7);
  const transcript = before.flatMap((other) => [`User: ${other.text}`, ...(other.reply ? [`Operator: ${other.reply.slice(0, 300)}`] : [])]);
  let actions: OperatorAction[] = [];
  let outcome: Outcome;
  try {
    actions = await extractor({ agents, tasks: [], transcript, latestUserSpeech: turn.text, now: Date.now(), defaultAgentId: chiefOfStaff(agents)?.id, quiet: { ownerMs: turn.ownerQuietMs, anyMs: turn.quietMs } });
    const work = actions.filter((action) => action.type !== 'none');
    if (!work.length) outcome = 'quiet';
    else if (actions.some(isUnsureMarker) && !namesSomeone(turn.text, names)) outcome = 'asks';
    else outcome = 'acts';
  } catch (error) {
    outcome = 'error';
    console.error(`${turn.session}#${turn.n}: ${(error as Error).message}`);
  }
  results.push({ turn, label, outcome, actions });
  if (results.length % 50 === 0) console.log(`${results.length} done`);
}

const queue = [...cases];
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (queue.length) await replay(queue.shift()!);
}));

const cold = (turn: Turn) => turn.ownerQuietMs === null || turn.ownerQuietMs >= 45_000;
const table: Record<string, Record<Outcome, number>> = {};
for (const result of results) {
  const key = `${result.label.addressed === 'yes' ? 'meant for it' : 'not for it / unclear'} · ${cold(result.turn) ? 'after a silence' : 'mid-session'}`;
  table[key] ??= { acts: 0, asks: 0, quiet: 0, error: 0 };
  table[key]![result.outcome] += 1;
}
console.table(table);
fs.writeFileSync(
  path.join(reviewDir, 'replay.jsonl'),
  results.map((result) => JSON.stringify({ session: result.turn.session, n: result.turn.n, text: result.turn.text, ownerQuietMs: result.turn.ownerQuietMs, addressed: result.label.addressed, kind: result.label.kind, harm: result.label.harm, outcome: result.outcome, actions: result.actions })).join('\n') + '\n',
);
console.log(`wrote ${path.join(reviewDir, 'replay.jsonl')}`);
