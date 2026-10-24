// Identity shared by the query evaluator and the row's labels. No DOM or server dependencies.
export const personaId = (id) => String(id || '').trim().toLowerCase().replace(/-(ollama|classic|test)$/, '');

export function agentId(item) {
  if (item?.facts?.agentSpace?.id) return personaId(item.facts.agentSpace.id);
  if (item?.source === 'system') return null;
  return personaId(item?.agentId) || null;
}

export function itemRepo(item) {
  if (!['loom'].includes(item?.source)) return null;
  for (const named of [item.facts?.project?.name, item.area]) if (named?.trim()) return named.trim();
  const place = item.place || '';
  const at = place.indexOf(' · ');
  return at > 0 ? place.slice(0, at).trim() || null : null;
}

export function kindOf(item) {
  const role = item?.facts?.role;
  if (role === 'ops') return 'job';
  if (role === 'worker') return 'worker';
  return ['default', 'coordinator'].includes(role) || (item?.kind === 'chapter' && item?.facts?.standing !== false) ? 'default' : 'thread';
}

export const reachesOwner = (item) => item?.status?.audience ? item.status.audience === 'owner' : ['thread', 'default'].includes(kindOf(item));

/** Done becomes Clear for a standing conversation; the server makes the authoritative choice. */
export const doneLabel = (item) => (item?.facts?.standing ?? kindOf(item) === 'default') ? 'Clear' : 'Done';
