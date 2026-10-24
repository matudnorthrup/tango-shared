import { describe, expect, it, vi } from "vitest";
import { executeGoogleDocTabUpdate } from "../src/google-doc-update-executor.js";

describe("executeGoogleDocTabUpdate", () => {
  it("applies verified find-replace updates against a specific tab", async () => {
    let tabText = "Old headline\n\nBody copy";
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] !== "docs") {
        throw new Error(`Unexpected gog namespace: ${args.join(" ")}`);
      }
      if (args[1] === "cat") {
        return tabText;
      }
      if (args[1] === "write") {
        tabText = "New headline\n\nBody copy";
        return "ok";
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await executeGoogleDocTabUpdate(
      {
        doc: "https://docs.google.com/document/d/1abcDocId/edit?tab=t.original",
        tab: "https://docs.google.com/document/d/1abcDocId/edit?tab=t.target",
        account: "work@example.test",
        replacements: [{ find: "Old headline", replace: "New headline", first: true }],
        verify_contains: ["New headline", "Body copy"],
      },
      {
        gogCommand: "gog",
        runCommand,
      },
    );

    expect(result).toMatchObject({
      status: "confirmed",
      docId: "1abcDocId",
      tabId: "t.target",
      account: "work@example.test",
      appliedReplacementCount: 1,
      verificationCount: 2,
      missingVerifications: [],
    });
    expect(runCommand.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ["docs", "cat"],
      ["docs", "write"],
      ["docs", "cat"],
    ]);
    expect(runCommand.mock.calls[0]?.[1]).toContain("--tab");
    expect(runCommand.mock.calls[1]?.[1]).toContain("--tab-id");
  });

  it("returns precondition_failed instead of guessing when the source text is missing", async () => {
    const runCommand = vi.fn(async () => "Current tab content");

    const result = await executeGoogleDocTabUpdate(
      {
        doc: "1abcDocId",
        tab: "t.target",
        account: "work@example.test",
        replacements: [{ find: "Missing headline", replace: "New headline" }],
      },
      {
        gogCommand: "gog",
        runCommand,
      },
    );

    expect(result).toEqual({
      status: "precondition_failed",
      docId: "1abcDocId",
      tabId: "t.target",
      account: "work@example.test",
      missing: ["Missing headline"],
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("writes full content without a pre-read when no replacements are requested", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] !== "docs") {
        throw new Error(`Unexpected gog namespace: ${args.join(" ")}`);
      }
      if (args[1] === "write") {
        return "ok";
      }
      if (args[1] === "cat") {
        return "Fresh content";
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await executeGoogleDocTabUpdate(
      {
        doc: "1abcDocId",
        tab: "t.target",
        account: "work@example.test",
        content: "Fresh content",
        verify_contains: ["Fresh content"],
      },
      {
        gogCommand: "gog",
        runCommand,
      },
    );

    expect(result).toMatchObject({
      status: "confirmed",
      docId: "1abcDocId",
      tabId: "t.target",
      verificationCount: 1,
    });
    expect(runCommand.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ["docs", "write"],
      ["docs", "cat"],
    ]);
  });

  it("uses the write receipt instead of rereading the tab when no explicit verification is requested", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] !== "docs") {
        throw new Error(`Unexpected gog namespace: ${args.join(" ")}`);
      }
      if (args[1] === "cat") {
        return "Old headline\n\nBody copy";
      }
      if (args[1] === "write") {
        return JSON.stringify({ revisionToken: "rev-123" });
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await executeGoogleDocTabUpdate(
      {
        doc: "1abcDocId",
        tab: "t.target",
        account: "work@example.test",
        replacements: [{ find: "Old headline", replace: "New headline", first: true }],
      },
      {
        gogCommand: "gog",
        runCommand,
      },
    );

    expect(result).toMatchObject({
      status: "confirmed",
      docId: "1abcDocId",
      tabId: "t.target",
      verificationCount: 0,
      verificationMode: "write_receipt",
      writeReceipt: {
        revisionToken: "rev-123",
      },
    });
    expect(runCommand.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ["docs", "cat"],
      ["docs", "write"],
    ]);
  });
});
