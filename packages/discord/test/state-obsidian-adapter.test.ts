import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService, TangoStorage } from "@tango/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseFrontmatter, StateObsidianAdapter } from "../src/state-obsidian-adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("StateObsidianAdapter", () => {
  it("mirrors the canonical head, ingests only declared human edits, ignores narrative, and flags invalid edits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-obsidian-"));
    dirs.push(dir);
    const vault = path.join(dir, "vault");
    fs.mkdirSync(vault);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    const service = new StateService(storage.getDatabase(), { now: () => new Date("2026-07-17T12:00:00Z") });
    const created = service.mutate({
      typeId: "project",
      title: "Obsidian Fixture",
      status: "active",
      attributes: { next_action: "Initial action", progress_pct: 10 },
      bodyPointer: "obsidian:state/fixture.md",
    }, { actor: "test", source: "test", includePrivate: true, turnId: "turn-create" });
    const file = path.join(vault, "state", "fixture.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "---\nstatus: idea\nnext_action: stale\nunrelated: keep\n---\nHuman narrative.\n", "utf8");

    const adapter = new StateObsidianAdapter({ service, vaultRoot: vault });
    expect(await adapter.scan()).toMatchObject({ linked: 1, mirrored: 1 });
    let doc = parseFrontmatter(fs.readFileSync(file, "utf8"));
    expect(doc.data).toMatchObject({ status: "active", next_action: "Initial action", progress_pct: 10, unrelated: "keep" });
    expect(doc.body).toBe("Human narrative.\n");
    const baselineEvents = service.listEvents(created.entity.id).length;

    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Human narrative.", "Edited narrative only."), "utf8");
    expect(await adapter.ingestFile(file)).toBe("unchanged");
    expect(service.listEvents(created.entity.id)).toHaveLength(baselineEvents);

    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("progress_pct: 10", "progress_pct: 35"), "utf8");
    expect(await adapter.ingestFile(file)).toBe("ingested");
    expect(service.getEntity(created.entity.id, {}, true)?.attributes.progress_pct).toBe(35);
    expect(service.listEvents(created.entity.id)[0]?.actor).toBe("user");
    expect(service.getEntity(created.entity.id, {}, true)?.source).toBe("obsidian");

    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("progress_pct: 35", "progress_pct: 135"), "utf8");
    expect(await adapter.ingestFile(file)).toBe("invalid");
    expect(service.getEntity(created.entity.id, {}, true)?.attributes.progress_pct).toBe(35);
    expect(service.listIssues("open").some((issue) => issue.entityId === created.entity.id && issue.kind === "body_validation")).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("progress_pct: 135");

    fs.writeFileSync(
      file,
      "---\ntango_view: generic-overview\nread_only_projection: true\nsource_kind: generated\nprogress_pct: 90\n---\n# Generated\n",
      "utf8",
    );
    expect(await adapter.ingestFile(file)).toBe("unchanged");
    expect(service.getEntity(created.entity.id, {}, true)?.attributes.progress_pct).toBe(35);
    adapter.stop();
    storage.close();
  });

  it("degrades cleanly when the vault is unavailable and rejects path traversal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-obsidian-offline-"));
    dirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    const service = new StateService(storage.getDatabase());
    service.mutate({ typeId: "project", title: "Offline Fixture", status: "active", attributes: {}, bodyPointer: "obsidian:missing.md" }, { actor: "test", source: "test", includePrivate: true });
    const unavailable = new StateObsidianAdapter({ service, vaultRoot: path.join(dir, "missing-vault") });
    expect(await unavailable.scan()).toMatchObject({ unavailable: 1 });

    service.mutate({ typeId: "project", title: "Escape Fixture", status: "active", attributes: {}, bodyPointer: "obsidian:../escape.md" }, { actor: "test", source: "test", includePrivate: true });
    fs.mkdirSync(path.join(dir, "vault"));
    const guarded = new StateObsidianAdapter({ service, vaultRoot: path.join(dir, "vault") });
    expect((await guarded.scan()).invalid).toBe(1);
    storage.close();
  });
});
