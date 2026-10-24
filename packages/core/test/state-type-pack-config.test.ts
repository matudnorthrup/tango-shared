import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStateTypePackConfigs } from "../src/config.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function configDir(yaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-type-packs-config-"));
  dirs.push(dir);
  const category = path.join(dir, "state-type-packs");
  fs.mkdirSync(category, { recursive: true });
  fs.writeFileSync(path.join(category, "fixture.yaml"), yaml, "utf8");
  return dir;
}

describe("state type pack config", () => {
  it("loads schema-only generic type definitions", () => {
    const [pack] = loadStateTypePackConfigs(configDir(`
id: synthetic-tracking
enabled: true
types:
  - id: synthetic-item
    display_name: Synthetic Item
    description: A sanitized reusable fixture.
    attributes_schema:
      type: object
      additionalProperties: false
      properties:
        priority:
          type: string
    statuses:
      values: [open, complete]
      transitions:
        open: [complete]
        complete: [open]
      initial: open
      terminal: [complete]
    staleness_policy:
      expected_update_days: 7
      on_stale: nudge
    digest_template: "{title} — {status}"
    body_fields: [status, priority]
    visibility: shared
`));

    expect(pack).toMatchObject({
      id: "synthetic-tracking",
      enabled: true,
      types: [{
        id: "synthetic-item",
        displayName: "Synthetic Item",
        statuses: { values: ["open", "complete"], initial: "open", terminal: ["complete"] },
        stalenessPolicy: { expected_update_days: 7, on_stale: "nudge" },
        bodyFields: ["status", "priority"],
        visibility: "shared",
      }],
    });
  });

  it("rejects duplicate type ids before installation", () => {
    expect(() => loadStateTypePackConfigs(configDir(`
id: duplicate-pack
enabled: true
types:
  - id: synthetic-item
    display_name: First
    attributes_schema: { type: object }
  - id: SYNTHETIC-ITEM
    display_name: Second
    attributes_schema: { type: object }
`))).toThrow(/Duplicate type id/u);
  });
});
