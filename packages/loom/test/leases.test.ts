import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoomStore } from "../src/store.js";
import { ResourceLeases, type LeaseBackend } from "../src/leases.js";
import { createManagedProcess, inspectProcess, managedProcessBackend, processBackend, RESOURCE_LOG_LIMIT } from "../src/managed-process.js";
import { killGroup } from "../src/proc.js";

const stores: LoomStore[] = [];
const roots: string[] = [];
const pids: number[] = [];
afterEach(() => { for (const pid of pids.splice(0)) killGroup(pid); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(path = ":memory:") {
  const store = new LoomStore(path); stores.push(store);
  const thread = store.tx(() => store.createThread({ cwd: tmpdir(), kind: "test", provider: "fake" }));
  const run = store.tx(() => { const r = store.createRun(thread.id, "user", "work"); store.updateRun(r.id, { status: "running" }); return r; });
  let present = true;
  const backend: LeaseBackend = { inspect: vi.fn(async () => present ? "same" : "gone"), reclaim: vi.fn(async () => { present = false; }) };
  const leases = new ResourceLeases(store, { warm: () => false, backends: { browser: backend, dev_server: backend, build: backend } });
  const register = (kind: "browser" | "dev_server" | "build" = "browser") => leases.register({ threadId: thread.id, runId: run.id, kind, key: "resource", identity: { generation: "one" }, policy: kind === "browser" ? "run_end" : kind === "build" ? "manual" : "thread_cool" });
  const end = () => store.tx(() => store.updateRun(run.id, { status: "completed", ended_at: store.now() }));
  return { store, thread, run, leases, backend, register, end };
}

describe("durable resource leases", () => {
  it("keeps a running browser, then reclaims exactly once on run completion", async () => {
    const f = setup(); f.register();
    await f.leases.reconcile(); expect(f.backend.reclaim).not.toHaveBeenCalled();
    f.end(); await Promise.all([f.leases.reconcile(), f.leases.reconcile()]);
    expect(f.backend.reclaim).toHaveBeenCalledTimes(1);
    expect(f.leases.list()[0]).toMatchObject({ state: "reclaimed", result: "Reclaimed" });
  });
  it("persists after restart and retains ownership after thread deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "lease-restart-")); roots.push(root);
    const f = setup(join(root, "state.db")); const lease = f.register("dev_server");
    f.store.tx(() => f.store.db.prepare("DELETE FROM threads WHERE id = ?").run(f.thread.id));
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    const store = new LoomStore(join(root, "state.db")); stores.push(store);
    const leases = new ResourceLeases(store, { warm: () => false, backends: { dev_server: f.backend } });
    expect(leases.list()[0].id).toBe(lease.id);
    await leases.reconcile(); expect(leases.list()[0].state).toBe("reclaimed");
  });
  it("leaves unknown owners and unsupported mapping backends untouched", async () => {
    const f = setup();
    f.leases.register({ kind: "browser", key: "external", identity: { pid: 12 }, policy: "run_end" });
    f.leases.register({ threadId: f.thread.id, runId: f.run.id, kind: "mapping", key: "mapping", identity: { port: 1234 }, policy: "run_end" });
    f.end(); await f.leases.reconcile();
    expect(f.leases.list().map(r => r.state).sort()).toEqual(["blocked", "unowned"]);
    expect(f.backend.reclaim).not.toHaveBeenCalled();
  });
  it("refuses conflicting ownership and ended runs", () => {
    const f = setup(); const row = f.register(); expect(f.register().id).toBe(row.id);
    expect(() => f.leases.register({ kind: "browser", key: "resource", identity: {}, policy: "run_end" })).toThrow(/already leased/);
    f.end(); expect(() => f.register()).toThrow(/not active/);
  });
  it("preserves reused identities and failed discovery", async () => {
    for (const state of ["different", "unknown"] as const) {
      const f = setup(); f.register(); f.end(); vi.mocked(f.backend.inspect).mockResolvedValue(state);
      await f.leases.reconcile(); expect(f.backend.reclaim).not.toHaveBeenCalled(); expect(f.leases.list()[0].state).toBe("blocked"); expect(f.leases.holds(f.thread.id)).toBe(true);
    }
  });
  it("rechecks owner activity after inspection and preserves active builds", async () => {
    const f = setup(); f.register("dev_server"); f.end();
    f.store.tx(() => f.store.updateThread(f.thread.id, { cooled_at: f.store.now() }));
    vi.mocked(f.backend.inspect).mockImplementation(async () => { f.store.tx(() => f.store.createRun(f.thread.id, "user", "new work")); return "same"; });
    await f.leases.reconcile(); expect(f.backend.reclaim).not.toHaveBeenCalled();
    const b = setup(); b.register("build"); b.end(); await b.leases.reconcile(); expect(b.backend.reclaim).not.toHaveBeenCalled(); expect(b.leases.holds(b.thread.id)).toBe(true);
    vi.mocked(b.backend.inspect).mockResolvedValue("gone"); await b.leases.reconcile(); expect(b.leases.holds(b.thread.id)).toBe(false);
  });
  it("dry-run changes no records and executes no backend; interrupted reclaim retries safely", async () => {
    const f = setup(); const row = f.register(); f.end();
    await f.leases.reconcile(true); expect(f.leases.list()[0]).toEqual(row); expect(f.backend.inspect).not.toHaveBeenCalled();
    f.store.db.prepare("UPDATE resource_leases SET state = 'reclaiming'").run();
    vi.mocked(f.backend.inspect).mockResolvedValue("gone"); await f.leases.reconcile();
    expect(f.leases.list()[0].state).toBe("reclaimed"); expect(f.backend.reclaim).not.toHaveBeenCalled();
  });
  it("does not activate a command when owner registration fails", async () => {
    const f = setup(); const root = mkdtempSync(join(tmpdir(), "lease-gate-")); roots.push(root);
    f.end();
    await expect(createManagedProcess(f.leases, root, { threadId: f.thread.id, runId: f.run.id, cwd: root, kind: "browser", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('activated','bad')"] })).rejects.toThrow(/not active/);
    expect(existsSync(join(root, "activated"))).toBe(false);
  });
  it("recovers and cleans a real managed process after its creator is killed", async () => {
    const root = mkdtempSync(join(tmpdir(), "lease-crash-")); roots.push(root);
    const source = fileURLToPath(new URL("../src/", import.meta.url));
    const script = `
      import { LoomStore } from ${JSON.stringify(source + "store.ts")};
      import { ResourceLeases } from ${JSON.stringify(source + "leases.ts")};
      import { createManagedProcess } from ${JSON.stringify(source + "managed-process.ts")};
      import { existsSync } from 'node:fs';
      const root=${JSON.stringify(root)};
      const store=new LoomStore(root+'/state.db');
      const thread=store.tx(()=>store.createThread({cwd:root,kind:'test',provider:'fake'}));
      const run=store.tx(()=>{const r=store.createRun(thread.id,'user','test');store.updateRun(r.id,{status:'running'});return r});
      const leases=new ResourceLeases(store,{warm:()=>false});
      const result=await createManagedProcess(leases,root,{threadId:thread.id,runId:run.id,cwd:root,kind:'browser',command:process.execPath,args:['-e',"require('node:fs').writeFileSync('ready','yes');setInterval(()=>{},1000)"]});
      const deadline=Date.now()+5000;
      while(!existsSync(root+'/ready')){if(Date.now()>deadline)throw Error('not activated');await new Promise(r=>setTimeout(r,10));}
      process.kill(process.pid,'SIGKILL');
    `;
    let signal: string | undefined;
    try { execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 10_000, stdio: "pipe" }); }
    catch (error) { signal = (error as { signal?: string }).signal; }
    const store = new LoomStore(join(root, "state.db")); stores.push(store);
    const leases = new ResourceLeases(store, { warm: () => false, backends: { browser: managedProcessBackend } });
    const lease = leases.list()[0]!;
    const identity = JSON.parse(lease.identity); pids.push(identity.pid);
    expect(signal).toBe("SIGKILL"); expect(inspectProcess(identity)).toBe("same");
    store.tx(() => store.updateRun(lease.run_id!, { status: "interrupted", ended_at: store.now() }));
    await leases.reconcile(); expect(inspectProcess(identity)).toBe("gone");
  }, 15_000);

  it("pins the checkout when only the leader dies and bounds output until confirmed cleanup", async () => {
    const f = setup(); const root = mkdtempSync(join(tmpdir(), "lease-orphan-")); roots.push(root);
    const leases = new ResourceLeases(f.store, { warm: () => false, backends: { browser: processBackend(root) } });
    const result = await createManagedProcess(leases, root, { threadId: f.thread.id, runId: f.run.id, cwd: root, kind: "browser", command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(2*1024*1024),()=>require('node:fs').writeFileSync('drained','yes'));setInterval(()=>{},1000)"] });
    const identity = JSON.parse(result.lease.identity); pids.push(identity.pid);
    await vi.waitFor(() => expect(statSync(result.log).size).toBe(RESOURCE_LOG_LIMIT));
    await vi.waitFor(() => expect(existsSync(join(root, "drained"))).toBe(true));
    process.kill(identity.pid, "SIGKILL");
    await vi.waitFor(() => expect(inspectProcess(identity)).toBe("unknown"));
    f.end(); await leases.reconcile();
    expect(leases.list()[0].state).toBe("blocked");
    expect(leases.holds(f.thread.id)).toBe(true);
    expect(existsSync(result.log)).toBe(true);
    killGroup(identity.pid);
    await vi.waitFor(() => expect(inspectProcess(identity)).toBe("gone"));
    await leases.reconcile();
    expect(leases.holds(f.thread.id)).toBe(false);
    expect(existsSync(result.log)).toBe(false);
  }, 10_000);

  it("launches a real isolated process only after durable registration and reclaims it", async () => {
    const f = setup(); const root = mkdtempSync(join(tmpdir(), "lease-process-")); roots.push(root);
    const leases = new ResourceLeases(f.store, { warm: () => false, backends: { browser: managedProcessBackend } });
    const result = await createManagedProcess(leases, root, { threadId: f.thread.id, runId: f.run.id, cwd: root, kind: "browser", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
    const identity = JSON.parse(result.lease.identity); pids.push(identity.pid);
    expect(inspectProcess(identity)).toBe("same");
    expect(inspectProcess({ ...identity, nonce: "00000000-0000-0000-0000-000000000000" })).toBe("different");
    f.end(); await leases.reconcile();
    expect(inspectProcess(identity)).toBe("gone"); expect(leases.list()[0].state).toBe("reclaimed");
  }, 10_000);
});
