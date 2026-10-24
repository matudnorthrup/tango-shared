import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStateViewConfigs } from "../src/config.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function configDir(yaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-views-config-"));
  dirs.push(dir);
  const category = path.join(dir, "state-views");
  fs.mkdirSync(category, { recursive: true });
  fs.writeFileSync(path.join(category, "fixture.yaml"), yaml, "utf8");
  return dir;
}

describe("state view config", () => {
  it("loads a generic deterministic projection definition", () => {
    const [view] = loadStateViewConfigs(configDir(`
id: generic-overview
enabled: true
for_each:
  types: [project]
  statuses: [active]
output_path: "Views/{root.slug}.md"
title_template: "{root.title} Overview"
sections:
  - heading: Current state
    source: state
    selector:
      where:
        project_entity_id: "$root.id"
      relation:
        kind: belongs_to
        target_entity_id: "$root.id"
      reference_roles: [evidence]
    sort:
      - field: attributes.due_at
        direction: asc
    limit: 25
    item_template: "- {entity.title} — {entity.status}"
    empty_text: "_Nothing open._"
  - heading: Timeline
    source: atlas
    selector:
      where:
        metadata.project_entity_id: "$root.id"
    sort:
      - field: created_at
        direction: desc
    item_template: "- {memory.created_at} — {memory.content}"
`));

    expect(view).toMatchObject({
      id: "generic-overview",
      enabled: true,
      forEach: { types: ["project"], statuses: ["active"] },
      outputPath: "Views/{root.slug}.md",
      titleTemplate: "{root.title} Overview",
    });
    expect(view?.sections).toHaveLength(2);
    expect(view?.sections[0]?.selector?.where).toEqual({ project_entity_id: "$root.id" });
    expect(view?.sections[0]?.selector?.relation).toEqual({ kind: "belongs_to", targetEntityId: "$root.id" });
    expect(view?.sections[0]?.selector?.referenceRoles).toEqual(["evidence"]);
    expect(view?.sections[1]?.source).toBe("atlas");
  });

  it("rejects unsafe or unbounded config shapes before rendering", () => {
    expect(() => loadStateViewConfigs(configDir(`
id: broken
for_each: {}
output_path: report.txt
title_template: Overview
sections:
  - heading: Items
    item_template: "- {entity.title}"
    limit: 501
`))).toThrow();
  });
});
