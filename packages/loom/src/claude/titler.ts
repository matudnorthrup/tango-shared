import { tmpdir } from "node:os";
import { query as sdkQuery, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { accountEnv, type ClaudeAccount } from "./claude-runtime.js";

/** A small, fast model: naming a thread shouldn't cost a real turn's quota. */
export const TITLE_MODEL = "claude-haiku-5-5";

const PROMPT = `Name this coding conversation for a sidebar, from the owner's first message below.
Rules: 3 to 6 words, Title Case, no quotes, no trailing period, no markdown, no "Handoff:" or similar prefix.
Name the work itself (what is being built or fixed), not the request.
Reply with the name only.

First message:
`;

const RULE_PROMPT = `The owner made the same kind of call twice. Write ONE standing rule that covers both, for an agent to act on next time without asking.
Rules: one line, exactly the form "Next time, for <scope>, do <what> without asking". The scope names the kind of situation both share, literally (an agent checks whether its case falls inside it), no wider than both calls justify. No quotes, no markdown.

The two calls (each with the rule it proposed):
`;

/**
 * Asks a small model to write the rule two similar approvals add up to (D-61), on the default account. Null on any
 * failure or an answer not in the rule's form: the plain proposal stays.
 */
export function createRuleWriter(options: {
  account: (name: string | null) => ClaudeAccount;
  query?: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
  timeoutMs?: number;
}) {
  const queryFn = options.query ?? sdkQuery;
  return async (briefs: Array<{ ask: string; proposedRule: string }>): Promise<string | null> => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), options.timeoutMs ?? 60_000);
    try {
      const q = queryFn({
        prompt: RULE_PROMPT + briefs.map((b, i) => `${i + 1}. ${b.ask}\n   proposed: ${b.proposedRule}`).join("\n"),
        options: { model: TITLE_MODEL, cwd: tmpdir(), env: accountEnv(options.account(null)), tools: [], maxTurns: 1, persistSession: false, settingSources: [], abortController },
      });
      for await (const message of q) {
        const m = message as { type: string; subtype?: string; is_error?: boolean; result?: string };
        if (m.type !== "result") continue;
        const line = m.subtype === "success" && !m.is_error && m.result ? m.result.split("\n").map((l) => l.trim()).find(Boolean) ?? "" : "";
        return /^next time,?\s+for\s+.+,\s+.+/i.test(line) && line.length <= 300 ? line.replace(/^["'`]+|["'`]+$/g, "") : null;
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The model's answer as a title: one line, no quotes or markdown, at most 60 characters. Null when unusable. */
export function cleanTitle(raw: string): string | null {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const title = line
    .replace(/^#+\s*/, "")
    .replace(/^(title|name)\s*:\s*/i, "")
    .replace(/^["'`*_]+|["'`*_]+$/g, "")
    .replace(/[.:;,]+$/, "")
    .trim();
  if (!title || title.length > 60 || title.split(/\s+/).length > 10) return null;
  return title;
}

/**
 * Asks a small model for a thread's name, on the thread's own account, with no
 * tools and no saved transcript. Null on any failure: the thread keeps its draft title.
 */
export function createClaudeTitler(options: {
  account: (name: string | null) => ClaudeAccount;
  query?: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
  timeoutMs?: number;
}) {
  const queryFn = options.query ?? sdkQuery;
  return async (text: string, accountName: string | null): Promise<string | null> => {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), options.timeoutMs ?? 60_000);
    try {
      const q = queryFn({
        prompt: PROMPT + text.slice(0, 4000),
        options: {
          model: TITLE_MODEL,
          cwd: tmpdir(),
          env: accountEnv(options.account(accountName)),
          tools: [],
          maxTurns: 1,
          persistSession: false,
          settingSources: [],
          abortController,
        },
      });
      for await (const message of q) {
        const m = message as { type: string; subtype?: string; is_error?: boolean; result?: string };
        if (m.type === "result") return m.subtype === "success" && !m.is_error && m.result ? cleanTitle(m.result) : null;
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
