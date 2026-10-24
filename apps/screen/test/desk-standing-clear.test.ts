import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deskStatus } from '../server/desk/status.js';
import { AGENT, cid, makeHarness, msg, NOW, type Harness } from './desk-harness.js';
let h: Harness;
beforeEach(() => { h = makeHarness(); });
afterEach(() => h.close());
function lead(id = 'loom:lead') {
  h.core.ensureItem({ id, source: 'loom', kind: 'thread', conversationKey: id, agentId: 'test', agentName: 'Test', createdAt: NOW - 1000, facts: { role: 'default', handoff: { owner: 'none', text: 'Finished', at: NOW - 500 } } }, 'agent');
  return id;
}
const done = (id: string) => h.core.command({ commandId: cid(), type: 'done', itemId: id });
describe('standing conversations', () => {
  it('Done clears a default in place; Undo restores unread and Finished; newer handoffs finish again', async () => {
    const id = lead();
    expect(deskStatus(h.core.item(id)!, NOW).pill).toBe('finished');
    const before = h.core.item(id)!;
    const result = await done(id);
    expect(result.outcome).toMatchObject({ cleared: true });
    expect(h.core.item(id)).toMatchObject({ disposition: 'active', seen: 'seen', doneAt: null, attentionUpdatedAt: before.attentionUpdatedAt });
    expect(deskStatus(h.core.item(id)!, NOW).pill).toBe('idle');
    await h.core.command({ commandId: cid(), type: 'undo', itemId: id, args: { seq: result.outcome!.seq } });
    expect(h.core.item(id)!.seen).toBe('new');
    expect(deskStatus(h.core.item(id)!, NOW).pill).toBe('finished');
    await done(id);
    h.core.setFacts(id, { handoff: { owner: 'none', text: 'Another result', at: NOW + 1 } });
    expect(deskStatus(h.core.item(id)!, NOW + 1).pill).toBe('finished');
  });
  it('closes handoff asks but leaves open briefs in Needs you', async () => {
    const id = lead();
    h.core.setFacts(id, { openAsk: { text: 'Review it', at: NOW - 10 }, openBrief: { kind: 'question', question: 'Pick a direction', brief: { id: 'D-test' } } });
    await done(id);
    expect(h.core.item(id)!.facts.openAsk).toBeNull();
    expect(deskStatus(h.core.item(id)!, NOW).pill).toBe('needs');
  });
  it('keeps snoozed and parked defaults in their place', async () => {
    for (const type of ['park', 'snooze'] as const) {
      const id = lead(`loom:${type}`);
      await h.core.command({ commandId: cid(), type, itemId: id, args: { trigger: 'desk' } });
      await done(id);
      expect(h.core.item(id)!.disposition).toBe(type === 'park' ? 'parked' : 'snoozed');
    }
  });
  it('refuses source settlement and sweep drop; a demoted thread still files', async () => {
    const id = lead();
    h.core.settle(id, { done: true, summarize: false });
    expect(h.core.item(id)!.disposition).toBe('active');
    const sweep = await h.core.command({ commandId: cid(), type: 'sweep', itemId: id, args: { decision: 'drop' } });
    expect(sweep.outcome).toMatchObject({ skipped: true });
    h.core.roles.set(id, { role: 'interactive' }, 'owner', NOW);
    await done(id);
    expect(h.core.item(id)!.disposition).toBe('done');
  });
  it('latest chapter clears with a checkmark and no archive; idle leaves it open; newer chapter quietly supersedes', async () => {
    h.discord.channels.set(AGENT.homeChannelId, [msg(-5, 'agent', 'First report')]);
    await h.source.poll();
    const id = h.core.items()[0]!.id;
    await done(id);
    expect(h.core.item(id)).toMatchObject({ disposition: 'active', seen: 'seen' });
    expect(h.discord.reacted).toHaveLength(1);
    expect(h.discord.archived).toEqual([]);
    h.clock.now = NOW + 40 * 60_000;
    expect(h.core.tick().settled).toEqual([]);
    expect(h.core.item(id)!.disposition).toBe('active');
    await h.core.command({ commandId: cid(), type: 'unseen', itemId: id });
    h.discord.push(AGENT.homeChannelId, msg(40, 'agent', 'Next report'));
    await h.source.poll();
    expect(h.core.item(id)).toMatchObject({ disposition: 'done', seen: 'new' });
    expect(h.discord.reacted).toHaveLength(1);
    expect(h.core.store.eventsFor(id).some(e => e.type === 'chapter.superseded')).toBe(true);
  });
  it('files an older chapter left active at upgrade while keeping the latest open', async () => {
    h.discord.channels.set(AGENT.homeChannelId, [msg(-50, 'agent', 'Earlier report')]);
    await h.source.poll();
    const old = h.core.items()[0]!.id;
    h.discord.push(AGENT.homeChannelId, msg(-5, 'agent', 'Latest report'));
    await h.source.poll();
    const latest = h.core.items().find(i => i.id !== old)!.id;
    // Simulate a pre-upgrade older chapter which was still active.
    h.core.store.saveAttention({ ...h.core.attention(old), disposition: 'active', doneAt: null });
    h.clock.now = NOW + 40 * 60_000;
    expect(h.core.tick().settled).toContain(old);
    expect(h.core.item(old)!.disposition).toBe('done');
    expect(h.core.item(latest)!.disposition).toBe('active');
  });
  it('retries the original Clear write-back without reading or closing newer asks', async () => {
    h.close();
    const cutoffs: unknown[] = [];
    h = makeHarness({ adapters: [{ owns: () => true, done: async () => ({ outcome: 'ok' }), reply: async () => ({ ok: true }), clear: async item => {
      cutoffs.push(item.facts.clearedAt);
      return cutoffs.length === 1 ? { outcome: 'failed', error: 'offline' } : { outcome: 'ok' };
    } }] });
    const id = lead();
    const original = await done(id);
    expect(original.outcome!.writeback).toMatchObject({ outcome: 'failed' });
    const retryClearSeq = original.outcome!.seq;
    h.clock.now += 1000;
    const ask = { text: 'Review new work', at: h.clock.now };
    h.core.setFacts(id, { openAsk: ask, handoff: { owner: 'you', text: ask.text, at: ask.at } });
    await h.core.command({ commandId: cid(), type: 'unseen', itemId: id });
    const retry = () => h.core.command({ commandId: cid(), type: 'done', itemId: id, args: { retryClearSeq } });
    expect(await retry()).toMatchObject({ status: 'applied', outcome: { retried: true, writeback: { outcome: 'ok' } } });
    expect(cutoffs).toEqual([NOW, NOW]);
    expect(h.core.item(id)).toMatchObject({ seen: 'new', facts: { clearedAt: NOW, openAsk: ask } });
    expect(deskStatus(h.core.item(id)!, h.clock.now).pill).toBe('needs');
    expect(h.core.store.eventsFor(id).filter(e => e.type === 'clear')).toHaveLength(1);
    await h.core.command({ commandId: cid(), type: 'undo', itemId: id, args: { seq: retryClearSeq } });
    expect(await retry()).toMatchObject({ status: 'failed' });
    expect(cutoffs).toHaveLength(2);
  });
  it('migration restores filed defaults as read once and excludes finished projects', async () => {
    const id = lead();
    h.core.importDecision(id, 'done', {});
    await h.core.migrateStanding(id);
    expect(h.core.item(id)).toMatchObject({ disposition: 'active', seen: 'seen' });
    await h.core.command({ commandId: cid(), type: 'unseen', itemId: id });
    await h.core.migrateStanding(id);
    expect(h.core.item(id)!.seen).toBe('new');
    const ended = lead('loom:ended');
    h.core.setFacts(ended, { projectId: 'ended' });
    h.core.store.setSetting('projects', JSON.stringify([{ id: 'ended', name: 'Ended', finishedAt: NOW }]));
    h.core.importDecision(ended, 'done', {});
    await h.core.migrateStanding(ended);
    expect(h.core.item(ended)!.disposition).toBe('done');
  });
  it('voice and source reaction commands clear, and client args cannot impersonate project Finish', async () => {
    const id = lead();
    for (const actor of ['voice', 'owner'] as const) {
      const result = await h.core.command({ commandId: cid(), type: 'done', itemId: id, actor, args: { fromSource: actor === 'owner', finishProject: true } });
      expect(result.outcome).toMatchObject({ cleared: true });
      expect(h.core.item(id)!.disposition).toBe('active');
    }
  });
  it('weekly sweep never offers standing rows', async () => {
    const id = lead();
    await h.core.command({ commandId: cid(), type: 'park', itemId: id });
    h.core.tick();
    h.clock.now += 14 * 86_400_000;
    expect(h.core.tick().sweep).not.toContain(id);
  });
  it('failed source recovery is retried and never marks the migration complete', async () => {
    h.close();
    let attempts = 0;
    h = makeHarness({ adapters: [{ owns: () => true, done: async () => ({ outcome: 'ok' }), reply: async () => ({ ok: true }), restoreStanding: async () => { if (++attempts === 1) throw new Error('offline'); } }] });
    const id = lead();
    h.core.importDecision(id, 'done', {});
    await expect(h.core.migrateStanding(id)).rejects.toThrow('offline');
    expect(h.core.item(id)!.disposition).toBe('done');
    await h.core.migrateStanding(id);
    expect(attempts).toBe(2);
    expect(h.core.item(id)).toMatchObject({ disposition: 'active', seen: 'seen' });
  });
  it('project Finish still files its default', async () => {
    const id = lead();
    h.core.store.setSetting('projects', JSON.stringify([{ id: 'p', name: 'Project' }]));
    h.core.setFacts(id, { projectId: 'p' });
    await h.core.projectAction('p', { action: 'finish', how: 'done' });
    expect(h.core.item(id)!.disposition).toBe('done');
  });
});
