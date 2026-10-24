import { describe, expect, it } from "vitest";
import {
  classifyClaudeCodeFailureError,
  classifyClaudeCodeFailureText,
  isSecondaryCliRecoverable,
} from "../src/claude-code-failures.js";

describe("classifyClaudeCodeFailureText", () => {
  it.each([
    ["Claude AI usage limit reached|1754500000", "usage-limit"],
    ["API Error: 429 rate_limit_error", "usage-limit"],
    ["Number of request tokens has exceeded your per-minute rate limit", "usage-limit"],
    ["This request exceeds your remaining usage", "usage-limit"],
    ["API Error: 529 overloaded_error", "overloaded"],
    ["API Error: 500 Internal server error", "overloaded"],
    ["API Error: 503 Service unavailable", "overloaded"],
    ["Failed to authenticate. API Error: 401 OAuth access token has been revoked.", "auth"],
    ["authentication_failed", "auth"],
    ["Invalid authentication credentials", "auth"],
    ["Claude Code request timed out after 900000ms.", "timeout"],
    ["Claude Code exited with code 1. stdout=Claude AI usage limit reached|1754500000", "usage-limit"],
  ] as const)("classifies %j as %s", (text, expected) => {
    expect(classifyClaudeCodeFailureText(text)).toBe(expected);
  });

  it.each([
    "Claude CLI returned an empty response",
    "Failed to parse Claude CLI JSON output",
    "Something went wrong",
    "",
  ])("returns null for unclassified text %j", (text) => {
    expect(classifyClaudeCodeFailureText(text)).toBeNull();
  });
});

describe("classifyClaudeCodeFailureError", () => {
  it("classifies Error messages", () => {
    expect(
      classifyClaudeCodeFailureError(new Error("Claude Code request timed out after 500ms.")),
    ).toBe("timeout");
  });

  it("returns null for non-Error values", () => {
    expect(classifyClaudeCodeFailureError("usage limit reached")).toBeNull();
    expect(classifyClaudeCodeFailureError(undefined)).toBeNull();
  });
});

describe("isSecondaryCliRecoverable", () => {
  it("recovers auth, usage-limit, and overloaded on the secondary CLI", () => {
    expect(isSecondaryCliRecoverable("auth")).toBe(true);
    expect(isSecondaryCliRecoverable("usage-limit")).toBe(true);
    expect(isSecondaryCliRecoverable("overloaded")).toBe(true);
  });

  it("leaves timeouts and unclassified failures to their own handling", () => {
    expect(isSecondaryCliRecoverable("timeout")).toBe(false);
    expect(isSecondaryCliRecoverable(null)).toBe(false);
  });
});
