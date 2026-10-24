import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDesk } from '../server/desk/setup.js';
import { SceneStore } from '../server/store.js';
import { Hub } from '../server/hub.js';
import { directCodingScene } from '../server/loom-scenes.js';

describe('native Loom desk wiring', () => {
  it('keeps repo identity for implicit mail starts without T3 or a caller-supplied project resolver', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-retirement-'));
    const scenes = new SceneStore(path.join(dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    const reposFile = path.join(dir, 'repos.json');
    fs.writeFileSync(reposFile, JSON.stringify([{ name: 'map-project', path: '/repos/maps' }]));
    const desk = createDesk({
      db: scenes.db, hub, discord: null, agents: [], ownerIds: [], rules: null,
      summarize: async () => { throw new Error('No model calls in this test'); },
      postToBot: async () => 'agent', jobsDir: path.join(dir, 'jobs'),
      jobBridgeUrl: 'http://127.0.0.1:9', collaborationToken: '', log: () => {},
      githubReviews: false, systemDb: false,
      loom: { url: 'http://127.0.0.1:9', tokenFile: path.join(dir, 'token') },
      startWorkReposFile: reposFile,
    });
    try {
      const start = vi.spyOn(desk.routes.startWork!.service, 'start').mockResolvedValue({ ok: false, error: 'Captured without launching' });
      for (const [id, repo, expected] of [['nested', '/repos/maps/subdir', 'map-project'], ['boundary', '/repos/maps-other', 'maps-other']]) {
        (desk.loom as unknown as { ingest(detail: unknown): void }).ingest({
          thread: { id, title: 'Owner thread', repo, cwd: '/worktrees/isolated', status: 'idle', created_at: 1, updated_at: 2, settled_at: null },
          messages: [{ id: `${id}:owner`, role: 'user', text: 'Build a map', created_at: 1 }], runs: [], requests: [],
        });
        expect(desk.core.item(`loom:${id}`)?.facts.project?.name).toBe(expected);
        await desk.mail.start({ from: `loom:${id}`, prompt: 'Add a legend' });
        expect(start.mock.calls.at(-1)?.[0]).toMatchObject({ repo: expected });
      }
    } finally {
      desk.close();
      hub.close();
      scenes.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('retired scene input', () => {
  it('refuses before a live voice operator can reinterpret a retained scene tap', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-scene-'));
    const scenes = new SceneStore(dir);
    const fallback = vi.fn(async () => 'failed:T3 is retired; use Loom');
    const hub = new Hub(scenes, fallback, () => {}, undefined, undefined, { direct: directCodingScene });
    const events: string[] = [];
    hub.addDirector({ send: (event) => { events.push(event); } });
    try {
      const { scene } = scenes.stage({ agentId: 't3', kind: 'html', body: '<p>Old decision</p>', summary: 'Retired scene', origin: { conversationKey: 't3:retired' } });
      const result = await hub.input({ sceneId: scene.id, type: 'reply', data: { text: 'Proceed' } });
      expect(result).toMatchObject({ status: 'failed', routed: 'failed:T3 is retired; use Loom' });
      expect(fallback).toHaveBeenCalledOnce();
      expect(events).not.toContain('input');
    } finally {
      hub.close(); scenes.db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
