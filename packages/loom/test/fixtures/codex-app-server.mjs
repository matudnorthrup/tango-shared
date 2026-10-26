import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
let threadId = 'native-new', turn = 0, flaked = 0;
const event = (method, params) => notify(method, { threadId, turnId: `turn-${turn}`, ...params });
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify(m) + '\n');
  const reply = result => send({ id: m.id, result });
  if (m.method === 'initialize') {
    if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), env: { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY }, token: process.env.EXAMPLE_TOKEN }) + '\n');
    reply({});
  }
  else if (m.method === 'config/read') reply({ config: { developer_instructions: process.env.FAKE_DEV_INSTRUCTIONS ?? null } });
  else if (m.method === 'thread/resume' && m.params.threadId === 'stalled') { /* never answers */ }
  else if (m.method === 'thread/resume' && (m.params.threadId === 'broken' || (m.params.threadId === 'flaky' && !flaked++))) {
    send({ id: m.id, error: { code: -32603, message: 'internal error: state db busy' } });
  } else if (m.method === 'thread/resume' && m.params.threadId === 'other-account') {
    send({ id: m.id, error: { code: -32600, message: 'no rollout found for thread id other-account' } });
  } else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    threadId = m.params.threadId ?? threadId;
    reply({ thread: { id: threadId } });
  } else if (m.method === 'turn/start') {
    turn++;
    const t = { id: `turn-${turn}`, status: 'inProgress' };
    reply({ turn: t });
    event('turn/started', { turn: t });
    const text = m.params.input[0].text;
    if (text.includes('exit-child')) process.exit(2);
    if (text.includes('wait-for-interrupt')) continue;
    if (text.includes('elicit-')) {
      for (const serverName of ['loom', 'other']) send({ id: `elicit-${serverName}`, method: 'mcpServer/elicitation/request', params: { threadId, turnId: t.id, serverName, mode: 'form', message: 'Allow tool call?', requestedSchema: { type: 'object', properties: {} } } });
      continue;
    }
    if (text.includes('approval-')) {
      const kind = text.includes('approval-fileChange') ? 'fileChange' : 'commandExecution';
      for (const id of ['approval-1', 'approval-2']) send({ id, method: `item/${kind}/requestApproval`, params: { threadId, turnId: t.id, itemId: id } });
      continue;
    }
    if (text.includes('subagent')) {
      const activity = (kind, agentThreadId, agentPath) => event('item/started', { item: { type: 'subAgentActivity', id: `${kind}-${agentThreadId}`, kind, agentThreadId, agentPath } });
      activity('started', 'child-1', '/root/review');
      activity('started', 'child-2', '/root/tests');
      // A child's own spawn reports on the child's thread; a stranger's doesn't count.
      const nested = (from, kind) => notify('item/started', { threadId: from, turnId: 'child-turn', item: { type: 'subAgentActivity', id: `${kind}-${from}`, kind, agentThreadId: `${from}-kid`, agentPath: '/root/review/deep' } });
      nested('child-1', 'started');
      nested('stranger', 'started');
      notify('turn/started', { threadId: 'child-1', turn: { id: 'child-turn', status: 'inProgress' } });
      notify('turn/completed', { threadId: 'child-1', turn: { id: 'child-turn', status: 'completed' } });
      activity('completed', 'child-1', '/root/review');
      activity('interacted', 'child-1', '/root/review');
      nested('child-1', 'completed');
      event('turn/completed', { turn: { ...t, status: 'completed' } });
      // Outlives the turn that spawned it.
      notify('item/started', { threadId, turnId: 'child-turn', item: { type: 'subAgentActivity', id: 'end-2', kind: 'interrupted', agentThreadId: 'child-2', agentPath: '/root/tests' } });
      if (text.includes('crash')) { activity('started', 'child-3', '/root/lint'); setTimeout(() => process.exit(3), 50); }
      continue;
    }
    if (text.includes('credits')) {
      notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 20, resetsAt: 1800000000 }, secondary: { usedPercent: 40, resetsAt: 1900000000 }, rateLimitReachedType: 'workspace_member_credits_depleted' } });
      event('turn/completed', { turn: { ...t, status: 'failed', error: { message: 'Usage limit exceeded', codexErrorInfo: 'usageLimitExceeded' } } });
      continue;
    }
    if (text.includes('short-full')) {
      notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, resetsAt: 1800000000 }, secondary: { usedPercent: 40, resetsAt: 1900000000 }, rateLimitReachedType: 'rate_limit_reached' } });
      event('turn/completed', { turn: { ...t, status: 'failed', error: { message: 'Usage limit exceeded', codexErrorInfo: 'usageLimitExceeded' } } });
      continue;
    }
    if (text.includes('limit')) {
      notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, resetsAt: 1900000000 } } });
      event('turn/completed', { turn: { ...t, status: 'failed', error: { message: 'Usage limit exceeded', codexErrorInfo: 'usageLimitExceeded' } } });
      continue;
    }
    event('item/started', { item: { type: 'commandExecution', id: 'exec', command: 'pwd', status: 'inProgress' } });
    event('item/completed', { item: { type: 'commandExecution', id: 'exec', command: 'pwd', status: 'completed', aggregatedOutput: 'scratch', exitCode: 0 } });
    event('item/agentMessage/delta', { delta: 'o' });
    event('item/agentMessage/delta', { delta: 'k' });
    event('item/completed', { item: { type: 'agentMessage', id: 'msg', text: 'ok', ...(text.includes('phase:') ? { phase: JSON.parse(text.split('phase:')[1]) } : {}) } });
    event('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 40, cachedInputTokens: 10, outputTokens: 2 }, modelContextWindow: 200000 } });
    event('turn/completed', { turn: { ...t, status: 'completed' } });
  } else if (m.method === 'turn/steer') reply({});
  else if (m.method === 'turn/interrupt') {
    reply({});
    event('turn/completed', { turn: { id: `turn-${turn}`, status: 'interrupted' } });
  }
}
