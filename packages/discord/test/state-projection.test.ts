import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService, TangoStorage, type StateViewConfig } from "@tango/core";
import { afterEach, describe, expect, it } from "vitest";
import { StateProjectionRunner } from "../src/state-projection.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-projection-"));
  dirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  let now = new Date("2026-07-18T12:00:00.000Z");
  const service = new StateService(storage.getDatabase(), { now: () => now });
  service.defineType({
    id: "activity",
    displayName: "Activity",
    origin: "seed",
    attributesSchema: {
      type: "object",
      additionalProperties: false,
      required: ["due_at"],
      properties: {
        due_at: { type: "string", format: "date" },
      },
    },
    statuses: {
      values: ["open", "done"],
      transitions: { open: ["done"], done: ["open"] },
      initial: "open",
    },
  }, { includePrivate: true });
  const context = { actor: "test", source: "test", includePrivate: true } as const;
  return {
    dir,
    storage,
    service,
    context,
    advance: () => { now = new Date(now.getTime() + 60_000); },
  };
}

const genericView: StateViewConfig = {
  id: "generic-overview",
  enabled: true,
  forEach: { types: ["project"], statuses: ["active"] },
  outputPath: "Views/{root.slug}.md",
  titleTemplate: "{root.title} Overview",
  sections: [
    {
      heading: "Current items",
      source: "state",
      selector: {
        types: ["activity"],
        statuses: ["open"],
        where: { project_entity_id: "$root.id" },
      },
      sort: [{ field: "attributes.due_at", direction: "asc" }],
      itemTemplate: "- {entity.title} — {entity.attributes.due_at}",
      emptyText: "_Nothing open._",
    },
    {
      heading: "Timeline",
      source: "atlas",
      selector: { where: { "metadata.root_ref": "$root.id" } },
      sort: [{ field: "created_at", direction: "desc" }],
      itemTemplate: "- {memory.created_at} — {memory.content}",
      emptyText: "_No narrative entries._",
    },
  ],
};

function ownedProjection(viewId: string, rootEntityId: string): string {
  return [
    "---",
    `tango_view: ${JSON.stringify(viewId)}`,
    `tango_root_entity_id: ${JSON.stringify(rootEntityId)}`,
    "read_only_projection: true",
    "source_kind: generated",
    "---",
    "# Generated fixture",
    "",
  ].join("\n");
}

describe("StateProjectionRunner", () => {
  it("renders stable state + Atlas Markdown and only rewrites when facts change", () => {
    const { dir, storage, service, context } = harness();
    const root = service.mutate({
      typeId: "project",
      title: "Synthetic Initiative",
      status: "active",
      attributes: { next_action: "Verify projection" },
    }, context).entity;
    const otherRoot = service.mutate({
      typeId: "project",
      title: "Other Synthetic Initiative",
      matchStrategy: "none",
      status: "idea",
      attributes: {},
    }, context).entity;
    service.mutate({
      typeId: "activity",
      title: "Later item",
      status: "open",
      projectEntityId: root.id,
      attributes: { due_at: "2026-07-22" },
    }, context);
    const firstActivity = service.mutate({
      typeId: "activity",
      title: "Earlier item",
      status: "open",
      projectEntityId: root.id,
      attributes: { due_at: "2026-07-20" },
    }, context).entity;
    service.mutate({
      typeId: "activity",
      title: "Other initiative item",
      status: "open",
      projectEntityId: otherRoot.id,
      attributes: { due_at: "2026-07-19" },
    }, context);

    let projectionNow = new Date("2026-07-18T12:00:00.000Z");
    const runner = new StateProjectionRunner({
      service,
      views: [genericView],
      outputRoot: path.join(dir, "vault"),
      atlasRecords: (selectedRoot) => {
        expect(selectedRoot.id).toBe(root.id);
        return [
          {
            id: "memory-2",
            content: "Second narrative entry",
            source: "conversation",
            agentId: null,
            importance: 0.5,
            createdAt: "2026-07-18T11:00:00.000Z",
            metadata: { root_ref: root.id, project_entity_id: root.id },
          },
          {
            id: "memory-1",
            content: "First narrative entry",
            source: "conversation",
            agentId: null,
            importance: 0.5,
            createdAt: "2026-07-17T11:00:00.000Z",
            metadata: { root_ref: root.id, project_entity_id: root.id },
          },
          {
            id: "memory-other",
            content: "Must not leak into this view",
            source: "conversation",
            agentId: null,
            importance: 0.5,
            createdAt: "2026-07-19T11:00:00.000Z",
            metadata: { root_ref: otherRoot.id, project_entity_id: otherRoot.id },
          },
        ];
      },
      now: () => projectionNow,
    });

    const first = runner.run();
    expect(first).toMatchObject({ views: 1, roots: 1, written: 1, unchanged: 0, removed: 0, errors: [] });
    const file = first.files[0]!.filePath;
    const markdown = fs.readFileSync(file, "utf8");
    expect(markdown).toContain("read_only_projection: true");
    expect(markdown).toContain("source_kind: generated");
    expect(markdown).toContain(`tango_root_entity_id: ${JSON.stringify(root.id)}`);
    expect(markdown.indexOf("Earlier item")).toBeLessThan(markdown.indexOf("Later item"));
    expect(markdown.indexOf("Second narrative entry")).toBeLessThan(markdown.indexOf("First narrative entry"));
    expect(markdown).not.toContain("Other initiative item");
    expect(markdown).not.toContain("Must not leak");
    const firstMtime = fs.statSync(file).mtimeMs;

    projectionNow = new Date("2026-07-18T12:01:00.000Z");
    const second = runner.run();
    expect(second).toMatchObject({ written: 0, unchanged: 1, errors: [] });
    expect(fs.statSync(file).mtimeMs).toBe(firstMtime);

    service.mutate({ entityId: firstActivity.id, status: "done" }, context);
    const third = runner.run();
    expect(third).toMatchObject({ written: 1, unchanged: 0, errors: [] });
    expect(fs.readFileSync(file, "utf8")).not.toContain("Earlier item");
    storage.close();
  });

  it("prunes only stale files owned by an enabled view without following symlinks", () => {
    const { dir, storage, service, context } = harness();
    const root = service.mutate({
      typeId: "project",
      title: "Synthetic Initiative",
      status: "active",
      attributes: {},
    }, context).entity;
    const outputRoot = path.join(dir, "vault");
    const runner = new StateProjectionRunner({ service, views: [genericView], outputRoot });
    const first = runner.run();
    const generatedFile = first.files[0]!.filePath;

    const humanFile = path.join(outputRoot, "Notes", "human.md");
    const otherViewFile = path.join(outputRoot, "Views", "other-view.md");
    const outsideFile = path.join(dir, "outside-owned.md");
    fs.mkdirSync(path.dirname(humanFile), { recursive: true });
    fs.writeFileSync(humanFile, "# Human note\n", "utf8");
    fs.writeFileSync(otherViewFile, ownedProjection("other-view", root.id), "utf8");
    fs.writeFileSync(outsideFile, ownedProjection(genericView.id, root.id), "utf8");
    fs.symlinkSync(outsideFile, path.join(outputRoot, "Views", "linked-owned.md"));

    service.mutate({ entityId: root.id, status: "blocked" }, context);
    const pruned = runner.run();
    expect(pruned).toMatchObject({ roots: 0, removed: 1, errors: [] });
    expect(fs.existsSync(generatedFile)).toBe(false);
    expect(fs.readFileSync(humanFile, "utf8")).toBe("# Human note\n");
    expect(fs.existsSync(otherViewFile)).toBe(true);
    expect(fs.existsSync(outsideFile)).toBe(true);

    fs.writeFileSync(generatedFile, ownedProjection(genericView.id, root.id), "utf8");
    const disabled = new StateProjectionRunner({
      service,
      views: [{ ...genericView, enabled: false }],
      outputRoot,
    }).run();
    expect(disabled).toMatchObject({ views: 0, removed: 0, errors: [] });
    expect(fs.existsSync(generatedFile)).toBe(true);
    storage.close();
  });

  it("moves a projection when its configured output path changes", () => {
    const { dir, storage, service, context } = harness();
    service.mutate({
      typeId: "project",
      title: "Synthetic Initiative",
      status: "active",
      attributes: {},
    }, context);
    const outputRoot = path.join(dir, "vault");
    const original = new StateProjectionRunner({ service, views: [genericView], outputRoot }).run();
    const originalFile = original.files[0]!.filePath;
    const moved = new StateProjectionRunner({
      service,
      views: [{ ...genericView, outputPath: "Dashboards/{root.slug}.md" }],
      outputRoot,
    }).run();

    expect(moved).toMatchObject({ roots: 1, written: 1, removed: 1, errors: [] });
    expect(fs.existsSync(originalFile)).toBe(false);
    expect(moved.files[0]?.filePath).toBe(path.join(outputRoot, "Dashboards", "synthetic-initiative.md"));
    expect(fs.existsSync(moved.files[0]!.filePath)).toBe(true);
    storage.close();
  });

  it("contains paths and refuses collisions with human-authored Markdown", () => {
    const { dir, storage, service, context } = harness();
    service.mutate({
      typeId: "project",
      title: "Synthetic Initiative",
      status: "active",
      attributes: {},
    }, context);
    const outputRoot = path.join(dir, "vault");
    const escaping = new StateProjectionRunner({
      service,
      views: [{ ...genericView, outputPath: "../outside.md" }],
      outputRoot,
    });
    expect(escaping.run().errors[0]?.error).toContain("escapes the configured root");
    expect(fs.existsSync(path.join(dir, "outside.md"))).toBe(false);

    const outsideDir = path.join(dir, "outside-dir");
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(outputRoot, "Views"));
    const linked = new StateProjectionRunner({ service, views: [genericView], outputRoot });
    expect(linked.run().errors[0]?.error).toContain("symbolic-link directory");
    expect(fs.readdirSync(outsideDir)).toHaveLength(0);
    fs.unlinkSync(path.join(outputRoot, "Views"));

    const humanFile = path.join(outputRoot, "Views", "synthetic-initiative.md");
    const staleOwnedFile = path.join(outputRoot, "Views", "stale-owned.md");
    fs.mkdirSync(path.dirname(humanFile), { recursive: true });
    fs.writeFileSync(humanFile, "# Human-authored note\n", "utf8");
    fs.writeFileSync(staleOwnedFile, ownedProjection(genericView.id, "stale-root"), "utf8");
    const guarded = new StateProjectionRunner({ service, views: [genericView], outputRoot });
    expect(guarded.run().errors[0]?.error).toContain("Refusing to overwrite non-projection Markdown");
    expect(fs.readFileSync(humanFile, "utf8")).toBe("# Human-authored note\n");
    expect(fs.existsSync(staleOwnedFile)).toBe(true);
    storage.close();
  });
});
