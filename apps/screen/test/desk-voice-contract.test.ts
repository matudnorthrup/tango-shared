import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deskVoiceContract } from '../server/desk/voice-contract.js';

const contract = deskVoiceContract();
const guidance = (value: string) => `New desk state \`${value}\`: add it to voice-contract.ts as knock, when asked, or silent.`;

describe('desk voice contract', () => {
  for (const list of ['pills', 'kinds', 'commands', 'waitingReasons'] as const) {
    it(`classifies exactly every ${list} value`, () => {
      const policies = contract.policies[list];
      for (const value of contract[list]) expect(Object.keys(policies), guidance(value)).toContain(value);
      expect(Object.keys(policies).sort()).toEqual([...contract[list]].sort());
      for (const policy of Object.values(policies)) {
        expect(['knock', 'when asked', 'silent']).toContain(policy.policy);
        if (policy.policy === 'silent') expect('reason' in policy && policy.reason.trim().length).toBeGreaterThan(0);
      }
    });
  }
  it('names a receipt source for every command', () => {
    for (const entry of Object.values(contract.policies.commands)) {
      expect(['server', 'fixed']).toContain(entry.receipt.source);
      if (entry.receipt.source === 'fixed') expect(entry.receipt.sentence.trim()).not.toBe('');
    }
    for (const command of contract.voiceCommands) expect(contract.commands).toContain(command);
    for (const command of contract.commands) {
      if (!(contract.voiceCommands as readonly string[]).includes(command)) expect(contract.policies.commands[command].policy).toBe('silent');
    }
  });
  it('keeps the committed voice fixture current', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../tango-voice/test/fixtures/desk-contract.json', import.meta.url), 'utf8'));
    expect(fixture, 'Desk contract changed: classify new desk states in voice-contract.ts, then run npx tsx apps/screen/scripts/write-voice-contract.ts and update voice handling.').toEqual(contract);
  });
});
