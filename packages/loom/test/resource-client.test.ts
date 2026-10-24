import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resourceCaller, resourceCommand, resourceRunContext } from "../src/resource-client.js";
const cleanups: (() => void)[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const f of cleanups.splice(0)) f(); });
const threadId = randomUUID(), runId = randomUUID();
const caller = { TANGO_DESK_ITEM: `loom:${threadId}`, LOOM_RUN_ID: runId };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "resource-cli-")); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "token"), "test-token"); return home;
}
it("requires an explicit immutable run identity without discovering a newer run", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect(resourceCaller(caller)).toEqual({ threadId, runId });
  for (const env of [{}, { TANGO_DESK_ITEM: caller.TANGO_DESK_ITEM }, { ...caller, LOOM_RUN_ID: "invalid" }]) await expect(resourceCommand(["port", "3100"], env)).rejects.toThrow(/LOOM_RUN_ID/);
  expect(fetch).not.toHaveBeenCalled();
  expect(resourceRunContext(runId)).toContain(`LOOM_RUN_ID=${runId}`);
  expect(resourceRunContext(runId)).toContain("loom resource release <lease-id>");
  expect(resourceRunContext(runId)).toContain("loom resource browser -- open <url>");
  expect(resourceRunContext(runId)).toContain("omit agent-browser, yarn and --session");
  expect(resourceRunContext(randomUUID())).not.toContain(runId);
});
it.each([400, 409])( "fails closed on HTTP %s with exactly one request", async status => {
  const home = fixture();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ message: "stale or invalid caller" }), { status })); vi.stubGlobal("fetch", fetch);
  await expect(resourceCommand(["dev-server", "--", "node", "server.js"], { ...caller, LOOM_HOME: home })).rejects.toThrow(`Loom ${status}`);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ runId, kind: "dev_server", command: "node", args: ["server.js"], cwd: process.cwd() });
});
it("prints only the leased mapping URL and sends explicit ports", async () => {
  const home = fixture();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ lease: { identity: JSON.stringify({ config: { Web: { "test.invalid:13100": {} } } }) } }))); vi.stubGlobal("fetch", fetch);
  expect(await resourceCommand(["port", "3100"], { ...caller, LOOM_HOME: home })).toBe("https://test.invalid:13100");
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ runId, kind: "mapping", localPort: 3100, httpsPort: 13100 });
});
it("private dev-server wrapper passes through outside Loom and never falls back after a Loom error", () => {
  const home = fixture();
  writeFileSync(join(home, "loom"), '#!/bin/sh\necho leased-call >&2\nexit 9\n', { mode: 0o700 });
  const wrapper = fileURLToPath(new URL("../../../scripts/leases/loom-dev-server", import.meta.url));
  const env = { ...process.env, PATH: home + ":" + process.env.PATH, TANGO_DESK_ITEM: "" };
  expect(execFileSync(wrapper, [process.execPath, "-e", "console.log('passthrough')"], { env, encoding: "utf8" })).toBe("passthrough\n");
  expect(() => execFileSync(wrapper, [process.execPath, "-e", "console.log('must-not-run')"], { env: { ...env, ...caller }, stdio: "pipe" })).toThrow();
});
it.each([400, 409])("never starts the browser client after HTTP %s", async status => {
  const home = fixture();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ message: "rejected" }), { status })); vi.stubGlobal("fetch", fetch);
  await expect(resourceCommand(["browser", "--", "snapshot"], { ...caller, LOOM_HOME: home, PATH: "/missing" })).rejects.toThrow(`Loom ${status}`);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ runId, kind: "browser", managed: true });
});
it("uses only the leased CDP port/session and ignores ambient browser configuration", async () => {
  const home = fixture();
  writeFileSync(join(home, "agent-browser"), `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),env:process.env.AGENT_BROWSER_PROVIDER,config:require('node:fs').readFileSync(process.argv[3],'utf8')}));`, { mode: 0o700 });
  const session = `loom-${randomUUID()}`;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ lease: { identity: "{}" }, browser: { port: 9223, session } }))));
  const output = JSON.parse(await resourceCommand(["browser", "--", "snapshot", "-i"], { ...caller, LOOM_HOME: home, PATH: home, AGENT_BROWSER_PROVIDER: "external", AGENT_BROWSER_SESSION: "shared" }) as string);
  expect(output.args.slice(2)).toEqual(["--cdp", "9223", "--session", session, "snapshot", "-i"]);
  expect(output.config).toBe("{}"); expect(output.env).toBeUndefined();
});
it.each([["connect", "9222"], ["batch", "open example.invalid"], ["close", "--all"], ["snapshot", "--cdp=9222"], ["snapshot", "--session", "shared"], ["snapshot", "--engine", "lightpanda"]])("rejects browser connection overrides before any request: %j", async (...args) => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(resourceCommand(["browser", "--", ...args], caller)).rejects.toThrow(/supported browser/);
  expect(fetch).not.toHaveBeenCalled();
});
it("browser wrapper preserves outside-Loom behavior and fails closed inside", () => {
  const home = fixture();
  writeFileSync(join(home, "agent-browser"), '#!/bin/sh\necho passthrough\n', { mode: 0o700 });
  writeFileSync(join(home, "loom"), '#!/bin/sh\nexit 9\n', { mode: 0o700 });
  const wrapper = fileURLToPath(new URL("../../../scripts/leases/loom-browser", import.meta.url));
  const env = { ...process.env, PATH: home + ":" + process.env.PATH, TANGO_DESK_ITEM: "" };
  expect(execFileSync(wrapper, ["snapshot"], { env, encoding: "utf8" })).toBe("passthrough\n");
  expect(() => execFileSync(wrapper, ["snapshot"], { env: { ...env, ...caller }, stdio: "pipe" })).toThrow();
});

it.each([200, 400, 409])("releases only the explicit lease with this turn identity (HTTP %s)", async status => {
  const home = fixture(), leaseId = randomUUID();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ lease: { id: leaseId, state: "reclaimed" }, message: "rejected" }), { status }));
  vi.stubGlobal("fetch", fetch);
  const result = resourceCommand(["release", leaseId], { ...caller, LOOM_HOME: home });
  if (status === 200) expect(await result).toMatchObject({ lease: { id: leaseId, state: "reclaimed" } });
  else await expect(result).rejects.toThrow(`Loom ${status}`);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]![0]).toContain(`/threads/${threadId}/resources/${leaseId}/release`);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ runId });
});

it.each(["agent-browser", "yarn"])("explains action-only syntax before requesting a browser for %s", async executable => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(resourceCommand(["browser", "--", executable, "open", "https://example.invalid"], caller)).rejects.toThrow("Pass only the browser action: loom resource browser -- open <url>. Omit agent-browser, yarn and --session");
  expect(fetch).not.toHaveBeenCalled();
});
