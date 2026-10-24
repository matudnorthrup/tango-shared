/**
 * Classification of Claude Code CLI / API failures, shared by the
 * ClaudeCodeAdapter's secondary-CLI retry decision and the discord v2
 * degraded-mode recovery chain (TGO-846). Matching is against the combined
 * stderr/stdout text of a failed CLI run, or against a thrown error's message —
 * the adapter preserves the CLI's own failure text in what it throws, so the
 * same patterns work at both layers.
 */
export type ClaudeCodeFailureReason = "usage-limit" | "overloaded" | "auth" | "timeout";

const USAGE_LIMIT_PATTERNS = [
  "usage limit reached",
  "rate limit",
  "rate_limit",
  "api error: 429",
  "exceeds your remaining",
  "out of extra usage",
  "quota exceeded",
] as const;

const OVERLOADED_PATTERNS = [
  "overloaded_error",
  "overloaded",
] as const;

const AUTH_PATTERNS = [
  "authentication_failed",
  "authentication_error",
  "failed to authenticate",
  "invalid authentication credentials",
  "api error: 401",
  "token has been revoked",
] as const;

const TIMEOUT_PATTERN = /claude code request timed out after \d+ms/u;
const SERVER_ERROR_PATTERN = /api error: 5\d\d/u;

export function classifyClaudeCodeFailureText(text: string): ClaudeCodeFailureReason | null {
  const haystack = text.toLowerCase();

  if (TIMEOUT_PATTERN.test(haystack)) {
    return "timeout";
  }
  if (USAGE_LIMIT_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return "usage-limit";
  }
  if (AUTH_PATTERNS.some((pattern) => haystack.includes(pattern))) {
    return "auth";
  }
  if (OVERLOADED_PATTERNS.some((pattern) => haystack.includes(pattern)) || SERVER_ERROR_PATTERN.test(haystack)) {
    return "overloaded";
  }
  return null;
}

export function classifyClaudeCodeFailureError(error: unknown): ClaudeCodeFailureReason | null {
  if (!(error instanceof Error)) {
    return null;
  }
  return classifyClaudeCodeFailureText(error.message);
}

/**
 * Failures where a second Claude account (the secondary CLI) plausibly
 * succeeds: separate credentials and a separate usage quota. Timeouts keep
 * their own dedicated handling in ClaudeCodeAdapter.send().
 */
export function isSecondaryCliRecoverable(reason: ClaudeCodeFailureReason | null): boolean {
  return reason === "auth" || reason === "usage-limit" || reason === "overloaded";
}
