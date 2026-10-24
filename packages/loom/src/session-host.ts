import { sessionHash, redactProfile } from "./session-profile.js";
import { createServer, type Socket } from "node:net";
import { mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeRuntime, localEditGuard, type ClaudeRuntimeOptions } from "./claude/claude-runtime.js";
import { CodexRuntime, type CodexRuntimeOptions } from "./codex/codex-runtime.js";
import { loomRequester } from "./claude/loom-tools.js";
import { holdsWork, taskEnded, type OpenSessionOptions, type Runtime, type RuntimeEvent, type RuntimeSession } from "./runtime.js";
import { HOST_PROTOCOL, type HostCommand, type HostHello, type HostMessage, type WireEvent } from "./host-protocol.js";
import { releaseId } from "./release-info.js";
import { FileSpawnLedger } from "./host-ledger.js";

/** A deliberately slow in-process harness for real coordinator/process recovery tests. */
class ProcessFakeRuntime implements Runtime {
  async open(options: OpenSessionOptions, emit: (event: RuntimeEvent) => void): Promise<RuntimeSession> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: { runId: string; text: string } | undefined;
    // Explicit sandbox exercise: the real guard and host lifecycle, with a deterministic fake model.
    const autoSmoke = process.env.LOOM_FAKE_AUTO_EDIT === "1";
    const nativeId = options.nativeSessionId ?? `fake-${autoSmoke ? randomUUID() : options.threadId}`;
    const smokeFile = "loom-auto-smoke.txt";
    const guard = autoSmoke ? localEditGuard(options.cwd, process.env.LOOM_HOME!) : null;

    const finish = () => {
      if (!active) return;
      const run = active;
      active = undefined;
      emit({ type: "message.completed", runId: run.runId, text: `Completed: ${run.text}` });
      emit({ type: "turn.completed", runId: run.runId });
    };
    return {
      startTurn(run) {
        active = run;
        emit({ type: "session.native", nativeSessionId: nativeId });
        emit({ type: "message.delta", runId: run.runId, text: "Working" });
        if (autoSmoke && run.text.startsWith("Loom: this thread is moving into its own worktree")) {
          void loomRequester()(`/threads/${options.threadId}/handoff`, { summary: "Sandbox Auto edit was denied before any checkout write.", next: `Create ${smokeFile} in the promoted worktree.` }).then(() => finish());
          return;
        }
        if (autoSmoke && options.worktreeMode === "auto" && run.text.includes("[test:auto-edit]") && guard?.("Write", { file_path: smokeFile })) {
          emit({ type: "message.completed", runId: run.runId, text: "Moving this thread into its own worktree; your next session continues there." });
          if (process.env.LOOM_AUTO_PROMOTE !== "off") emit({ type: "worktree.promote", runId: run.runId });
          return;
        }
        if (autoSmoke && options.worktreeMode === "worktree" && run.text.includes("Continue the interrupted task")) {
          writeFileSync(join(options.cwd, smokeFile), "Written after Auto promotion.\n");
          emit({ type: "message.completed", runId: run.runId, text: `Sandbox edit completed in worktree: ${options.cwd}/${smokeFile}` });
        }
        if (run.text.includes("question")) emit({ type: "request.opened", runId: run.runId, requestId: `question-${run.runId}`, kind: "question", payload: { questions: [{ question: "Continue?", header: "Test", options: [{ label: "Yes", description: "Continue" }], multiSelect: false }] } });
        else timer = setTimeout(finish, Number(process.env.LOOM_FAKE_TURN_MS ?? 1000));
      },
      respond() { timer = setTimeout(finish, 50); },
      async interrupt() { if (timer) clearTimeout(timer); if (active) emit({ type: "turn.failed", runId: active.runId, failure: { kind: "interrupted", message: "Interrupted" } }); active = undefined; },
      async close() { if (timer) clearTimeout(timer); },
    };
  }
}

async function main(): Promise<void> {
  const config = JSON.parse(process.env.LOOM_HOST_CONFIG ?? "{}") as { loomHome: string; open: OpenSessionOptions; provider?: "claude" | "codex"; claude: ClaudeRuntimeOptions; codex: CodexRuntimeOptions };
  const dir = join(config.loomHome, "hosts");
  mkdirSync(dir, { recursive: true });
  const socketPath = join(dir, `${config.open.threadId}.sock`);
  const pendingPath = join(dir, `${config.open.threadId}.pending.jsonl`);
  const release = releaseId();
  const ledger = new FileSpawnLedger(dir, config.open.threadId, release, HOST_PROTOCOL);
  let client: Socket | undefined;
  let seq = 0;
  let endedSeq: number | undefined;
  let closing = false;
  let backgroundEndedAt = 0;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let session: RuntimeSession;
  const retained = new Map<number, Extract<HostMessage, { type: "event" }>>();
  const answered = new Map<string, unknown>();
  const injected = new Set<string>();
  const answering = new Map<string, Promise<void>>();
  const wakes = new Map<string, (id: string) => void>();
  const wakeRuns = new Map<string, string>();
  const hello: HostHello = { sessionProfileHash: sessionHash(config.open.session, config.open.role), type: "hello", instanceId: randomUUID(), protocol: HOST_PROTOCOL, release, upgradeClose: true, startedAt: Date.now(), background: [], threadId: config.open.threadId, pid: process.pid, nativeSessionId: config.open.nativeSessionId, activeRunId: null, openRequests: [], answeredRequests: [], answeredAnswers: {}, lastSeq: 0 };
  const send = (message: HostMessage) => { if (client?.writable) client.write(`${JSON.stringify(message)}\n`); };
  const heartbeat = setInterval(() => {
    if (!closing && !hello.ended && hello.activeRunId) emit({ type: "host.heartbeat", runId: hello.activeRunId, at: Date.now() });
  }, 30_000);
  heartbeat.unref();
  const exit = async () => {
    clearInterval(heartbeat);
    if (exitTimer) clearTimeout(exitTimer);
    ledger.killGroups();
    await session?.close();
    client?.destroy();
    server.close();
    rmSync(socketPath, { force: true });
    ledger.remove();
    process.exit(0);
  };
  const emit = (event: RuntimeEvent) => {
    if (closing) return;
    let wire: WireEvent;
    if (event.type === "wake.started") {
      const wakeId = event.wakeId ?? randomUUID();
      wakes.set(wakeId, event.bind);
      hello.activeRunId = wakeId;
      wire = { type: "wake.started", text: event.text, wakeId };
    } else {
      wire = event;
      if ("runId" in wire && wakeRuns.has(wire.runId)) wire = { ...wire, runId: wakeRuns.get(wire.runId)! };
    }
    if (wire.type === "background.changed") {
      // A finished task's completion arrives in a wake turn a moment later: not a safe point until then.
      // Any task finishing (work or a watcher) wakes the agent a moment later: that moment isn't a safe point.
      if (taskEnded(hello.background, wire.tasks)) backgroundEndedAt = Date.now();
      hello.background = wire.tasks;
    }
    if (wire.type === "session.native") hello.nativeSessionId = wire.nativeSessionId;
    if (wire.type === "request.opened") hello.openRequests.push({ requestId: wire.requestId, kind: wire.kind, payload: wire.payload, runId: wire.runId });
    if (wire.type === "turn.completed" || wire.type === "turn.failed") { hello.activeRunId = null; hello.openRequests = hello.openRequests.filter((r) => r.runId !== wire.runId); }
    const message = { type: "event" as const, seq: ++seq, event: wire };
    hello.lastSeq = seq;
    if (wire.type !== "message.delta" && wire.type !== "host.heartbeat") retained.set(seq, message);
    send(message);
    if (wire.type === "session.ended") {
      hello.ended = true;
      endedSeq = seq;
      exitTimer = setTimeout(() => {
        const temporary = `${pendingPath}.tmp`;
        writeFileSync(temporary, [hello, ...retained.values()].map((m) => JSON.stringify(m)).join("\n") + "\n", { mode: 0o600 });
        renameSync(temporary, pendingPath);
        void exit();
      }, 60_000);
    }
  };
  const runtime = process.env.LOOM_FAKE_RUNTIME === "1" ? new ProcessFakeRuntime() : config.provider === "codex" ? new CodexRuntime({ ...config.codex, ledger }) : new ClaudeRuntime({ ...config.claude, ledger });
  session = await runtime.open(config.open, emit);
  const server = createServer((socket) => {
    client?.destroy();
    client = socket;
    send(hello);
    for (const message of retained.values()) send(message);
    send({ type: "replay.end" });
    let buffer = "";
    socket.on("error", () => {});
    socket.on("close", () => { if (client === socket) client = undefined; });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let command: HostCommand;
        try { command = JSON.parse(line); } catch { socket.destroy(); return; }
        void handle(command);
      }
    });
  });
  async function handle(command: HostCommand): Promise<void> {
    if (command.type === "ack") {
      for (const key of retained.keys()) if (key <= command.seq) retained.delete(key);
      if (endedSeq && command.seq >= endedSeq) await exit();
      return;
    }
    if (command.type === "bindWake") {
      wakeRuns.set(command.wakeId, command.runId);
      for (const [key, message] of retained) {
        if ("runId" in message.event && message.event.runId === command.wakeId) retained.set(key, { ...message, event: { ...message.event, runId: command.runId } });
      }
      wakes.get(command.wakeId)?.(command.runId);
      wakes.delete(command.wakeId);
      if (hello.activeRunId === command.wakeId) hello.activeRunId = command.runId;
      hello.openRequests = hello.openRequests.map((r) => r.runId === command.wakeId ? { ...r, runId: command.runId } : r);
      return;
    }
    try {
      switch (command.type) {
        case "startTurn": hello.activeRunId = command.run.runId; session.startTurn(command.run); break;
        case "inject": {
          if (!session.inject) throw new Error("Injection unsupported");
          if (command.steerId && injected.has(command.steerId)) break;
          await session.inject(command.text, command.images);
          if (command.steerId) { injected.add(command.steerId); hello.injectedSteers = [...injected]; }
          break;
        }
        case "interrupt": await session.interrupt(); break;
        case "respond": {
          if (answered.has(command.requestId)) {
            // The same answer again is a retry; a different one would change what the harness already got.
            if (JSON.stringify(answered.get(command.requestId)) !== JSON.stringify(command.answer)) throw new Error("Request already answered");
          } else {
            let delivery = answering.get(command.requestId);
            if (!delivery) {
              delivery = Promise.resolve().then(() => session.respond(command.requestId, command.answer)).then(() => {
                answered.set(command.requestId, command.answer);
                hello.answeredRequests = [...answered.keys()];
                hello.answeredAnswers = Object.fromEntries(answered);
                hello.openRequests = hello.openRequests.filter((r) => r.requestId !== command.requestId);
              }).finally(() => { answering.delete(command.requestId); });
              answering.set(command.requestId, delivery);
            }
            await delivery;
          }
          break;
        }
        case "closeForUpgrade":
          if (hello.activeRunId != null || hello.openRequests.length || (!command.forceBackground && (holdsWork(hello.background) || Date.now() - backgroundEndedAt < 30_000))) {
            send({ type: "result", id: command.id, ok: false, error: "Upgrade safe point unavailable" });
            return;
          }
          // Freeze the harness before yielding to socket I/O, so a native wake cannot race the safe point.
          closing = true;
          ledger.killGroups();
        case "close":
          closing = true;
          await new Promise<void>((resolve) => {
            if (client?.writable) client.write(`${JSON.stringify({ type: "result", id: command.id, ok: true, tasks: hello.background ?? [] })}\n`, () => resolve());
            else resolve();
          });
          await exit();
          return;
      }
      send({ type: "result", id: command.id, ok: true });
    } catch (error) { send({ type: "result", id: command.id, ok: false, error: redactProfile(String(error), config.open.session) }); }
  }
  server.listen(socketPath);
}
void main().catch((error) => { console.error(redactProfile(String(error), JSON.parse(process.env.LOOM_HOST_CONFIG ?? "{}").open?.session)); process.exit(1); });
