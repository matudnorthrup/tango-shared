import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processStart } from "../src/proc.js";

const coordinators: ChildProcess[] = [];
const homes: string[] = [];
const token = "session-host-system-test";
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  let value: T | undefined;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      value = await read();
      if (accept(value)) return value;
    } catch (caught) {
      error = caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)} ${String(error ?? "")}`);
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill(signal);
  });
}

function home(): string {
  // Keep Unix socket paths below macOS's 104-byte limit, independent of TMPDIR.
  const path = mkdtempSync("/tmp/loom-host-");
  homes.push(path);
  writeFileSync(join(path, "token"), token);
  writeFileSync(join(path, "accounts.json"), JSON.stringify({ claude: { default: "test", accounts: [{ name: "test" }] } }));
  return path;
}

async function start(home: string) {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", main], {
    env: {
      ...process.env,
      LOOM_HOME: home,
      LOOM_PORT: String(port),
      LOOM_USAGE_URL: "",
      LOOM_FAKE_RUNTIME: "1",
      LOOM_FAKE_TURN_MS: "2500",
      LOOM_RELEASE: "system-test-release",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  coordinators.push(child);
  let output = "";
  child.stdout!.on("data", (data) => (output += data));
  child.stderr!.on("data", (data) => (output += data));
  const base = `http://127.0.0.1:${port}`;
  const call = async (path: string, command?: Record<string, unknown>): Promise<any> => {
    const response = await fetch(base + path, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(command ? { method: "POST", body: JSON.stringify(command) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    return body;
  };
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Coordinator exited: ${output}`);
      return call("/health");
    }, (body) => body.ok, "coordinator health");
  } catch (error) {
    throw new Error(`${String(error)}\n${output}`);
  }
  const submit = async (text: string) => {
    const body = await call("/commands", { type: "submit", commandId: "submit", provider: "claude", session: { loomTools: false }, cwd: tmpdir(), text, title: "Test" });
    expect(body.ok).toBe(true);
    return body.result.threadId as string;
  };
  return { child, call, submit, detail: (id: string) => call(`/threads/${id}`) };
}

function hostPid(home: string, threadId: string): number {
  const ledger = JSON.parse(readFileSync(join(home, "hosts", `${threadId}.json`), "utf8"));
  return ledger.pid;
}

afterEach(async () => {
  for (const child of coordinators.splice(0)) await stop(child);
  for (const home of homes.splice(0)) {
    // Hosts are intentionally detached; clean them up even when an assertion fails.
    let files: string[] = [];
    try { files = readdirSync(join(home, "hosts")); } catch {}
    for (const file of files.filter((file) => file.endsWith(".json") && !file.endsWith(".pending.jsonl"))) {
      try {
        const ledger = JSON.parse(readFileSync(join(home, "hosts", file), "utf8"));
        if (ledger.pid > 1 && processStart(ledger.pid) === ledger.started) process.kill(ledger.pid, "SIGKILL");
      } catch {}
    }
    rmSync(home, { recursive: true, force: true });
  }
});

describe("detached session host recovery", { timeout: 60_000 }, () => {
  it("reattaches the same host after SIGKILL and stores its completed turn once", async () => {
    const path = home();
    const first = await start(path);
    const threadId = await first.submit("slow");
    await until(() => first.detail(threadId), (detail) => detail.runs[0]?.status === "running" && detail.thread.native_session_id, "running native session");
    const pid = hostPid(path, threadId);
    await stop(first.child);
    expect(processStart(pid)).not.toBeNull();
    const second = await start(path);
    expect(hostPid(path, threadId)).toBe(pid);
    const completed = await until(() => second.detail(threadId), (detail) => detail.runs[0]?.status === "completed", "original completed run");
    expect(completed.runs).toHaveLength(1);
    expect(completed.runs[0].source).toBe("user");
    expect(completed.messages.filter((message: any) => message.role === "assistant").map((message: any) => message.text)).toEqual(["Completed: slow"]);
    expect(completed.thread.host_release).toBe("system-test-release");
    // A second reattach cannot replay the completed message into storage again.
    await stop(second.child, "SIGTERM");
    expect(processStart(pid)).not.toBeNull();
    const third = await start(path);
    const replayed = await third.detail(threadId);
    expect(hostPid(path, threadId)).toBe(pid);
    expect(replayed.messages.filter((message: any) => message.role === "assistant")).toHaveLength(1);
    expect(replayed.runs).toHaveLength(1);
  }, 30_000);

  it("replays a turn completed while the coordinator was down exactly once", async () => {
    const path = home();
    const first = await start(path);
    const threadId = await first.submit("slow replay");
    await until(() => first.detail(threadId), (detail) => detail.runs[0]?.status === "running" && detail.thread.native_session_id, "running native session");
    const pid = hostPid(path, threadId);
    await stop(first.child);
    await new Promise((resolve) => setTimeout(resolve, 2800));
    const second = await start(path);
    const completed = await until(() => second.detail(threadId), (detail) => detail.runs[0]?.status === "completed", "replayed completed run");
    expect(hostPid(path, threadId)).toBe(pid);
    expect(completed.runs).toHaveLength(1);
    expect(completed.messages.filter((message: any) => message.role === "assistant").map((message: any) => message.text)).toEqual(["Completed: slow replay"]);
    await stop(second.child);
    const third = await start(path);
    const detail = await third.detail(threadId);
    expect(detail.runs).toHaveLength(1);
    expect(detail.messages.filter((message: any) => message.role === "assistant")).toHaveLength(1);
  }, 30_000);

  it("interrupts and continues exactly once when the host died while the coordinator was down", async () => {
    const path = home();
    const first = await start(path);
    const threadId = await first.submit("slow");
    await until(() => first.detail(threadId), (detail) => detail.runs[0]?.status === "running" && detail.thread.native_session_id, "running native session");
    const pid = hostPid(path, threadId);
    await stop(first.child);
    process.kill(pid, "SIGKILL");
    await until(() => processStart(pid), (start) => start === null, "dead session host");
    const second = await start(path);
    const recovered = await until(() => second.detail(threadId), (detail) => detail.runs.length === 2, "automatic continue");
    expect(recovered.runs[0].status).toBe("interrupted");
    expect(recovered.runs.filter((run: any) => run.source === "continue")).toHaveLength(1);
    expect(hostPid(path, threadId)).not.toBe(pid);
    const completed = await until(() => second.detail(threadId), (detail) => detail.runs[1]?.status === "completed", "continued run completion");
    expect(completed.runs).toHaveLength(2);
  }, 30_000);

  it("keeps an open question answerable across a coordinator restart", async () => {
    const path = home();
    const first = await start(path);
    const threadId = await first.submit("question");
    const waiting = await until(() => first.detail(threadId), (detail) => detail.requests.length === 1, "open question");
    const requestId = waiting.requests[0].id;
    const pid = hostPid(path, threadId);
    await stop(first.child);
    const second = await start(path);
    const reattached = await second.detail(threadId);
    expect(hostPid(path, threadId)).toBe(pid);
    expect(reattached.requests.map((request: any) => request.id)).toEqual([requestId]);
    expect(reattached.runs).toHaveLength(1);
    expect(reattached.runs[0].status).toBe("running");
    expect((await second.call("/commands", { type: "answer", commandId: "answer", requestId, answer: { Continue: "Yes" } })).ok).toBe(true);
    const completed = await until(() => second.detail(threadId), (detail) => detail.runs[0]?.status === "completed", "answered question completion");
    expect(completed.requests).toHaveLength(0);
    expect(completed.runs).toHaveLength(1);
    expect(completed.messages.filter((message: any) => message.role === "assistant")).toHaveLength(1);
  }, 30_000);
});


it("accepts a repeated answer once, refuses a different one, and reports the original on reattach", async () => {
  const { RemoteRuntime } = await import("../src/remote-runtime.js");
  const path = home();
  const runtime = new RemoteRuntime({ loomHome: path, claude: { accounts: [], defaultAccount: "test", sharedProjectsDir: path } });
  const previous = process.env.LOOM_FAKE_RUNTIME;
  process.env.LOOM_FAKE_RUNTIME = "1";
  let session;
  try {
    const options = { threadId: "answer-test", cwd: tmpdir(), account: null, nativeSessionId: null };
    session = await runtime.open(options, () => {});
    await session.activate(0);
    session.startTurn({ runId: "run", text: "question" });
    await session.respond("question-run", "yes");
    await session.respond("question-run", "yes");
    await expect(session.respond("question-run", "different")).rejects.toThrow("already answered");
    session.detach();
    session = (await runtime.attach(options, () => {}))!;
    expect(session.hello.answeredRequests).toEqual(["question-run"]);
    expect(session.hello.answeredAnswers).toEqual({ "question-run": "yes" });
  } finally {
    if (previous === undefined) delete process.env.LOOM_FAKE_RUNTIME; else process.env.LOOM_FAKE_RUNTIME = previous;
    await session?.close();
  }
}, 30_000);
