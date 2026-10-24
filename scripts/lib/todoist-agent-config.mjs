/** Pure profile configuration patch. The operator selects trusted agents explicitly. */
export function configureTodoistAgent(base, override, { coordinator, isCoordinator = false }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(coordinator ?? '')) throw new Error('A concrete coordinator agent ID is required');
  const result = structuredClone(override);
  const servers = structuredClone(override.mcp_servers ?? base.mcp_servers ?? []);
  for (const [name, tool] of [['todoist', 'todoist'], ['collaboration', 'collaborate_with_agent']]) {
    const existing = servers.find(server => server.name === name);
    if (existing) {
      // Keep custom transports intact; an explicit restrictive allowlist is not ours to widen.
      const allowed = existing.env?.ALLOWED_TOOL_IDS?.split(',').map(value => value.trim());
      if (allowed && !allowed.includes(tool)) throw new Error(`Existing ${name} server excludes ${tool}`);
    } else {
      servers.push({ name, command: 'node', args: ['packages/core/dist/mcp-proxy.js', name], env: { ALLOWED_TOOL_IDS: tool } });
    }
  }
  result.mcp_servers = servers;
  const mounts = { ...(base.mcp ?? {}), ...(override.mcp ?? {}) };
  // With no mount policy Tango already loads every configured server. If a
  // selective policy exists, these two capabilities must be discoverable on
  // ordinary turns ("add this" / "ask Watson"), not only keyword-triggered.
  if (mounts.default_servers !== undefined || mounts.available_servers !== undefined) {
    result.mcp = { ...mounts, default_servers: [...new Set([...(mounts.default_servers ?? []), 'todoist', 'collaboration'])] };
  }
  const responsibilities = structuredClone(override.responsibilities ?? base.responsibilities ?? []);
  const taskResponsibility = {
    id: 'todoist_tasks',
    description: isCoordinator ? 'Coordinate the user task list across domains and return verified planning advice.' : 'Capture user-requested tasks directly and consult the configured coordinator for cross-domain planning.',
    objectives: [
      'Use Todoist directly for authorized tasks in your domain; verify writes and preserve user-specified details.',
      'Share only the minimum task context needed for planning. Return advice without making unrequested changes.',
    ],
    autonomy: { default: 'supervised', writes_require_confirmation: true, purchase_or_payment: 'never' },
    collaboration: isCoordinator
      ? { can_fulfill: [{ purpose: 'task-planning', max_turns: 1, max_duration_seconds: 120, max_tool_calls: 6, visibility_modes: ['summary', 'digest', 'silent'] }] }
      : { can_request: [{ agent: coordinator, purposes: ['task-planning'] }] },
  };
  const at = responsibilities.findIndex(item => item.id === taskResponsibility.id);
  if (at >= 0) {
    if (JSON.stringify(responsibilities[at]) !== JSON.stringify(taskResponsibility)) throw new Error('Existing todoist_tasks responsibility differs; review it explicitly');
  } else responsibilities.push(taskResponsibility);
  result.responsibilities = responsibilities;
  const tools = { ...(base.tools ?? {}), ...(override.tools ?? {}) };
  if (tools.mode === 'allowlist') {
    result.tools = { ...tools, allowlist: [...new Set([...(tools.allowlist ?? []), 'mcp__todoist__todoist', 'mcp__collaboration__collaborate_with_agent'])] };
  }
  return result;
}
