import { describe, expect, it } from "vitest";
import {
  applyEditPatch,
  missingFrozenHeadings,
  validateProfileStateFileMutation,
} from "../src/profile-state-write-guard.js";

const CANARY = `---
status: active
state_managed: true
---

# Cod-E canary

## Quick Read

Smoke in progress.

## Open Items

- [ ] A8 pending

## Notes

probe
`;

describe("profile-state-write-guard", () => {
  it("allows targeted patch that preserves frozen headings", () => {
    const next = applyEditPatch(CANARY, "A8 pending", "A8 pass")!;
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/infrastructure/cod-e-canary/cod-e-canary.md",
      existingContent: CANARY,
      nextContent: next,
      operation: "patch",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks A5-style full overwrite on existing thread file", () => {
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/infrastructure/cod-e-canary/cod-e-canary.md",
      existingContent: CANARY,
      nextContent: "This is a full overwrite test. All original content should be gone.",
      operation: "write",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/full-file write on an existing/i);
  });

  it("blocks write on existing thread even when frozen headings are preserved", () => {
    const replacement = `---
status: active
state_managed: true
---

# Cod-E canary

## Quick Read

Replaced entirely via write.

## Open Items

- [ ] still here

## Notes

${"x".repeat(500)}
`;
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/infrastructure/cod-e-canary/cod-e-canary.md",
      existingContent: CANARY,
      nextContent: replacement,
      operation: "write",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/full-file write on an existing/i);
  });

  it("allows create-on-missing thread file with contract headings", () => {
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/infrastructure/new-thread/new-thread.md",
      nextContent: CANARY,
      operation: "write",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(true);
  });

  it("allows patch that removes a mistaken non-contract section", () => {
    const withMistake = `${CANARY}

## Oops Wrong Section

This should not have been added.
`;
    const next = applyEditPatch(
      withMistake,
      "\n## Oops Wrong Section\n\nThis should not have been added.\n",
      "",
    )!;
    expect(next).not.toContain("Oops Wrong Section");
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/infrastructure/cod-e-canary/cod-e-canary.md",
      existingContent: withMistake,
      nextContent: next,
      operation: "patch",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks patch that removes a frozen heading", () => {
    const next = applyEditPatch(CANARY, "## Open Items\n\n- [ ] A8 pending\n", "")!;
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/infrastructure/cod-e-canary/cod-e-canary.md",
      existingContent: CANARY,
      nextContent: next,
      operation: "patch",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/missing frozen heading/i);
  });

  it("blocks patch that would empty the thread file", () => {
    const next = applyEditPatch(CANARY, CANARY.trim(), "") ?? "";
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/infrastructure/cod-e-canary/cod-e-canary.md",
      existingContent: CANARY,
      nextContent: next,
      operation: "patch",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it("blocks empty write", () => {
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/foo.md",
      existingContent: CANARY,
      nextContent: "   ",
      operation: "write",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(false);
  });

  it("detects missing frozen headings", () => {
    expect(missingFrozenHeadings("# no headings")).toEqual(["Quick Read", "Open Items"]);
  });

  it("can simulate replace-all edits before validating hook output", () => {
    const content = `${CANARY}\nA8 pending again\n`;
    const next = applyEditPatch(content, "A8 pending", "A8 pass", true)!;
    expect(next).not.toContain("A8 pending");
    expect(next.match(/A8 pass/gu)).toHaveLength(2);
  });

  it("does not simulate empty-string edits", () => {
    expect(applyEditPatch(CANARY, "", "prefix")).toBeNull();
  });

  it("ignores non-thread paths", () => {
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/agents/assistants/cod-e/knowledge.md",
      existingContent: "long ".repeat(100),
      nextContent: "short",
      operation: "write",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(true);
  });
});
