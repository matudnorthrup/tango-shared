import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SceneStore } from '../server/store.js';
import { PrototypeStore } from '../server/prototypes.js';

let dir: string;
let scenes: SceneStore;
let prototypes: PrototypeStore;
let now: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-assets-'));
  now = 1_800_000_000_000;
  scenes = new SceneStore(dir, () => now);
  prototypes = new PrototypeStore(scenes.db, () => now);
});
afterEach(() => { scenes.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
function reopen() {
  scenes.db.close();
  scenes = new SceneStore(dir, () => now);
  prototypes = new PrototypeStore(scenes.db, () => now);
}

for (const kind of ['scene', 'prototype'] as const) describe(`${kind} Loom identity migration`, () => {
  const put = (agentId: string, conversationKey: string, name = 'main', agentName?: string) => kind === 'scene'
    ? scenes.stage({ agentId, agentName, origin: { conversationKey }, slot: name, kind: 'html', body: '<p>Preview</p>', summary: 'Synthetic preview' }).scene
    : prototypes.publish({ agentId, agentName, conversationKey, name, url: 'https://example.test/preview' }).prototype;
  const get = (id: string) => kind === 'scene' ? scenes.get(id) : prototypes.get(id);
  const clear = (id: string) => kind === 'scene' ? scenes.clear(id) : prototypes.clear(id);

  it('reattributes Loom assets, preserves genuine T3 and other agents, and is replay safe', () => {
    const legacy = put('t3', 'loom:thread', 'main', 'T3');
    const history = put('t3', 't3:thread', 'main', 'T3');
    const other = put('agent', 'loom:thread');
    const caseSensitive = put('t3', 'LOOM:thread');
    const cleared = put('t3', 'loom:thread', 'old', 'Custom title');
    clear(cleared.id);
    reopen();
    expect(get(legacy.id)).toEqual({ ...legacy, agentId: 'loom', agentName: 'Loom' });
    expect(get(history.id)).toEqual(history);
    expect(get(other.id)).toEqual(other);
    expect(get(caseSensitive.id)).toEqual(caseSensitive);
    expect(get(cleared.id)).toMatchObject({ agentId: 'loom', agentName: 'Custom title', status: 'cleared' });
    const snapshot = [legacy, history, other, cleared].map(row => get(row.id));
    reopen();
    expect([legacy, history, other, cleared].map(row => get(row.id))).toEqual(snapshot);
    const updated = put('loom', 'loom:thread');
    expect(updated.id).toBe(legacy.id);
    expect(updated.version).toBe(legacy.version + 1);
  });

  it.each(['native-newer', 'legacy-newer', 'tie'] as const)('resolves %s live collisions without deleting either row', ordering => {
    const legacy = put('t3', 'loom:collision');
    if (ordering === 'native-newer') now += 100;
    const native = put('loom', 'loom:collision');
    if (ordering === 'legacy-newer') { now += 200; put('t3', 'loom:collision'); }
    const beforeLegacy = get(legacy.id)!;
    const beforeNative = get(native.id)!;
    reopen();
    const legacyWins = ordering === 'legacy-newer';
    expect(get(legacy.id)).toMatchObject({ agentId: 'loom', status: legacyWins ? 'live' : 'cleared', updatedAt: beforeLegacy.updatedAt });
    expect(get(native.id)).toMatchObject({ agentId: 'loom', status: legacyWins ? 'cleared' : 'live', updatedAt: beforeNative.updatedAt });
    const active = kind === 'scene' ? scenes.liveForConversation('loom:collision') : prototypes.liveForConversation('loom:collision');
    expect(active.map(row => row.id)).toEqual([legacyWins ? legacy.id : native.id]);
    reopen();
    expect(get(legacy.id)?.status).toBe(legacyWins ? 'live' : 'cleared');
    expect(get(native.id)?.status).toBe(legacyWins ? 'cleared' : 'live');
  });
});

it('keeps pending input replay attached to Loom and leaves genuine T3 events alone', () => {
  const scene = scenes.stage({ agentId: 't3', origin: { conversationKey: 'loom:thread' }, kind: 'html', body: '<p>Test</p>', summary: 'Test' }).scene;
  const claim = { sceneId: scene.id, agentId: 't3', conversationKey: 'loom:thread', commandId: 'test-command', type: 'choice', data: { choice: 'yes' } };
  scenes.claimInput(claim);
  scenes.updateInput('test-command', { status: 'pending', routed: 'operator' });
  scenes.claimInput({ ...claim, conversationKey: 't3:thread', commandId: 'historic' });
  reopen();
  const replay = scenes.claimInput({ ...claim, agentId: 'loom' });
  expect(replay.created).toBe(false);
  expect(replay.event).toMatchObject({ agentId: 'loom', status: 'pending', routed: 'operator', commandId: 'test-command' });
  expect(scenes.inputByCommand('historic')).toMatchObject({ agentId: 't3', conversationKey: 't3:thread' });
});
