import { describe, expect, it } from "vitest";

import { redactEmailAddresses, resolveEmailAccount } from "../src/email-agent-tools.js";

describe("redactEmailAddresses", () => {
  it("redacts addresses embedded in gog-style command failures", () => {
    const message = redactEmailAddresses(
      "gog gmail messages search is:unread --account someone@example.com --json failed: No auth for gmail someone@example.com.\n\nOAuth (browser flow):\n  gog auth add someone@example.com",
    );
    expect(message).not.toContain("someone@example.com");
    expect(message).toContain("[redacted-email]");
    expect(message).toContain("failed: No auth for gmail");
  });

  it("leaves non-address text untouched", () => {
    expect(redactEmailAddresses("exit 1: network unreachable")).toBe("exit 1: network unreachable");
  });
});

describe("resolveEmailAccount error surfaces", () => {
  it("does not echo a firewalled override address in the error message", () => {
    let caught: Error | undefined;
    try {
      resolveEmailAccount("blocked@example.com", {
        defaultAccount: "assistant@example.com",
        firewalledAccounts: ["blocked@example.com"],
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain("blocked@example.com");
    expect(caught?.message).not.toMatch(/@/);
  });

  it("still resolves the configured account for allowed use", () => {
    expect(resolveEmailAccount(undefined, { defaultAccount: "assistant@example.com" })).toBe(
      "assistant@example.com",
    );
  });
});
