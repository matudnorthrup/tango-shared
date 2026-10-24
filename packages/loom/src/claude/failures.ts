import type { RuntimeFailure } from "../runtime.js";

/**
 * Classify a Claude turn failure. Patterns follow T3 Code's adapter
 * (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts,
 * pingdotgg/t3code@d09a9ead, MIT). One quirk: the SDK reports some failures,
 * such as "Not logged in", 401 and 529, as subtype "success" with is_error set.
 */
export function classifyResult(result: {
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  terminal_reason?: string;
  api_error_status?: number | null;
}, lastRateLimit?: { status: string; resetsAt?: number }): RuntimeFailure | null {
  const text = [result.result ?? "", ...(result.errors ?? [])].join("\n");
  const failed = result.is_error === true || result.subtype !== "success";
  if (!failed) return null;
  const resetAt = lastRateLimit?.resetsAt ? lastRateLimit.resetsAt * (lastRateLimit.resetsAt < 1e12 ? 1000 : 1) : undefined;

  if (
    result.terminal_reason === "blocking_limit" ||
    result.api_error_status === 429 ||
    lastRateLimit?.status === "rejected" ||
    /usage limit|rate limit|limit reached|out of extra usage/i.test(text)
  ) {
    return { kind: "usage_limit", message: text || "Usage limit reached", ...(resetAt ? { resetAt } : {}) };
  }
  if (result.api_error_status === 401 || /not logged in|please run \/login|invalid api key|oauth token|consumer terms|review the updated terms/i.test(text)) {
    return { kind: "auth", message: text || "Not signed in" };
  }
  if (result.api_error_status === 529 || /overloaded/i.test(text)) {
    return { kind: "overloaded", message: text || "Overloaded" };
  }
  if (result.terminal_reason === "aborted_streaming" || result.terminal_reason === "aborted_tools") {
    return { kind: "interrupted", message: text || "Interrupted" };
  }
  return { kind: "other", message: text || `Turn failed (${result.subtype})` };
}
