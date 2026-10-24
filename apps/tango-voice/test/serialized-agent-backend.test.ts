import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_TURN_FAILED_TEXT,
  STILL_RUNNING_TEXT,
  SerializedAgentBackend,
  type AgentBackend,
  type AgentTaskRequest,
  type AgentUpdate,
} from '../src/live/agent-backend.js';

/** An agent that answers after `ms` and records what it was asked. */
function fakeAgent(replies: Array<string | ((request: AgentTaskRequest) => string)>, ms = 1000) {
  const calls: AgentTaskRequest[] = [];
  let active = 0;
  let maxActive = 0;
  const backend: AgentBackend = {
    send(request, onUpdate) {
      calls.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const reply = replies.shift() ?? 'ok';
      setTimeout(() => {
        active -= 1;
        onUpdate({ kind: 'result', text: typeof reply === 'function' ? reply(request) : reply });
      }, ms);
    },
  };
  return { backend, calls, maxActive: () => maxActive };
}

const request = (taskId: string, message: string, turn = 0, agentId = 'sierra'): AgentTaskRequest => ({ taskId, agentId, message, turn });

describe('SerializedAgentBackend', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never runs two turns for the same agent at once', async () => {
    const agent = fakeAgent(['first', 'second']);
    const results: string[] = [];
    const serialized = new SerializedAgentBackend(agent.backend);
    serialized.send(request('t1', 'plan the trip'), (u) => results.push(u.text));
    serialized.send(request('t2', 'find lunch'), (u) => results.push(u.text));
    await vi.advanceTimersByTimeAsync(2500);
    expect(agent.maxActive()).toBe(1);
    expect(results).toEqual(['first', 'second']);
  });

  it('runs different agents in parallel', async () => {
    const agent = fakeAgent(['a', 'b']);
    const serialized = new SerializedAgentBackend(agent.backend);
    serialized.send(request('t1', 'x', 0, 'sierra'), () => {});
    serialized.send(request('t2', 'y', 0, 'watson'), () => {});
    await vi.advanceTimersByTimeAsync(10);
    expect(agent.maxActive()).toBe(2);
  });

  it('merges follow-ups for the same task that queued behind a busy agent', async () => {
    const agent = fakeAgent(['working', 'merged']);
    const updates: AgentUpdate[] = [];
    const serialized = new SerializedAgentBackend(agent.backend);
    serialized.send(request('t1', 'plan the trip'), () => {});
    serialized.send(request('t2', 'add Costco', 0), () => {});
    serialized.send(request('t2', 'and lunch', 1), (u) => updates.push(u));
    await vi.advanceTimersByTimeAsync(2500);
    expect(agent.calls.map((call) => call.message)).toEqual(['plan the trip', 'add Costco\n\nand lunch']);
    expect(updates.map((u) => u.text)).toEqual(['merged']);
    // The relay covers both questions, not just the last fragment (Codex review on #426).
    expect(updates[0].asked).toBe('add Costco\n\nand lunch');
  });

  it('retries a crashed turn once instead of relaying the canned error', async () => {
    const agent = fakeAgent([AGENT_TURN_FAILED_TEXT, 'real answer']);
    const updates: AgentUpdate[] = [];
    const serialized = new SerializedAgentBackend(agent.backend, () => {}, 500);
    serialized.send(request('t1', 'plan'), (u) => updates.push(u));
    await vi.advanceTimersByTimeAsync(3000);
    expect(agent.calls).toHaveLength(2);
    expect(updates.map((u) => u.text)).toEqual(['real answer']);
  });

  it('never resends a turn that timed out: it may still be running, with side effects', async () => {
    const agent = fakeAgent([STILL_RUNNING_TEXT, 'second run']);
    const updates: AgentUpdate[] = [];
    const serialized = new SerializedAgentBackend(agent.backend, () => {}, 500);
    serialized.send(request('t1', 'delete the extra draft copies'), (u) => updates.push(u));
    await vi.advanceTimersByTimeAsync(3000);
    expect(agent.calls).toHaveLength(1);
    expect(updates.map((u) => u.text)).toEqual([STILL_RUNNING_TEXT]);
  });

  it('holds the conversation after a timeout until the bot says the turn is done', async () => {
    const agent = fakeAgent([STILL_RUNNING_TEXT, 'follow-up answer']);
    let running = true;
    const serialized = new SerializedAgentBackend(agent.backend, () => {}, 500, { stillRunning: async (conversation) => running && conversation === 'sierra|', probeMs: 1000 });
    serialized.send(request('t1', 'long job'), () => {});
    await vi.advanceTimersByTimeAsync(500);
    serialized.send(request('t1', 'and one more thing'), () => {});
    await vi.advanceTimersByTimeAsync(5000);
    expect(agent.calls).toHaveLength(1); // still held: nothing runs on top of the timed-out turn
    running = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(agent.calls).toHaveLength(2);
  });

  it('keeps holding when the probe fails, until it answers or the cap runs out', async () => {
    const agent = fakeAgent([STILL_RUNNING_TEXT, 'follow-up answer']);
    const serialized = new SerializedAgentBackend(agent.backend, () => {}, 500, {
      stillRunning: async () => {
        throw new Error('status endpoint down');
      },
      probeMs: 1000,
      holdMaxMs: 10_000,
    });
    serialized.send(request('t1', 'long job'), () => {});
    await vi.advanceTimersByTimeAsync(500);
    serialized.send(request('t1', 'and one more thing'), () => {});
    await vi.advanceTimersByTimeAsync(5000);
    expect(agent.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(agent.calls).toHaveLength(2);
  });

  it('reports a plain failure if the retry also crashes', async () => {
    const agent = fakeAgent([AGENT_TURN_FAILED_TEXT, AGENT_TURN_FAILED_TEXT]);
    const updates: AgentUpdate[] = [];
    const serialized = new SerializedAgentBackend(agent.backend, () => {}, 500);
    serialized.send(request('t1', 'plan'), (u) => updates.push(u));
    await vi.advanceTimersByTimeAsync(3000);
    expect(updates).toHaveLength(1);
    expect(updates[0].text).not.toBe(AGENT_TURN_FAILED_TEXT);
  });
});
