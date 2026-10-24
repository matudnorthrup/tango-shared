import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from 'vitest';
import { LoomStore } from '../src/store.js';
import { LoomHost } from '../src/host.js';
import { FakeRuntime } from './fake-runtime.js';
import { STALL_WAKE_TEXTS, MISSING_HANDOFF_WAKE_TEXT, RERECORD_ASK_WAKE_TEXT, wakeCause } from '../src/handoff.js';
import { askLintWake } from '../src/ask-lint.js';

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });
async function setup() {
  const store = new LoomStore(':memory:');
  const runtime = new FakeRuntime(store);
  const host = new LoomHost(store, { fake: runtime });
  close.push(async () => { await host.closeAll(); store.close(); });
  const started = await host.execute({ type: 'submit', commandId: 'start', cwd: '/repo', provider: 'fake', text: 'Make the export' });
  return { store, runtime, host, id: started.threadId! };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const ask = 'Export the project to the archive';

it('stores every wake cause, derives legacy corrections at the detail boundary, and leaves triggers alone', async () => {
  const { store, host, id } = await setup();
  const corrections = [...STALL_WAKE_TEXTS, RERECORD_ASK_WAKE_TEXT, askLintWake('decision', 'Choose the color')!, askLintWake('verification', 'Check the page')!,
    'Loom: Your closing "Next — you" ("Export the project") is still open from before. Say "still open" instead of repeating it. (Delegation board: ask once.)',
    'Loom: your closing "Next — you" points at a decision that is already closed. D-1 is settled.'];
  for (const text of corrections) {
    expect(wakeCause(text)).toBe('corrective');
    const run = store.createRun(id, 'wake', text);
    expect(run.wake_cause).toBe('corrective');
    store.db.prepare('UPDATE runs SET wake_cause = NULL WHERE id = ?').run(run.id);
    expect(host.detail(id)!.runs.find(r => r.id === run.id)!.wake_cause).toBe('corrective');
  }
  for (const text of ['Loom: the trigger you set fired: worker idle', 'A message from another session.', 'Please say still open']) {
    expect(store.createRun(id, 'wake', text).wake_cause).toBe('trigger');
  }
  expect(askLintWake('repeat', ask)).toBeNull();
});

it.each([...STALL_WAKE_TEXTS, askLintWake('decision', ask)!])('a corrective cannot replace an owner ask: %s', async text => {
  const { store, runtime, host, id } = await setup();
  runtime.last.complete(`Report with evidence.\n\nNext — you: ${ask}`);
  await flush();
  const original = store.thread(id)!.ask;
  store.createRun(id, 'wake', text);
  await host.kick(id);
  runtime.last.complete('Next — you: Export the other project instead');
  await flush();
  expect(store.thread(id)!.ask).toBe(original);
  host.rebuildAsks();
  expect(store.thread(id)!.ask).toBe(original);
});

it('a missing-handoff corrective cannot retarget an owner ask to an agent', async () => {
  const { store, runtime, host, id } = await setup();
  const agent = store.createThread({ kind: 'coding', cwd: '/repo', provider: 'fake' });
  runtime.last.complete(`Report with evidence.\n\nNext — you: ${ask}`);
  await flush();
  const original = store.thread(id)!.ask;
  store.createRun(id, 'wake', MISSING_HANDOFF_WAKE_TEXT);
  await host.kick(id);
  await host.execute({ type: 'handoff.record', commandId: crypto.randomUUID(), threadId: id,
    kind: 'agent', who: `loom:${agent.id}`, text: 'Review and integrate the finished export' });
  runtime.last.complete('The export is ready for review.');
  await flush();
  expect(store.thread(id)!.ask).toBe(original);
  host.rebuildAsks();
  expect(store.thread(id)!.ask).toBe(original);
});

it('an explicit re-record wake can change the ask; a normalized repeat preserves every original field', async () => {
  const { store, runtime, host, id } = await setup();
  runtime.last.complete(`Report.\n\nNext — you: ${ask}`);
  await flush();
  const original = store.thread(id)!.ask;
  store.createRun(id, 'wake', 'Loom: the trigger you set fired: worker idle');
  await host.kick(id);
  runtime.last.complete(`Next — you: **${ask.toUpperCase()}!**`);
  await flush();
  expect(store.thread(id)!.ask).toBe(original);
  expect(store.runs(id)).toHaveLength(2);
  store.createRun(id, 'wake', RERECORD_ASK_WAKE_TEXT);
  await host.kick(id);
  runtime.last.complete('Next — you: Export the other project instead');
  await flush();
  expect(JSON.parse(store.thread(id)!.ask!).text).toBe('Export the other project instead');
});

it('a trigger turn that changes only the link moves the ask: a new deliverable is not a repeat', async () => {
  const { store, runtime, host, id } = await setup();
  runtime.last.complete('Report.\n\nNext — you: Review the finished export at https://example.test/v1');
  await flush();
  store.createRun(id, 'wake', 'Loom: the trigger you set fired: worker idle');
  await host.kick(id);
  runtime.last.complete('Next — you: Review the finished export at https://example.test/v2');
  await flush();
  const moved = JSON.parse(store.thread(id)!.ask!);
  expect(moved.text).toContain('/v2');
  expect(moved.runId).toBe(store.runs(id)[1]!.id);
});
it('human handoffs reject fewer than four normalized words, but brief pointers pass', async () => {
  const { host, id } = await setup();
  for (const text of ['still open', '**Still** open!', 'watch https://example.test/cut', 'one two three']) {
    await expect(host.execute({ type: 'handoff.record', commandId: crypto.randomUUID(), threadId: id, kind: 'human', who: 'fixture-owner', text })).rejects.toThrow(/at least four words/);
  }
  for (const text of ['Answer D-123', 'Watch the finished cut']) {
    await expect(host.execute({ type: 'handoff.record', commandId: crypto.randomUUID(), threadId: id, kind: 'human', who: 'fixture-owner', text })).resolves.toHaveProperty('runId');
  }
});

it('migrates an older runs table without altering its historical rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-migration-'));
  const file = join(dir, 'loom.sqlite');
  let store = new LoomStore(file);
  try {
    const thread = store.createThread({ kind: 'coding', cwd: '/repo', provider: 'fake' });
    const run = store.createRun(thread.id, 'wake', RERECORD_ASK_WAKE_TEXT);
    store.db.exec('ALTER TABLE runs DROP COLUMN wake_cause');
    store.close();
    store = new LoomStore(file);
    expect(store.run(run.id)).toMatchObject({ text: RERECORD_ASK_WAKE_TEXT, wake_cause: null });
    expect(wakeCause(store.run(run.id)!.text)).toBe('corrective');
    expect(store.createRun(thread.id, 'wake', RERECORD_ASK_WAKE_TEXT).wake_cause).toBe('corrective');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
