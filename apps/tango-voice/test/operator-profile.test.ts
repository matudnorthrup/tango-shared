import { describe, expect, it } from 'vitest';
import { parseOperatorProfiles, resolveProfileAgents, selectOperatorProfile, type AgentConfigLike } from '../src/live/operator-profile.js';

const YAML = `
operators:
  - id: alex
    voice_channel_id: "111"
    owner_user_ids: ["901", 902]
    agents:
      - atlas
      - id: nova
        role: research and travel
    auth: codex:~/.codex-alex
    idle_minutes: 5
    state_dir: ~/operator-state/alex
    people:
      - name: Robin
        note: example person
        heard_as: [Robbin, Roban]
      - Jordan
  - id: sam
    voice_channel_id: "222"
    owner_user_ids: ["903"]
    agents: [nova]
`;

const configs = new Map<string, AgentConfigLike>([
  ['atlas', { id: 'atlas', enabled: true, displayName: 'Atlas', type: 'personal', voice: { callSigns: ['Atlas', 'Hey Atlas'] }, discord: { defaultChannelId: '501' }, responsibilities: [{ description: 'Coordinate personal work.' }] }],
  ['nova', { id: 'nova', displayName: 'Nova', type: 'research', discord: { defaultChannelId: '502' } }],
  ['off', { id: 'off', enabled: false, displayName: 'Off', type: 'x' }],
]);

describe('voice operator profiles', () => {
  it('parses people, owners, agents and defaults', () => {
    const [alex, sam] = parseOperatorProfiles(YAML);
    expect(alex).toMatchObject({ id: 'alex', voiceChannelId: '111', ownerUserIds: ['901', '902'], auth: 'codex:~/.codex-alex', idleMinutes: 5 });
    expect(alex.agents).toEqual([{ id: 'atlas' }, { id: 'nova', role: 'research and travel' }]);
    expect(alex.stateDir).not.toContain('~');
    expect(alex.stateDir.endsWith('operator-state/alex')).toBe(true);
    expect(alex.people).toEqual([{ name: 'Robin', note: 'example person', heardAs: ['Robbin', 'Roban'] }, { name: 'Jordan' }]);
    expect(sam).toMatchObject({ auth: 'codex', idleMinutes: 10 });
    expect(sam.people).toBeUndefined();
    expect(sam.stateDir.endsWith('voice-operator/sam')).toBe(true);
  });

  it('tolerates fields from before the desk (attention / touched-threads state)', () => {
    const [old] = parseOperatorProfiles(
      'operators:\n  - id: old\n    voice_channel_id: "1"\n    owner_user_ids: ["9"]\n    agents: [atlas]\n    screen_url: http://127.0.0.1:9419\n    state_dir: ~/operator-state/old\n    attention: true\n    attention_file: attention.json\n    touched_threads: touched-threads.json\n',
    );
    expect(old).toMatchObject({ id: 'old', screenUrl: 'http://127.0.0.1:9419' });
    expect(old.stateDir.endsWith('operator-state/old')).toBe(true);
  });

  it('refuses a profile without owners, channel or agents', () => {
    expect(() => parseOperatorProfiles('operators:\n  - id: a\n    voice_channel_id: "1"\n    owner_user_ids: []\n    agents: [x]\n')).toThrow(/owner_user_ids/);
    expect(() => parseOperatorProfiles('operators:\n  - id: a\n    owner_user_ids: ["1"]\n    agents: [x]\n')).toThrow(/voice_channel_id/);
    expect(() => parseOperatorProfiles('operators:\n  - id: a\n    voice_channel_id: "1"\n    owner_user_ids: ["1"]\n')).toThrow(/agents/);
    expect(() => parseOperatorProfiles('operators: []')).toThrow(/non-empty/);
  });

  it('selects by id, or the only profile', () => {
    const profiles = parseOperatorProfiles(YAML);
    expect(selectOperatorProfile(profiles, 'sam').id).toBe('sam');
    expect(() => selectOperatorProfile(profiles)).toThrow(/--operator/);
    expect(() => selectOperatorProfile(profiles, 'nobody')).toThrow(/No voice operator "nobody"/);
    expect(selectOperatorProfile([profiles[1]]).id).toBe('sam');
  });

  it('builds the roster from agent configs, preferring configured roles', () => {
    const [alex] = parseOperatorProfiles(YAML);
    const { agents, homeChannels } = resolveProfileAgents(alex, configs);
    expect(agents).toEqual([
      { id: 'atlas', name: 'Atlas', aliases: ['Hey Atlas'], role: 'Coordinate personal work.' },
      { id: 'nova', name: 'Nova', role: 'research and travel' },
    ]);
    expect([...homeChannels]).toEqual([['atlas', '501'], ['nova', '502']]);
  });

  it('rejects unknown or disabled agents', () => {
    const profile = { ...parseOperatorProfiles(YAML)[1], agents: [{ id: 'ghost' }] };
    expect(() => resolveProfileAgents(profile, configs)).toThrow(/no agent config for "ghost"/);
    expect(() => resolveProfileAgents({ ...profile, agents: [{ id: 'off' }] }, configs)).toThrow(/disabled/);
  });
});
