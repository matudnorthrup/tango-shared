import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StartWork, readStartRepos, repoForDir, publicOptions, publicResult, matchRepo, titleFromPrompt } from '../server/desk/start-work.js';
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-start-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function service() {
  return new StartWork({ repos: [{ id: 'repo', name: 'demo', path: '/repos/demo' }], accountsFile: path.join(dir, 'accounts.json'), policyFile: path.join(dir, 'policy.yaml'), loom: { startThread: async () => ({ ok: true, threadId: 'one' }) }, git: async () => 'origin/main' });
}
describe('native Loom start configuration', () => {
  it('discovers only direct Git checkouts, including linked worktrees', () => {
    fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'worktree'));
    fs.writeFileSync(path.join(dir, 'worktree', '.git'), 'gitdir: elsewhere');
    fs.mkdirSync(path.join(dir, 'other'));
    expect(readStartRepos(undefined, dir).map(r => r.name)).toEqual(['repo', 'worktree']);
    expect(readStartRepos(undefined, path.join(dir, 'missing'))).toEqual([]);
  });
  it('names a Loom thread for the deepest configured checkout, whatever the list order', () => {
    const repos = [{ id: 'parent', name: 'parent', path: '/repos/parent' }, { id: 'nested', name: 'nested', path: '/repos/parent/nested' }];
    for (const list of [repos, [...repos].reverse()]) {
      expect(repoForDir('/repos/parent/nested/src', list)?.name).toBe('nested');
      expect(repoForDir('/repos/parent/nested', list)?.name).toBe('nested');
      expect(repoForDir('/repos/parent/other', list)?.name).toBe('parent');
    }
    expect(repoForDir('/repos/parent-two', repos)).toBeUndefined();
  });
  it('validates explicit repo configuration and never returns private paths publicly', async () => {
    const file = path.join(dir, 'repos.json');
    fs.writeFileSync(file, JSON.stringify([{ name: 'demo', path: '/repos/demo', mode: 'local' }]));
    expect(readStartRepos(file)).toEqual([{ id: 'demo', name: 'demo', path: '/repos/demo', mode: 'local' }]);
    fs.writeFileSync(file, '[{"name":"demo","path":"relative"}]');
    expect(() => readStartRepos(file)).toThrow('absolute');
    expect(publicOptions(await service().options()).repos[0]).not.toHaveProperty('path');
    const result = publicResult(await service().start({ repo: 'demo', prompt: 'Do the work' }));
    expect(result.ok && result.plan.repo).not.toHaveProperty('path');
  });
  it('resolves existing policy aliases to canonical Loom accounts', async () => {
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ claude: { accounts: [{ name: 'main', usageName: 'Main Seat', aliases: ['old-account'] }] } }));
    fs.writeFileSync(path.join(dir, 'policy.yaml'), 'default: old-account');
    expect((await service().check({ repo: 'demo', prompt: 'Do it' })).plan?.repo).toMatchObject({ loomSeats: ['old-account'], loomPick: 'old-account' });
    expect((await service().check({ repo: 'demo', prompt: 'Do it', pin: 'old-account' })).plan?.pin).toBe('old-account');
  });
  it('colors accounts from the documented accentColor, falling back to color', async () => {
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ claude: { accounts: [{ name: 'main', accentColor: '#c96' }, { name: 'old', color: '#369' }] } }));
    const accounts = (await service().options()).accounts;
    expect(accounts.find(a => a.id === 'main')?.color).toBe('#c96');
    expect(accounts.find(a => a.id === 'old')?.color).toBe('#369');
  });
  it('blocks malformed account configuration and unknown policy seats', async () => {
    fs.writeFileSync(path.join(dir, 'accounts.json'), '{bad');
    expect((await service().check({ repo: 'demo', prompt: 'Do it' })).ready).toBe(false);
    fs.writeFileSync(path.join(dir, 'accounts.json'), '{}');
    fs.writeFileSync(path.join(dir, 'policy.yaml'), 'default: missing');
    expect((await service().options()).policyError).toContain('unknown Loom accounts');
  });
  it('validates required fields and derives a bounded title', async () => {
    expect((await service().check({})).missing).toEqual(['repo', 'prompt']);
    expect((await service().check({ repo: 'demo', prompt: 'Do it', mode: 'invalid' })).ready).toBe(false);
    expect(titleFromPrompt('Fix the export. Then test it.')).toBe('Fix the export.');
    expect(titleFromPrompt('Long words '.repeat(20)).length).toBeLessThanOrEqual(60);
    expect(matchRepo('demo', (await service().options()).repos)?.id).toBe('repo');
  });
  it('reserves different pool seats for concurrent starts and releases failed reservations', async () => {
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ claude: { accounts: [{ name: 'first' }, { name: 'second' }] } }));
    fs.writeFileSync(path.join(dir, 'policy.yaml'), 'default: [first, second]');
    const picked: string[] = [];
    const releases: Array<() => void> = [];
    const svc = new StartWork({ repos: [{ id: 'repo', name: 'demo', path: '/repos/demo' }], accountsFile: path.join(dir, 'accounts.json'), policyFile: path.join(dir, 'policy.yaml'), git: async () => 'origin/main', loom: { startThread: async start => { picked.push(start.account!); await new Promise<void>(resolve => releases.push(resolve)); return { ok: true, threadId: start.commandId }; } } });
    const first = svc.start({ repo: 'demo', prompt: 'One', commandId: 'one' });
    const second = svc.start({ repo: 'demo', prompt: 'Two', commandId: 'two' });
    while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    expect(picked).toEqual(['first', 'second']);
    releases.forEach(release => release());
    expect((await Promise.all([first, second])).every(result => result.ok)).toBe(true);
  });

  it('uses provider aliases when Claude and Codex share their native name', async () => {
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ claude: { accounts: [{ name: 'main', aliases: ['claude-main'] }] }, codex: { accounts: [{ name: 'main', aliases: ['codex-main'] }] } }));
    fs.writeFileSync(path.join(dir, 'policy.yaml'), 'default: claude-main');
    const options = await service().options();
    expect(options.policyError).toBeNull();
    expect(options.accounts.map(account => account.id)).toEqual(['claude-main', 'codex-main', 'loom']);
    expect((await service().check({ repo: 'demo', prompt: 'Do it', pin: 'main' })).plan?.pin).toBe('claude-main');
  });

});

it('starts on the Claude seat when providers share an unaliased name', async () => {
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ claude: { accounts: [{ name: 'main' }] }, codex: { accounts: [{ name: 'main' }] } }));
  fs.writeFileSync(path.join(dir, 'policy.yaml'), 'default: main');
  const svc = service();
  const options = await svc.options();
  expect(options.policyError).toBeNull();
  expect(options.accounts.map(account => account.id)).toEqual(['main', 'codex:main', 'loom']);
  expect(options.repos[0].loomSeats).toEqual(['main']);
  expect((await svc.start({ repo: 'demo', prompt: 'Do it', pin: 'main' })).ok).toBe(true);
});
