import type {
  AgentRuntimeConfig,
  McpMountSelection,
  McpServerConfig,
  SendOptions,
} from "./agent-runtime.js";

export interface McpTurnSelectionInput {
  message?: string;
  sendOptions?: Pick<
    SendOptions,
    "context" | "currentTurnMetadataPrompt" | "turnBriefingPrompt" | "images"
  >;
  requestedServerNames?: readonly string[];
}

export interface McpTurnSelectionResult {
  config: AgentRuntimeConfig;
  selection: McpMountSelection;
}

const SERVER_KEYWORD_PATTERNS: Record<string, RegExp[]> = {
  "agent-docs": [
    /\b(agent docs?|prompt docs?|soul\.md|knowledge\.md|rules\.md)\b/iu,
  ],
  atlas: [
    /\b(atlas|atlas sql|memory database)\b/iu,
  ],
  attachments: [
    /\[attachments\]/iu,
    /\battachment:\d+\b/iu,
    /\b(attach(?:ed|ment|ments)?|upload(?:ed)?|file|files|pdf|document|documents|docx|spreadsheet|csv|ocr)\b/iu,
    /\b(attached|uploaded|sent).{0,40}\b(image|photo|picture|screenshot)\b/iu,
    /\b(image|photo|picture|screenshot).{0,40}\b(attached|uploaded|sent)\b/iu,
  ],
  browser: [
    /\b(browser|open (?:the )?(?:site|page|url)|website|web page|webpage|click|navigate)\b/iu,
    /https?:\/\//iu,
  ],
  "claude-sessions": [
    /\b(spawn|start|list).{0,40}\b(claude|session|remote control|tmux)\b/iu,
    /\bclaude sessions?\b/iu,
  ],
  // Day One journal tools (dayone_read/dayone_write). The bare name only
  // matches "dayone", so trigger on how people actually refer to a journal.
  dayone: [
    /\b(day ?one|journal|journals|journaling|journaled|diary|on this day)\b/iu,
  ],
  exa: [
    /\b(exa|web search|search the web|research|find sources?|look up)\b/iu,
  ],
  fatsecret: [
    /\b(fatsecret|nutrition api|calorie lookup|food lookup|log food)\b/iu,
  ],
  google: [
    /\b(gmail|email|calendar|google docs?|doc tabs?|google)\b/iu,
  ],
  "study-library": [
    /\b(study library|reading|verse|lesson|talk|manual)\b/iu,
  ],
  "kilo-ledger": [
    /\b(kilo|ledger|allowance|budget|transaction)\b/iu,
  ],
  linear: [
    /\b(linear|issue|ticket|project update|milestone|tgo-\d+)\b/iu,
  ],
  location: [
    /\b(route|directions|near me|nearby|drive|driving|map|maps|gas|diesel|distance)\b/iu,
  ],
  notion: [
    /\b(notion|notion page|notion database)\b/iu,
  ],
  offroad: [
    /\b(off-?road|ohv|atv|utv|dirt ?bike|dual[- ]?sport|adv bike|adventure bike|motorcycle|moto|trail|trails|forest road|fs \d+|nf-?\d+|gravel|mvum|ride ?book|onx|gaia|gpx|loop|route|ride|rides|riding)\b/iu,
  ],
  things: [
    /\b(things(?:\s*3)?|to-?do(?:s| lists?)?|task list|weekly review)\b/iu,
  ],
  obsidian: [
    /\b(obsidian|vault|daily note|note|notes|markdown file)\b/iu,
  ],
  onepassword: [
    /\b(1password|onepassword|secret|credential|password|api key|token)\b/iu,
  ],
  orientation: [
    /\b(orientation|nudge|onboarding)\b/iu,
  ],
  printer: [
    /\b(print|printer|3d print|openscad|prusa|slice|paper print)\b/iu,
  ],
  "send-image": [
    /\b(send|post|drop|share|upload|show).{0,50}\b(image|photo|picture|screenshot|map|visual)\b/iu,
    /\b(image|photo|picture|screenshot|map|visual).{0,50}\b(send|post|drop|share|upload|show)\b/iu,
    /\bconfirm-before-purchase\b/iu,
  ],
  "agent-inbox": [
    /\b(inbox|catch me up|what('?s| is) (waiting|pending|outstanding)|tackle first|what should i (do|work on)|chase|follow up with)\b/iu,
  ],
  screen: [
    /\b(screens?|put (?:it|that|this) up|on the (?:tv|monitor|display|tablet))\b/iu,
  ],
  // Desk mail (apps/screen desk/mail.ts): other conversations, other agents, starting a new thread, and
  // any turn that is itself mail ("✉️ Mail from …", "✉️ Reply from …").
  "desk-mail": [
    /✉️/u,
    /\b(desk mail|other (?:agents?|threads?|conversations?|sessions?)|coding (?:threads?|sessions?)|loom|t3 threads?|which threads?|what(?:'s| is) running)\b/iu,
    /\b(ask|tell|message|mail|check with|ping|hand (?:it|this|that) (?:off|over) to)\b.{0,40}\b(agent|thread|session|conversation|watson|sierra|victor|malibu|papa|foxtrot|juliet|charlie)\b/iu,
    /\b(start|open|spin up|kick off|spawn|create)\b.{0,30}\b(new )?(threads?|sessions?|conversations?|workstreams?)\b/iu,
  ],
  slack: [
    /\b(slack|channel mention|slack thread)\b/iu,
  ],
  state: [
    /\b(state|status|current value|track|tracking|progress|project|trip|travel|vehicle|weight|body fat|protein goal|calorie target|undo that)\b/iu,
  ],
  wellness: [
    /\b(health|wellness|workout|nutrition|meal|recipe|supplement|calorie|sleep|recovery)\b/iu,
  ],
  "wellness-db": [
    /\b(wellness db|wellness database|product|supplement|recipe|meal log|delete product|delete supplement)\b/iu,
  ],
  // Wispr Flow captures meetings/notes; the bare server name ("wispr-flow")
  // only matches when both words are said, so trigger on the vocabulary people
  // actually use for a recorded conversation.
  "wispr-flow": [
    /\b(wispr|wisprflow|scratchpad)\b/iu,
    /\bnotes\.wisprflow\.ai\b/iu,
    // Links resolve_calendar_link accepts: Google Calendar, Meet, and Zoom.
    /\b(?:meet\.google\.com|calendar\.google\.com\/calendar|[\w-]*\.?zoom\.us\/j)\//iu,
    // Meeting discovery: "who did I meet with", "my meeting with Alice".
    /\b(?:did|do|have) (?:i|we) (?:meet|met)\b/iu,
    /\b(?:meet|met|meeting|meetings) with\b/iu,
    /\b(?:find|search|pull up|look up|list|show)\b.{0,30}\bmeetings?\b/iu,
    /\b(meeting|meetings|standup|stand-up|1:1|one[- ]on[- ]one|sync|call|huddle|retro)\b.{0,60}\b(notes?|recap|summar(?:y|ies|i[sz]e)|transcript|recording|action items?|takeaways?|decide[ds]?|decisions?|discuss(?:ed|ions?)?|agree[ds]?|agreements?|commit(?:ted|ments?)?|promised?|said|attendees?|attended|participants?|invitees?|emails?|contacts?)\b/iu,
    /\b(notes?|recap|summar(?:y|ies|i[sz]e)|transcript|recording|action items?|takeaways?|decide[ds]?|decisions?|discuss(?:ed|ions?)?|agree[ds]?|agreements?|commit(?:ted|ments?)?|promised?|said|attendees?|attended|participants?|invitees?|emails?|contacts?)\b.{0,60}\b(meeting|meetings|standup|stand-up|1:1|one[- ]on[- ]one|sync|call|huddle|retro)\b/iu,
  ],
  walmart: [
    /\b(walmart|cart|checkout|order)\b/iu,
  ],
  youtube: [
    /\b(youtube|video transcript|transcript)\b/iu,
  ],
};

function cloneServerConfig(server: McpServerConfig): McpServerConfig {
  return {
    name: server.name,
    ...(server.command ? { command: server.command } : {}),
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}

function normalizeServerName(name: string): string {
  return name.trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function serverNameMentioned(name: string, corpus: string): boolean {
  const normalized = normalizeServerName(name);
  if (!normalized) return false;
  const words = normalized
    .split(/[-_]+/gu)
    .map((part) => escapeRegExp(part))
    .join("[\\s_-]+");
  return new RegExp(`\\b${words}\\b`, "iu").test(corpus);
}

function collectCorpus(input: McpTurnSelectionInput): string {
  return [
    input.message,
    input.sendOptions?.context,
    input.sendOptions?.currentTurnMetadataPrompt,
    input.sendOptions?.turnBriefingPrompt,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
}

function resolveTriggerReasons(
  serverName: string,
  input: McpTurnSelectionInput,
  corpus: string,
): string[] {
  const reasons: string[] = [];
  const normalized = normalizeServerName(serverName);

  if (input.requestedServerNames?.some((name) => normalizeServerName(name) === normalized)) {
    reasons.push("requested");
  }

  if (
    normalized === "attachments"
    && input.sendOptions?.images
    && input.sendOptions.images.length > 0
  ) {
    reasons.push("images-present");
  }

  const patterns = SERVER_KEYWORD_PATTERNS[normalized] ?? [];
  if (patterns.some((pattern) => pattern.test(corpus))) {
    reasons.push("turn-keyword");
  } else if (serverNameMentioned(serverName, corpus)) {
    reasons.push("server-mentioned");
  }

  return [...new Set(reasons)];
}

function mergeServers(
  defaultServers: readonly McpServerConfig[],
  activatedServers: readonly McpServerConfig[],
): McpServerConfig[] {
  const merged: McpServerConfig[] = [];
  const seen = new Set<string>();

  for (const server of [...defaultServers, ...activatedServers]) {
    const name = normalizeServerName(server.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    merged.push(cloneServerConfig(server));
  }

  return merged;
}

export function selectMcpServersForTurn(
  config: AgentRuntimeConfig,
  input: McpTurnSelectionInput,
): McpTurnSelectionResult {
  const defaultServers = config.mcpServers.map((server) => cloneServerConfig(server));
  const availableServers = (config.availableMcpServers ?? []).map((server) => cloneServerConfig(server));
  const corpus = collectCorpus(input);
  const triggerReasons: Record<string, string[]> = {};
  const activatedServers: McpServerConfig[] = [];

  for (const server of availableServers) {
    const reasons = resolveTriggerReasons(server.name, input, corpus);
    if (reasons.length === 0) {
      continue;
    }
    activatedServers.push(server);
    triggerReasons[server.name] = reasons;
  }

  const mountedServers = mergeServers(defaultServers, activatedServers);
  const selection: McpMountSelection = {
    defaultServerNames: defaultServers.map((server) => server.name),
    availableServerNames: availableServers.map((server) => server.name),
    mountedServerNames: mountedServers.map((server) => server.name),
    activatedServerNames: activatedServers.map((server) => server.name),
    triggerReasons,
  };

  return {
    selection,
    config: {
      ...config,
      mcpServers: mountedServers,
      ...(availableServers.length > 0 ? { availableMcpServers: availableServers } : {}),
      mcpMountSelection: selection,
    },
  };
}
