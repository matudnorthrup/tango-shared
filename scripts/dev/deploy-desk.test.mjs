import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploy } from './deploy-desk.mjs';

for (const managed of [true, false]) test(`restarts services after canary promotion (managed=${managed})`, async () => {
  const calls = [];
  let promoted = false;
  const id = await deploy({ operator: '/operator', live: '/live' }, {
    release(args) { assert.deepEqual(args, ['build']); return 'candidate'; },
    async canary(id) { assert.equal(id, 'candidate'); promoted = true; calls.push('promoted'); },
    run(file, args) {
      calls.push([file, ...args]);
      if (args[0] === 'managed' && !managed) throw Object.assign(new Error('unmanaged'), { status: 1 });
      if (args[0] === 'restart' || file === 'launchctl') assert.equal(promoted, true);
    },
  });
  assert.equal(id, 'candidate');
  assert.deepEqual(calls.at(-1), ['tango-server', 'restart', 'screen', '-v']);
  assert.equal(calls.filter(c => Array.isArray(c) && (c[1] === 'restart' || c[0] === 'launchctl')).length, 2);
});
test('canary failure prevents service restarts', async () => {
  const calls = [];
  await assert.rejects(deploy({ operator: '/operator', live: '/live' }, {
    release: () => 'candidate',
    canary: async () => { throw new Error('canary failed'); },
    run: (...args) => calls.push(args),
  }), /canary failed/);
  assert.equal(calls.length, 1);
});
