import type { AgentTool } from "@tango/core";

const DEFAULT_SCREEN_URL = "http://127.0.0.1:9410";

export interface AgentInboxToolOptions {
  screenUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * `agent_inbox`: the owner's agent inbox (apps/screen), for the chief of staff.
 * One item per open topic across all the owner's agents: what waits on the
 * owner, what agents are working on, updates, parked items. Read it to brief
 * and prioritize; mark items only when the owner says so.
 */
export function createAgentInboxTools(options: AgentInboxToolOptions = {}): AgentTool[] {
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = (options.screenUrl ?? process.env.TANGO_SCREEN_URL ?? DEFAULT_SCREEN_URL).replace(/\/$/, "");

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(20_000),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`inbox unreachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text || `HTTP ${response.status}` };
    }
    if (!response.ok) throw new Error(String((parsed as { error?: unknown }).error ?? `inbox returned HTTP ${response.status}`));
    return parsed;
  }

  /** Keep results small: the fields that matter for briefing and triage. */
  function compact(item: Record<string, unknown>): Record<string, unknown> {
    const fields = ["id", "kind", "agentId", "agentName", "place", "summary", "status", "state", "acked", "note", "lastActivityAt", "labels", "quiet"];
    return Object.fromEntries(fields.filter((field) => item[field] !== undefined && item[field] !== null).map((field) => [field, item[field]]));
  }

  return [
    {
      name: "agent_inbox",
      description: [
        "The owner's agent inbox: one item per open topic across all their agents (threads, and topics in each agent's chat), the same list their screens and the voice operator use.",
        "action=briefing: ranked open items per agent plus a ready-to-say summary (start here for 'catch me up' / 'what should I tackle first').",
        "action=list: items for a view: filter active (default) | needs_you | in_progress | done | later | archive | all; optional agent (e.g. foxtrot); sort smart (default) | recent | agent.",
        "action=item (id): one item with its messages, oldest first; author 'owner' is the owner, 'agent' is the agent.",
        "action=mark (id, mark): done (✅ on the agent's last message; a thread is closed) | seen (👍: stays open, quiet) | later (optional note) | dismiss | reopen. Only mark what the owner asked you to mark.",
        "Statuses: needs_you (the agent asked the owner something), in_progress (the owner asked; the agent is working), done (an update). To chase or answer another agent, use collaborate_with_agent; to see the full guide, read agents/skills/inbox-chief-of-staff.md via agent_docs.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["briefing", "list", "item", "mark"] },
          filter: { type: "string", enum: ["active", "needs_you", "in_progress", "done", "later", "archive", "all"] },
          agent: { type: "string", description: "Agent id to narrow list to (e.g. foxtrot)." },
          sort: { type: "string", enum: ["smart", "recent", "agent"] },
          id: { type: "string", description: "Inbox item id (item, mark)." },
          mark: { type: "string", enum: ["done", "seen", "later", "dismiss", "reopen"] },
          note: { type: "string", description: "For mark later: why or when." },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = typeof input.action === "string" ? input.action : "briefing";
        const id = typeof input.id === "string" ? input.id.trim() : "";
        switch (action) {
          case "briefing":
            return call("GET", "/api/inbox/briefing");
          case "list": {
            const params = new URLSearchParams({
              filter: typeof input.filter === "string" ? input.filter : "active",
              sort: typeof input.sort === "string" ? input.sort : "smart",
            });
            if (typeof input.agent === "string" && input.agent.trim()) params.set("agent", input.agent.trim());
            const result = (await call("GET", `/api/inbox?${params}`)) as { items: Array<Record<string, unknown>>; counts: unknown };
            return { counts: result.counts, items: result.items.slice(0, 40).map(compact) };
          }
          case "item": {
            if (!id) throw new Error("id is required for item");
            const result = (await call("GET", `/api/inbox/${encodeURIComponent(id)}`)) as Record<string, unknown> & { messages?: Array<Record<string, unknown>> };
            return {
              ...compact(result),
              messages: (result.messages ?? []).slice(-12).map((message) => ({ author: message.author, at: message.at, text: String(message.text ?? "").slice(0, 2000) })),
            };
          }
          case "mark": {
            if (!id) throw new Error("id is required for mark");
            const mark = typeof input.mark === "string" ? input.mark : "";
            const path = mark === "seen" ? "react" : mark;
            if (!["done", "react", "later", "dismiss", "reopen"].includes(path)) throw new Error("mark must be done, seen, later, dismiss, or reopen");
            const body = mark === "seen" ? { emoji: "👍" } : mark === "later" && typeof input.note === "string" ? { note: input.note } : {};
            return compact((await call("POST", `/api/inbox/${encodeURIComponent(id)}/${path}`, body)) as Record<string, unknown>);
          }
          default:
            throw new Error(`unknown action '${action}' (use briefing, list, item, or mark)`);
        }
      },
    },
  ];
}
