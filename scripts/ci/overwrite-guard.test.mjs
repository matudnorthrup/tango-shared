import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect, declarations, report } from './overwrite-guard.mjs';

const now = Date.parse('2026-10-21T12:00:00Z');
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'overwrite-guard-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_DATE: '2026-10-20T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-20T12:00:00Z' } }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const write = (file, text) => { mkdirSync(dirname(join(cwd, file)), { recursive: true }); writeFileSync(join(cwd, file), text); };
  const commit = subject => { git('add', '.'); git('commit', '-qm', subject); return git('rev-parse', 'HEAD'); };
  write('code.js', 'const legacyFirst = true;\nconst legacySecond = true;\nconst legacyThird = true;\n');
  commit('Initial baseline');
  write('code.js', 'const modernFirst = true;\nconst modernSecond = true;\nconst modernThird = true;\n');
  write('new file.js', 'export const policy = "approved";\n');
  write('app/test/policy.ts', 'expect(policy).toEqual("approved");\nassert.equal(policy, "approved");\n');
  const base = commit('Implement approved policy (#10)');
  const check = options => inspect({ cwd, base, head: 'HEAD', now, ...options });
  return { cwd, git, write, commit, base, check };
}

test('A: deleted recent file requires a declaration', t => {
  const f = fixture(t); f.git('rm', 'new file.js'); f.commit('Delete file (#11)');
  const result = f.check(); assert.deepEqual(result.missing, [10]); assert.match(result.findings[0].kind, /^A/);
  assert.deepEqual(f.check({ body: '## Changes earlier work\n\n- #10: Approved replacement in D-1.\n' }).missing, []);
  assert.match(report(result), /#10: <!-- Explain why/);
});

test('B: restores the earlier PR removal and removes its additions', t => {
  const f = fixture(t); f.write('code.js', 'const legacyFirst = true;\nconst legacySecond = true;\nconst legacyThird = true;\n'); f.commit('Replace implementation');
  assert.match(f.check().findings[0].kind, /^B/);
  assert.deepEqual(f.check({ body: '## Changes earlier work\n- #10: Required by D-1.' }).missing, []);
});

test('C: blame attributes changed assertions to the earlier PR', t => {
  const f = fixture(t); f.write('app/test/policy.ts', 'expect(policy).toEqual("different");\n'); f.commit('Change expectation');
  const result = f.check(); assert.equal(result.findings.length, 1); assert.match(result.findings[0].kind, /^C/); assert.deepEqual(result.missing, [10]);
  assert.deepEqual(f.check({ body: '## Changes earlier work\n- #10: New approved behaviour.' }).missing, []);
});

test('own PR, old commits, push events, Dependabot and Revert are exempt', t => {
  const f = fixture(t); f.git('rm', 'new file.js'); f.commit('Delete file (#11)');
  for (const options of [{ number: 10 }, { now: now + 8 * 86400000 }, { windowDays: 0 }, { eventName: 'push' }, { author: 'dependabot[bot]' }]) assert.deepEqual(f.check(options).findings, []);
  f.git('commit', '--allow-empty', '-qm', 'Revert "Implement approved policy (#10)"');
  assert.deepEqual(f.check().findings, []);
});

test('declarations must have a reason inside the named section', () => {
  assert.deepEqual([...declarations('## Summary\n- #10: reason\n## Changes earlier work\n- #11: <!-- reason -->\n- #12:\n- #13: actual reason\n## Verification\n- #14: reason')], [13]);
});

test('B ignores short lines, punctuation, unchanged moves and one-sided overlaps', t => {
  const f = fixture(t); f.write('code.js', 'const legacyFirst = true;\nconst legacySecond = true;\nconst modernThird = true;\n'); f.commit('Only four matching lines');
  assert.deepEqual(f.check().findings, []);
});

test('CLI reads event, reports to summary, and returns failing or passing status', t => {
  const f = fixture(t); f.git('rm', 'new file.js'); f.commit('Delete file');
  const event = join(f.cwd, 'event.json'), summary = join(f.cwd, 'summary.md');
  const run = body => {
    writeFileSync(event, JSON.stringify({ number: 11, pull_request: { body, user: { login: 'fixture' } } }));
    return spawnSync(process.execPath, [fileURLToPath(new URL('./overwrite-guard.mjs', import.meta.url)), '--base', f.base, '--now', new Date(now).toISOString()], { cwd: f.cwd, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary } });
  };
  assert.equal(run('').status, 1); assert.match(readFileSync(summary, 'utf8'), /A — Deleted recent file/);
  assert.equal(run('## Changes earlier work\n- #10: Owner-approved replacement.').status, 0);
});

test('B ignores short and punctuation-only lines and lines moved within a PR', t => {
  const f = fixture(t);
  f.write('noise.js', 'shortOldA\nshortOldB\n;;;;;;;;;;;;;;;;\nconst unchangedMoved = true;\n');
  const before = f.commit('Before noise');
  f.write('noise.js', 'const unchangedMoved = true;\nshortNewA\nshortNewB\n((((((((((((((((\n');
  const base = f.commit('Move and punctuation (#12)');
  f.write('noise.js', f.git('show', `${before}:noise.js`) + '\n'); f.commit('Restore noise');
  assert.deepEqual(f.check({ base }).findings, []);
});

test('assertions in .test files and merge PR subjects are attributed', t => {
  const f = fixture(t); f.write('checks.test.js', 'assert.equal(actualValue, "approved");\n');
  const base = f.commit('Merge pull request #12 from fixture/topic');
  f.write('checks.test.js', 'assert.equal(actualValue, "changed");\n'); f.commit('Change test');
  assert.deepEqual(f.check({ base }).missing, [12]);
});

test('diff uses merge-base rather than unrelated later base changes', t => {
  const f = fixture(t); f.git('checkout', '-qb', 'later-base'); f.write('later.js', 'export const laterValue = true;\n');
  const base = f.commit('Later addition (#12)');
  f.git('checkout', '--detach', f.base); f.write('unrelated.js', 'export const ownValue = true;\n'); f.commit('Own addition');
  assert.deepEqual(f.check({ base }).findings, []);
});

test('historical Revert commits are not attributed', t => {
  const f = fixture(t); f.write('reverted.js', 'export const restored = true;\n');
  const base = f.commit('Revert "Earlier removal" (#12)');
  f.git('rm', 'reverted.js'); f.commit('Delete restored file');
  assert.deepEqual(f.check({ base }).findings, []);
});

test('multiline assertion values require a declaration, but adjacent setup does not', t => {
  const f = fixture(t);
  const original = 'const setupValue = true;\nexpect(policy)\n  .toEqual({\n    approved: true,\n    punctuation: ")", // ) does not close the assertion\n  });\nconst afterValue = true;\n';
  f.write('multiline.test.js', original); const base = f.commit('Approve multiline assertion (#12)');
  f.write('multiline.test.js', original.replace('approved: true', 'approved: false')); f.commit('Change expected value');
  assert.deepEqual(f.check({ base }).missing, [12]);
  f.write('multiline.test.js', original.replace('afterValue = true', 'afterValue = false')); f.commit('Change only setup');
  assert.deepEqual(f.check({ base }).findings, []);
});

test('normal merge PR owns added files, reverted lines and blamed assertions', t => {
  const f = fixture(t);
  const main = f.git('branch', '--show-current');
  f.git('checkout', '-qb', 'feature');
  f.write('merged.js', 'export const approvedMerge = true;\n');
  f.write('code.js', 'const mergedFirst = true;\nconst mergedSecond = true;\nconst mergedThird = true;\n');
  f.write('merge.test.js', 'expect(policy).toEqual({\n  approved: true,\n});\n');
  f.commit('Approved policy without PR number');
  f.git('checkout', main); f.git('merge', '--no-ff', 'feature', '-m', 'Merge pull request #12 from fixture/feature');
  const base = f.git('rev-parse', 'HEAD');
  f.git('rm', 'merged.js');
  f.write('code.js', 'const modernFirst = true;\nconst modernSecond = true;\nconst modernThird = true;\n');
  f.write('merge.test.js', 'expect(policy).toEqual({\n  approved: false,\n});\n'); f.commit('Undo merged policy');
  const result = f.check({ base });
  assert.deepEqual(result.findings.map(finding => finding.kind[0]).sort(), ['A', 'B', 'C']);
  assert.deepEqual(result.missing, [12]);
  assert.deepEqual(f.check({ base, number: 12 }).findings, []);
});

test('polling and soft assertion edits require declarations', t => {
  const f = fixture(t);
  const original = 'await expect.poll(() => release).toEqual(\n  "new",\n);\nexpect.soft(policy).toEqual("approved");\n';
  f.write('poll.test.js', original); const base = f.commit('Approve polling assertions (#12)');
  f.write('poll.test.js', original.replace('"new"', '"old"')); f.commit('Change polling expectation');
  assert.deepEqual(f.check({ base }).missing, [12]);
  f.write('poll.test.js', original.replace('"approved"', '"changed"')); f.commit('Change soft expectation');
  assert.deepEqual(f.check({ base }).missing, [12]);
});

test('regex brackets do not extend assertions into unrelated setup', t => {
  const f = fixture(t);
  const original = String.raw`expect(text).toMatch(/hello\(/);
expect(text).toMatch(/[()/]/);
const setupValue = true;
expect(ratio / divisor).toEqual(3);
const afterDivision = true;
`;
  f.write('regex.test.js', original); const base = f.commit('Approve regex assertions (#12)');
  f.write('regex.test.js', original.replace('setupValue = true', 'setupValue = false').replace('afterDivision = true', 'afterDivision = false')); f.commit('Change only setup');
  assert.deepEqual(f.check({ base }).findings, []);
  f.write('regex.test.js', original.replace('hello', 'goodbye')); f.commit('Change regex expectation');
  assert.deepEqual(f.check({ base }).missing, [12]);
});
