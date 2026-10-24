import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearSessionAnchor, VoiceSessionMemory } from '../src/live/session-anchor.js';

describe('voice session memory (TGO-1050)', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'anchor-')), 'session-anchor.json');

  it('a join starts a new session; a restart with the owner still here keeps it and what was answered', () => {
    const path = file();
    const first = new VoiceSessionMemory(path, { fresh: true, now: 1_000 });
    expect(first.startedAt).toBe(1_000);
    first.add('item:500');
    const restarted = new VoiceSessionMemory(path, { fresh: false, now: 50_000 });
    expect(restarted.startedAt).toBe(1_000);
    expect(restarted.has('item:500')).toBe(true);
    const rejoined = new VoiceSessionMemory(path, { fresh: true, now: 90_000 });
    expect(rejoined.startedAt).toBe(90_000);
    expect(rejoined.has('item:500')).toBe(false);
  });

  it('after the owner left, or with a stale or missing file, the session starts now', () => {
    const path = file();
    expect(new VoiceSessionMemory(path, { fresh: false, now: 5_000 }).startedAt).toBe(5_000);
    clearSessionAnchor(path);
    expect(new VoiceSessionMemory(path, { fresh: false, now: 7_000 }).startedAt).toBe(7_000);
    const later = 7_000 + 13 * 3_600_000;
    expect(new VoiceSessionMemory(path, { fresh: false, now: later }).startedAt).toBe(later);
  });

  it('keeps the spans voice slept, across restarts', () => {
    const path = file();
    const memory = new VoiceSessionMemory(path, { fresh: true, now: 1_000 });
    memory.sleep(10_000);
    memory.sleep(12_000);
    expect(memory.asleepAt(11_000)).toBe(true);
    expect(memory.asleepAt(9_000)).toBe(false);
    const restarted = new VoiceSessionMemory(path, { fresh: false, now: 20_000 });
    expect(restarted.asleepAt(19_000)).toBe(true);
    restarted.wake(30_000);
    expect(restarted.asleepAt(29_999)).toBe(true);
    expect(restarted.asleepAt(30_000)).toBe(false);
    expect(new VoiceSessionMemory(path, { fresh: true, now: 40_000 }).asleepAt(15_000)).toBe(false);
  });
});
