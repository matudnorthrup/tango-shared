import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TangoStorage } from "@tango/core";
import {
  buildStateFilePointer,
  conversationKeyFor,
  refreshProjectHeadOnTurn,
  renderProjectStateBlock,
  resolveStateVaultRoot,
} from "../src/project-state.js";
import {
  formatStateBodyPointer,
  normalizeProfileStateBodyPath,
  parseStateBodyPointer,
  readStateBody,
  resolveProfileStateBodyPath,
} from "../src/state-body-provider.js";
import { createAtlasColdStartContextBuilder } from "../src/v2-runtime.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorage(): TangoStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-project-state-"));
  tempDirs.push(dir);
  return new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
}

describe("project-state integration", () => {
  it("resolves state vaults from injection, configuration, or an isolated profile", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-vault-root-"));
    tempDirs.push(root);
    const injected = path.join(root, "injected");
    const configured = path.join(root, "configured");

    vi.stubEnv("TANGO_OBSIDIAN_VAULT", configured);
    expect(resolveStateVaultRoot(injected)).toBe(injected);
    expect(resolveStateVaultRoot()).toBe(configured);

    vi.stubEnv("TANGO_OBSIDIAN_VAULT", "");
    vi.stubEnv("TANGO_HOME", root);
    vi.stubEnv("TANGO_PROFILE", "wt-2");
    expect(resolveStateVaultRoot()).toBe(path.join(root, "profiles", "wt-2", "notes"));
    expect(fs.existsSync(path.join(root, "profiles", "wt-2", "notes"))).toBe(false);

    // The repo's shared .env may configure the production vault. Slot identity
    // must still win so a live-test bot cannot write operator documents.
    vi.stubEnv("TANGO_OBSIDIAN_VAULT", configured);
    vi.stubEnv("TANGO_SLOT", "2");
    expect(resolveStateVaultRoot()).toBe(path.join(root, "profiles", "wt-2", "notes"));
  });

  it("derives the conversation key like TangoRouter", () => {
    expect(conversationKeyFor("chan-1")).toBe("channel:chan-1");
    expect(conversationKeyFor("chan-1", "thread-9")).toBe("thread:thread-9");
  });

  it("returns no pointer or block when the conversation is not a project arc", () => {
    const storage = createStorage();
    expect(buildStateFilePointer(storage, "thread:none")).toBeUndefined();
    expect(renderProjectStateBlock(storage, "thread:none")).toBeUndefined();
    storage.close();
  });

  it("builds a whisper pointer and a reseed block from the head + open items", () => {
    const storage = createStorage();
    const key = "thread:launch";
    storage.upsertProjectState({
      projectId: key,
      title: "Launch Plan",
      status: "planning",
      quickRead: "Release path locked; vendor decision open.",
      obsidianPath: "Launch Plan.md",
    });

    const pointer = buildStateFilePointer(storage, key);
    expect(pointer).toEqual({
      path: "Launch Plan.md",
      project: "Launch Plan",
      status: "planning",
    });

    storage.upsertActiveContextItem({
      key: "vendor-decision",
      kind: "decision",
      title: "Vendor decision",
      summary: "Decide whether to keep the current vendor or switch.",
      scope: { projectId: key },
    });

    const block = renderProjectStateBlock(storage, key)!;
    expect(block).toContain("Project: Launch Plan (status: planning)");
    expect(block).toContain("Quick read: Release path locked");
    expect(block).toContain("State file: Launch Plan.md");
    expect(block).toContain("read it before responding");
    expect(block).toContain("Open items:");
    expect(block).toContain("[decision] Vendor decision: Decide whether to keep");
    storage.close();
  });

  it("refreshes the head's session chain on a turn, and no-ops without a head", () => {
    const storage = createStorage();
    const key = "thread:italy";

    // No head yet → no-op (must not create one).
    refreshProjectHeadOnTurn(storage, key, "session-1");
    expect(storage.getProjectState(key)).toBeUndefined();

    storage.upsertProjectState({ projectId: key, title: "Italy", obsidianPath: "Italy.md" });
    refreshProjectHeadOnTurn(storage, key, "session-xyz");
    expect(storage.getProjectState(key)?.prevSessionId).toBe("session-xyz");
    storage.close();
  });

  it("emits a pointer only when an obsidian body is linked", () => {
    const storage = createStorage();
    const key = "thread:nopath";
    storage.upsertProjectState({ projectId: key, title: "No body yet", status: "active" });
    // Head exists but no obsidian_path → reseed block renders, pointer does not.
    expect(buildStateFilePointer(storage, key)).toBeUndefined();
    expect(renderProjectStateBlock(storage, key)).toContain("Project: No body yet");
    storage.close();
  });

  it("reads the live Obsidian body for reseed when a vault root is supplied", () => {
    const storage = createStorage();
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-vault-"));
    tempDirs.push(vaultRoot);
    const rel = "Projects/Launch.md";
    fs.mkdirSync(path.join(vaultRoot, "Projects"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, rel),
      [
        "---", "status: planning", "---", "",
        "## Quick Read", "Release path locked; staging buffer added.", "",
        "## Open Items", "- Confirm launch checklist", "- Decide vendor owner", "",
        "## Notes", "misc",
      ].join("\n"),
    );

    const key = "thread:launch";
    storage.upsertProjectState({
      projectId: key, title: "Launch", status: "active", quickRead: "stale head text", obsidianPath: rel,
    });

    const block = renderProjectStateBlock(storage, key, { vaultRoot })!;
    expect(block).toContain("Quick read: Release path locked; staging buffer added.");
    expect(block).not.toContain("stale head text"); // live body overrides the head
    expect(block).toContain("- Confirm launch checklist");
    expect(block).toContain("- Decide vendor owner");

    // Missing file → graceful fallback to the head's quick read.
    storage.upsertProjectState({
      projectId: "thread:gone", title: "Gone", obsidianPath: "Trips/missing.md", quickRead: "fallback text",
    });
    expect(renderProjectStateBlock(storage, "thread:gone", { vaultRoot })).toContain(
      "Quick read: fallback text",
    );
    storage.close();
  });

  it("reads a profile-backed state body for pointer snapshots and reseed blocks", () => {
    const storage = createStorage();
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-"));
    tempDirs.push(profileRoot);
    fs.mkdirSync(path.join(profileRoot, "threads"), { recursive: true });
    fs.writeFileSync(
      path.join(profileRoot, "threads", "launch.md"),
      [
        "---", "status: waiting", "---", "",
        "## Quick Read", "Profile body is now canonical for this launch.", "",
        "## Open Items", "- Confirm profile-backed read path", "- Keep Obsidian legacy paths working", "",
      ].join("\n"),
    );

    const key = "thread:profile-launch";
    storage.upsertProjectState({
      projectId: key,
      title: "Profile Launch",
      status: "active",
      quickRead: "stale head text",
      obsidianPath: "profile:threads/launch.md",
    });

    const pointer = buildStateFilePointer(storage, key, { profileRoot });
    expect(pointer).toEqual({
      path: "profile:threads/launch.md",
      project: "Profile Launch",
      status: "waiting",
      snapshot: "Profile body is now canonical for this launch.",
    });

    const block = renderProjectStateBlock(storage, key, { profileRoot })!;
    expect(block).toContain("Project: Profile Launch (status: waiting)");
    expect(block).toContain("Quick read: Profile body is now canonical");
    expect(block).not.toContain("stale head text");
    expect(block).toContain("State file: profile:threads/launch.md");
    expect(block).toContain("- Confirm profile-backed read path");
    expect(block).toContain("- Keep Obsidian legacy paths working");
    storage.close();
  });

  it("builds a live pointer snapshot (status + Quick Read) from the body when a vault root is given", () => {
    const storage = createStorage();
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-vault-"));
    tempDirs.push(vaultRoot);
    fs.writeFileSync(
      path.join(vaultRoot, "Trip.md"),
      "---\nstatus: active\n---\n\n## Quick Read\n+2 days confirmed; Three Peaks loop is on.\n",
    );
    const key = "thread:x";
    // Head says "planning"; the live body says "active" and should win.
    storage.upsertProjectState({ projectId: key, title: "Trip", status: "planning", obsidianPath: "Trip.md" });

    const headOnly = buildStateFilePointer(storage, key);
    expect(headOnly?.status).toBe("planning");
    expect(headOnly?.snapshot).toBeUndefined();

    const live = buildStateFilePointer(storage, key, { vaultRoot });
    expect(live?.status).toBe("active");
    expect(live?.snapshot).toContain("+2 days confirmed; Three Peaks loop is on.");
    storage.close();
  });

  it("the cold-start builder injects the project reseed block (end-to-end wiring)", async () => {
    const storage = createStorage();
    const key = "thread:launch";
    storage.upsertProjectState({
      projectId: key, title: "Launch Plan", status: "planning",
      quickRead: "Release path locked.", obsidianPath: "Launch.md",
    });
    const atlasStub = { pinnedFactGet: async () => [], memorySearch: async () => [] };
    const builder = createAtlasColdStartContextBuilder(atlasStub as never, {
      projectStateProvider: (ck) => renderProjectStateBlock(storage, ck),
    });

    const ctx = await builder(key, "sierra");
    expect(ctx.recentMessages).toContain("Project state:");
    expect(ctx.recentMessages).toContain("Project: Launch Plan (status: planning)");
    expect(ctx.recentMessages).toContain("Quick read: Release path locked.");
    expect(ctx.recentMessages).toContain("State file: Launch.md");

    // Unbound conversation → no project block.
    const empty = await builder("thread:unbound", "sierra");
    expect(empty.recentMessages).toBe("");
    storage.close();
  });
});

describe("state body provider", () => {
  it("treats plain paths as legacy Obsidian and profile URIs as profile bodies", () => {
    const legacy = parseStateBodyPointer("Projects/Launch.md");
    expect(legacy.provider).toBe("obsidian");
    expect(legacy.path).toBe("Projects/Launch.md");
    expect(formatStateBodyPointer(legacy)).toBe("Projects/Launch.md");

    const profile = parseStateBodyPointer("threads/Launch.md", { provider: "profile" });
    expect(profile.provider).toBe("profile");
    expect(profile.path).toBe("threads/Launch.md");
    expect(formatStateBodyPointer(profile)).toBe("profile:threads/Launch.md");

    expect(parseStateBodyPointer("profile:collab/handoff.md")).toMatchObject({
      provider: "profile",
      path: "collab/handoff.md",
      displayPath: "profile:collab/handoff.md",
    });
  });

  it("rejects unsafe profile state body paths", () => {
    expect(() => normalizeProfileStateBodyPath("../threads/launch.md")).toThrow(/traverse/i);
    expect(() => normalizeProfileStateBodyPath("threads/../launch.md")).toThrow(/traverse/i);
    expect(() => normalizeProfileStateBodyPath("/tmp/launch.md")).toThrow(/relative/i);
    expect(() => normalizeProfileStateBodyPath("private/launch.md")).toThrow(/start with/i);
    expect(() => normalizeProfileStateBodyPath("threads/launch.txt")).toThrow(/markdown/i);
    expect(() => parseStateBodyPointer("profile:/tmp/launch.md")).toThrow(/relative/i);
  });

  it("rejects profile body symlink escapes", () => {
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-"));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-outside-"));
    tempDirs.push(profileRoot, outsideRoot);

    fs.mkdirSync(path.join(profileRoot, "threads"), { recursive: true });
    const outsideFile = path.join(outsideRoot, "escaped.md");
    fs.writeFileSync(outsideFile, "## Quick Read\noutside\n");
    fs.symlinkSync(outsideFile, path.join(profileRoot, "threads", "escaped.md"));

    expect(() => resolveProfileStateBodyPath("threads/escaped.md", { profileRoot })).toThrow(/escapes/i);
    expect(() => readStateBody("profile:threads/escaped.md", { profileRoot })).toThrow(/escapes/i);
  });
});
