// A deliberately smaller vocabulary than the Discord operator. No arbitrary command payloads.
export const NAVIGATOR_OPS = ['open', 'tab', 'view', 'space', 'page', 'back', 'seen', 'unseen', 'snooze', 'done', 'pin', 'unpin'];
export function validNavigatorAction(a) {
  if (!a || !NAVIGATOR_OPS.includes(a.op) || typeof a.target !== 'string' || a.target.length > 256) return false;
  if (Object.keys(a).some(k => !['op', 'target', 'when'].includes(k))) return false;
  if (a.op === 'back') return a.target === '' && a.when === undefined;
  if (a.op === 'page') return ['inbox', 'catchup', 'projects', 'agents', 'prs'].includes(a.target) && a.when === undefined;
  if (a.op === 'space' && !/^(project|agent):.+$/.test(a.target)) return false;
  if (a.op === 'snooze') return ['soon', 'evening', 'morning', 'monday', 'agent_posts'].includes(a.when) && !!a.target;
  return !!a.target && a.when === undefined;
}
export function sameNavigatorAction(a, b) {
  return validNavigatorAction(a) && validNavigatorAction(b) && a.op === b.op && a.target === b.target && a.when === b.when;
}
