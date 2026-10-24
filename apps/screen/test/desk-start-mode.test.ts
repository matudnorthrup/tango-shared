import { expect, it } from 'vitest';
import { defaultStartMode } from '../server/desk/start-work.js';

it('defaults by role, then build intent, read-only intent, and repo policy', () => {
  for (const input of [{role:'ops'}, {role:'coordinator'}, {tier:'qa',role:'worker'}]) {
    expect(defaultStartMode({...input,prompt:'build a fix'})).toBe('local');
  }
  expect(defaultStartMode({role:'worker',prompt:'review'})).toBe('worktree');
  for (const prompt of ['question', 'investigate', 'audit', 'inventory', 'check', 'why', 'how does it work', 'what', 'review the PR']) {
    expect(defaultStartMode({prompt,repo:{mode:'worktree'}})).toBe('local');
  }
  for (const prompt of ['implement', 'fix', 'build', 'refactor', 'add', 'ship', 'fix the bug, then check what else breaks', 'review and fix the PR']) {
    expect(defaultStartMode({prompt,repo:{mode:'local'}})).toBe('worktree');
  }
  expect(defaultStartMode({prompt:'hello',repo:{mode:'local'}})).toBe('local');
  expect(defaultStartMode({plan:true})).toBe('worktree');
  expect(defaultStartMode({plan:'build the feature'})).toBe('worktree');
});
