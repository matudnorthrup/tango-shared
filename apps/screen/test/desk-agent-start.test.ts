import { describe, expect, it } from 'vitest';
import { AgentStart } from '../server/desk/agent-start.js';
// @ts-expect-error plain browser module, no types
import { createStore } from '../public/desk/store.js';

// Start work on a named agent: one bot call that opens a thread in the agent's home channel, and the
// sheet's first chip switching between a repo and an agent.

const agents = [{ id: 'sierra', name: 'Sierra', homeChannelId: 'c-sierra' }];

function service(answer: { ok: true; threadId: string } | { ok: false; error: string } = { ok: true, threadId: 't-1' }) {
  const sent: Array<Record<string, unknown>> = [];
  const svc = new AgentStart({ agents: () => agents, startInBot: async (body) => (sent.push(body), answer) });
  return { svc, sent };
}

describe('starting a thread with an agent', () => {
  it('asks the bot for a thread in the agent’s home channel, titled from the prompt', async () => {
    const { svc, sent } = service();
    const result = await svc.start({ agentId: 'sierra', prompt: 'Plan the coast loop. Avoid gravel.', commandId: 'cmd-1' });
    expect(result).toEqual({ ok: true, itemId: 'discord:thread:t-1', threadId: 't-1', agent: { id: 'sierra', name: 'Sierra' }, title: 'Plan the coast loop.' });
    expect(sent).toEqual([{ agentId: 'sierra', channelId: 'c-sierra', type: 'start', sceneTitle: 'Plan the coast loop.', data: { text: 'Plan the coast loop. Avoid gravel.', title: 'Plan the coast loop.' }, commandId: 'cmd-1' }]);
    // A retry with the same command id never opens a second thread.
    expect(await svc.start({ agentId: 'sierra', prompt: 'Plan the coast loop. Avoid gravel.', commandId: 'cmd-1' })).toEqual(result);
    expect(sent).toHaveLength(1);
    expect(svc.agents()).toEqual([{ id: 'sierra', name: 'Sierra' }]);
  });

  it('refuses an unknown agent or an empty prompt before calling the bot, and passes the bot’s refusal on', async () => {
    const { svc, sent } = service({ ok: false, error: 'channel c-sierra can’t hold threads' });
    expect(await svc.start({ agentId: 'nobody', prompt: 'x' })).toMatchObject({ ok: false, status: 422 });
    expect(await svc.start({ agentId: 'sierra', prompt: '  ' })).toMatchObject({ ok: false, status: 422 });
    expect(sent).toHaveLength(0);
    expect(await svc.start({ agentId: 'sierra', prompt: 'Go' })).toMatchObject({ ok: false, status: 502, error: 'channel c-sierra can’t hold threads' });
  });
});

describe('the sheet with an agent', () => {
  const options = { repos: [{ id: 'p-tango', name: 'tango', account: 'loom', mode: 'worktree' }], accounts: [{ id: 'loom', name: 'Loom', driver: 'loom' }], agents: [{ id: 'sierra', name: 'Sierra' }] };

  it('opens on the agent, switches between a repo and an agent, and starts with the agent', async () => {
    let sent: Record<string, unknown> | null = null;
    const store = createStore({ mode: 'fixtures', startWorkOptions: async () => options, startAgentThread: async (body: Record<string, unknown>) => ((sent = body), { ok: true, itemId: 'discord:thread:t', agent: { id: 'sierra', name: 'Sierra' }, title: 'Go' }), items: async () => ({ items: [] }) });
    await store.openStartWork({ agentId: 'sierra' });
    expect(store.state.startWork.form.agent).toBe('sierra');
    await store.pickStartPlace({ kind: 'repo', id: 'p-tango' });
    expect(store.state.startWork.form).toMatchObject({ agent: '', repo: 'p-tango' });
    await store.pickStartPlace({ kind: 'agent', id: 'sierra' });
    // A repo named in the words doesn't pull the sheet off the agent.
    store.setStartField('prompt', 'In tango, look at the desk logs');
    expect(store.state.startWork.form).toMatchObject({ agent: 'sierra', repoInferred: false });
    await store.submitStartWork();
    expect(sent).toMatchObject({ agentId: 'sierra', prompt: 'In tango, look at the desk logs' });
    expect(store.state.startWork).toBeNull();
  });
});
