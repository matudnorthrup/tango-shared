import type { AgentTool } from "@tango/core";

const DEFAULT_SCREEN_URL = "http://127.0.0.1:9410";
const START_TIMEOUT_MS = 180_000;

export interface DeskMailToolOptions {
  screenUrl?: string;
  fetchImpl?: typeof fetch;
}

function trustedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The calling conversation, as the desk files it: the thread, else the conversation, else the channel
 * (the same key `screen` watch_pr and background jobs use). Only the runtime-injected (trusted) keys count,
 * so an agent can't mail as another conversation.
 */
export function deskConversationKey(input: Record<string, unknown>): string | undefined {
  const threadId = trustedString(input._thread_id);
  const conversationKey = trustedString(input._conversation_key);
  const channelId = trustedString(input._channel_id);
  return threadId ? `thread:${threadId}` : conversationKey ?? (channelId ? `channel:${channelId}` : undefined);
}

/**
 * `desk_mail` (apps/screen/server/desk/mail.ts): see the other conversations on the owner's desk (Tango
 * agents and Loom coding threads) with their status, read one, mail it a question (its answer comes
 * back to this conversation as a message), and start a new coding thread for a separate piece of work.
 */
export function createDeskMailTools(options: DeskMailToolOptions = {}): AgentTool[] {
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = (options.screenUrl ?? process.env.TANGO_SCREEN_URL ?? DEFAULT_SCREEN_URL).replace(/\/$/, "");

  async function call(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`the desk is unreachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const raw = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = { error: raw || `HTTP ${response.status}` };
    }
    if (!response.ok) throw new Error(String(parsed.error ?? `the desk returned HTTP ${response.status}`));
    return parsed;
  }

  return [
    {
      name: "desk_mail",
      description: [
        "Talk to the other conversations on the owner's desk: other Tango agents' threads and the owner's coding threads (Loom). Use it when another conversation knows something you need, owns work you depend on, or should hear about something — instead of asking the owner to carry messages.",
        "action=threads: every open conversation with its id, status (working, idle, needs owner, failed, watching), title, agent and project. Filters: status, agent, project; all=true includes finished ones.",
        "action=peek (item_id): one conversation, read-only: where it stands and its last messages.",
        "action=send (to = item_id, text): mail it. It is delivered when that conversation is next idle; its answer comes back to THIS conversation as a message starting '✉️ Reply from …' (reply=false for an FYI that needs no answer). Mail is words only: it never answers or approves anything a conversation is waiting on the owner for. Keep Discord-bound mail under about 1500 characters.",
        "action=start (prompt, repo; optional title, project_id, report=false): start a NEW coding thread (Loom, best account) for a separate piece of work the owner wants done, e.g. 'build the card back art pipeline'. prompt is its full task; repo is the codebase it works in (required from here). Its first answer comes back to this conversation as mail. Start one only when the owner asked for the work or it clearly follows from what they asked; at most a few an hour.",
        "action=mail: this conversation's mail, sent and received, with answers.",
        "action=reply (mail_id, text): answer mail directly, when its footer asks you to.",
        "Mail you receive starts with '✉️ Mail from “…” [item_id] · m-…': answer it in your reply, briefly; the desk takes your reply back. The owner sees all mail in both conversations on the desk.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["threads", "peek", "send", "reply", "start", "mail"] },
          mail_id: { type: "string", description: "reply: the mail's id (m-…, from its header)" },
          item_id: { type: "string", description: "peek: the conversation's id (from threads)" },
          to: { type: "string", description: "send: the conversation's id (from threads)" },
          text: { type: "string", description: "send: the message" },
          reply: { type: "boolean", description: "send: false when no answer is needed (default true)" },
          prompt: { type: "string", description: "start: the new thread's full task" },
          repo: { type: "string", description: "start: the repo it works in (e.g. tango)" },
          title: { type: "string", description: "start: a short title (default: the task's first line)" },
          project_id: { type: "string", description: "start: the desk project it joins (default: this conversation's)" },
          report: { type: "boolean", description: "start: false when its first answer needn't come back (default true)" },
          status: { type: "string", description: "threads: working | idle | needs owner | failed | watching" },
          agent: { type: "string", description: "threads: an agent's id or name" },
          project: { type: "string", description: "threads: a desk project id" },
          all: { type: "boolean", description: "threads: include finished conversations" },
          limit: { type: "number", description: "threads: how many, newest first (default 30)" },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = text(input.action);
        const fromConversationKey = deskConversationKey(input);
        switch (action) {
          case "threads": {
            const query = new URLSearchParams();
            for (const key of ["status", "agent", "project"] as const) {
              const value = text(input[key]);
              if (value) query.set(key, value);
            }
            if (input.all === true) query.set("all", "1");
            // Enough to pick from without flooding the turn: the newest 30.
            query.set("limit", String(Math.min(100, Math.max(1, Number(input.limit) || 30))));
            // The desk marks this conversation as `you`, so the agent doesn't mail itself.
            if (fromConversationKey) query.set("conversationKey", fromConversationKey);
            return call("GET", `/api/desk/mail/threads?${query.toString()}`);
          }
          case "peek": {
            const id = text(input.item_id) ?? text(input.to);
            if (!id) throw new Error("peek needs item_id (from threads)");
            return call("GET", `/api/desk/mail/peek/${encodeURIComponent(id)}?limit=12`);
          }
          case "send": {
            const to = text(input.to) ?? text(input.item_id);
            const body = text(input.text);
            if (!to || !body) throw new Error("send needs to (an item id from threads) and text");
            if (!fromConversationKey) throw new Error("send needs the conversation this turn runs in");
            return call("POST", "/api/desk/mail", { fromConversationKey, to, text: body, expect: input.reply === false ? "none" : "reply" });
          }
          case "start": {
            const prompt = text(input.prompt);
            if (!prompt) throw new Error("start needs prompt (the new thread's full task)");
            if (!fromConversationKey) throw new Error("start needs the conversation this turn runs in");
            // One id for this start: a retry after a timeout is the same start, never a second thread.
            const body = {
              fromConversationKey,
              prompt,
              commandId: `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
              ...(text(input.repo) ? { repo: text(input.repo) } : {}),
              ...(text(input.title) ? { title: text(input.title) } : {}),
              ...(text(input.project_id) ? { projectId: text(input.project_id) } : {}),
              report: input.report !== false,
            };
            try {
              // Past Loom's own 150 s for making a worktree.
              return await call("POST", "/api/desk/mail/start", body, START_TIMEOUT_MS);
            } catch (error) {
              if (!/unreachable|aborted|timeout/i.test(error instanceof Error ? error.message : String(error))) throw error;
              return call("POST", "/api/desk/mail/start", body, START_TIMEOUT_MS);
            }
          }
          case "reply": {
            const id = text(input.mail_id);
            const body = text(input.text);
            if (!id || !body) throw new Error("reply needs mail_id and text");
            if (!fromConversationKey) throw new Error("reply needs the conversation this turn runs in");
            return call("POST", `/api/desk/mail/${encodeURIComponent(id)}/answer`, { fromConversationKey, text: body });
          }
          case "mail": {
            if (!fromConversationKey) throw new Error("mail needs the conversation this turn runs in");
            return call("GET", `/api/desk/mail?conversationKey=${encodeURIComponent(fromConversationKey)}`);
          }
          default:
            throw new Error("action must be threads, peek, send, start or mail");
        }
      },
    },
  ];
}
