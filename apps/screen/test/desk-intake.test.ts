import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requestTitle } from '../server/desk/source-discord.js';
import { AGENT, cid, makeHarness, msg, type Harness } from './desk-harness.js';

// An intake channel: a website form's webhook posts requests there for an agent. Synthetic ids only.
const INTAKE = '6000';
const FORM = 'form-hook';
const intake = [{ channelId: INTAKE, agentId: AGENT.id, label: 'garden-intake', webhookIds: [FORM] }];
const form = (minutes: number, body: string) =>
  msg(minutes, 'agent', `📥 Garden request — schedule\nFrom: Pat Doe\n${body}`, { webhook_id: FORM, author: { id: FORM, bot: true, username: 'Garden Intake' } });
const person = (minutes: number, content: string) => msg(minutes, 'agent', content, { webhook_id: undefined, author: { id: '222', username: 'robin', global_name: 'Robin' } as never });

let h: Harness;
beforeEach(() => {
  h = makeHarness({}, { intake });
});
afterEach(() => h.close());

const requests = () => h.core.items().filter((item) => item.id.startsWith('discord:intake:')).sort((a, b) => a.createdAt - b.createdAt);

describe('intake channels', () => {
  it('files each request as a thread of its agent, named for what was asked', async () => {
    const first = form(-300, 'Water the beds on Tuesday');
    h.discord.channels.set(INTAKE, [first, msg(-298, 'agent', 'Done: Tuesday watering is on the schedule.'), form(-60, 'Skip mowing this week')]);
    await h.source.poll();
    const list = requests();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: `discord:intake:${INTAKE}:${first.id}`, kind: 'thread', agentId: AGENT.id, channelId: INTAKE, conversationKey: `channel:${INTAKE}`, place: 'Water the beds on Tuesday', messageCount: 2 });
    expect(list[1]!.place).toBe('Skip mowing this week');
    // The request is on the requester's side, labelled with who sent it; the agent answers.
    expect(h.core.store.messages(list[0]!.id).map((m) => [m.author, m.text.split('\n')[0]])).toEqual([
      ['owner', '**Pat Doe:** 📥 Garden request — schedule'],
      ['agent', 'Done: Tuesday watering is on the schedule.'],
    ]);
    // The agent's turn in the channel belongs to the newest request.
    h.core.agentEvent({ type: 'turn.started', agentId: AGENT.id, conversationKey: `channel:${INTAKE}`, channelId: INTAKE, turnId: 't1', at: h.clock.now });
    expect(requests().map((item) => item.nextStep === 'working')).toEqual([false, true]);
    // Requests never become the agent's home chat.
    expect(h.core.items().filter((item) => item.kind === 'chapter')).toHaveLength(0);
  });

  it('a person in the channel follows up in the same request', async () => {
    h.discord.channels.set(INTAKE, [form(-30, 'Order mulch'), msg(-28, 'agent', 'How many bags?'), person(-20, 'Ten bags please')]);
    await h.source.poll();
    const [only] = requests();
    expect(requests()).toHaveLength(1);
    expect(h.core.store.messages(only!.id).at(-1)).toMatchObject({ author: 'owner', text: '**Robin:** Ten bags please' });
  });

  it('replies into the intake channel and Done reacts without archiving', async () => {
    h.discord.channels.set(INTAKE, [form(-30, 'Order mulch'), msg(-28, 'agent', 'Ordered ten bags.')]);
    await h.source.poll();
    const [request] = requests();
    await h.core.command({ commandId: cid(), type: 'reply', itemId: request!.id, args: { text: 'thanks, make it twelve' } });
    expect(h.posted[0]).toMatchObject({ agentId: AGENT.id, channelId: INTAKE, type: 'reply' });
    await h.core.command({ commandId: cid(), type: 'done', itemId: request!.id });
    expect(h.discord.reacted).toEqual([`${INTAKE}/${request!.lastAgentMessageId}/✅`]);
    expect(h.discord.archived).toEqual([]);
  });

  it('every form post is a new request, and nothing joins a done one', async () => {
    h.discord.channels.set(INTAKE, [form(-30, 'Order mulch'), form(-29, 'Fix the gate')]);
    await h.source.poll();
    expect(requests().map((item) => item.place)).toEqual(['Order mulch', 'Fix the gate']);
    await h.core.command({ commandId: cid(), type: 'done', itemId: requests()[1]!.id });
    h.discord.push(INTAKE, person(-28, 'Also the hinge'));
    await h.source.poll();
    expect(requests()).toHaveLength(3);
  });

  it("a follow-up long after joins the open request; one that starts a request is titled by its summary, not the follow-up's words", async () => {
    // An hour after the request, past the chapter gap: still that request's follow-up.
    h.discord.channels.set(INTAKE, [form(-200, 'Trim the hedges on Friday'), msg(-199, 'agent', 'Added it.'), person(-120, 'is that a tool problem?')]);
    await h.source.poll();
    expect(requests()).toHaveLength(1);
    expect(requests()[0]!.place).toBe('Trim the hedges on Friday');
    // Once that request is done, a person's message starts a new one: no form line names it, so it has no place.
    await h.core.command({ commandId: cid(), type: 'done', itemId: requests()[0]!.id });
    h.discord.push(INTAKE, person(-10, 'one more question about the schedule'));
    await h.source.poll();
    const started = requests().at(-1)!;
    expect(requests()).toHaveLength(2);
    expect(started.place).toBeNull();
    expect(h.core.title({ ...started, summary: { title: 'Decide when the schedule goes out' } as never })).toBe('Decide when the schedule goes out');
  });

  it('titles a request past the form header', () => {
    expect(requestTitle('📥 Request — program\nFrom: Pat\nOpening remarks: Riley')).toBe('Opening remarks: Riley');
    expect(requestTitle('Just a plain question')).toBe('Just a plain question');
  });
});
