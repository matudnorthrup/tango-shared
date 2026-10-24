import { describe, expect, it } from "vitest";
import { isBenignUnhandledRejection } from "../src/file-logger.js";

describe("isBenignUnhandledRejection", () => {
  it("matches Playwright's lost dialog-dismiss race", () => {
    expect(
      isBenignUnhandledRejection(
        new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing"),
      ),
    ).toBe(true);
  });

  it("keeps every other rejection fatal", () => {
    expect(isBenignUnhandledRejection(new Error("Protocol error (Page.navigate): Target closed"))).toBe(false);
    expect(isBenignUnhandledRejection(new Error("database is locked"))).toBe(false);
    expect(isBenignUnhandledRejection("No dialog is showing")).toBe(false);
  });
});
