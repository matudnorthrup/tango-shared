import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/dev/update-live-checkouts.sh');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tango-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const origin = join(dir, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-b', 'main');
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(origin, 'package.json'), '{"private":true}');
  git(origin, 'add', '.');
  git(origin, 'commit', '-m', 'initial');
  const old = git(origin, 'rev-parse', 'HEAD');
  const operator = join(dir, 'operator');
  const live = join(dir, 'live');
  git(dir, 'clone', origin, operator);
  git(dir, 'clone', origin, live);
  writeFileSync(join(origin, 'version.txt'), 'new');
  git(origin, 'add', '.');
  git(origin, 'commit', '-m', 'update');
  const head = git(origin, 'rev-parse', 'HEAD');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'builds');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s:%s\\n" "$PWD" "$*" >> "$BUILD_LOG"\nexit "${BUILD_EXIT:-0}"\n', { mode: 0o755 });
  const run = (env = {}) => spawnSync('bash', [script, operator, live], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BUILD_LOG: log, ...env },
  });
  return { origin, operator, live, git, old, head, log, run };
}

test('updates both to one revision and builds in each checkout', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const cwd of [f.operator, f.live]) {
    assert.equal(f.git(cwd, 'rev-parse', 'HEAD'), f.head);
    assert.equal(f.git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
  }
  assert.equal(readFileSync(f.log, 'utf8'), `${f.operator}:run build\n${f.live}:run build\n`);
});

test('dirty second checkout stops before changing the clean first copy', (t) => {
  const f = fixture(t);
  const edited = join(f.live, 'package.json');
  writeFileSync(edited, 'local work');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Local changes/);
  assert.equal(readFileSync(edited, 'utf8'), 'local work');
  assert.equal(f.git(f.operator, 'rev-parse', 'HEAD'), f.old);
  assert.equal(f.git(f.live, 'rev-parse', 'HEAD'), f.old);
});

test('build failure stops before updating the second copy', (t) => {
  const f = fixture(t);
  const result = f.run({ BUILD_EXIT: '7' });
  assert.equal(result.status, 7);
  assert.equal(f.git(f.operator, 'rev-parse', 'HEAD'), f.head);
  assert.equal(f.git(f.live, 'rev-parse', 'HEAD'), f.old);
  assert.equal(readFileSync(f.log, 'utf8'), `${f.operator}:run build\n`);
});


test('a detached committed hotfix stops both updates', (t) => {
  const f = fixture(t);
  f.git(f.live, 'checkout', '--detach');
  f.git(f.live, 'config', 'user.name', 'Test');
  f.git(f.live, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(f.live, 'hotfix.txt'), 'keep this fix');
  f.git(f.live, 'add', '.');
  f.git(f.live, 'commit', '-m', 'local hotfix');
  const hotfix = f.git(f.live, 'rev-parse', 'HEAD');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Local commits/);
  assert.equal(f.git(f.live, 'rev-parse', 'HEAD'), hotfix);
  assert.equal(f.git(f.operator, 'rev-parse', 'HEAD'), f.old);
});

test('ignored files are not overwritten by newly tracked files', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.operator, '.git', 'info', 'exclude'), 'version.txt\n');
  writeFileSync(join(f.operator, 'version.txt'), 'local ignored contents');
  assert.equal(f.git(f.operator, 'status', '--porcelain'), '');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(f.operator, 'version.txt'), 'utf8'), 'local ignored contents');
  assert.equal(f.git(f.operator, 'rev-parse', 'HEAD'), f.old);
  assert.equal(f.git(f.live, 'rev-parse', 'HEAD'), f.old);
});
