import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FINISHED_KEEP_MS, readCodexWorkers } from '../server/desk/source-agentctl.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
let dir: string;

function task(project: string, name: string, status: Record<string, unknown>, lastMessage?: string): void {
  const at = path.join(dir, project, name);
  fs.mkdirSync(at, { recursive: true });
  if (lastMessage !== undefined) {
    fs.writeFileSync(path.join(at, 'codex-001.last-message.md'), lastMessage);
    status = { ...status, worker: { ...(status.worker as object), lastMessagePath: path.join(at, 'codex-001.last-message.md') } };
  }
  fs.writeFileSync(path.join(at, 'status.json'), JSON.stringify({ project, task: name, ...status }));
}

describe('agentctl Codex workers', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctl-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists each task under the conversation that dispatched it, with what state it is in', async () => {
    const recent = new Date(NOW - 60_000).toISOString();
    task('tango', 'rules-engine', { parentThread: 'loom:card', status: 'worker_running', branch: 'codex/rules-engine', codexAccount: 'acme', updatedAt: recent, worker: { status: 'running', startedAt: recent } });
    task('tango', 'counts-tests', { parentThread: 'loom:card', status: 'review', updatedAt: new Date(NOW - 120_000).toISOString(), worker: { status: 'succeeded' } }, 'Added 14 tests.\n\nAll green.');
    task('tango', 'broken', { parentThread: 'loom:desk', status: 'worker_failed', updatedAt: recent, worker: { status: 'failed' } });
    task('tango', 'no-parent', { status: 'worker_running', updatedAt: recent, worker: { status: 'running' } });
    task('tango', 'discarded', { parentThread: 'loom:card', status: 'discarded', updatedAt: recent, worker: { status: 'succeeded' } });
    task('tango', 'old', { parentThread: 'loom:card', status: 'review', updatedAt: new Date(NOW - FINISHED_KEEP_MS - 1).toISOString(), worker: { status: 'succeeded' } });

    const workers = await readCodexWorkers(dir, NOW);
    expect([...workers.keys()].sort()).toEqual(['loom:card', 'loom:desk']);
    expect(workers.get('loom:card')!.map((w) => [w.id, w.state])).toEqual([
      ['agentctl:tango/rules-engine', 'working'],
      ['agentctl:tango/counts-tests', 'finished'],
    ]);
    expect(workers.get('loom:card')![0]).toMatchObject({ branch: 'codex/rules-engine', account: 'acme', lastMessage: null });
    expect(workers.get('loom:card')![1]!.lastMessage).toBe('Added 14 tests. All green.');
    expect(workers.get('loom:desk')![0]!.state).toBe('failed');
  });

  it('reads nothing when agentctl never ran', async () => {
    expect((await readCodexWorkers(path.join(dir, 'missing'), NOW)).size).toBe(0);
  });
});
