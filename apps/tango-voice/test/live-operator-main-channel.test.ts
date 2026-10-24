import { describe, expect, it } from 'vitest';
import { buildDraftCompilePrompt, createDraftCompiler } from '../src/live/draft-mode.js';
import { nameFixer } from '../src/live/known-names.js';
import { buildExtractorPrompt, createTaskExtractor, fixHeardNames, keepMainChannel, preferNamedLoom, type OperatorAction } from '../src/live/task-extractor.js';

const intoThread: OperatorAction[] = [{ type: 'dispatch', agentId: 'sierra', message: 'Please share the boat registration number.', threadId: '1000000000000000001' }];

describe('main channel routing', () => {
  it('"in our chat" drops the thread the router picked', () => {
    for (const speech of ['ask Sierra to put the registration number in our chat', 'tell Sierra in the main channel', 'send that to Sierra top level', 'ask Sierra, not in a thread']) {
      expect(keepMainChannel(speech, intoThread), speech).toEqual([{ type: 'dispatch', agentId: 'sierra', message: 'Please share the boat registration number.' }]);
    }
  });

  it('"not in that thread" is not a named thread', () => {
    expect(keepMainChannel('put it in our chat, not in that thread', intoThread)[0]).not.toHaveProperty('threadId');
    expect(keepMainChannel('main channel instead of the dock thread', intoThread)[0]).not.toHaveProperty('threadId');
  });

  it('several dispatches in one breath keep the router\'s routing', () => {
    const two: OperatorAction[] = [...intoThread, { type: 'dispatch', agentId: 'victor', message: 'Check the build.', threadId: '1000000000000000002' }];
    expect(keepMainChannel('ask Sierra in our chat, and tell Victor to check the build', two)).toBe(two);
  });

  it('also drops a new thread', () => {
    expect(keepMainChannel('ask Sierra in our chat', [{ type: 'dispatch', agentId: 'sierra', message: 'x', newThreadTitle: 'Boat' }])).toEqual([{ type: 'dispatch', agentId: 'sierra', message: 'x' }]);
  });

  it('leaves the routing alone without a cue, or when a thread is named too', () => {
    expect(keepMainChannel('ask Sierra for the boat registration number', intoThread)).toBe(intoThread);
    expect(keepMainChannel('post it in the dock lines thread, not our chat', intoThread)).toBe(intoThread);
  });

  it('the router prompt says a shared topic is not enough for a thread', () => {
    const prompt = buildExtractorPrompt({ agents: [], tasks: [], transcript: [], now: 0 } as never);
    expect(prompt).toContain('A shared topic is not enough');
    expect(prompt).toContain('thread_options');
  });

  it('the router prompt drops speech meant for someone else', () => {
    const prompt = buildExtractorPrompt({ agents: [], tasks: [], transcript: [], now: 0 } as never);
    expect(prompt).toContain('Speech not meant for the operator is none');
    expect(prompt).toContain('new Loom thread in tango');
  });

  it('the router prompt lists known people and how speech-to-text spells them', () => {
    const prompt = buildExtractorPrompt({ agents: [], tasks: [], transcript: [], now: 0, people: [{ name: 'Robin', note: 'example person', heardAs: ['Robbin'] }, { name: 'Jordan' }] } as never);
    expect(prompt).toContain('- Robin (example person), heard as "Robbin"');
    expect(prompt).toContain('- Jordan');
    expect(buildExtractorPrompt({ agents: [], tasks: [], transcript: [], now: 0 } as never)).not.toContain('People the user mentions');
  });

  it('the router prompt passes the request on without inventing access limits', () => {
    const prompt = buildExtractorPrompt({ agents: [], tasks: [], transcript: [], now: 0 } as never);
    expect(prompt).toContain('not limits of your own');
    expect(prompt).toContain('tell the agent where to look');
    expect(prompt).toContain('add no restrictions, conditions or approval steps');
    expect(prompt).toContain('exactly as said');
    expect(prompt).toContain('Keep every limit the user does say');
  });
});

describe('a named Loom thread wins', () => {
  const items = [
    { handle: 'i1', id: 'loom:aaa', place: 'harbor · epic: Field Survey Tools' },
    { handle: 'i2', id: 'loom:bbb', place: 'harbor · enh: Make Tide Tables Searchable' },
    { handle: 'i3', id: 'discord:chapter:x', place: null },
  ];
  const agents = [{ id: 'sierra', names: ['Sierra'] }, { id: 'victor', names: ['Victor'] }];
  const toSierra = (message: string): OperatorAction[] => [{ type: 'dispatch', agentId: 'sierra', message }];

  it('a thread named outright wins without "Loom" said, even when its title sounds like a role', () => {
    const named = [...items, { handle: 'i4', id: 'loom:ccc', place: 'harbor · Captain Nautilus (Opus)' }];
    const toWatson: OperatorAction[] = [{ type: 'dispatch', agentId: 'watson', message: 'Tell Captain Nautilus the build server is back.' }];
    const people = [...agents, { id: 'watson', names: ['Watson'] }];
    expect(preferNamedLoom('can you tell Captain Nautilus that the build server is back up', toWatson, named, people)[0]).toMatchObject({ type: 'desk', op: 'reply', item: 'i4' });
    // Ruled out by name: the router's choice stands; a "not" elsewhere doesn't rule it out.
    expect(preferNamedLoom("don't tell Captain Nautilus, just summarize it for me", toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom("I'm not sure, but tell Captain Nautilus the build is back", toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i4' });
    // Title words scattered, not said as a name: no override.
    const budget = [...items, { handle: 'i5', id: 'loom:ddd', place: 'harbor · Memory Budget' }];
    expect(preferNamedLoom('have someone budget more memory for that process', toWatson, budget, people)).toEqual(toWatson);
    // Not named outright (one word of a long title, no "Loom"): the router's choice stands.
    expect(preferNamedLoom('ask Sierra about field trips', toSierra('x'), named, people)).toEqual(toSierra('x'));
    expect(preferNamedLoom('tell Victor the survey is done', [{ type: 'dispatch', agentId: 'victor', message: 'x' }], named, people)[0]).toMatchObject({ type: 'dispatch', agentId: 'victor' });
  });

  it('a distinctive one-word thread title counts as a name; a short or common one does not', () => {
    const named = [...items, { handle: 'i6', id: 'loom:eee', place: 'harbor · Lighthouse' }, { handle: 'i7', id: 'loom:fff', place: 'harbor · Docs' }];
    const toWatson: OperatorAction[] = [{ type: 'dispatch', agentId: 'watson', message: 'x' }];
    const people = [...agents, { id: 'watson', names: ['Watson'] }];
    expect(preferNamedLoom('tell Lighthouse the deploy finished', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('update the docs when you can', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('ask the Loom Lighthouse thread for status', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('ask the Lighthouse thread for status', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom("don't update Lighthouse; have someone investigate instead", toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom("don't have someone update Lighthouse, investigate elsewhere", toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom("don't remind me to update Lighthouse", toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom("Lighthouse is active, but don't have someone update Lighthouse", toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Please wait. Lighthouse, post the result', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('Lighthouse is active. Have someone investigate the database', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Have Lighthouse alerts stopped?', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('The Lighthouse thread is not the right place; have someone investigate elsewhere', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom("tell Lighthouse isn't the one, ask someone else", toWatson, named, people)).toEqual(toWatson);
    // "tell Loom <word> …" stays with the router: it reads the same as "tell Loom notifications are noisy".
    expect(preferNamedLoom('tell Loom Lighthouse the deploy finished', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('I cannot tell Lighthouse yet; ask someone else', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('The message Lighthouse sent is incomplete; ask someone to investigate', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('The latest message Lighthouse sent is incomplete; ask someone to investigate', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom("tell Lighthouse's maintainer to investigate", toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('The latest ask Lighthouse made is unreasonable; have someone investigate', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('The Lighthouse thread is done; have someone investigate', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('ok, can you tell Lighthouse the deploy finished', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('Can you tell Lighthouse from Harbor apart?', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Okay, Lighthouse, post the result', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('ping Lighthouse with the result', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('send this to Lighthouse', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('The note says: wait, then tell Lighthouse the deploy finished. Have someone investigate why it appeared', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Lighthouse, read the logs', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('tell Lighthouse what the report says', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('Should I wait and then tell Lighthouse tomorrow?', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Lighthouse is available, but should I wait and then tell Lighthouse tomorrow?', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Lighthouse, the monitoring service, is healthy. Have someone investigate the database', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('I will wait and then tell Lighthouse tomorrow. Have someone investigate now', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Harbor will wait and then tell Lighthouse tomorrow. Have someone investigate now', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Harbor will wait, then tell Lighthouse tomorrow', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Wait a minute, tell Lighthouse the deploy finished', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('Hey can you tell Lighthouse the deploy finished', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('Do anything but tell Lighthouse; have someone else investigate', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('Let Lighthouse finish its current work; have someone investigate the outage', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('let Lighthouse know the deploy finished', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('Let the Lighthouse thread finish its current work; have someone investigate the outage', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('let the Lighthouse thread know the deploy finished', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('The note reads: tell Lighthouse the deploy finished. Have someone investigate why it appeared', toWatson, named, people)).toEqual(toWatson);
    expect(preferNamedLoom('ask Lighthouse whether the deployment passed', toWatson, named, people)[0]).toMatchObject({ type: 'desk', item: 'i6' });
    expect(preferNamedLoom('tell Lighthouse the build is fine, dont wait', toWatson, named, people)).toEqual(toWatson);
  });

  it('the router prompt says a role-sounding thread title is a name', () => {
    const prompt = buildExtractorPrompt({ agents: [], tasks: [], transcript: [], now: 0, desk: { items: [] } } as never);
    expect(prompt).toContain('"Captain Nautilus"');
  });

  it('the router prompt sends an unnamed follow-up on a Loom item back to that thread, and keeps approve for listed approvals', () => {
    const prompt = buildExtractorPrompt({ agents: [], tasks: [], transcript: [], now: 0, desk: { items: [] } } as never);
    expect(prompt).toContain('Answering or following up on what a Loom item just said');
    expect(prompt).toContain('a yes to a question asked in the item\'s text is desk_op reply');
  });

  it('"ask the Loom field survey tools thread…" goes to that thread, not the agent the router picked', () => {
    expect(preferNamedLoom('ask the Loom field survey tools thread why no alert went out', toSierra('Ask why no alert went out.'), items, agents)).toEqual([
      { type: 'desk', op: 'reply', item: 'i1', message: 'Ask why no alert went out.' },
    ]);
  });

  it('a stray name glued on the front does not count as addressing that agent', () => {
    expect(preferNamedLoom('Sierra uh can you tell Loom tide tables searchable that it can be cancelled', toSierra('Cancel it.'), items, agents)[0]).toMatchObject({ type: 'desk', item: 'i2' });
  });

  it('title words before the cue count; other desk actions do not block the correction', () => {
    expect(preferNamedLoom('ask the field survey tools Loom thread why no alert went out', toSierra('x'), items, agents)[0]).toMatchObject({ type: 'desk', item: 'i1' });
    const mixed: OperatorAction[] = [{ type: 'desk', op: 'seen', item: 'i3' }, ...toSierra('x')];
    expect(preferNamedLoom('mark that seen and ask Loom field survey tools why', mixed, items, agents)[1]).toMatchObject({ type: 'desk', op: 'reply', item: 'i1' });
  });

  it('several dispatches in one breath keep the router\'s routing', () => {
    const two: OperatorAction[] = [...toSierra('x'), { type: 'dispatch', agentId: 'victor', message: 'y' }];
    expect(preferNamedLoom('ask the Loom field survey tools thread x and tell Victor y', two, items, agents)).toBe(two);
  });

  it('an agent named anywhere keeps the dispatch; a one-word match never overrides', () => {
    expect(preferNamedLoom('can Sierra review the Loom field survey tools thread', toSierra('x'), items, agents)[0]).toMatchObject({ type: 'dispatch' });
    expect(preferNamedLoom('Sierra, please review the Loom field survey tools thread', toSierra('x'), items, agents)[0]).toMatchObject({ type: 'dispatch' });
    expect(preferNamedLoom("don't send this to Loom; have someone make field survey tools report the error", toSierra('x'), items, agents)[0]).toMatchObject({ type: 'dispatch' });
    const single = [{ handle: 'i9', id: 'loom:ccc', place: 'harbor · Notifications' }];
    expect(preferNamedLoom('tell Loom notifications are noisy', toSierra('x'), single, agents)[0]).toMatchObject({ type: 'dispatch' });
  });

  it('leaves it alone: no Loom cue, the agent addressed by name, a weak or tied match, or a desk action already', () => {
    expect(preferNamedLoom('ask Sierra about the field survey tools', toSierra('x'), items, agents)[0]).toMatchObject({ type: 'dispatch' });
    expect(preferNamedLoom('ask Sierra what the Loom field survey tools thread is doing', toSierra('x'), items, agents)[0]).toMatchObject({ type: 'dispatch' });
    expect(preferNamedLoom('tell Loom the tools are fine', toSierra('x'), items, agents)[0]).toMatchObject({ type: 'dispatch' });
    const desk: OperatorAction[] = [{ type: 'desk', op: 'reply', item: 'i2', message: 'x' }];
    expect(preferNamedLoom('tell the Loom field survey tools thread x', desk, items, agents)).toBe(desk);
  });
});

describe('known names reach agents spelled right', () => {
  const people = [{ name: 'Robin', heardAs: ['Robbin', 'Rob in'] }];

  it('replaces every heard spelling in what agents get, whole words only', () => {
    const actions = fixHeardNames(
      [
        { type: 'dispatch', agentId: 'atlas', message: "Plan Robbin's chess club notes; ROBBIN wants a copy.", newThreadTitle: 'Robbin chess notes' },
        { type: 'reply', taskId: 't1', message: 'Send Rob in the summary. Robbins Road stays.' },
        { type: 'status' },
      ],
      people,
    );
    expect(actions[0]).toMatchObject({ message: "Plan Robin's chess club notes; Robin wants a copy.", newThreadTitle: 'Robin chess notes' });
    expect(actions[1]).toMatchObject({ message: 'Send Robin the summary. Robbins Road stays.' });
    expect(actions[2]).toEqual({ type: 'status' });
  });

  it('the extractor sends the profile people to the model and fixes its answer', async () => {
    let prompt = '';
    const extractor = createTaskExtractor((async (request: { input: Array<{ text: string }> }) => {
      prompt = request.input[0].text;
      return JSON.stringify({ actions: [{ type: 'dispatch', agent_id: 'atlas', message: 'Send Robbin the summary.', task_id: '', thread_id: '', new_thread_title: '', thread_options: [], screen_op: '', desk_op: '', item: '', option: '', until: '', trigger: '', stop_job: '', decision: '', answers: [], approval: '', draft_op: '', next_op: '' }] });
    }) as never, { people });
    const actions = await extractor({ agents: [], tasks: [], transcript: [], latestUserSpeech: 'send robbin the summary', now: 0 });
    expect(prompt).toContain('- Robin, heard as "Robbin", "Rob in"');
    expect(actions[0]).toMatchObject({ type: 'dispatch', message: 'Send Robin the summary.' });
  });

  it('never cascades, and leaves text typed into a page alone', () => {
    const fix = nameFixer([{ name: 'Ann', heardAs: ['Anne'] }, { name: 'Ana', heardAs: ['Ann'] }]);
    expect(fix('Anne and Ann')).toBe('Ann and Ana');
    const robin = nameFixer(people);
    expect(robin('see https://example.com/?contact=Robbin#Robbin and C:\\notes\\Robbin.txt')).toBe('see https://example.com/?contact=Robbin#Robbin and C:\\notes\\Robbin.txt');
    expect(robin('Email Robbin+orders@example.com about robbin.pdf at example.com/robbin, then call Robbin.')).toBe('Email Robbin+orders@example.com about robbin.pdf at example.com/robbin, then call Robin.');
    const [respond] = fixHeardNames([{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'ask Robbin to review it' }] }], people);
    expect(respond).toMatchObject({ answers: [{ question: 'q1', answer: 'ask Robin to review it' }] });
    const [label] = fixHeardNames([{ type: 'desk', op: 'respond', item: 'i1', answers: [{ question: 'q1', answer: 'Robbin' }] }], people);
    expect(label).toMatchObject({ answers: [{ question: 'q1', answer: 'Robbin' }] });
    const [fill] = fixHeardNames([{ type: 'screen', op: 'fill', target: 'Username', text: 'Robbin' }], people);
    expect(fill).toMatchObject({ text: 'Robbin' });
  });

  it('a draft leaves out speech that was not part of the message', () => {
    expect(buildDraftCompilePrompt({ fragments: ['x'], agents: [], tasks: [], threads: [], transcript: [], now: 0 })).toContain('Leave out fragments that are not part of the message');
  });

  it('a drafted message gets the same fix', async () => {
    const compile = createDraftCompiler((async () => JSON.stringify({ message: 'Robbin reviews the doc Friday.', agent_id: 'atlas', item: '', thread_id: '', new_thread_title: 'Robbin chess notes', new_loom_repo: '', questions: [] })) as never, { people });
    const result = await compile({ fragments: ['robbin reviews the doc friday'], agents: [], tasks: [], threads: [], transcript: [], now: 0 });
    expect(result).toMatchObject({ message: 'Robin reviews the doc Friday.', newThreadTitle: 'Robin chess notes' });
  });
});
