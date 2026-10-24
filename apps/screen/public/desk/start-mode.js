/** Role wins over intent. Build verbs win mixed prompts ("fix X and check Y"): a local thread can't edit its
 * checkout, so a wrong local guess costs more than a spare worktree. Read-only words select local. Ambiguous
 * requests retain repo policy, else worktree. Plan-first is a boolean approval preference, not build intent.
 */
export function defaultStartMode({ role, tier, prompt = '', plan, repo } = {}) {
  if (role === 'ops' || role === 'coordinator' || tier === 'qa') return 'local';
  if (role === 'worker') return 'worktree';
  const text = `${prompt} ${typeof plan === 'string' ? plan : ''}`;
  if (/(?<![\w-])(implement|fix|build|refactor|add|ship)(?![\w-])/i.test(text)) return 'worktree';
  if (/(?<![\w-])(question|investigate|audit|inventory|check|why|how|what|review)(?![\w-])/i.test(text)) return 'local';
  return repo?.mode ?? 'worktree';
}
