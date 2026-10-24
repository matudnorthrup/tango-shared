/**
 * Notion Agent Tools — direct Notion API integration (stable, long-lived).
 *
 * Replaces the Acme remote-MCP bridge for Notion, which relied on an OAuth
 * token that expired hourly and did not reliably refresh. This tool uses a
 * Notion *internal integration token* (no expiry) the same way the Linear/Slack
 * tools use direct API keys.
 *
 * Credentials are resolved entirely from the environment/profile layer: this
 * repo carries no vault name, item name, workspace id, or page id belonging to
 * any particular operator. See `agents/tools/notion.md` for the generic setup
 * and `docs/guides/profile-model.md` for the layering rules.
 *
 * Setup (one-time, per installation):
 *   1. Create an internal integration at notion.so/my-integrations.
 *   2. Share the pages/databases it should reach with that integration.
 *   3. Expose the token as NOTION_API_KEY, or point Tango at a 1Password item
 *      with NOTION_1PASSWORD_VAULT + NOTION_1PASSWORD_ITEM.
 */

import type { AgentTool } from "@tango/core";
import { getSecret } from "./op-secret.js";

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/** Notion caps a single rich-text run at 2000 characters. */
const RICH_TEXT_LIMIT = 2000;
/** Notion caps one block-children request at 100 blocks. */
const MAX_BLOCKS_PER_REQUEST = 100;
/** Depth limit when flattening nested blocks on read. */
const MAX_BLOCK_DEPTH = 3;
/** Page-cursor guard when walking block children. */
const MAX_BLOCK_PAGES = 20;

/* -------------------------------------------------------------------------- */
/* Credentials and workspaces (profile layer — never hardcoded in this repo)   */
/* -------------------------------------------------------------------------- */

/*
 * A Notion internal integration token is scoped to exactly ONE workspace and
 * cannot reach across workspaces. An installation that spans more than one
 * (say a work workspace and a personal one) therefore needs one token per
 * workspace, and — more importantly — needs agents pinned to the workspace
 * they belong in. Routing is a safety boundary, not a convenience: an agent
 * handling private material must not be able to write it into a shared or
 * employer-owned workspace by picking the wrong id.
 *
 * Env surface (all values live in the profile layer):
 *   NOTION_API_KEY                    token for the default workspace
 *   NOTION_1PASSWORD_VAULT/_ITEM/_FIELD   1Password ref for the default workspace
 *   NOTION_API_KEY_<WS>               token for named workspace <WS>
 *   NOTION_1PASSWORD_VAULT_<WS> / _ITEM_<WS> / _FIELD_<WS>
 *   NOTION_DEFAULT_WORKSPACE          name of the unnamed/default workspace
 *   NOTION_WORKSPACES_<AGENT>         comma-separated allowlist; first = default
 *
 * With none of the named vars set this behaves exactly as a single-workspace
 * install, so existing setups keep working untouched.
 */

/** Direct token. Simplest path and the one CI/test runs use. */
export const NOTION_TOKEN_ENV = "NOTION_API_KEY";
/** 1Password fallback: which vault holds the token item. */
export const NOTION_VAULT_ENV = "NOTION_1PASSWORD_VAULT";
/** 1Password fallback: the item title or id. */
export const NOTION_ITEM_ENV = "NOTION_1PASSWORD_ITEM";
/** 1Password fallback: the field on that item (defaults to "credential"). */
export const NOTION_FIELD_ENV = "NOTION_1PASSWORD_FIELD";
/** Name given to the workspace configured by the unsuffixed vars above. */
export const NOTION_DEFAULT_WORKSPACE_ENV = "NOTION_DEFAULT_WORKSPACE";
const DEFAULT_CREDENTIAL_FIELD = "credential";
const FALLBACK_WORKSPACE_NAME = "default";

export const NOTION_SETUP_HINT =
  `Notion is not configured for this installation. Set ${NOTION_TOKEN_ENV} to a Notion ` +
  `internal integration token, or point Tango at a 1Password item with ${NOTION_VAULT_ENV} ` +
  `and ${NOTION_ITEM_ENV} (field ${NOTION_FIELD_ENV}, default "${DEFAULT_CREDENTIAL_FIELD}"). ` +
  "Create the token at notion.so/my-integrations and share the pages or databases it " +
  "should reach with that integration.";

function envValue(name: string): string | null {
  const raw = process.env[name];
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Workspace/agent names become env-var suffixes: lowercase-kebab → UPPER_SNAKE. */
function envSuffix(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function notionDefaultWorkspace(): string {
  return (envValue(NOTION_DEFAULT_WORKSPACE_ENV) ?? FALLBACK_WORKSPACE_NAME).toLowerCase();
}

interface WorkspaceCredentialRef {
  workspace: string;
  tokenEnv: string;
  vaultEnv: string;
  itemEnv: string;
  fieldEnv: string;
  vault: string | null;
  item: string | null;
  field: string;
  hasDirectToken: boolean;
  configured: boolean;
}

/**
 * Env var names for one workspace. The default workspace uses the unsuffixed
 * vars; every other workspace gets a `_<WS>` suffix.
 */
function credentialEnvNames(workspace: string): Pick<WorkspaceCredentialRef, "tokenEnv" | "vaultEnv" | "itemEnv" | "fieldEnv"> {
  if (workspace === notionDefaultWorkspace()) {
    return {
      tokenEnv: NOTION_TOKEN_ENV,
      vaultEnv: NOTION_VAULT_ENV,
      itemEnv: NOTION_ITEM_ENV,
      fieldEnv: NOTION_FIELD_ENV,
    };
  }
  const s = envSuffix(workspace);
  return {
    tokenEnv: `${NOTION_TOKEN_ENV}_${s}`,
    vaultEnv: `${NOTION_VAULT_ENV}_${s}`,
    itemEnv: `${NOTION_ITEM_ENV}_${s}`,
    fieldEnv: `${NOTION_FIELD_ENV}_${s}`,
  };
}

/**
 * Where this installation keeps the token for a workspace. Values come from the
 * profile layer, so the repo stays generic and shareable.
 */
export function notionCredentialRef(workspace?: string): WorkspaceCredentialRef {
  const ws = (workspace ?? notionDefaultWorkspace()).toLowerCase();
  const envs = credentialEnvNames(ws);
  const vault = envValue(envs.vaultEnv);
  const item = envValue(envs.itemEnv);
  const hasDirectToken = envValue(envs.tokenEnv) !== null;
  return {
    workspace: ws,
    ...envs,
    vault,
    item,
    field: envValue(envs.fieldEnv) ?? DEFAULT_CREDENTIAL_FIELD,
    hasDirectToken,
    configured: hasDirectToken || Boolean(vault && item),
  };
}

/** Every workspace this installation has credentials for. */
export function listNotionWorkspaces(): string[] {
  const found = new Set<string>();
  if (notionCredentialRef().configured) found.add(notionDefaultWorkspace());

  const patterns: Array<[string, RegExp]> = [
    [NOTION_TOKEN_ENV, new RegExp(`^${NOTION_TOKEN_ENV}_(.+)$`)],
    [NOTION_ITEM_ENV, new RegExp(`^${NOTION_ITEM_ENV}_(.+)$`)],
  ];
  for (const key of Object.keys(process.env)) {
    for (const [, re] of patterns) {
      const m = key.match(re);
      if (m && envValue(key)) found.add(m[1]!.toLowerCase());
    }
  }
  return [...found].sort();
}

/**
 * Which workspaces an agent may use, most-preferred first.
 *
 * Ollama clones inherit their persona's mapping so `watson` and
 * `watson-ollama` can never drift apart.
 *
 * With no explicit mapping this deliberately FAILS CLOSED once more than one
 * workspace exists: returning the default would hand an unmapped agent whichever
 * workspace happens to be default, which in a work+personal install is the one
 * with the most to lose. A single-workspace install is unambiguous, so it needs
 * no mapping at all and keeps working untouched.
 */
export function notionWorkspacesForAgent(agentId?: string | null): string[] {
  const id = String(agentId ?? "").trim().toLowerCase();
  const candidates = id ? [id, id.replace(/-ollama$/, "")] : [];

  for (const candidate of candidates) {
    const raw = envValue(`NOTION_WORKSPACES_${envSuffix(candidate)}`);
    if (raw) {
      const list = raw.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
      if (list.length) return list;
    }
  }

  const configured = listNotionWorkspaces();
  if (configured.length > 1) return [];
  return [configured[0] ?? notionDefaultWorkspace()];
}

/** Env var an operator must set to give an agent a workspace. */
export function notionWorkspaceEnvForAgent(agentId?: string | null): string {
  const id = String(agentId ?? "").trim().toLowerCase();
  return `NOTION_WORKSPACES_${envSuffix(id || "AGENT")}`;
}

// Cache per workspace — a rotation or a test must be able to drop just one.
const tokenCache = new Map<string, string>();

/** Drop memoized tokens — used by tests and after a credential rotation. */
export function resetNotionTokenCache(): void {
  tokenCache.clear();
}

export async function resolveNotionToken(workspace?: string): Promise<string> {
  const ref = notionCredentialRef(workspace);
  const cached = tokenCache.get(ref.workspace);
  if (cached) return cached;

  const direct = envValue(ref.tokenEnv);
  if (direct) {
    tokenCache.set(ref.workspace, direct);
    return direct;
  }

  if (ref.vault && ref.item) {
    const secret = await getSecret(ref.vault, ref.item, ref.field);
    if (secret) {
      tokenCache.set(ref.workspace, secret);
      return secret;
    }
    throw new Error(
      `Notion token not found in 1Password (vault "${ref.vault}", item "${ref.item}", ` +
        `field "${ref.field}"). Check that the item exists and the service account can read it.`,
    );
  }

  const known = listNotionWorkspaces();
  if (known.length && !known.includes(ref.workspace)) {
    throw new Error(
      `Notion workspace "${ref.workspace}" has no credentials configured. ` +
        `Configured workspaces: ${known.join(", ")}. Set ${ref.tokenEnv}, or ${ref.vaultEnv} + ${ref.itemEnv}.`,
    );
  }
  throw new Error(NOTION_SETUP_HINT);
}

/**
 * Pick the workspace for one call. Requesting a workspace outside the agent's
 * allowlist is refused rather than silently redirected — a caller that names
 * the wrong workspace should be told, not quietly served the default.
 */
export function selectNotionWorkspace(
  agentId: string | null | undefined,
  requested: unknown,
): { workspace: string } | { error: string } {
  const allowed = notionWorkspacesForAgent(agentId);
  const asked = String(requested ?? "").trim().toLowerCase();

  if (allowed.length === 0) {
    // An identified agent that is simply unmapped is a configuration gap:
    // refuse either way, so it cannot reach a workspace nobody assigned it.
    if (agentId) {
      return {
        error:
          `This installation has more than one Notion workspace ` +
          `(${listNotionWorkspaces().join(", ")}) and no workspace is assigned to "${agentId}". ` +
          `Set ${notionWorkspaceEnvForAgent(agentId)} to the workspace(s) it should use. ` +
          "Refusing rather than guessing.",
      };
    }
    // No identity at all means an in-process/operator caller (scripts, smoke
    // tests). The rule being enforced is "never guess", and naming a workspace
    // outright is not a guess — so allow it, but still refuse to pick one.
    if (asked) {
      const known = listNotionWorkspaces();
      if (known.includes(asked)) return { workspace: asked };
      return { error: `Unknown Notion workspace "${asked}". Configured: ${known.join(", ")}.` };
    }
    return {
      error:
        `This installation has more than one Notion workspace ` +
        `(${listNotionWorkspaces().join(", ")}). Pass \`workspace\` to choose one. ` +
        "Refusing rather than guessing.",
    };
  }

  if (!asked) return { workspace: allowed[0]! };
  if (allowed.includes(asked)) return { workspace: asked };
  return {
    error:
      `This agent is not permitted to use the "${asked}" Notion workspace. ` +
      `Allowed: ${allowed.join(", ")}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

/** Accept a raw id or a Notion URL; return the 32-char id (dashed). */
export function normalizeNotionId(value: unknown): string {
  const s = String(value ?? "").trim();
  const m = s.match(/([0-9a-fA-F]{32})/);
  const hex = m ? m[1]! : s.replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return s;
}

class NotionApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

/**
 * A Notion client bound to ONE workspace. Every request in a call goes through
 * the same client, so a handler cannot accidentally mix workspaces mid-operation.
 */
export type NotionApi = (
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
) => Promise<unknown>;

function notionClient(workspace: string): NotionApi {
  return (path, method, body) => notionFetch(workspace, path, method, body);
}

async function notionFetch(
  workspace: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const token = await resolveNotionToken(workspace);
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json as { message?: string; code?: string };
    throw new NotionApiError(res.status, detail?.message ?? text, detail?.code);
  }
  return json;
}

/* -------------------------------------------------------------------------- */
/* Rich text + markdown                                                       */
/* -------------------------------------------------------------------------- */

/** Pull plain text out of a Notion rich_text array. */
/** Plain concatenation — for titles, which carry no markdown. */
function richText(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr.map((r) => (r as { plain_text?: string })?.plain_text ?? "").join("");
}

interface Annotations {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
}

interface RichTextRun {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: Annotations;
}

/*
 * Notion does not parse markdown. Inline styling has to be sent as separate
 * rich-text runs carrying `annotations`, so `**bold**` written as one plain run
 * renders as literal asterisks. These two functions are the inverse of each
 * other and keep a get_page → edit → write round trip from losing styling.
 */

interface InlineSegment {
  content: string;
  annotations: Annotations;
  link?: string;
}

/** `_` is only an emphasis delimiter at a word boundary, so snake_case survives. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

interface InlineRule {
  re: RegExp;
  /** Annotation this delimiter adds; absent for links. */
  add?: keyof Annotations;
  /** Content is literal — do not parse inside it (code spans). */
  literal?: boolean;
  link?: boolean;
  /** Reject a match, e.g. `_` inside a word. */
  reject?: (text: string, m: RegExpExecArray) => boolean;
}

// Longer delimiters first: `**` must win over `*`, `~~` over `~`.
const INLINE_RULES: InlineRule[] = [
  { re: /`([^`\n]+)`/, add: "code", literal: true },
  { re: /\[([^\]]*)\]\(([^)\s]+)\)/, link: true },
  { re: /\*\*([\s\S]+?)\*\*/, add: "bold" },
  { re: /__([\s\S]+?)__/, add: "bold",
    reject: (t, m) => isWordChar(t[m.index - 1]) || isWordChar(t[m.index + m[0].length]) },
  { re: /~~([\s\S]+?)~~/, add: "strikethrough" },
  { re: /\*([^*\n]+?)\*/, add: "italic" },
  { re: /_([^_\n]+?)_/, add: "italic",
    reject: (t, m) => isWordChar(t[m.index - 1]) || isWordChar(t[m.index + m[0].length]) },
];

/** Strip backslash escapes (`\*` → `*`) once no delimiter can consume them. */
function unescape(text: string): string {
  return text.replace(/\\([\\`*_~[\]()])/g, "$1");
}

/**
 * Split inline markdown into annotated segments. Recurses so `**bold *both* **`
 * nests correctly; code spans are literal and stop recursion.
 */
export function parseInlineMarkdown(text: string, base: Annotations = {}): InlineSegment[] {
  const out: InlineSegment[] = [];
  let rest = text;

  while (rest.length > 0) {
    let best: { m: RegExpExecArray; rule: InlineRule } | null = null;

    for (const rule of INLINE_RULES) {
      const re = new RegExp(rule.re.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(rest)) !== null) {
        // A delimiter escaped with a backslash is literal text.
        const skip = rest[m.index - 1] === "\\" || rule.reject?.(rest, m);
        if (skip) {
          // Resume one character in, not past the whole match: a rejected
          // candidate may have swallowed the opening delimiter of a valid one
          // ("a_b and _real italic_" must still italicize the second pair).
          re.lastIndex = m.index + 1;
          continue;
        }
        if (!best || m.index < best.m.index) best = { m, rule };
        break;
      }
    }

    if (!best) {
      if (rest) out.push({ content: unescape(rest), annotations: base });
      break;
    }

    const { m, rule } = best;
    if (m.index > 0) {
      out.push({ content: unescape(rest.slice(0, m.index)), annotations: base });
    }

    if (rule.link) {
      out.push(...parseInlineMarkdown(m[1] ?? "", base).map((s) => ({ ...s, link: s.link ?? m[2] })));
    } else {
      const next: Annotations = { ...base, ...(rule.add ? { [rule.add]: true } : {}) };
      if (rule.literal) out.push({ content: m[1] ?? "", annotations: next });
      else out.push(...parseInlineMarkdown(m[1] ?? "", next));
    }

    rest = rest.slice(m.index + m[0].length);
  }

  return out.filter((s) => s.content.length > 0);
}

/**
 * Build Notion rich text from inline markdown, splitting any run longer than
 * Notion's 2000-character limit.
 */
function richTextRuns(content: string): RichTextRun[] {
  if (!content) return [];
  const runs: RichTextRun[] = [];
  for (const seg of parseInlineMarkdown(content)) {
    for (let i = 0; i < seg.content.length; i += RICH_TEXT_LIMIT) {
      runs.push({
        type: "text",
        text: {
          content: seg.content.slice(i, i + RICH_TEXT_LIMIT),
          ...(seg.link ? { link: { url: seg.link } } : {}),
        },
        ...(Object.keys(seg.annotations).length ? { annotations: seg.annotations } : {}),
      });
    }
  }
  return runs;
}

/** Literal runs — code-block bodies must not be re-parsed as markdown. */
function literalRichTextRuns(content: string): RichTextRun[] {
  if (!content) return [];
  const runs: RichTextRun[] = [];
  for (let i = 0; i < content.length; i += RICH_TEXT_LIMIT) {
    runs.push({ type: "text", text: { content: content.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return runs;
}

/** Emphasis delimiters cannot sit next to the whitespace they wrap. */
function wrap(text: string, delim: string): string {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m || !m[2]) return text;
  return `${m[1]}${delim}${m[2]}${delim}${m[3]}`;
}

/** Render Notion rich text back to inline markdown (inverse of the parser). */
function richTextToMarkdown(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr
    .map((raw) => {
      const r = raw as { plain_text?: string; annotations?: Annotations; href?: string | null };
      let text = r?.plain_text ?? "";
      if (!text) return "";
      const a = r.annotations ?? {};
      // Innermost first: code, then emphasis, then the link wrapper.
      if (a.code) text = wrap(text, "`");
      if (a.italic) text = wrap(text, "*");
      if (a.bold) text = wrap(text, "**");
      if (a.strikethrough) text = wrap(text, "~~");
      if (r.href) text = `[${text}](${r.href})`;
      return text;
    })
    .join("");
}

/** Languages Notion accepts for a code block; anything else falls back. */
const CODE_LANGUAGES = new Set([
  "bash", "c", "c++", "c#", "css", "diff", "docker", "go", "graphql", "html",
  "java", "javascript", "json", "kotlin", "less", "lua", "makefile", "markdown",
  "objective-c", "php", "plain text", "powershell", "python", "ruby", "rust",
  "scala", "shell", "sql", "swift", "typescript", "xml", "yaml",
]);

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  sh: "shell", zsh: "shell", js: "javascript", ts: "typescript", py: "python",
  rb: "ruby", yml: "yaml", md: "markdown", "c++": "c++", cpp: "c++", cs: "c#",
  dockerfile: "docker", text: "plain text", txt: "plain text",
};

function codeLanguage(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (!key) return "plain text";
  const aliased = CODE_LANGUAGE_ALIASES[key] ?? key;
  return CODE_LANGUAGES.has(aliased) ? aliased : "plain text";
}

function textBlock(type: string, content: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    object: "block",
    type,
    [type]: { rich_text: richTextRuns(content), ...(extra ?? {}) },
  };
}

/**
 * Convert simple markdown into Notion blocks. Deliberately symmetric with the
 * reader below: headings, lists, to-dos, quotes, code fences, and dividers
 * round-trip. Anything unrecognized becomes a paragraph.
 */
export function markdownToBlocks(markdown: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const lines = String(markdown ?? "").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    const fence = trimmed.match(/^```(.*)$/);
    if (fence) {
      const language = codeLanguage(fence[1] ?? "");
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        body.push(lines[i]!);
        i++;
      }
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: literalRichTextRuns(body.join("\n")), language },
      });
      continue;
    }

    if (trimmed.length === 0) continue;

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1]!.length, 3);
      blocks.push(textBlock(`heading_${level}`, heading[2]!));
      continue;
    }

    const todo = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      blocks.push(textBlock("to_do", todo[2]!, { checked: todo[1]!.toLowerCase() === "x" }));
      continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push(textBlock("bulleted_list_item", bullet[1]!));
      continue;
    }

    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      blocks.push(textBlock("numbered_list_item", numbered[1]!));
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push(textBlock("quote", quote[1]!));
      continue;
    }

    blocks.push(textBlock("paragraph", trimmed));
  }

  return blocks;
}

/** POST blocks in ≤100-block batches, since Notion rejects larger payloads. */
async function appendBlocksBatched(
  api: NotionApi,
  blockId: string,
  blocks: Record<string, unknown>[],
): Promise<{ appended: number; batches: number }> {
  let batches = 0;
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
    await api(`/blocks/${blockId}/children`, "PATCH", {
      children: blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST),
    });
    batches++;
  }
  return { appended: blocks.length, batches };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

function renderBlock(type: string, text: string, block: Record<string, unknown>): string | null {
  const data = block[type] as { checked?: boolean; language?: string } | undefined;
  switch (type) {
    case "heading_1": return `# ${text}`;
    case "heading_2": return `## ${text}`;
    case "heading_3": return `### ${text}`;
    case "bulleted_list_item": return `- ${text}`;
    case "numbered_list_item": return `1. ${text}`;
    case "to_do": return `- [${data?.checked ? "x" : " "}] ${text}`;
    case "quote": return `> ${text}`;
    case "callout": return `> 💡 ${text}`;
    case "code": return `\`\`\`${data?.language ?? ""}\n${text}\n\`\`\``;
    case "toggle": return `▸ ${text}`;
    case "divider": return "---";
    case "child_page":
      return `📄 sub-page: ${String((block.child_page as { title?: string } | undefined)?.title ?? "")}`;
    case "child_database":
      return `🗂 sub-database: ${String((block.child_database as { title?: string } | undefined)?.title ?? "")}`;
    default:
      return text ? text : null;
  }
}

/** Flatten a page's block children into readable markdown-ish text. */
async function readPageContent(api: NotionApi, pageId: string, depth = 0): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const qs = new URLSearchParams({
      page_size: "100",
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    const res = (await api(`/blocks/${pageId}/children?${qs.toString()}`, "GET")) as {
      results?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string | null;
    };

    for (const block of res.results ?? []) {
      const type = String(block.type ?? "");
      const data = block[type] as { rich_text?: unknown } | undefined;
      const text = type === "code" ? richText(data?.rich_text) : richTextToMarkdown(data?.rich_text);
      const rendered = renderBlock(type, text, block);
      if (rendered !== null) lines.push(rendered);

      // Nested content (toggles, list children, columns) is invisible without this.
      if (block.has_children === true && type !== "child_page" && type !== "child_database" && depth < MAX_BLOCK_DEPTH) {
        const nested = await readPageContent(api, String(block.id), depth + 1);
        if (nested) lines.push(nested.split("\n").map((l) => `  ${l}`).join("\n"));
      }
    }

    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor && ++pages < MAX_BLOCK_PAGES);

  return lines.join("\n");
}

function titleOf(page: Record<string, unknown>): string {
  // Databases carry a top-level `title`; pages carry a title-typed property.
  if (Array.isArray(page.title)) {
    const direct = richText(page.title);
    if (direct) return direct;
  }
  const props = (page.properties ?? {}) as Record<string, { type?: string; title?: unknown }>;
  for (const p of Object.values(props)) {
    if (p?.type === "title") return richText(p.title) || "(untitled)";
  }
  return "(untitled)";
}

/* -------------------------------------------------------------------------- */
/* Parents                                                                    */
/* -------------------------------------------------------------------------- */

type ParentInfo =
  | { kind: "database"; titleProperty: string }
  | { kind: "page" };

/**
 * `create_page` needs to know whether the parent is a page or a database — the
 * request shape differs, and databases name their own title property. Callers
 * may state it explicitly; otherwise probe.
 */
async function resolveParent(api: NotionApi, id: string, declared?: unknown): Promise<ParentInfo> {
  const stated = String(declared ?? "").trim().toLowerCase();
  if (stated === "page") return { kind: "page" };

  if (stated === "database" || stated === "") {
    try {
      const db = (await api(`/databases/${id}`, "GET")) as {
        object?: string;
        properties?: Record<string, { type?: string }>;
      };
      if (db?.object === "database") {
        const titleProperty =
          Object.entries(db.properties ?? {}).find(([, v]) => v?.type === "title")?.[0] ?? "Name";
        return { kind: "database", titleProperty };
      }
    } catch (err) {
      // Probing a page id against /databases gives 400 ("is a page, not a
      // database"); a genuinely unknown id gives 404. Both mean "use a page
      // parent". Anything else (auth, rate limit, 5xx) must surface.
      if (stated === "database") throw err;
      if (err instanceof NotionApiError && err.status !== 400 && err.status !== 404) throw err;
    }
  }

  return { kind: "page" };
}

/* -------------------------------------------------------------------------- */
/* Block-level editing                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Editing an existing document needs block ids: Notion's unit of edit is a
 * block, and `PATCH /blocks/{id}` / `DELETE /blocks/{id}` address one directly.
 * Reading a page as flat text gives an agent nothing to target, which is why
 * append-and-rebuild was the only option before this.
 */

interface BlockSummary {
  id: string;
  type: string;
  text: string;
  has_children: boolean;
}

/** Flat, addressable listing of a page's blocks (one level, plus children). */
async function listBlocks(
  api: NotionApi,
  parentId: string,
  depth = 0,
): Promise<BlockSummary[]> {
  const out: BlockSummary[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const qs = new URLSearchParams({ page_size: "100", ...(cursor ? { start_cursor: cursor } : {}) });
    const res = (await api(`/blocks/${parentId}/children?${qs.toString()}`, "GET")) as {
      results?: Array<Record<string, unknown>>;
      has_more?: boolean;
      next_cursor?: string | null;
    };

    for (const block of res.results ?? []) {
      const type = String(block.type ?? "");
      const data = block[type] as { rich_text?: unknown } | undefined;
      out.push({
        id: String(block.id),
        type,
        text: type === "code" ? richText(data?.rich_text) : richTextToMarkdown(data?.rich_text),
        has_children: block.has_children === true,
      });
      if (block.has_children === true && depth < MAX_BLOCK_DEPTH && type !== "child_page" && type !== "child_database") {
        out.push(...(await listBlocks(api, String(block.id), depth + 1)));
      }
    }

    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor && ++pages < MAX_BLOCK_PAGES);

  return out;
}

/** Block types whose body is a single rich_text array we can rewrite. */
const REWRITABLE_TEXT_BLOCKS = new Set([
  "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item",
  "numbered_list_item", "to_do", "quote", "callout", "toggle", "code",
]);

/**
 * Rewrite one block's text in place, keeping its existing type — Notion cannot
 * change a block's type, so a bullet stays a bullet. Markdown that parses to a
 * single block contributes only its inline content, so passing "- new text" to
 * a bullet does not double the marker.
 */
async function rewriteBlock(
  api: NotionApi,
  blockId: string,
  markdown: string,
  checked?: unknown,
): Promise<{ id: string; type: string; text: string }> {
  const current = (await api(`/blocks/${blockId}`, "GET")) as Record<string, unknown>;
  const type = String(current.type ?? "");
  if (!REWRITABLE_TEXT_BLOCKS.has(type)) {
    throw new Error(
      `Block ${blockId} is a "${type}", which has no editable text. ` +
        "Use delete_block plus insert_after to replace it.",
    );
  }

  const existing = (current[type] ?? {}) as Record<string, unknown>;
  const body: Record<string, unknown> = {};

  if (markdown !== undefined && markdown !== null && String(markdown).length > 0) {
    if (type === "code") {
      body.rich_text = literalRichTextRuns(String(markdown));
      if (existing.language) body.language = existing.language;
    } else {
      const parsed = markdownToBlocks(String(markdown));
      // One parsed block → reuse its inline runs under the original type.
      // Several → the caller passed multiple lines; join them into one block.
      const runs = parsed.length === 1
        ? ((parsed[0]![parsed[0]!.type as string] as { rich_text?: unknown })?.rich_text ?? [])
        : richTextRuns(String(markdown));
      body.rich_text = runs;
    }
  }

  if (typeof checked === "boolean" && type === "to_do") body.checked = checked;
  if (Object.keys(body).length === 0) throw new Error("update_block needs `markdown` (or `checked` on a to-do).");

  const updated = (await api(`/blocks/${blockId}`, "PATCH", { [type]: body })) as Record<string, unknown>;
  const data = updated[type] as { rich_text?: unknown } | undefined;
  return {
    id: String(updated.id),
    type,
    text: type === "code" ? richText(data?.rich_text) : richTextToMarkdown(data?.rich_text),
  };
}

/**
 * Insert blocks directly after a sibling. Notion takes `after` on the PARENT's
 * children endpoint, so the block's parent has to be resolved first.
 */
async function insertAfterBlock(
  api: NotionApi,
  blockId: string,
  blocks: Record<string, unknown>[],
): Promise<{ inserted: number; parent_id: string }> {
  const block = (await api(`/blocks/${blockId}`, "GET")) as { parent?: Record<string, string> };
  const parent = block.parent ?? {};
  const parentId = parent.page_id ?? parent.block_id ?? parent.database_id;
  if (!parentId) throw new Error(`Could not resolve the parent of block ${blockId}.`);

  // `after` is only honored on the first request, so anything past the 100-block
  // limit is appended to the parent's end rather than silently dropped.
  const first = blocks.slice(0, MAX_BLOCKS_PER_REQUEST);
  await api(`/blocks/${parentId}/children`, "PATCH", { children: first, after: blockId });
  const rest = blocks.slice(MAX_BLOCKS_PER_REQUEST);
  if (rest.length) await appendBlocksBatched(api, parentId, rest);
  return { inserted: blocks.length, parent_id: parentId };
}

/* -------------------------------------------------------------------------- */
/* Governance classification                                                  */
/* -------------------------------------------------------------------------- */

/** Every operation that only reads. Anything else is treated as a mutation. */
const READ_ONLY_OPERATIONS = new Set([
  "search", "get_page", "read", "fetch", "query_database", "get_database", "database_schema",
  "get_blocks", "list_blocks", "list_workspaces", "workspaces",
]);

/**
 * Read-vs-write for the governance layer. An explicit read allowlist rather
 * than a keyword regex: unknown or misspelled operations must fall to "write"
 * so a mutation can never be waved through as a read.
 */
export function notionOperationLooksReadOnly(operation: unknown): boolean {
  if (typeof operation !== "string") return false;
  return READ_ONLY_OPERATIONS.has(operation.trim().toLowerCase().replace(/[-\s]/g, "_"));
}

/* -------------------------------------------------------------------------- */
/* Tool                                                                       */
/* -------------------------------------------------------------------------- */

export function createNotionTools(): AgentTool[] {
  return [
    {
      name: "notion",
      description: [
        "Read and write the user's Notion workspace (direct Notion API).",
        "",
        "Set `operation` and the fields it needs:",
        "  - search:         { query }  → find pages/databases. Returns id, title, url for each.",
        "  - get_page:       { page_id } → the page's properties AND full text content (this is how you READ a doc).",
        "  - create_page:    { parent_id, title, markdown?, properties? } → new page under a parent page, or a new row in a database.",
        "  - update_page:    { page_id, properties } → set page properties (Notion property JSON).",
        "  - append:         { page_id, markdown } → append content to the end of a page.",
        "  - query_database: { database_id, filter?, sorts? } → rows of a database.",
        "  - get_database:   { database_id } → a database's schema (property names and types).",
        "  - archive:        { page_id } → move a page to trash. `restore` puts it back.",
        "",
        "EDITING AN EXISTING PAGE (you do not need to rebuild it):",
        "  - get_blocks:     { page_id } → every block with its id, type and text. Ids come from here.",
        "  - update_block:   { block_id, markdown } → rewrite one block in place. `checked` ticks a to-do.",
        "  - delete_block:   { block_id } → remove one block.",
        "  - insert_after:   { block_id, markdown } → insert new blocks right after that one.",
        "  - replace_text:   { page_id, find, replace } → swap wording in whichever block holds it.",
        "                    Errors and lists candidates if several blocks match, unless all:true.",
        "",
        "So: to change a line, get_blocks → update_block. Do NOT create a replacement page for an edit.",
        "A block keeps its type (a bullet stays a bullet); to change type, delete_block + insert_after.",
        "",
        "markdown accepts headings (#/##/###), bullets, numbered lists, - [ ] to-dos,",
        "> quotes, ``` code fences, and --- dividers; they round-trip with get_page.",
        "",
        "page_id/database_id/parent_id accept a raw id or a full Notion URL. To read a document,",
        "use get_page (NOT a browser — Notion's web UI requires interactive login and renders",
        "blank to tools). Only pages shared with this installation's integration are reachable.",
        "",
        "This installation may have more than one Notion workspace, and each is a separate",
        "world — a page in one is invisible from another. You are restricted to the",
        "workspace(s) assigned to you; omit `workspace` to use your default. Use",
        "`list_workspaces` to see which ones you may use. If a page you expect is missing,",
        "check you are in the right workspace before concluding it does not exist.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description:
              "search | get_page | get_blocks | create_page | update_page | append | update_block | delete_block | insert_after | replace_text | query_database | get_database | archive | restore | list_workspaces",
          },
          workspace: {
            type: "string",
            description:
              "which Notion workspace to act in; omit for your default. Only workspaces assigned to you are allowed.",
          },
          query: { type: "string", description: "search text (operation=search)" },
          page_id: { type: "string", description: "page id or Notion URL (get_page/update_page/append/archive)" },
          database_id: { type: "string", description: "database id or URL (query_database/get_database)" },
          parent_id: { type: "string", description: "parent page/database id or URL (create_page)" },
          parent_type: {
            type: "string",
            description: "optional 'page' or 'database'; auto-detected when omitted (create_page)",
          },
          title: { type: "string", description: "title for create_page" },
          markdown: { type: "string", description: "markdown body for create_page or append" },
          properties: {
            type: "object",
            description: "Notion property JSON for update_page, or extra row properties for create_page",
          },
          filter: { type: "object", description: "Notion filter JSON for query_database" },
          sorts: { type: "array", description: "Notion sorts JSON for query_database" },
          block_id: { type: "string", description: "block id from get_blocks (update_block/delete_block/insert_after)" },
          checked: { type: "boolean", description: "tick/untick a to_do block (update_block)" },
          find: { type: "string", description: "exact text to look for (replace_text)" },
          replace: { type: "string", description: "text to substitute (replace_text)" },
          all: { type: "boolean", description: "replace in every matching block instead of erroring on ambiguity" },
          page_size: { type: "number", description: "max results (search/query_database)" },
          start_cursor: { type: "string", description: "pagination cursor (search/query_database)" },
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const op = String(input.operation ?? "").trim().toLowerCase().replace(/[-\s]/g, "_");

        // Injected by the MCP server from the X-Worker-ID header; absent for
        // direct/in-process callers, which then get the default workspace.
        const agentId = typeof input._requester_agent_id === "string" ? input._requester_agent_id : null;
        const allowed = notionWorkspacesForAgent(agentId);

        if (op === "list_workspaces" || op === "workspaces") {
          return {
            workspaces: allowed,
            default: allowed[0],
            configured: listNotionWorkspaces(),
          };
        }

        const picked = selectNotionWorkspace(agentId, input.workspace);
        if ("error" in picked) return { error: picked.error, allowed_workspaces: allowed };
        const workspace = picked.workspace;
        const api = notionClient(workspace);

        try {
          switch (op) {
            case "search": {
              const res = (await api("/search", "POST", {
                ...(input.query ? { query: String(input.query) } : {}),
                page_size: typeof input.page_size === "number" ? input.page_size : 10,
                ...(input.start_cursor ? { start_cursor: String(input.start_cursor) } : {}),
              })) as { results?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string | null };
              return {
                results: (res.results ?? []).map((r) => ({
                  id: r.id,
                  object: r.object,
                  title: titleOf(r),
                  url: r.url,
                  last_edited: r.last_edited_time,
                })),
                has_more: res.has_more ?? false,
                next_cursor: res.next_cursor ?? null,
              };
            }

            case "get_page":
            case "read":
            case "fetch": {
              const id = normalizeNotionId(input.page_id ?? input.id);
              let page: Record<string, unknown>;
              try {
                page = (await api(`/pages/${id}`, "GET")) as Record<string, unknown>;
              } catch (err) {
                // Agents routinely hand a database URL to get_page; say so plainly.
                if (err instanceof NotionApiError && err.status === 404) {
                  const db = await api(`/databases/${id}`, "GET").catch(() => null);
                  if (db) {
                    return {
                      error:
                        `${id} is a database, not a page. Use operation "query_database" for its rows ` +
                        `or "get_database" for its schema.`,
                    };
                  }
                }
                throw err;
              }
              const content = await readPageContent(api, id);
              return {
                id: page.id,
                title: titleOf(page),
                url: page.url,
                last_edited: page.last_edited_time,
                properties: page.properties,
                content,
              };
            }

            case "create_page": {
              const parentId = normalizeNotionId(input.parent_id);
              if (!parentId) return { error: "create_page needs a parent_id (page or database id/URL)." };

              const title = String(input.title ?? "Untitled");
              const parent = await resolveParent(api, parentId, input.parent_type);
              const extraProps = (input.properties as Record<string, unknown> | undefined) ?? {};
              const titleValue = { title: [{ type: "text", text: { content: title } }] };

              const properties =
                parent.kind === "database"
                  ? { [parent.titleProperty]: titleValue, ...extraProps }
                  : { title: titleValue, ...extraProps };

              const blocks = markdownToBlocks(String(input.markdown ?? ""));
              const inlineBlocks = blocks.slice(0, MAX_BLOCKS_PER_REQUEST);
              const overflow = blocks.slice(MAX_BLOCKS_PER_REQUEST);

              const created = (await api("/pages", "POST", {
                parent:
                  parent.kind === "database"
                    ? { database_id: parentId }
                    : { page_id: parentId },
                properties,
                ...(inlineBlocks.length ? { children: inlineBlocks } : {}),
              })) as Record<string, unknown>;

              if (overflow.length) {
                await appendBlocksBatched(api, String(created.id), overflow);
              }

              return {
                id: created.id,
                url: created.url,
                title,
                parent_kind: parent.kind,
                blocks_written: blocks.length,
              };
            }

            case "update_page": {
              const id = normalizeNotionId(input.page_id);
              const updated = (await api(`/pages/${id}`, "PATCH", {
                properties: (input.properties as Record<string, unknown>) ?? {},
              })) as Record<string, unknown>;
              return { id: updated.id, url: updated.url, title: titleOf(updated), updated: true };
            }

            case "append": {
              const id = normalizeNotionId(input.page_id);
              const blocks = markdownToBlocks(String(input.markdown ?? ""));
              if (!blocks.length) return { error: "append needs non-empty markdown." };
              const result = await appendBlocksBatched(api, id, blocks);
              return { id, ...result };
            }

            case "get_blocks":
            case "list_blocks": {
              const id = normalizeNotionId(input.page_id);
              const blocks = await listBlocks(api, id);
              return { page_id: id, count: blocks.length, blocks };
            }

            case "update_block":
            case "edit_block": {
              const id = normalizeNotionId(input.block_id ?? input.page_id);
              if (!id) return { error: "update_block needs a block_id (from get_blocks)." };
              return await rewriteBlock(api, id, String(input.markdown ?? ""), input.checked);
            }

            case "delete_block":
            case "remove_block": {
              const id = normalizeNotionId(input.block_id ?? input.page_id);
              if (!id) return { error: "delete_block needs a block_id (from get_blocks)." };
              await api(`/blocks/${id}`, "DELETE");
              return { id, deleted: true };
            }

            case "insert_after": {
              const id = normalizeNotionId(input.block_id);
              if (!id) return { error: "insert_after needs a block_id (from get_blocks)." };
              const blocks = markdownToBlocks(String(input.markdown ?? ""));
              if (!blocks.length) return { error: "insert_after needs non-empty markdown." };
              return { block_id: id, ...(await insertAfterBlock(api, id, blocks)) };
            }

            case "replace_text": {
              // The common editing shape: "swap this wording for that". Operates
              // on each block's markdown, so inline styling survives the rewrite.
              const id = normalizeNotionId(input.page_id);
              const find = String(input.find ?? "");
              if (!id || !find) return { error: "replace_text needs page_id and find." };
              const replace = String(input.replace ?? "");

              const blocks = (await listBlocks(api, id)).filter(
                (b) => b.text.includes(find) && REWRITABLE_TEXT_BLOCKS.has(b.type),
              );
              if (blocks.length === 0) {
                return { error: `No block on this page contains ${JSON.stringify(find)}.`, matched: 0 };
              }
              // Ambiguity is reported, never guessed at — an edit to the wrong
              // paragraph of a real document is expensive to notice.
              if (blocks.length > 1 && input.all !== true) {
                return {
                  error:
                    `${blocks.length} blocks contain ${JSON.stringify(find)}. Pass all:true to change ` +
                    "every one, or use update_block with a specific block_id.",
                  matched: blocks.length,
                  candidates: blocks.map((b) => ({ id: b.id, type: b.type, text: b.text.slice(0, 160) })),
                };
              }

              const updated = [];
              for (const b of blocks) {
                updated.push(await rewriteBlock(api, b.id, b.text.split(find).join(replace)));
              }
              return { page_id: id, replaced: updated.length, blocks: updated };
            }

            case "query_database": {
              const id = normalizeNotionId(input.database_id ?? input.page_id);
              const res = (await api(`/databases/${id}/query`, "POST", {
                ...(input.filter ? { filter: input.filter } : {}),
                ...(input.sorts ? { sorts: input.sorts } : {}),
                page_size: typeof input.page_size === "number" ? input.page_size : 25,
                ...(input.start_cursor ? { start_cursor: String(input.start_cursor) } : {}),
              })) as { results?: Array<Record<string, unknown>>; has_more?: boolean; next_cursor?: string | null };
              return {
                results: (res.results ?? []).map((r) => ({
                  id: r.id,
                  title: titleOf(r),
                  url: r.url,
                  last_edited: r.last_edited_time,
                  properties: r.properties,
                })),
                has_more: res.has_more ?? false,
                next_cursor: res.next_cursor ?? null,
              };
            }

            case "get_database":
            case "database_schema": {
              const id = normalizeNotionId(input.database_id ?? input.page_id);
              const db = (await api(`/databases/${id}`, "GET")) as Record<string, unknown>;
              const props = (db.properties ?? {}) as Record<string, { type?: string }>;
              return {
                id: db.id,
                title: titleOf(db),
                url: db.url,
                properties: Object.fromEntries(
                  Object.entries(props).map(([name, meta]) => [name, meta?.type ?? "unknown"]),
                ),
              };
            }

            case "archive":
            case "trash":
            case "delete": {
              const id = normalizeNotionId(input.page_id);
              await api(`/pages/${id}`, "PATCH", { in_trash: true });
              return { id, archived: true };
            }

            case "restore":
            case "unarchive": {
              const id = normalizeNotionId(input.page_id);
              await api(`/pages/${id}`, "PATCH", { in_trash: false });
              return { id, archived: false };
            }

            default:
              return {
                error:
                  `Unknown notion operation "${op}". Use search | get_page | create_page | ` +
                  "update_page | append | query_database | get_database | archive | restore.",
              };
          }
        } catch (err) {
          if (err instanceof NotionApiError) {
            // 404 from Notion usually means "not shared with the integration",
            // which is a setup problem the agent should report, not retry.
            const hint =
              err.status === 404
                ? " (the page/database may not be shared with this installation's Notion integration)"
                : "";
            return { error: `Notion API ${err.status}: ${err.message}${hint}`, code: err.code };
          }
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
