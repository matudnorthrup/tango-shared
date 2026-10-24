import type { AgentBackend, AgentDescriptor, AgentTaskRequest, AgentUpdate } from '../live/agent-backend.js';
import type { ResponsesCaller } from '../live/responses-caller.js';

// Role-played agents for trying the live operator by voice without touching
// real Tango agents. Answers are invented; the UI must say so.

type Turn = { role: 'user' | 'assistant'; text: string };

export interface SimulatedLlmAgentOptions {
  call: ResponsesCaller;
  agents: AgentDescriptor[];
  minDelayMs?: number;
  maxDelayMs?: number;
}

export class SimulatedLlmAgentBackend implements AgentBackend {
  private readonly history = new Map<string, Turn[]>();

  constructor(private readonly options: SimulatedLlmAgentOptions) {}

  send(request: AgentTaskRequest, onUpdate: (update: AgentUpdate) => void): void {
    void this.run(request).then(onUpdate, (err: Error) => onUpdate({ kind: 'result', text: `Sorry, I hit an error: ${err.message}` }));
  }

  private async run(request: AgentTaskRequest): Promise<AgentUpdate> {
    const agent = this.options.agents.find((candidate) => candidate.id === request.agentId);
    const turns = this.history.get(request.taskId) ?? [];
    turns.push({ role: 'user', text: request.message });
    const { minDelayMs = 6000, maxDelayMs = 20000 } = this.options;
    const delay = sleep(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));

    const raw = await this.options.call({
      instructions: [
        `You are ${agent?.name ?? request.agentId}, an AI agent whose specialty is ${agent?.role ?? 'general help'}.`,
        'This is a simulation for testing a voice interface: you have no real tools, so invent plausible, specific results as if you had done the work.',
        'Reply in at most three short spoken-style sentences. No markdown.',
        'If the request is genuinely ambiguous or needs a decision from the user (a choice, an approval), ask exactly one short question instead and set kind to "question".',
      ].join('\n'),
      input: turns,
      schema: {
        name: 'agent_reply',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'text'],
          properties: { kind: { type: 'string', enum: ['result', 'question'] }, text: { type: 'string' } },
        },
      },
    });
    const reply = JSON.parse(raw) as AgentUpdate;
    turns.push({ role: 'assistant', text: reply.text });
    this.history.set(request.taskId, turns);
    await delay;
    return reply;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
