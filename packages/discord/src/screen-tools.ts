import type { AgentTool } from "@tango/core";

const DEFAULT_SCREEN_URL = "http://127.0.0.1:9410";

export interface ScreenToolOptions {
  screenUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * `screen` stages visual scenes for the Tango screen service (apps/screen):
 * tailnet pages the owner leaves open around the house. Agents only stage; the
 * voice operator decides what is showing. The MCP server injects the trusted
 * `_requester_agent_id`, `_channel_id`, and `_thread_id`, so a scene belongs to
 * the calling agent and taps on it come back to this conversation.
 */
interface SceneConversationFilter {
  conversationKey?: string;
  threadId?: string;
  channelId?: string;
}

function trustedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The turn's conversation, from the runtime-injected (trusted) context keys only. */
function sceneConversationFrom(input: Record<string, unknown>): SceneConversationFilter {
  const conversationKey = trustedString(input._conversation_key);
  const threadId = trustedString(input._thread_id);
  const channelId = trustedString(input._channel_id);
  return {
    ...(conversationKey ? { conversationKey } : {}),
    ...(threadId ? { threadId } : {}),
    ...(channelId ? { channelId } : {}),
  };
}

export function createScreenTools(options: ScreenToolOptions = {}): AgentTool[] {
  const fetchFn = options.fetchImpl ?? fetch;
  const baseUrl = (options.screenUrl ?? process.env.TANGO_SCREEN_URL ?? DEFAULT_SCREEN_URL).replace(/\/$/, "");

  async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(`screen service unreachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { error: text || `HTTP ${response.status}` };
    }
    if (!response.ok) throw new Error(String(parsed.error ?? `screen service returned HTTP ${response.status}`));
    return parsed;
  }

  /**
   * The calling agent's scene in `slot` for THIS conversation. Scene identity is
   * (conversation, agent, slot), so the turn's conversation goes along as query
   * filters; an older screen service ignores them and matches by agent + slot.
   */
  async function sceneForSlot(
    agentId: string,
    slot: string,
    conversation: SceneConversationFilter,
  ): Promise<Record<string, unknown> | null> {
    const query = new URLSearchParams({ slot });
    if (conversation.conversationKey) query.set("conversationKey", conversation.conversationKey);
    if (conversation.threadId) query.set("threadId", conversation.threadId);
    if (conversation.channelId) query.set("channelId", conversation.channelId);
    const { scenes } = await call("GET", `/api/stages/${encodeURIComponent(agentId)}?${query.toString()}`) as { scenes: Array<Record<string, unknown>> };
    return scenes[0] ?? null;
  }

  return [
    {
      name: "screen",
      description: [
        "Put something on the owner's screens: tailnet pages left open around the house that show what agents stage.",
        "You STAGE scenes; the voice operator decides when yours shows (when the conversation is about you, when asked, or when urgent). Stage when the request says a screen is live or the owner asks to see something — not on ordinary text turns.",
        "action=stage: kind html (default) | markdown | image | video | url. body = your HTML/markdown, an absolute local file path (image/video), or an http(s) URL. summary (required) = one sentence the operator can say and match against (\"the middle one\").",
        "Content is yours to design: any HTML, inline CSS/JS, CDN libraries (cdn.jsdelivr.net, cdnjs). Base styles give big readable type and CSS vars (--bg --fg --muted --card --line --accent --good --warn --bad) plus a .card class; override freely. Design for a glance from across the room.",
        "Screens range from a phone (390px wide) to a TV, so every scene must be responsive: fluid widths only (%, flex-wrap, grid-template-columns: repeat(auto-fit, minmax(min(100%, 16em), 1fr))), no fixed pixel widths on containers, and wide tables become stacked cards under @media (max-width: 640px). The check renders at phone width and errors on anything wider than the screen.",
        "kind url with a Google Docs/Sheets/Slides/Drive link or a Linear issue, project, or document link (linear.app/<workspace>/issue|project|document/…) shows its content, read with the owner's accounts and laid out for the screen; the result's google or linear field says whether the read worked. Prefer this over rebuilding a Linear project or doc as HTML.",
        "slot names the scene (default 'main'). Staging the same slot again replaces it in place — use one slot for a running deliverable (a ranking, plan, or decision board) and re-stage it as the conversation refines it. Give a different scene (a deep dive on one pick, a new topic) its own slot so the earlier one stays available.",
        "choices: [{id,label}] the owner can pick by tapping or by voice. In HTML, put data-choice=\"<id>\" on any clickable element (or call tango.choose(id)). Picks come back to you as a message.",
        "Live scenes: pass state (JSON) and render from it with tango.onState(fn); later, action=update with slot + state changes only the data — cheap for charts and running totals.",
        "Voice commands reach the page through tango.onCommand(fn) with names like next, back, play, pause (step guides, videos).",
        "The result includes a headless render check at desktop and phone width: fix any listed errors and re-stage (warnings are worth fixing too). check.screenshot and check.phoneScreenshot are PNGs of how it looks.",
        "action=update (slot, state and/or summary), action=clear (slot, or all your scenes), action=list (screens connected, what is showing, your scenes).",
        "action=watch_pr (url = a GitHub PR link): when work is waiting on a teammate's PR review, hand the wait to the owner's desk instead of polling or holding a background job open. The desk checks GitHub for as long as it takes (days or weeks), shows this conversation as Watching meanwhile, and on approval posts a message here so you pick it back up and merge if the project allows (on_approve 'notify' instead: the owner only sees 'approved — merge?'). Merged or closed PRs drop off on their own; off: true stops watching.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["stage", "update", "clear", "list", "watch_pr"] },
          url: { type: "string", description: "watch_pr: the GitHub pull request link." },
          on_approve: { type: "string", enum: ["continue", "notify"], description: "watch_pr: continue (default) wakes you here on approval; notify only tells the owner." },
          off: { type: "boolean", description: "watch_pr: stop watching this PR." },
          kind: { type: "string", enum: ["html", "markdown", "image", "video", "url"] },
          body: { type: "string", description: "HTML or markdown source, an absolute local file path (image/video), or an http(s) URL (stage)." },
          summary: { type: "string", description: "One sentence: what the scene shows (stage, optional on update)." },
          title: { type: "string", description: "Short title for the dashboard tile and the screen bar (stage)." },
          slot: { type: "string", description: "Scene name within your stage; same slot replaces in place. Default 'main'." },
          choices: {
            type: "array",
            description: "Options the owner can pick, in visual order (stage).",
            items: {
              type: "object",
              properties: { id: { type: "string" }, label: { type: "string" } },
              required: ["label"],
            },
          },
          state: { type: "object", description: "Live data for tango.onState (stage); merged in on update." },
          urgent: { type: "boolean", description: "Ask the operator to show it now (stage). Only for time-sensitive things." },
          ttl_minutes: { type: "number", description: "How long the scene stays staged (default 120)." },
          all: { type: "boolean", description: "clear: remove all your scenes instead of one slot." },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const agentId = typeof input._requester_agent_id === "string" ? input._requester_agent_id.trim() : "";
        if (!agentId) throw new Error("screen requires a calling agent identity");
        const action = typeof input.action === "string" ? input.action : "list";
        const slot = typeof input.slot === "string" && input.slot.trim() ? input.slot.trim() : "main";
        const conversation = sceneConversationFrom(input);

        switch (action) {
          case "stage": {
            const result = await call("POST", "/api/scenes", {
              agentId,
              kind: input.kind ?? "html",
              body: input.body,
              summary: input.summary,
              title: input.title,
              slot,
              choices: input.choices,
              state: input.state,
              urgent: input.urgent === true,
              ...(typeof input.ttl_minutes === "number" ? { ttlMinutes: input.ttl_minutes } : {}),
              channelId: input._channel_id,
              threadId: input._thread_id,
              conversationKey: input._conversation_key,
            });
            const screens = Number(result.screens ?? 0);
            return {
              ...result,
              note: screens === 0
                ? "Staged, but no screen is connected right now; it will be there when one opens."
                : result.showing
                  ? "Staged and on screen now."
                  : result.operatorLive
                    ? "Staged. The operator will put it up when the conversation turns to you."
                    : "Staged. It shows on the dashboard; the owner can tap it.",
            };
          }
          case "update": {
            const scene = await sceneForSlot(agentId, slot, conversation);
            if (!scene) throw new Error(`no live scene in slot '${slot}'; stage it first`);
            return call("PATCH", `/api/scenes/${encodeURIComponent(String(scene.id))}`, {
              state: input.state,
              summary: input.summary,
            });
          }
          case "clear": {
            if (input.all === true) return call("DELETE", `/api/stages/${encodeURIComponent(agentId)}`);
            const scene = await sceneForSlot(agentId, slot, conversation);
            if (!scene) return { cleared: [] };
            return call("DELETE", `/api/scenes/${encodeURIComponent(String(scene.id))}`);
          }
          case "list": {
            const status = await call("GET", "/api/status") as {
              screens: unknown[];
              operatorLive: boolean;
              showing: Record<string, unknown> | null;
              stages: Array<{ agentId: string; scenes: unknown[] }>;
            };
            return {
              screens: status.screens.length,
              operatorLive: status.operatorLive,
              showing: status.showing
                ? { agentId: status.showing.agentId, slot: status.showing.slot, summary: status.showing.summary }
                : null,
              yourScenes: status.stages.find((stage) => stage.agentId === agentId)?.scenes ?? [],
            };
          }
          case "watch_pr": {
            const url = typeof input.url === "string" ? input.url.trim() : "";
            if (!url) throw new Error("watch_pr needs url (a GitHub pull request link)");
            if (!conversation.conversationKey && !conversation.threadId && !conversation.channelId) throw new Error("watch_pr needs the conversation this turn runs in");
            // The same key the desk files a background job under: the thread, else the conversation, else the channel.
            const conversationKey = conversation.threadId
              ? `thread:${conversation.threadId}`
              : (conversation.conversationKey ?? `channel:${conversation.channelId}`);
            const result = await call("POST", "/api/desk/pr-watch", {
              conversationKey,
              url,
              onApprove: input.on_approve === "notify" ? "notify" : "continue",
              off: input.off === true,
            });
            return {
              ...result,
              note: input.off === true
                ? "Stopped watching."
                : "The desk is watching the review; you can end your turn. On approval it posts here (continue) or tells the owner (notify).",
            };
          }
          default:
            throw new Error(`unknown action '${action}' (use stage, update, clear, list, or watch_pr)`);
        }
      },
    },
  ];
}
