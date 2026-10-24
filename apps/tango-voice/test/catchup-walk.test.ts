import { describe, expect, it } from 'vitest';
import { matchCatchupCommand, optionFor, spaceNamed, speakFocus, speakLeft } from '../src/live/catchup-walk.js';
import type { CatchupWalk, CatchupWalkFocus } from '../src/live/desk-client.js';

const brief: CatchupWalkFocus = {
  spaceId: 'desk',
  name: 'Tango Desk',
  headline: null,
  line: { id: 1, ids: [1], kind: 'needs', title: 'Ship it?', detail: null, briefId: 'D-1', itemId: 'loom:0000', decisionId: null, waiting: true },
  brief: { ask: 'Ship the walk?', options: [{ key: 'A', label: 'Ship it.', recommended: false, answer: 'A · Ship it.' }, { key: 'B', label: 'Wait', recommended: false, answer: 'B · Wait' }], defaultOption: 'B', revision: 1 },
};
const walk: CatchupWalk = {
  focus: brief,
  map: { needs: [{ spaceId: 'desk', name: 'Tango Desk', summary: '1 needs you · 2 shipped' }], look: [{ spaceId: 'bike', name: 'Bike', summary: '1 failed' }], smaller: [{ spaceId: 'a', name: 'Alpha', summary: '' }, { spaceId: 'b', name: 'Bravo', summary: '' }] },
  left: 4,
};

describe('catch-up walk words', () => {
  it('reads the walk commands, polite or not', () => {
    expect(matchCatchupCommand('ok next please')).toEqual({ op: 'next' });
    expect(matchCatchupCommand('on to the next one')).toEqual({ op: 'next' });
    expect(matchCatchupCommand('skip that one')).toEqual({ op: 'skip' });
    expect(matchCatchupCommand('skip this project')).toEqual({ op: 'defer' });
    expect(matchCatchupCommand("let's go with b")).toEqual({ op: 'pick', key: 'B' });
    expect(matchCatchupCommand('option a')).toEqual({ op: 'pick', key: 'A' });
    expect(matchCatchupCommand('go with your recommendation')).toEqual({ op: 'pick', key: null });
    expect(matchCatchupCommand("that's fine")).toEqual({ op: 'fine' });
    expect(matchCatchupCommand('got it, thanks')).toEqual({ op: 'gotit' });
    expect(matchCatchupCommand('accept')).toEqual({ op: 'accept', space: null });
    expect(matchCatchupCommand('accept the desk project')).toEqual({ op: 'accept', space: 'desk' });
    expect(matchCatchupCommand("what's left")).toEqual({ op: 'left' });
    expect(matchCatchupCommand('go to bike')).toEqual({ op: 'goto', space: 'bike' });
    expect(matchCatchupCommand("that's enough")).toEqual({ op: 'stop' });
  });

  it('leaves a sentence that only mentions them to the usual routes', () => {
    expect(matchCatchupCommand('tell sierra the next one is fine')).toBeNull();
    expect(matchCatchupCommand('what did foxtrot ship')).toBeNull();
  });

  it('speaks a brief with its options and its pick, and the map per space', () => {
    expect(speakFocus(brief)).toBe("Tango Desk, needs you: Ship the walk. Options: A, Ship it; B, Wait. I'd go with B.");
    expect(speakLeft(walk)).toBe('Tango Desk: 1 needs you, 2 shipped. Bike: 1 failed. Smaller updates in 2 places.');
    expect(speakLeft({ ...walk, map: { needs: [], look: [], smaller: [] } })).toBe("Nothing's left.");
  });

  it('finds a space by name and a brief option by key or recommendation', () => {
    expect(spaceNamed(walk, 'Bike')).toEqual({ spaceId: 'bike' });
    expect(spaceNamed(walk, 'tango')).toEqual({ spaceId: 'desk' });
    expect(spaceNamed(walk, 'zulu')).toBeNull();
    const two: CatchupWalk = { ...walk, map: { ...walk.map, look: [...walk.map.look, { spaceId: 'voice', name: 'Tango Voice', summary: '1 shipped' }] } };
    expect(spaceNamed(two, 'tango')).toEqual({ choices: ['Tango Desk', 'Tango Voice'] });
    expect(spaceNamed(two, 'tango voice')).toEqual({ spaceId: 'voice' });
    expect(optionFor(brief, 'A')).toEqual({ key: 'A', label: 'Ship it.', answer: 'A · Ship it.' });
    expect(optionFor(brief, null)?.key).toBe('B');
    expect(optionFor(brief, 'F')).toBeNull();
  });
});

 it('says finished, keeps consequences and speaks only active-time defaults', () => {
   expect(speakFocus({ ...brief, brief: null, line: { ...brief.line, kind: 'shipped' } })).toContain('finished:');
   const b = { ...brief, brief: { ...brief.brief!, options: [{ key: 'A', label: 'Short page', recommended: true, answer: 'A', consequence: 'It keeps the page short.' }], defaultOption: 'A', level: 3, tripwire: null, vetoLeftMs: 2 * 60 * 60_000 } };
   expect(speakFocus(b)).toContain("I'd go with A: It keeps the page short.");
   expect(speakFocus(b)).toContain('after about two hours of your active time');
   expect(speakFocus({ ...b, brief: { ...b.brief, vetoLeftMs: null } })).not.toContain('active time');
 });
 it('inbox names Unfiled', () => {
   expect(spaceNamed({ ...walk, map: { ...walk.map, look: [{ spaceId: 'unfiled', name: 'Unfiled', summary: '1 to see' }] } }, 'inbox')).toEqual({ spaceId: 'unfiled' });
 });
