import { attachmentProblems, type StartAttachment } from './attachments.js';
import { titleFromPrompt } from './start-work.js';

// A new thread with a named agent (Sierra, Foxtrot, …) from the Start work sheet: the bot opens a
// thread in the agent's home channel (a forum post when that's a forum), posts the owner's words as
// its first message, and wakes the agent there. The desk files it as `discord:thread:<id>` on its
// next Discord poll, which a start runs right away.

export interface AgentStartAgent {
  id: string;
  name: string;
  homeChannelId: string;
}

export interface AgentStartRequest {
  agentId?: string;
  prompt?: string;
  title?: string;
  attachments?: StartAttachment[];
  /** Client-generated; a retry with the same id returns the first result instead of a second thread. */
  commandId?: string;
}

export type AgentStartResult =
  | { ok: true; itemId: string; threadId: string; agent: { id: string; name: string }; title: string }
  | { ok: false; error: string; status: number };

export interface AgentStartDeps {
  agents: () => AgentStartAgent[];
  /** The bot's /screen/input with `type: "start"`: the new thread's id, or why not. */
  startInBot: (body: Record<string, unknown>) => Promise<{ ok: true; threadId: string; conversationKey?: string } | { ok: false; error: string }>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export class AgentStart {
  private readonly started = new Map<string, AgentStartResult>();
  private readonly inFlight = new Map<string, Promise<AgentStartResult>>();

  constructor(private readonly deps: AgentStartDeps) {}

  /** The agents a thread can start with: id and name only (channels stay on the server). */
  agents(): Array<{ id: string; name: string }> {
    return this.deps.agents().map(({ id, name }) => ({ id, name }));
  }

  async start(request: AgentStartRequest): Promise<AgentStartResult> {
    const key = request.commandId?.trim();
    if (key) {
      const done = this.started.get(key) ?? (await this.inFlight.get(key));
      if (done?.ok) return done;
    }
    const attempt = this.launch(request);
    if (key) this.inFlight.set(key, attempt);
    const result = await attempt.finally(() => key && this.inFlight.delete(key));
    if (key && result.ok) {
      this.started.set(key, result);
      if (this.started.size > 200) this.started.delete(this.started.keys().next().value!);
    }
    return result;
  }

  private async launch(request: AgentStartRequest): Promise<AgentStartResult> {
    const agent = this.deps.agents().find((a) => a.id === request.agentId);
    if (!agent) return { ok: false, error: `No agent named “${request.agentId ?? ''}”`, status: 422 };
    const prompt = request.prompt?.trim() ?? '';
    const attachments = request.attachments ?? [];
    if (!prompt && !attachments.length) return { ok: false, error: 'Say what the new thread should work on', status: 422 };
    const problems = attachmentProblems(attachments).problems;
    if (problems.length) return { ok: false, error: problems.join(' '), status: 422 };
    const title = request.title?.trim() || titleFromPrompt(prompt) || 'New thread';
    const sent = await this.deps.startInBot({
      agentId: agent.id,
      channelId: agent.homeChannelId,
      type: 'start',
      sceneTitle: title,
      data: { text: prompt, title, ...(attachments.length ? { attachments } : {}) },
      ...(request.commandId ? { commandId: request.commandId } : {}),
    });
    if (!sent.ok) {
      this.deps.log?.('desk.agent-start.error', { agentId: agent.id, message: sent.error });
      return { ok: false, error: sent.error, status: 502 };
    }
    this.deps.log?.('desk.agent-start', { agentId: agent.id, threadId: sent.threadId });
    return { ok: true, itemId: sent.conversationKey ? `tango:${sent.conversationKey}` : `discord:thread:${sent.threadId}`, threadId: sent.threadId, agent: { id: agent.id, name: agent.name }, title };
  }
}
