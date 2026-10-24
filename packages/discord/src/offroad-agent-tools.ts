/**
 * Off-road agent tools: check a motorcycle / off-road route for who may legally ride it, read the owner's
 * trail app library, and maintain + publish ride books.
 *
 * Thin typed pass-throughs to engine CLIs that take and return JSON:
 *   - scripts/offroad/offroad-check.mjs   legality (USFS MVUM, closed NFS roads, land manager, state forestry
 *                                         ownership where available), surface, shape, gates, map image
 *   - scripts/offroad/offroad-plan.mjs    candidate rides from the local routing engine, checked and repaired
 *   - scripts/offroad/offroad-networks.mjs  connected roads open to all vehicles (unplated bikes)
 *   - scripts/offroad/offroad-photos.mjs  freely licensed photos (Wikimedia Commons) for stops
 *   - scripts/offroad/ridebook.mjs        ride book data, private build, family copy stage and promote
 *   - <profile>/offroad/<trail_app.adapter>  read-only adapter for the owner's trail app (profile layer, because
 *                                         it names the owner's account and app)
 *
 * Which books exist, where they publish, and the trail app adapter come from
 * <profile>/offroad/config.json; nothing personal lives in the repo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { resolveTangoDataDir, resolveTangoProfileDir, type AgentTool } from "@tango/core";
import { ensureSiteSession } from "./site-session.js";

const execFileAsync = promisify(execFile);

export function offroadHome(): string {
  return process.env.OFFROAD_HOME || path.join(resolveTangoProfileDir(), "offroad");
}

function engineDir(): string {
  return process.env.OFFROAD_ENGINE_DIR || path.join(process.cwd(), "scripts", "offroad");
}

interface OffroadConfig {
  trail_app?: { name?: string; adapter?: string; site?: string };
}

function loadConfig(): OffroadConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(offroadHome(), "config.json"), "utf8")) as OffroadConfig;
  } catch {
    return {};
  }
}

/** Run a node script that prints one JSON object; non-zero exits still print JSON. */
export async function runJsonScript(script: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync("node", [script, ...args], {
      cwd: path.dirname(script),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, OFFROAD_HOME: offroadHome() },
    });
    try {
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "engine produced non-JSON output", raw: stdout.slice(-1500) };
    }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const out = (e.stdout || "").toString();
    try {
      return JSON.parse(out) as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    if (e.killed) return { ok: false, error: `engine timed out after ${Math.round(timeoutMs / 1000)}s` };
    return { ok: false, error: (e.stderr || e.message || "engine error").toString().slice(0, 800) };
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "route";

async function runTrailApp(command: "--status" | "--list" | "--export" | "--import" | "--file", input: Record<string, unknown>, timeoutMs = 180_000): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  if (!cfg.trail_app?.adapter) {
    return { ok: false, error: "no trail app configured (trail_app.adapter in the profile's offroad/config.json)" };
  }
  const adapter = path.resolve(offroadHome(), cfg.trail_app.adapter);
  const args = [command, `--json=${JSON.stringify(input)}`];
  let result = await runJsonScript(adapter, args, timeoutMs);
  // Signed out: restore the session with the generic site-session machinery, then retry once.
  if (result.ok === false && result.needs_sign_in === true && cfg.trail_app.site) {
    const restore = await ensureSiteSession({ site: cfg.trail_app.site, allowLogin: true })
      .then((s) => ({ authenticated: s.authenticated, path: s.path, message: s.message }))
      .catch((err: unknown) => ({ authenticated: false, path: "failed", message: String(err) }));
    result = restore.authenticated ? await runJsonScript(adapter, args, timeoutMs) : result;
    result.session_restore = restore;
  }
  return result;
}

function ridebook(args: string[], timeoutMs = 300_000): Promise<Record<string, unknown>> {
  return runJsonScript(path.join(engineDir(), "ridebook.mjs"), args, timeoutMs);
}

const rideSchema = {
  type: "object",
  description: [
    "Ride fields to set (patch: only what changes; null deletes a field). Required for a new ride: id, name, area.",
    "Core: id (lowercase-dashes), name, area (an area id in the book), kind route|trail, status open|seasonal|closed|done|fix|idea,",
    "shape loop|loop-with-spurs|out-and-back|one-way|area, surface paved|mixed|gravel|trail|sand, diff [low, high] on 1-5, unplated (bool),",
    "code (short label like 'C' or 'DB'), eyebrow, dek (one line), from, time ('~2 h'), diffNote, statusNote, shapeNote, tags [..],",
    "roads [{c: fs|hw|co|pl|arr, t}], stops [{n, name, text, opt}], heads (heads-up), eat, reportsHtml, filesHtml, facts [[k, v]],",
    "pairs [ride ids], private (bool: owner-only, never in the family copy), app {url, label, name, folder} (trail app link, private copy only),",
    "share {field: value} (family-copy overrides for fields whose private text is personal).",
  ].join(" "),
  additionalProperties: true,
};

export function createOffroadTools(): AgentTool[] {
  return [
    {
      name: "offroad_check",
      description: [
        "Check a motorcycle / off-road route: who may legally ride each stretch (open to all vehicles incl. unplated OHVs, OHV trail,",
        "street-legal forest road, public road, closed or private, unknown), surface (paved vs gravel), shape (loop / out-and-back / one-way),",
        "gates, and a color-coded map image. Pass ONE route source: trail_app (name or id of a route/track in the owner's trail app),",
        "geojson_path, gpx_path, or coords. Takes 30-90 s. Returns verdicts per vehicle (unplated, plated, truck), issues with mile",
        "ranges, roads, seasonal designations and files (map JPG to send with discord_send_image; route GeoJSON for ridebook_update",
        "from_check). Designations come from federal/state data; closure orders (fire, storm, logging) override them, so check the",
        "forest's alerts before calling a route good.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          trail_app: { type: "string", description: "Name (exact or a unique part) or id of a route/track in the owner's trail app library." },
          geojson_path: { type: "string", description: "Path to a GeoJSON LineString/MultiLineString/FeatureCollection." },
          gpx_path: { type: "string", description: "Path to a GPX file (track or route points)." },
          coords: { type: "array", items: { type: "array", items: { type: "number" } }, description: "[[lon, lat], ...] in order along the route." },
          title: { type: "string", description: "Title for the map and output (defaults to the route's name)." },
          map: { type: "boolean", description: "Render the map image (default true)." },
        },
        additionalProperties: false,
      },
      handler: async (input) => {
        const args = { ...(input ?? {}) } as Record<string, unknown>;
        let appItem: unknown;
        if (typeof args.trail_app === "string" && args.trail_app.trim()) {
          const q = args.trail_app.trim();
          const exported = await runTrailApp("--export", /^[0-9A-Za-z-]{20,}$/.test(q) ? { id: q } : { name: q });
          if (exported.ok !== true) return exported;
          appItem = exported.item;
          args.geojson_path = exported.geojson_path;
          if (!args.title) args.title = (exported.item as { name?: string })?.name;
        }
        delete args.trail_app;
        if (!args.geojson_path && !args.gpx_path && !args.coords) {
          return { ok: false, error: "pass one of trail_app, geojson_path, gpx_path or coords" };
        }
        const title = typeof args.title === "string" && args.title ? args.title : "route";
        args.out_dir = path.join(resolveTangoDataDir(), "offroad", "checks", `${slug(title)}-${Date.now().toString(36)}`);
        const result = await runJsonScript(path.join(engineDir(), "offroad-check.mjs"), [`--json=${JSON.stringify(args)}`], 420_000);
        return appItem ? { ...result, trail_app_item: appItem } : result;
      },
    },
    {
      name: "offroad_plan",
      description: [
        "Create new motorcycle / off-road rides: generates many candidate loops (or one-way routes when `end` is given) with the local",
        "routing engine, runs every candidate through the same legality check as offroad_check, re-routes around closed or private",
        "stretches, and returns the best 1-5 distinct options with an overview map (all options), a check map and GPX per option,",
        "miles, ride time, surface split and road list. Plated bikes and trucks only: for unplated bikes use offroad_networks.",
        "Takes 1-3 minutes. Every option is UNVERIFIED until someone rides it; say so when presenting it.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          start: { type: "string", description: "Start: a place name (\"Petersburg, OR\") or \"lat,lon\"." },
          end: { type: "string", description: "End for a one-way ride (omit for a loop)." },
          via: { type: "array", items: { type: "string" }, description: "Up to 3 places the ride must pass (a waterfall, a viewpoint, lunch)." },
          miles: { type: "array", items: { type: "number" }, description: "[min, max] loop length in miles (default [30, 50]); for one-ways, the longest acceptable." },
          vehicle: { type: "string", enum: ["plated", "truck"], description: "Who must be legal on every mile (default plated)." },
          prefer: { type: "string", enum: ["gravel", "mixed", "paved"], description: "Surface preference (default gravel)." },
          count: { type: "number", description: "Options to return, 1-5 (default 3)." },
          title: { type: "string" },
        },
        required: ["start"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const args = { ...(input ?? {}) } as Record<string, unknown>;
        const title = typeof args.title === "string" && args.title ? args.title : `plan-${typeof args.start === "string" ? args.start : "ride"}`;
        args.out_dir = path.join(resolveTangoDataDir(), "offroad", "plans", `${slug(title)}-${Date.now().toString(36)}`);
        return runJsonScript(path.join(engineDir(), "offroad-plan.mjs"), [`--json=${JSON.stringify(args)}`], 600_000);
      },
    },
    {
      name: "offroad_networks",
      description: [
        "Where can an UNPLATED bike ride near a place? Finds connected networks of National Forest roads open to all vehicles and",
        "motorized trails within a radius, ranked by miles, with the roads in each, the closest point to the place, seasonal miles,",
        "an overview map and a GeoJSON + GPX per network. Roads between networks are usually plated-only, so plan to trailer in.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          center: { type: "string", description: "A place name or \"lat,lon\"." },
          radius_mi: { type: "number", description: "Search radius in miles (default 25, max 60)." },
          min_miles: { type: "number", description: "Smallest network to list (default 4)." },
          limit: { type: "number", description: "Networks to return (default 6)." },
          include_trails: { type: "boolean", description: "Include motorized trails (default true)." },
        },
        required: ["center"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const args = { ...(input ?? {}) } as Record<string, unknown>;
        args.out_dir = path.join(resolveTangoDataDir(), "offroad", "networks", `${slug(String(args.center ?? "area"))}-${Date.now().toString(36)}`);
        return runJsonScript(path.join(engineDir(), "offroad-networks.mjs"), [`--json=${JSON.stringify(args)}`], 300_000);
      },
    },
    {
      name: "offroad_photos",
      description: [
        "Find and fetch freely licensed photos for ride stops (Wikimedia Commons). action search: photos near a point and/or",
        "matching place-qualified queries (\"Example Falls\"), with license, author, source page and distance, plus a",
        "numbered contact sheet JPG to look at before choosing. action fetch: download chosen titles (1280 px) and return",
        "{path, credit, href, caption} ready for ridebook_update photos / stop_photos. Always show the credit with a photo.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["search", "fetch"] },
          lat: { type: "number" },
          lon: { type: "number" },
          radius_m: { type: "number", description: "search: metres around the point (default 3000, max 10000)." },
          queries: { type: "array", items: { type: "string" }, description: "search: text searches; include the state to avoid same-name places." },
          limit: { type: "number", description: "search: candidates (default 12)." },
          titles: { type: "array", items: { type: "string" }, description: "fetch: Commons file titles (\"File:...\") from a search." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const { action, ...rest } = (input ?? {}) as Record<string, unknown>;
        rest.out_dir = path.join(resolveTangoDataDir(), "offroad", "photos", `${action === "fetch" ? "fetch" : "search"}-${Date.now().toString(36)}`);
        return runJsonScript(path.join(engineDir(), "offroad-photos.mjs"), [action === "fetch" ? "--fetch" : "--search", `--json=${JSON.stringify(rest)}`], 300_000);
      },
    },
    {
      name: "trail_app_library",
      description: [
        "Read the owner's trail app library (their own saved routes, tracks, waypoints and folders) without changing anything.",
        "action list: newest first, filter by kind / query / folder; each item has a deep link. action export: one route or track",
        "to GeoJSON + GPX files (by id or name) for offroad_check or the ride book. Opens the app in the managed browser",
        "(~20 s; reuses a capture from the last 10 minutes unless refresh). Read-only: never edits, moves or deletes app content.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "export", "status"] },
          kind: { type: "string", enum: ["route", "track", "line", "waypoint"] },
          query: { type: "string", description: "list: case-insensitive name filter." },
          folder: { type: "string", description: "list: only items in folders whose name contains this." },
          limit: { type: "number", description: "list: max items (default 40)." },
          id: { type: "string", description: "export: item id." },
          name: { type: "string", description: "export: exact name, or a part that matches one item." },
          refresh: { type: "boolean", description: "Capture fresh instead of using the last 10 minutes' capture." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const { action, ...rest } = (input ?? {}) as Record<string, unknown>;
        const command = action === "export" ? "--export" : action === "status" ? "--status" : "--list";
        if (command === "--export") {
          rest.out_dir = path.join(resolveTangoDataDir(), "offroad", "trail-app");
        }
        return runTrailApp(command, rest);
      },
    },
    {
      name: "trail_app_import",
      description: [
        "Put routes into the owner's trail app: imports GPX files and files each new item in one of Sierra's own folders.",
        "Guarded by the profile adapter: the folder must be a Sierra folder, item names get Sierra's prefix and \"(unverified)\",",
        "names that already exist are refused, the new items are found by diffing the library before and after (exact count or",
        "nothing is filed), and folder membership is verified. It never edits, moves or deletes the owner's own items.",
        "Use only when the owner asks to put routes in their trail app. dry_run shows the names without importing.",
        "If an import created items but filing failed, pass retry_ids with the folder to file them.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          routes: {
            type: "array",
            description: "GPX files to import (1-10), each with an optional display name (default: the GPX track name).",
            items: { type: "object", properties: { file: { type: "string" }, name: { type: "string" } }, required: ["file"], additionalProperties: false },
          },
          folder: { type: "string", description: "Exact name of an existing Sierra folder in the trail app." },
          dry_run: { type: "boolean", description: "Return the names that would be used; import nothing." },
          retry_ids: { type: "array", items: { type: "string" }, description: "Item ids from an earlier import to file (instead of importing)." },
        },
        required: ["folder"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const { retry_ids, ...rest } = (input ?? {}) as Record<string, unknown>;
        if (Array.isArray(retry_ids) && retry_ids.length) return runTrailApp("--file", { ids: retry_ids, folder: rest.folder }, 600_000);
        if (!Array.isArray(rest.routes) || !rest.routes.length) return { ok: false, error: "pass routes (GPX files) to import" };
        return runTrailApp("--import", rest, 900_000);
      },
    },
    {
      name: "ridebook_status",
      description: "List the ride books: title, areas, notes, every ride (id, name, area, status, shape, miles, difficulty, unplated, private), the private URL, the family copy's live and preview URLs, and whether a staged family copy is waiting to be promoted. Read-only.",
      inputSchema: {
        type: "object",
        properties: { book: { type: "string", description: "Book id (default: the configured default book)." } },
        additionalProperties: false,
      },
      handler: async (input) => {
        const book = (input as { book?: string } | undefined)?.book;
        return ridebook(["--status", ...(book ? [`--book=${book}`] : [])], 60_000);
      },
    },
    {
      name: "ridebook_update",
      description: [
        "Add or update a ride (or an area or notes page) in a ride book, or remove a ride, then rebuild the PRIVATE copy",
        "(owner-only, on the tailnet). Nothing goes to the family/public copy. Pass from_check (the files.dir of an offroad_check",
        "result) to fill mileage, surface split, shape, map image and GPX from the check. Pass assets to copy in a map, GPX, thumbnail,",
        "photos or stop photos from local files (with caption, credit and source link for photos). Returns warnings for missing",
        "fields and the ride's private URL.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          book: { type: "string" },
          ride: rideSchema,
          from_check: { type: "string", description: "offroad_check files.dir to take miles, surface, shape, map and GPX from." },
          assets: {
            type: "object",
            properties: {
              map: { type: "string" },
              gpx: { type: "string" },
              thumb: { type: "string" },
              photos: { type: "array", items: { type: "object", properties: { path: { type: "string" }, caption: { type: "string" }, credit: { type: "string" }, href: { type: "string" } }, required: ["path"], additionalProperties: false } },
              stop_photos: { type: "array", items: { type: "object", properties: { n: { type: ["number", "string"] }, path: { type: "string" }, caption: { type: "string" }, credit: { type: "string" }, href: { type: "string" } }, required: ["n", "path"], additionalProperties: false } },
            },
            additionalProperties: false,
          },
          area: { type: "object", description: "Area to add/update: {id, name, base, notes (notes page id), color, codeLabel, notesLink}.", additionalProperties: true },
          note: { type: "object", description: "Notes page to add/update: {id, title, html, folder}.", additionalProperties: true },
          remove_ride: { type: "string", description: "Ride id to remove from the book (instead of an update)." },
        },
        additionalProperties: false,
      },
      handler: async (input) => {
        const { remove_ride, ...rest } = (input ?? {}) as Record<string, unknown>;
        if (typeof remove_ride === "string" && remove_ride) {
          return ridebook(["--remove", `--json=${JSON.stringify({ id: remove_ride, book: rest.book })}`]);
        }
        return ridebook(["--upsert", `--json=${JSON.stringify(rest)}`]);
      },
    },
    {
      name: "ridebook_publish",
      description: "Rebuild a ride book's private copy and stage its FAMILY copy into a private preview folder (personal text rewritten, private rides and trail-app links removed, leak check enforced). Returns the private URL, the family preview URL, and what changed versus the live family site. Does not publish anything publicly; ridebook_promote does that.",
      inputSchema: {
        type: "object",
        properties: { book: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (input) => {
        const book = (input as { book?: string } | undefined)?.book;
        return ridebook(["--stage-family", ...(book ? [`--book=${book}`] : [])]);
      },
    },
    {
      name: "ridebook_promote",
      description: "Deploy the staged family copy of a ride book to its PUBLIC (unlisted) site. Refuses if nothing is staged or the book changed since staging. ONLY call when the owner explicitly asks to publish / update the family or shared copy, after they have seen the preview or the change list.",
      inputSchema: {
        type: "object",
        properties: {
          book: { type: "string" },
          requested_by: { type: "string", description: "Who explicitly asked to publish the family copy." },
        },
        required: ["requested_by"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const book = (input as { book?: string } | undefined)?.book;
        return ridebook(["--promote-family", ...(book ? [`--book=${book}`] : [])], 420_000);
      },
    },
  ];
}
