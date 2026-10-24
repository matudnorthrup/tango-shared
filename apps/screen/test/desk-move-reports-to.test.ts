import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT, cid, makeHarness, msg, NOW, type Harness } from './desk-harness.js';
import { snowflakeAt } from '../server/discord.js';

// Moving a reporting conversation validates against its destination before either write.
describe('moving a worker and its reports-to relation', () => {
  let h: Harness;
  const id = (n: number) => `discord:thread:${n}`;
  const act = (n: number, type: 'project' | 'role', args: Record<string, unknown>) => h.core.command({ commandId: cid(), type, itemId: id(n), args });
  const into = (n: number, projectId: string, parentItemId?: string) => act(n, 'project', { projectId, ...(parentItemId ? { parentItemId } : {}) });
  beforeEach(async () => {
    h = makeHarness();
    h.core.store.setSetting('projects', JSON.stringify([
      { id: 'top', name: 'Top', createdAt: 1 },
      { id: 'child', name: 'Child', createdAt: 2, parent: 'project:top' },
      { id: 'other', name: 'Other', createdAt: 3 },
      { id: 'empty', name: 'Empty', createdAt: 4 },
    ]));
    h.discord.threads = [8001, 8002, 8003, 8004].map((n) => ({ id: String(n), name: `T${n}`, parent_id: AGENT.homeChannelId, last_message_id: snowflakeAt(NOW + 365 * 86400000) }));
    for (const n of [8001, 8002, 8003, 8004]) h.discord.channels.set(String(n), [msg(-3, 'owner', 'Go'), msg(-1, 'agent', 'Done.')]);
    await h.source.poll();
    await into(8001, 'top');
    await into(8002, 'top');
    await into(8003, 'other');
    await into(8004, 'other');
    await act(8002, 'role', { role: 'default' });
    await act(8003, 'role', { role: 'default' });
    await act(8001, 'role', { role: 'worker', parentItemId: id(8002) });
  });
  afterEach(() => h.close());

  it('keeps an owner in the enclosing project, with no adapter write', async () => {
    const write = vi.fn();
    Object.assign(h.source, { setRole: write });
    expect(await into(8001, 'child')).toMatchObject({ status: 'applied', outcome: { projectId: 'child' } });
    expect(h.core.item(id(8001))!.facts.parentItemId).toBe(id(8002));
    expect(write).not.toHaveBeenCalled();
  });

  it('re-points to a sibling space’s lead, and returns both parents for undo', async () => {
    const write = vi.fn();
    Object.assign(h.source, { setRole: write });
    expect(await into(8001, 'other')).toMatchObject({ status: 'applied', outcome: { parentItemId: id(8003), previousParentItemId: id(8002) } });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ id: id(8001) }), 'worker', id(8003));
    await into(8001, 'other');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('has no owner and shows ownerGone when the destination has no lead', async () => {
    expect(await into(8001, 'empty')).toMatchObject({ status: 'applied', outcome: { parentItemId: null, previousParentItemId: id(8002) } });
    expect(h.core.item(id(8001))!.facts).toMatchObject({ parentItemId: null, ownerGone: true });
  });

  it('undo restores an ownerless worker even when its original space gains a lead', async () => {
    await into(8001, 'empty');
    const moved = await into(8001, 'other');
    expect(moved).toMatchObject({ status: 'applied', outcome: { previousParentItemId: null } });
    await into(8002, 'empty');
    const write = vi.fn();
    Object.assign(h.source, { setRole: write });
    expect(await act(8001, 'project', { projectId: 'empty', parentItemId: null })).toMatchObject({ status: 'applied' });
    expect(h.core.item(id(8001))!.facts).toMatchObject({ projectId: 'empty', parentItemId: null });
    expect(h.core.roles.get(id(8001)).parentItemId).toBeNull();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ id: id(8001) }), 'worker', null);
  });

  it('accepts an explicit null parent on an ordinary thread move', async () => {
    expect(await act(8004, 'project', { projectId: 'top', parentItemId: null })).toMatchObject({ status: 'applied' });
    expect(h.core.item(id(8004))!.facts.projectId).toBe('top');
  });

  it('finishing out keeps an owner in No project', async () => {
    h.core.ensureItem({ id: 'loom:personal', source: 'loom', kind: 'thread', conversationKey: 'personal', agentId: 'loom', agentName: 'Loom', place: 'Personal', createdAt: 1 }, 'agent');
    await into(8001, 'child');
    await act(8001, 'role', { role: 'worker', parentItemId: 'loom:personal' });
    const write = vi.fn();
    Object.assign(h.source, { setRole: write });
    await h.core.projectAction('child', { action: 'finish', how: 'out' });
    expect(h.core.item(id(8001))!.facts).toMatchObject({ projectId: 'top', parentItemId: 'loom:personal' });
    expect(write).not.toHaveBeenCalled();
  });

  it('finishing out keeps an owner in the enclosing space', async () => {
    await into(8001, 'child');
    const write = vi.fn();
    Object.assign(h.source, { setRole: write });
    await h.core.projectAction('child', { action: 'finish', how: 'out' });
    expect(h.core.item(id(8001))!.facts).toMatchObject({ projectId: 'top', parentItemId: id(8002) });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([[8001, 8004], [8004, 8001]])('finishing out keeps an owner that leaves in the same finish (worker %i, owner %i)', async (worker, owner) => {
    await act(8001, 'role', { role: 'interactive' });
    await into(8001, 'child');
    await into(8004, 'child');
    await act(worker, 'role', { role: 'worker', parentItemId: id(owner) });
    const write = vi.fn();
    Object.assign(h.source, { setRole: write });
    await h.core.projectAction('child', { action: 'finish', how: 'out' });
    expect(h.core.item(id(worker))!.facts).toMatchObject({ projectId: 'top', parentItemId: id(owner) });
    expect(h.core.item(id(owner))!.facts).toMatchObject({ projectId: 'top' });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([true, false])('finishing out replaces an owner left working behind (lead: %s)', async (hasLead) => {
    await into(8001, 'child');
    await into(8004, 'child');
    await act(8001, 'role', { role: 'worker', parentItemId: id(8004) });
    h.core.store.patchItem(id(8004), { nextStep: 'working' });
    if (!hasLead) await act(8002, 'role', { role: 'interactive' });
    const write = vi.fn();
    Object.assign(h.source, { setRole: write });
    const parentItemId = hasLead ? id(8002) : null;
    expect(await h.core.projectAction('child', { action: 'finish', how: 'out' })).toMatchObject({ stayed: 1 });
    expect(h.core.item(id(8001))!.facts).toMatchObject({ projectId: 'top', parentItemId, ...(!hasLead ? { ownerGone: true } : {}) });
    expect(h.core.roles.get(id(8001)).parentItemId).toBe(parentItemId);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ id: id(8001) }), 'worker', parentItemId);
  });

  it('refuses an out-of-reach explicit owner without moving, for every actor', async () => {
    const result = await h.core.command({ commandId: cid(), type: 'project', itemId: id(8001), actor: 'agent', args: { projectId: 'other', parentItemId: id(8002) } });
    expect(result.status).toBe('failed');
    expect(h.core.item(id(8001))!.facts).toMatchObject({ projectId: 'top', parentItemId: id(8002) });
  });

  it('sets an explicit valid owner, and refuses self and a parent for a thread', async () => {
    expect(await into(8001, 'other', id(8004))).toMatchObject({ status: 'applied', outcome: { parentItemId: id(8004) } });
    expect((await into(8001, 'other', id(8001))).status).toBe('failed');
    expect(await into(8004, 'top', id(8002))).toMatchObject({ status: 'failed', error: 'only a worker or job reports to a conversation' });
  });

  it('revises the worker row when only its owner changes within the same project', async () => {
    await into(8004, 'top');
    const before = h.core.item(id(8001))!.revision;
    expect(await into(8001, 'top', id(8004))).toMatchObject({ status: 'applied', outcome: { parentItemId: id(8004) } });
    expect(h.core.item(id(8001))!.revision).toBeGreaterThan(before);
  });

  it('null project resolves to the agent space and accepts an owner picked there', async () => {
    h.core.setFacts(id(8004), { projectId: null });
    const space = h.core.spaceOfItem(h.core.item(id(8004))!);
    expect(space).toBe(`agent:${AGENT.id}`);
    expect(h.core.reportTargetError(id(8004), space)).toBeNull();
    expect(await act(8001, 'project', { projectId: null, parentItemId: id(8004) })).toMatchObject({ status: 'applied' });
    expect(h.core.spaceOfItem(h.core.item(id(8001))!)).toBe(space);
    expect(h.core.item(id(8001))!.facts.parentItemId).toBe(id(8004));
  });

  it('leaves both relations unchanged when Loom refuses its write', async () => {
    Object.assign(h.source, { setRole: vi.fn().mockRejectedValue(new Error('write refused')) });
    expect((await into(8001, 'other')).status).toBe('failed');
    expect(h.core.item(id(8001))!.facts).toMatchObject({ projectId: 'top', parentItemId: id(8002) });
  });
  it('follow moves into a project, and does not move for an enclosing owner', async () => {
    expect(await act(8001, 'role', { role: 'ops', parentItemId: id(8003), follow: true })).toMatchObject({ status: 'applied', outcome: { movedTo: 'project:other' } });
    expect(h.core.item(id(8001))!.facts).toMatchObject({ projectId: 'other', role: 'ops', parentItemId: id(8003), projectPickedUpAt: null });
    await into(8001, 'child', id(8002));
    const result = await act(8001, 'role', { role: 'worker', parentItemId: id(8002), follow: true });
    expect(result.status).toBe('applied');
    expect(result.outcome).not.toHaveProperty('movedTo');
    expect(h.core.item(id(8001))!.facts.projectId).toBe('child');
  });

  it('follow moves a Loom conversation into an agent space', async () => {
    h.core.ensureItem({ id: 'loom:personal', source: 'loom', kind: 'thread', conversationKey: 'personal', agentId: 'loom', agentName: 'Loom', place: 'Personal', createdAt: 1 }, 'agent');
    h.core.setFacts(id(8004), { projectId: null });
    const result = await h.core.command({ commandId: cid(), type: 'role', itemId: 'loom:personal', actor: 'agent', args: { role: 'ops', parentItemId: id(8004), follow: true } });
    expect(result).toMatchObject({ status: 'applied', outcome: { movedTo: `agent:${AGENT.id}` } });
    expect(h.core.spaceOfItem(h.core.item('loom:personal')!)).toBe(`agent:${AGENT.id}`);
  });

  it('refuses a Discord move to another agent before any write', async () => {
    h.core.ensureItem({ id: 'loom:other', source: 'loom', kind: 'thread', conversationKey: 'other', agentId: 'loom', agentName: 'Loom', place: 'Other', createdAt: 1 }, 'agent');
    h.core.setFacts('loom:other', { agentSpace: { id: 'helper', name: 'Helper' } });
    const write = vi.fn();
    Object.assign(h.source, { setRole: write });
    expect((await act(8001, 'role', { role: 'ops', parentItemId: 'loom:other', follow: true })).status).toBe('failed');
    expect(write).not.toHaveBeenCalled();
    expect(h.core.item(id(8001))!.facts).toMatchObject({ projectId: 'top', role: 'worker', parentItemId: id(8002) });
  });

  it('follow writes nothing when the destination is gone or the adapter refuses', async () => {
    const write = vi.fn().mockRejectedValue(new Error('refused'));
    Object.assign(h.source, { setRole: write });
    expect((await act(8001, 'role', { role: 'ops', parentItemId: 'missing', follow: true })).status).toBe('failed');
    expect(write).not.toHaveBeenCalled();
    expect((await act(8001, 'role', { role: 'ops', parentItemId: id(8003), follow: true })).status).toBe('failed');
    expect(h.core.item(id(8001))!.facts).toMatchObject({ projectId: 'top', role: 'worker', parentItemId: id(8002) });
  });

});
