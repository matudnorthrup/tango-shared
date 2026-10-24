import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOffroadTools } from "../src/offroad-agent-tools.js";

// Fake engines that echo what they were called with, so the tests cover the tool plumbing only.
const ECHO = `const a = process.argv.slice(2); const j = a.find((x) => x.startsWith("--json="));
process.stdout.write(JSON.stringify({ ok: true, script: process.argv[1].split("/").pop(), args: a.filter((x) => !x.startsWith("--json=")), input: j ? JSON.parse(j.slice(7)) : null, home: process.env.OFFROAD_HOME }));`;
const ADAPTER = `const a = process.argv.slice(2); const j = JSON.parse((a.find((x) => x.startsWith("--json=")) || "--json={}").slice(7));
if (a.includes("--export")) process.stdout.write(JSON.stringify({ ok: true, item: { id: "R1", name: "20 mile Loop", kind: "route" }, geojson_path: "/tmp/r1.geojson", request: j }));
else process.stdout.write(JSON.stringify({ ok: true, listed: true, request: j, command: a[0] }));`;

const tool = (name: string) => {
  const t = createOffroadTools().find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe("offroad agent tools", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "offroad-tools-"));
    const engine = path.join(dir, "engine");
    const home = path.join(dir, "home");
    fs.mkdirSync(engine);
    fs.mkdirSync(path.join(home, "adapters"), { recursive: true });
    fs.writeFileSync(path.join(engine, "ridebook.mjs"), ECHO);
    for (const f of ["offroad-check.mjs", "offroad-plan.mjs", "offroad-networks.mjs", "offroad-photos.mjs"]) fs.writeFileSync(path.join(engine, f), ECHO);
    fs.writeFileSync(path.join(home, "adapters", "trail-app.mjs"), ADAPTER);
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ trail_app: { adapter: "adapters/trail-app.mjs" } }));
    for (const k of ["OFFROAD_ENGINE_DIR", "OFFROAD_HOME", "TANGO_DATA_DIR"]) saved[k] = process.env[k];
    process.env.OFFROAD_ENGINE_DIR = engine;
    process.env.OFFROAD_HOME = home;
    process.env.TANGO_DATA_DIR = path.join(dir, "data");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exposes the ten tools, and promote needs a named requester", () => {
    expect(createOffroadTools().map((t) => t.name)).toEqual([
      "offroad_check",
      "offroad_plan",
      "offroad_networks",
      "offroad_photos",
      "trail_app_library",
      "trail_app_import",
      "ridebook_status",
      "ridebook_update",
      "ridebook_publish",
      "ridebook_promote",
    ]);
    expect((tool("ridebook_promote").inputSchema as { required?: string[] }).required).toEqual(["requested_by"]);
    expect(tool("ridebook_promote").description).toMatch(/ONLY call when the owner explicitly asks/);
  });

  it("checks a trail-app route by exporting it first, writing under the data dir", async () => {
    const out = (await tool("offroad_check").handler({ trail_app: "20 mile" })) as Record<string, any>;
    expect(out.script).toBe("offroad-check.mjs");
    expect(out.input.geojson_path).toBe("/tmp/r1.geojson");
    expect(out.input.title).toBe("20 mile Loop");
    expect(out.input.trail_app).toBeUndefined();
    expect(out.input.out_dir.startsWith(path.join(dir, "data", "offroad", "checks", "20-mile-loop-"))).toBe(true);
    expect(out.trail_app_item).toMatchObject({ id: "R1", name: "20 mile Loop" });
  });

  it("refuses a check with no route source", async () => {
    const out = (await tool("offroad_check").handler({ title: "nothing" })) as Record<string, any>;
    expect(out).toMatchObject({ ok: false });
  });

  it("routes planning, networks and photos to their engines with output under the data dir", async () => {
    const plan = (await tool("offroad_plan").handler({ start: "44.31,-124.10", miles: [20, 30], title: "Coast loop" })) as Record<string, any>;
    expect(plan.script).toBe("offroad-plan.mjs");
    expect(plan.input).toMatchObject({ start: "44.31,-124.10", miles: [20, 30] });
    expect(plan.input.out_dir.startsWith(path.join(dir, "data", "offroad", "plans", "coast-loop-"))).toBe(true);
    const nets = (await tool("offroad_networks").handler({ center: "Petersburg, OR" })) as Record<string, any>;
    expect(nets.script).toBe("offroad-networks.mjs");
    expect(nets.input.out_dir.startsWith(path.join(dir, "data", "offroad", "networks", "petersburg-or-"))).toBe(true);
    const photos = (await tool("offroad_photos").handler({ action: "fetch", titles: ["File:A.jpg"] })) as Record<string, any>;
    expect(photos.args).toEqual(["--fetch"]);
    expect(photos.input.titles).toEqual(["File:A.jpg"]);
    expect(photos.input.action).toBeUndefined();
  });

  it("routes trail-app imports and filing retries to the adapter, and needs routes for an import", async () => {
    const imp = (await tool("trail_app_import").handler({ routes: [{ file: "/tmp/a.gpx", name: "A" }], folder: "Sierra ideas" })) as Record<string, any>;
    expect(imp).toMatchObject({ ok: true, command: "--import", request: { routes: [{ file: "/tmp/a.gpx", name: "A" }], folder: "Sierra ideas" } });
    const retry = (await tool("trail_app_import").handler({ retry_ids: ["x1"], folder: "Sierra ideas" })) as Record<string, any>;
    expect(retry).toMatchObject({ command: "--file", request: { ids: ["x1"], folder: "Sierra ideas" } });
    expect(await tool("trail_app_import").handler({ folder: "Sierra ideas" })).toMatchObject({ ok: false });
  });

  it("passes library filters through to the profile adapter", async () => {
    const out = (await tool("trail_app_library").handler({ action: "list", kind: "route", query: "loop" })) as Record<string, any>;
    expect(out).toMatchObject({ ok: true, listed: true, command: "--list", request: { kind: "route", query: "loop" } });
  });

  it("routes ride book updates, removals, publish and promote to the right engine commands", async () => {
    const up = (await tool("ridebook_update").handler({ ride: { id: "a-ride", name: "A ride", area: "coast" } })) as Record<string, any>;
    expect(up.args).toEqual(["--upsert"]);
    expect(up.input.ride.id).toBe("a-ride");
    const rm = (await tool("ridebook_update").handler({ remove_ride: "a-ride", book: "example" })) as Record<string, any>;
    expect(rm.args).toEqual(["--remove"]);
    expect(rm.input).toEqual({ id: "a-ride", book: "example" });
    const pub = (await tool("ridebook_publish").handler({})) as Record<string, any>;
    expect(pub.args).toEqual(["--stage-family"]);
    const promote = (await tool("ridebook_promote").handler({ requested_by: "owner", book: "example" })) as Record<string, any>;
    expect(promote.args).toEqual(["--promote-family", "--book=example"]);
    expect(promote.home).toBe(process.env.OFFROAD_HOME);
  });
});
