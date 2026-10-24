import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { releaseId } from "./release-info.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { ClaudeRuntimeOptions } from "./claude/claude-runtime.js";
import { HostOutcomeUnknown, holdsWork, type Runtime, type RuntimeEvent, type RuntimeSession, type OpenSessionOptions } from "./runtime.js";
import { SUPPORTED_HOST_PROTOCOLS, type HostHello, type HostMessage, type HostCommand } from "./host-protocol.js";

import { isLiveHost, readHostLedgers } from "./host-ledger.js";
import { killGroup, processStart } from "./proc.js";

import type { CodexRuntimeOptions } from "./codex/codex-runtime.js";

type Emit = (event: RuntimeEvent, seq?: number) => void;

export interface RemoteRuntimeOptions { loomHome: string; claude?: ClaudeRuntimeOptions; provider?: "claude" | "codex"; codex?: CodexRuntimeOptions; releasesDir?: string }

/**
 * Whether this coordinator can talk to the release's session hosts. A release promoted before the
 * coordinator restarts may speak a newer protocol; until then this coordinator keeps its own hosts.
 */
export function speaksSupported(releasesDir: string, id: string): boolean {
  try {
    const speaks = JSON.parse(readFileSync(join(releasesDir, id, "release.json"), "utf8")).hostSpeaks;
    return speaks === undefined || SUPPORTED_HOST_PROTOCOLS.has(speaks);
  } catch (error) {
    // No manifest: nothing says otherwise (spawning still checks the entry exists). Unreadable: don't route.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** State is authoritative; never route through the mutable current symlink. */
export function resolveHostRelease(threadId: string, releasesDir = process.env.LOOM_RELEASES_DIR ?? join(homedir(), ".tango/releases/loom")): { entry: string; release: string; source: boolean } {
  const source = import.meta.url.endsWith(".ts");
  const local = { entry: fileURLToPath(new URL(source ? "./session-host.ts" : "./session-host.js", import.meta.url)), release: releaseId(), source };
  if (!existsSync(releasesDir)) return local;
  let state: { current?: string | null; pins?: Record<string, string> };
  try { state = JSON.parse(readFileSync(join(releasesDir, "state.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return local; throw error; }
  const id = (Object.hasOwn(state.pins ?? {}, threadId) ? state.pins![threadId] : state.current);
  if (id == null) return local;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error("Invalid host release id");
  if (!speaksSupported(releasesDir, id)) return local;
  const entry = join(releasesDir, id, "packages/loom/dist/session-host.js");
  if (!existsSync(entry)) throw new Error(`Session host entry missing for release ${id}`);
  return { entry, release: id, source: false };
}
export class RemoteRuntime implements Runtime {
  constructor(private readonly options: RemoteRuntimeOptions) {}
  /** Every host that is running: by socket, and by a live ledger (a slow host is waited out, not missed). */
  async discover(): Promise<HostHello[]> {
    const dir = join(this.options.loomHome, "hosts");
    let files: string[];
    try { files = readdirSync(dir); } catch { return []; }
    const threads = new Set(files.filter((f) => f.endsWith(".sock")).map((f) => f.slice(0, -5)));
    for (const host of readHostLedgers(dir)) if (isLiveHost(host)) threads.add(host.threadId);
    const found: HostHello[] = [];
    for (const threadId of threads) {
      const session = await this.attach({ threadId, cwd: "/", account: null, nativeSessionId: null }, () => {});
      if (session) { found.push(session.hello); session.detach(); }
    }
    return found;
  }
  /**
   * Connect to the thread's host if one is running. A host whose ledger says it is alive is retried
   * for up to 15 s before it counts as absent, so a slow handshake is never mistaken for a dead host
   * (in recovery or in open) and its turn is never interrupted or doubled.
   */
  async attach(options: OpenSessionOptions, emit: Emit): Promise<RemoteSession | null> {
    const first = await this.connection(options.threadId, emit);
    if (first) return first;
    const dir = join(this.options.loomHome, "hosts");
    const ledger = readHostLedgers(dir).find((host) => host.threadId === options.threadId);
    if (!ledger || !isLiveHost(ledger)) return null;
    const deadline = Date.now() + 15_000;
    let backoff = 30;
    while (Date.now() < deadline && isLiveHost(ledger)) {
      const session = await this.connection(options.threadId, emit, Math.max(1, deadline - Date.now()));
      if (session) return session;
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 500);
    }
    return null;
  }
  async open(options: OpenSessionOptions, emit: Emit): Promise<RemoteSession> {
    const existing = await this.attach(options, emit);
    if (existing && !existing.hello.ended) return existing;
    if (existing) {
      await existing.close().catch(() => {});
      // An ended host must finish removing its socket before its replacement can own it.
      const path = join(this.options.loomHome, "hosts", `${options.threadId}.sock`);
      const deadline = Date.now() + 15_000;
      while (existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
      if (existsSync(path)) throw new Error(`Ended session host did not exit for ${options.threadId}`);
    }
    const dir = join(this.options.loomHome, "hosts");
    mkdirSync(dir, { recursive: true });
    // attach() already waited out a live host; one that is still there is stuck and gets replaced.
    const ledger = readHostLedgers(dir).find((host) => host.threadId === options.threadId);
    if (ledger) {
      // Re-read after waiting: the host may have spawned additional harness groups.
      const latest = readHostLedgers(dir).find((host) => host.threadId === options.threadId) ?? ledger;
      const owned = [latest, ...latest.groups].filter((entry) => entry.pid > 1 && entry.started && processStart(entry.pid) === entry.started);
      for (const entry of owned) killGroup(entry.pid);
      const deadline = Date.now() + 15_000;
      const alive = () => owned.some((entry) => {
        try { process.kill(-entry.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      });
      while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
      if (alive()) throw new Error(`Session host groups did not exit for ${options.threadId}`);
    }
    rmSync(join(dir, `${options.threadId}.sock`), { force: true });
    const { source, entry, release } = resolveHostRelease(options.threadId, this.options.releasesDir);
    const log = openSync(join(dir, `${options.threadId}.log`), "a", 0o600);
    const child = spawn(process.execPath, [...(source ? ["--import", "tsx"] : []), entry], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, LOOM_RELEASE: release, LOOM_HOST_CONFIG: JSON.stringify({ loomHome: this.options.loomHome, open: options, provider: this.options.provider ?? "claude", claude: this.options.claude, codex: this.options.codex }) },
    });
    closeSync(log);
    let spawnError: Error | undefined;
    child.on("error", (error) => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const session = await this.attach(options, emit);
      if (session) {
        if (session.hello.release !== release) {
          session.detach();
          throw new Error(`Session host release mismatch: spawned ${release}, reported ${session.hello.release}`);
        }
        return session;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Session host did not start for ${options.threadId}; see its host log`);
  }
  async drainPending(threadId: string, emit: Emit, afterSeq: number, instanceId: string | null): Promise<void> {
    const path = join(this.options.loomHome, "hosts", `${threadId}.pending.jsonl`);
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { return; }
    let messages: HostMessage[];
    try { messages = text.trim().split("\n").map((line) => JSON.parse(line) as HostMessage); }
    catch (error) {
      renameSync(path, join(this.options.loomHome, "hosts", `${threadId}.pending.corrupt-${Date.now()}.jsonl`));
      console.warn("Quarantined corrupt session pending tail", threadId, error);
      return;
    }
    const metadata = messages[0]!;
    if (metadata.type !== "hello" || (instanceId && metadata.instanceId !== instanceId)) { rmSync(path, { force: true }); return; }
    const wakes = new Map<string, string>();
    for (const message of messages) {
      if (message.type !== "event") continue;
      const event = message.event;
      if (event.type === "wake.started") emit({ type: "wake.started", text: event.text, wakeId: event.wakeId, bind: (runId) => { wakes.set(event.wakeId, runId); } }, message.seq);
      else if (message.seq > afterSeq) emit("runId" in event && wakes.has(event.runId) ? { ...event, runId: wakes.get(event.runId)! } : event, message.seq);
    }
    rmSync(path, { force: true });
  }
  private connection(threadId: string, emit: Emit, timeoutMs = 1000): Promise<RemoteSession | null> {
    return new Promise((resolve) => {
      const socket = connect(join(this.options.loomHome, "hosts", `${threadId}.sock`));
      let buffer = "";
      let remote: RemoteSession | undefined;
      const timeout = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
      socket.on("error", () => { if (!remote) { clearTimeout(timeout); resolve(null); } });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let message: HostMessage;
          try { message = JSON.parse(line); } catch { socket.destroy(); clearTimeout(timeout); resolve(null); return; }
          if (!remote) {
            if (message.type !== "hello" || !SUPPORTED_HOST_PROTOCOLS.has(message.protocol) || message.threadId !== threadId) { socket.destroy(); clearTimeout(timeout); resolve(null); return; }
            clearTimeout(timeout);
            remote = new RemoteSession(socket, message, emit);
            resolve(remote);
          } else remote.receive(message);
        }
      });
    });
  }
}
export class RemoteSession implements RuntimeSession {
  private active = false;
  private afterSeq = 0;
  private queue: Extract<HostMessage, { type: "event" }>[] = [];
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private detached = false;
  private ended = false;
  private replayDone = false;
  private replayResolve?: () => void;
  private replayReject?: (error: Error) => void;
  private readonly wakeRuns = new Map<string, string>();
  constructor(private readonly socket: Socket, readonly hello: HostHello, private readonly emit: Emit) {
    socket.on("close", () => {
      this.replayReject?.(new Error("Session host disconnected during replay"));
      for (const request of this.pending.values()) request.reject(new HostOutcomeUnknown("Session host disconnected"));
      this.pending.clear();
      if (!this.detached && !this.ended && this.active) this.emit({ type: "session.ended", failure: { kind: "crashed", message: "Session host disconnected" } });
    });
  }
  receive(message: HostMessage): void {
    if (message.type === "replay.end") { this.replayDone = true; this.replayResolve?.(); }
    else if (message.type === "result") {
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.ok && message.tasks) {
        this.frozenTasks = message.tasks;
        // The close result precedes EOF. This is an intentional stop, not a crash wake.
        this.detached = true;
      }
      if (message.ok) request?.resolve(); else request?.reject(new Error(message.error));
    } else if (message.type === "event") {
      if (!this.active) this.queue.push(message); else this.apply(message);
    }
  }
  activate(afterSeq: number): Promise<void> {
    this.afterSeq = afterSeq;
    this.active = true;
    for (const message of this.queue) this.apply(message);
    this.queue = [];
    return this.replayDone ? Promise.resolve() : new Promise((resolve, reject) => { this.replayResolve = resolve; this.replayReject = reject; if (this.socket.destroyed) reject(new Error("Session host disconnected during replay")); });
  }
  private apply(message: Extract<HostMessage, { type: "event" }>): void {
    const event = message.event;
    if (event.type === "session.ended") this.ended = true;
    if (event.type === "background.changed") this.hello.background = event.tasks;
    if (event.type === "request.opened" && !this.hello.openRequests.some((request) => request.requestId === event.requestId)) this.hello.openRequests.push({ requestId: event.requestId, kind: event.kind, payload: event.payload, runId: event.runId });
    if (event.type === "turn.completed" || event.type === "turn.failed") { this.hello.activeRunId = null; this.hello.openRequests = this.hello.openRequests.filter((request) => request.runId !== event.runId); }
    if (message.seq <= this.afterSeq && event.type !== "wake.started") { this.acknowledge(message.seq); return; }
    if (event.type === "wake.started") this.emit({ type: "wake.started", text: event.text, wakeId: event.wakeId, bind: (runId) => { this.wakeRuns.set(event.wakeId, runId); this.hello.activeRunId = runId; this.send({ type: "bindWake", wakeId: event.wakeId, runId }); } }, message.seq);
    else if ("runId" in event && this.wakeRuns.has(event.runId)) this.emit({ ...event, runId: this.wakeRuns.get(event.runId)! }, message.seq);
    else this.emit(event, message.seq);
  }
  acknowledge(seq: number): void { this.afterSeq = Math.max(this.afterSeq, seq); this.send({ type: "ack", seq }); }
  detach(): void { this.detached = true; this.socket.destroy(); }
  startTurn(run: Parameters<RuntimeSession["startTurn"]>[0]): void { this.hello.activeRunId = run.runId; void this.command({ type: "startTurn", run, id: randomUUID() }).catch((error) => this.emit({ type: "turn.failed", runId: run.runId, failure: { kind: "crashed", message: String(error) } })); }
  inject(text: string, images?: Parameters<NonNullable<RuntimeSession["inject"]>>[1], steerId?: string): Promise<void> { return this.command({ type: "inject", text, images, ...(steerId ? { steerId } : {}), id: randomUUID() }); }
  interrupt(): Promise<void> { return this.command({ type: "interrupt", id: randomUUID() }); }
  async respond(requestId: string, answer: unknown): Promise<void> { await this.command({ type: "respond", requestId, answer, id: randomUUID() }); this.hello.openRequests = this.hello.openRequests.filter((request) => request.requestId !== requestId); }
  private frozenTasks: import("./runtime.js").BackgroundTask[] | undefined;
  async closeForUpgrade(forceBackground: boolean): Promise<boolean | import("./runtime.js").BackgroundTask[]> {
    // Legacy protocol-1 hosts predate the atomic safe-point handshake. Use the latest
    // observed state and their explicit close command as a best-effort fallback.
    if (!this.hello.upgradeClose && (this.hello.activeRunId != null || this.hello.openRequests.length || (!forceBackground && holdsWork(this.hello.background)))) return false;
    let onClose: () => void = () => {};
    const closed = new Promise<void>((resolve) => { onClose = resolve; if (this.socket.destroyed) resolve(); else this.socket.once("close", onClose); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The EOF that follows is this close, not a crash: mark it before the host can hang up.
    this.detached = true;
    try {
      await this.command(this.hello.upgradeClose ? { type: "closeForUpgrade", forceBackground, id: randomUUID() } : { type: "close", id: randomUUID() });
      await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HostOutcomeUnknown("Session host upgrade close timed out")), 15_000); })]);
      this.detach();
      return this.frozenTasks ?? this.hello.background ?? [];
    } catch (error) {
      if (error instanceof Error && error.message === "Upgrade safe point unavailable") { this.detached = false; return false; }
      throw error;
    } finally { if (timer) clearTimeout(timer); this.socket.off("close", onClose); }
  }
  async close(): Promise<void> {
    const closed = this.socket.destroyed ? Promise.resolve() : new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    try {
      await this.command({ type: "close", id: randomUUID() });
      // A host that acknowledges but never hangs up must not hold its caller (or the warmth queue) forever.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 15_000); })]).finally(() => clearTimeout(timer));
    } finally { this.detach(); }
  }
  private send(command: HostCommand): void { if (!this.socket.destroyed) this.socket.write(`${JSON.stringify(command)}\n`); }
  private command(command: Extract<HostCommand, { id: string }>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) { reject(new Error("Session host disconnected")); return; }
      const timer = setTimeout(() => { this.pending.delete(command.id); reject(new HostOutcomeUnknown(`Session host command timed out: ${command.type}`)); }, 15_000);
      this.pending.set(command.id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.send(command);
    });
  }
}
