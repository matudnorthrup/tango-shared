// Display facts only: PRs never change thread status or ordering.
import { age } from '../util.js';
export const PR_STATES = ['open', 'draft', 'merged', 'closed'];
export const isPrArtifact = a => a.kind === 'pr' || /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#]|$)/i.test(a.url || '');
export const otherLinks = item => (item.artifacts || []).filter(a => !isPrArtifact(a));
export function threadPrs(item) {
  if (Array.isArray(item.prs)) return item.prs;
  // Older snapshots still have links, but no trustworthy state or ownership.
  const canonical = url => {
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url || '');
    return m ? `https://github.com/${m[1]}/pull/${Number(m[2])}`.toLowerCase() : null;
  };
  const watched = new Set((item.facts?.prWatches || []).map(w => canonical(w.url)).filter(Boolean));
  const seen = new Set();
  return (item.artifacts || []).filter(isPrArtifact).flatMap(a => {
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(a.url || '');
    if (!m) return [];
    const url = `https://github.com/${m[1]}/pull/${Number(m[2])}`;
    if (seen.has(url.toLowerCase())) return [];
    seen.add(url.toLowerCase());
    return [{ url, repo: m[1], number: Number(m[2]), title: a.label || null, state: 'open', relation: 'mentioned', watched: watched.has(canonical(url)), checkedAt: null }];
  });
}
export function prChip(item) {
  const prs = threadPrs(item).filter(p => p.relation !== 'mentioned');
  if (!prs.length) return null;
  const states = PR_STATES.filter(s => prs.some(p => p.state === s));
  const words = states.map(s => `${prs.length === 1 ? '' : prs.filter(p => p.state === s).length + ' '}${s}`).join(' · ');
  const unwatched = ['idle', 'finished'].includes(item.status?.pill) && prs.some(p => ['open', 'draft'].includes(p.state) && p.watched === false);
  return { state: states[0], words: words + (unwatched ? ' · not watched' : ''), prs };
}
export function prGroups(item) {
  const prs = threadPrs(item);
  return [
    { label: 'Open', prs: prs.filter(p => p.relation !== 'mentioned' && ['open', 'draft'].includes(p.state)) },
    { label: 'Merged', prs: prs.filter(p => p.relation !== 'mentioned' && p.state === 'merged') },
    { label: 'Closed', prs: prs.filter(p => p.relation !== 'mentioned' && p.state === 'closed') },
    { label: 'Mentioned', prs: prs.filter(p => p.relation === 'mentioned'), folded: true },
  ].filter(g => g.prs.length);
}
export function prColor(p) {
  if (p.state !== 'open') return { merged: 'merged', closed: 'bad', draft: 'draft' }[p.state];
  return p.checks === 'failing' || p.review === 'changes_requested' ? 'bad' : p.checks === 'running' || p.review === 'pending' ? 'wait' : 'open';
}
export function prState(p, now) {
  if (p.state === 'merged' || p.state === 'closed') return `${p.state}${p.mergedAt || p.closedAt ? ' ' + age(p.mergedAt || p.closedAt, now) : ''}`;
  if (p.state === 'draft') return 'draft';
  if (p.checks === 'failing') return 'CI failing';
  if (p.review === 'changes_requested') return 'changes requested';
  if (p.checks === 'running') return 'CI running';
  return { pending: 'review pending', approved: 'approved' }[p.review] || 'open';
}
export const prCount = item => { const prs = threadPrs(item); return prs.filter(p => p.relation !== 'mentioned').length || prs.length; };
