import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createObsidianTools } from "../src/personal-agent-tools.js";

// Point both supported environment inputs at a temp dir so an externally
// configured vault cannot redirect this end-to-end fixture.
let homeBackup: string | undefined;
let vaultBackup: string | undefined;
let tempHome: string;
let vault: string;

beforeEach(() => {
  homeBackup = process.env.HOME;
  vaultBackup = process.env.TANGO_OBSIDIAN_VAULT;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-gov-home-"));
  process.env.HOME = tempHome;
  vault = path.join(tempHome, "Documents", "main");
  fs.mkdirSync(vault, { recursive: true });
  process.env.TANGO_OBSIDIAN_VAULT = vault;
});

afterEach(() => {
  if (homeBackup === undefined) delete process.env.HOME;
  else process.env.HOME = homeBackup;
  if (vaultBackup === undefined) delete process.env.TANGO_OBSIDIAN_VAULT;
  else process.env.TANGO_OBSIDIAN_VAULT = vaultBackup;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

async function run(command: string, content?: string): Promise<string> {
  const [obsidian] = createObsidianTools();
  const res = await obsidian!.handler(content === undefined ? { command } : { command, content });
  return (res as { result: string }).result;
}

function writeNote(rel: string, body: string): void {
  const target = path.join(vault, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, "utf8");
}

function readNote(rel: string): string {
  return fs.readFileSync(path.join(vault, rel), "utf8");
}

describe("obsidian governance (source protection + versioning)", () => {
  it("leaves plain notes (no governance frontmatter) fully editable", async () => {
    expect(await run("create 'Notes/Plain' --vault main", "hello")).toContain("Created");
    expect(await run("create 'Notes/Plain' --vault main --overwrite", "hello v2")).toContain("Overwrote");
    expect(readNote("Notes/Plain.md")).toBe("hello v2");
    expect(await run("versions 'Notes/Plain' --vault main")).toContain("(no prior versions)");
  });

  it("refuses to mutate read-only source material without --force", async () => {
    writeNote("Records/Filing.md", "---\nsource_kind: source\n---\nOfficial filing text.\n");
    expect(await run("create 'Records/Filing' --vault main --overwrite", "tampered")).toContain("read-only source material");
    expect(await run("create 'Records/Filing' --vault main --append", "extra")).toContain("read-only source material");
    expect(await run("delete 'Records/Filing' --vault main")).toContain("read-only source material");
    expect(await run("move 'Records/Filing' 'Records/Moved' --vault main")).toContain("read-only source material");
    // The source document is untouched on disk.
    expect(readNote("Records/Filing.md")).toContain("Official filing text.");
  });

  it("allows source edits when --force is given", async () => {
    writeNote("Records/Filing.md", "---\nsource_kind: source\n---\nOfficial.\n");
    expect(await run("create 'Records/Filing' --vault main --overwrite --force", "corrected")).toContain("Overwrote");
    expect(readNote("Records/Filing.md")).toBe("corrected");
  });

  it("snapshots versioned drafts before mutation and can restore a prior version", async () => {
    writeNote("Records/Draft.md", "---\nversioned: true\n---\nv1 body\n");
    expect(await run("create 'Records/Draft' --vault main --overwrite", "---\nversioned: true\n---\nv2 body\n")).toContain("Overwrote");

    const listing = await run("versions 'Records/Draft' --vault main");
    const stamps = listing.split("\n").filter((line) => line && line !== "(no prior versions)");
    expect(stamps.length).toBe(1);

    expect(await run(`versions 'Records/Draft' --vault main --restore ${stamps[0]}`)).toContain("Restored");
    expect(readNote("Records/Draft.md")).toContain("v1 body");
  });

  it("does not allow a non-canonical reference doc to be deleted without --force", async () => {
    writeNote("References/Standard.md", "---\nsource_kind: reference\n---\nRCW text.\n");
    expect(await run("delete 'References/Standard' --vault main")).toContain("read-only source material");
    expect(await run("delete 'References/Standard' --vault main --force")).toContain("Deleted");
  });

  it("never lets agent tools mutate generated read-only projections", async () => {
    writeNote(
      "Views/Synthetic Overview.md",
      [
        "---",
        "tango_view: generic-overview",
        "tango_root_entity_id: synthetic-root",
        "read_only_projection: true",
        "source_kind: generated",
        "---",
        "# Synthetic Overview",
        "",
        "## Current",
        "Generated content.",
        "",
      ].join("\n"),
    );

    const commands = [
      ["create 'Views/Synthetic Overview' --vault main --append --force", "extra"],
      ["create 'Views/Synthetic Overview' --vault main --overwrite --force", "replacement"],
      ["section 'Views/Synthetic Overview' --vault main --heading 'Current' --force", "replacement"],
      ["frontmatter 'Views/Synthetic Overview' --vault main --edit --key 'status' --value 'done' --force", undefined],
      ["move 'Views/Synthetic Overview' 'Views/Moved' --vault main --force", undefined],
      ["delete 'Views/Synthetic Overview' --vault main --force", undefined],
    ] as const;
    for (const [command, content] of commands) {
      expect(await run(command, content)).toContain("read_only_projection");
    }
    expect(readNote("Views/Synthetic Overview.md")).toContain("Generated content.");
  });

  it("enforces required frontmatter on governed notes only", async () => {
    // A state-managed note missing types/areas is refused with an actionable error.
    const bad = await run(
      "create 'Projects/Trip' --vault main --overwrite",
      "---\nstate_managed: true\ndate: 2026-06-02\n---\n## Quick Read\nx\n",
    );
    expect(bad).toContain("missing required frontmatter");
    expect(bad).toContain("types");
    expect(bad).toContain("areas");

    // The same note with all required fields is written.
    const good = await run(
      "create 'Projects/Trip' --vault main --overwrite",
      "---\nstate_managed: true\ndate: 2026-06-02\ntypes:\n  - \"[[Project Plan]]\"\nareas:\n  - \"[[Personal]]\"\n---\n## Quick Read\nx\n",
    );
    expect(good).toContain("Created");

    // A plain note (not governed) is unaffected by schema enforcement.
    expect(await run("create 'Notes/Loose' --vault main", "just text")).toContain("Created");
  });
});
