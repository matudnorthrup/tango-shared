import { createBrowserProfile, browserProfilePath, removeBrowserProfile, type BrowserProfileIdentity } from "./browser-profile.js";
import { promisify } from "node:util";
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { killGroup } from "./proc.js";
import type { LeaseBackend, ResourceLeases, ResourceLease } from "./leases.js";

export interface ProcessIdentity { pid: number; started: string; uid: number; nonce: string; profile?: BrowserProfileIdentity; browser?: { port: number; session: string } }

// The nonce in argv distinguishes a reused PID even within ps's one-second start-time resolution.
export function inspectProcess(value: unknown): "same" | "gone" | "different" | "unknown" {
  const identity = value as ProcessIdentity;
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 1 || !Number.isInteger(identity.uid) || !identity.started || !/^[a-f0-9-]{36}$/.test(identity.nonce)) return "unknown";
  try {
    const output = execFileSync("/bin/ps", ["-ww", "-o", "uid=,pgid=,lstart=,command=", "-p", String(identity.pid)], { encoding: "utf8", timeout: 2000 });
    const match = output.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+([\s\S]+)$/);
    if (!match) return "unknown";
    return Number(match[1]) === identity.uid && Number(match[2]) === identity.pid && match[3] === identity.started && match[4]!.endsWith(`loom-managed-${identity.nonce}`) ? "same" : "different";
  } catch (error) {
    // ps failure is not proof of absence: both leader and group must be absent.
    try { process.kill(identity.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        // A dead leader may leave descendants. Preserve them without nonce proof.
        try { process.kill(-identity.pid, 0); }
        catch (groupError) {
          if ((groupError as NodeJS.ErrnoException).code === "ESRCH") return "gone";
        }
      }
    }
    return "unknown";
  }
}

export const managedProcessBackend: LeaseBackend = {
  inspect: async identity => inspectProcess(identity),
  reclaim: async identity => {
    const state = inspectProcess(identity);
    if (state === "gone") return;
    if (state !== "same") {
      // A process may be exiting between the caller's check and this one. Only
      // confirmed leader+group absence can turn that race into successful cleanup.
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        if (inspectProcess(identity) === "gone") return;
      }
      throw new Error("Process identity changed before reclaim");
    }
    if (!killGroup((identity as ProcessIdentity).pid)) throw new Error("Process group could not be stopped");
    // Wait boundedly for the kernel to reap it before confirming cleanup.
    for (let i = 0; i < 40; i++) {
      if (inspectProcess(identity) === "gone") return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  },
};

export function processBackend(home: string): LeaseBackend {
  return { ...managedProcessBackend, cleanup: async value => {
    const identity = value as ProcessIdentity;
    if (!/^[a-f0-9-]{36}$/.test(identity.nonce)) throw new Error("Invalid resource nonce");
    if (inspectProcess(identity) !== "gone") throw new Error("Managed process is still present; retry cleanup after it exits");
    if (identity.profile) removeBrowserProfile(home, identity.profile);
    rmSync(join(home, "resources", identity.nonce), { recursive: true, force: true });
  } };
}
export const RESOURCE_LOG_LIMIT = 1024 * 1024;

// Wait for the durable record before executing user code. Before activation, losing IPC exits the
// supervisor. After activation it outlives the coordinator; on command exit it kills its own group.
const supervisor = `
const {spawn}=require('node:child_process');
const {openSync,writeSync}=require('node:fs');
let active=false, bytes=0, log;
const output=data=>{
  const chunk=Buffer.isBuffer(data)?data:Buffer.from(String(data));
  const length=Math.min(chunk.length,${RESOURCE_LOG_LIMIT}-bytes);
  if(length>0){writeSync(log,chunk,0,length);bytes+=length;}
};
const timer=setTimeout(()=>process.exit(1),10000);
process.on('disconnect',()=>{if(!active)process.exit(1)});
process.on('message',m=>{
  if(active)return;
  active=true;clearTimeout(timer);
  log=openSync(m.log,'w',0o600);
  const child=spawn(m.command,m.args,{cwd:m.cwd,env:m.env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',output);child.stderr.on('data',output);
  const end=()=>{try{process.kill(-process.pid,'SIGKILL')}catch{process.exit(1)}};
  child.on('error',error=>{output(error);end()});child.on('exit',end);
  process.disconnect();
});
process.send('ready');
`;

export async function createManagedProcess(leases: ResourceLeases, home: string, input: {
  threadId: string; runId: string; cwd: string; kind: "build" | "dev_server" | "browser";
  command: string; args: string[]; profile?: "exclusive";
  managedBrowser?: { port: number; releasePort(): Promise<void> };
}) {
  const nonce = randomUUID();
  const directory = join(home, "resources", nonce);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const log = join(directory, "output.log");
  const child = spawn(process.execPath, ["-e", supervisor, `loom-managed-${nonce}`], { cwd: input.cwd, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let identity: ProcessIdentity | undefined;
  let registered: ResourceLease | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Managed process did not become ready")), 5000);
      const done = (error?: Error) => { clearTimeout(timeout); child.off("error", fail); child.off("exit", exited); child.off("message", ready); error ? reject(error) : resolve(); };
      const fail = (e: Error) => done(e);
      const exited = () => done(new Error("Managed process exited before registration"));
      const ready = () => done();
      child.once("error", fail); child.once("exit", exited); child.once("message", ready);
    });
    const pid = child.pid!;
    const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    identity = { pid, started, uid: process.getuid!(), nonce };
    if (inspectProcess(identity) !== "same") throw new Error("Cannot establish managed process identity");
    if (input.profile === "exclusive") {
      if (input.kind !== "browser") throw new Error("Exclusive profiles require a browser lease");
      identity.profile = createBrowserProfile(home, nonce);
    }
    if (input.managedBrowser) {
      if (input.kind !== "browser" || !identity.profile) throw new Error("Managed Chrome requires an exclusive browser profile");
      identity.browser = { port: input.managedBrowser.port, session: `loom-${nonce}` };
    }
    const lease = leases.register({ threadId: input.threadId, runId: input.runId, kind: input.kind, key: identity.browser ? `browser-port:${identity.browser.port}` : `process:${pid}:${nonce}`, identity, policy: input.kind === "browser" ? "run_end" : input.kind === "build" ? "manual" : "thread_cool" });
    registered = lease;
    // The port reservation is held through registration. Chrome must then bind it;
    // readiness independently verifies the listener belongs to this process group.
    if (input.managedBrowser) await input.managedBrowser.releasePort();
    const args = identity.browser ? [...input.args,
      `--user-data-dir=${browserProfilePath(home, identity.profile!)}`,
      `--remote-debugging-port=${identity.browser.port}`, "--remote-debugging-address=127.0.0.1",
      "--headless=new", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "about:blank"] : input.args;
    child.send({ log, command: input.command, args, cwd: input.cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG, TANGO_DESK_ITEM: `loom:${input.threadId}`, LOOM_RUN_ID: input.runId, ...(identity.profile ? { LOOM_BROWSER_PROFILE: browserProfilePath(home, identity.profile) } : {}) } }, error => { if (error && identity && child.exitCode === null && child.signalCode === null && inspectProcess(identity) === "same") killGroup(identity.pid); });
    child.unref();
    return { lease, log };
  } catch (error) {
    // This is our direct child, which has not been handed to a caller yet.
    if (registered) await leases.release(registered.id, input.threadId);
    else if (child.pid && child.exitCode === null && child.signalCode === null && (!identity || inspectProcess(identity) === "same")) killGroup(child.pid);
    if (!registered && identity?.profile) removeBrowserProfile(home, identity.profile);
    if (!registered) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Discovery is advisory only. Never adopt a process on the strength of a name match. */
export async function externalResourceProcesses(): Promise<{ pid: number; kind: string; ownership: "unknown" }[]> {
  const { stdout: text } = await promisify(execFile)("/bin/ps", ["-axo", "pid=,uid=,command="], { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  return text.split("\n").flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m || Number(m[2]) !== process.getuid?.()) return [];
    const command = m[3]!;
    const kind = /agent-browser|playwright|chrome.*--remote-debugging/i.test(command) ? "browser" : /(?:vite|next dev|webpack-dev-server|http-server)/.test(command) ? "dev_server" : /(?:^|\/)tshare(?:\s|$)/.test(command) ? "mapping" : null;
    return kind ? [{ pid: Number(m[1]), kind, ownership: "unknown" as const }] : [];
  });
}

/** Only report ports, never infer that a persistent mapping belongs to the process using its port. */
export async function externalMappings(): Promise<{ port: number; ownership: "unknown" }[]> {
  const { stdout } = await promisify(execFile)("tailscale", ["serve", "status", "--json"], { encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024 });
  const value = JSON.parse(stdout) as { TCP?: Record<string, unknown> };
  return Object.keys(value.TCP ?? {}).filter(port => /^\d+$/.test(port)).map(port => ({ port: Number(port), ownership: "unknown" }));
}
