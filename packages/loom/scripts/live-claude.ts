/**
 * Live check of Loom's Claude runtime against real accounts. Not part of CI.
 *
 *   LOOM_ACCOUNTS=~/.tango/loom/accounts.json \
 *     npx tsx packages/loom/scripts/live-claude.ts <accountA> <accountB> <scratch-git-dir>
 *
 * Uses a temporary database and shared project store. It links the scratch
 * folder's project into both accounts and removes those links at the end.
 */
import { mkdtempSync, rmSync, unlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeRuntime, configDirOf } from "../src/claude/claude-runtime.js";
import { projectSlug } from "../src/claude/project-store.js";
import { loadAccounts, loadConfig } from "../src/config.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";

const [accountA, accountB, cwd] = process.argv.slice(2);
if (!accountA || !accountB || !cwd) throw new Error("usage: live-claude.ts <accountA> <accountB> <scratch-git-dir>");

const accounts = loadAccounts(loadConfig()).claude;
if (!accounts) throw new Error("No Claude accounts configured");
const tmp = mkdtempSync(join(tmpdir(), "loom-live-"));
const store = new LoomStore(join(tmp, "loom.sqlite"));
const runtime = new ClaudeRuntime({ accounts: accounts.accounts, defaultAccount: accountA, sharedProjectsDir: join(tmp, "shared"), store });
const host = new LoomHost(store, { claude: runtime });

let n = 0;
const id = () => `live-${Date.now()}-${n++}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | null | false, timeoutMs = 180_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await sleep(250);
  }
}
const lastAssistant = (t: string) => store.messages(t).filter((m) => m.role === "assistant").at(-1)?.text ?? "";
const idle = (t: string) => store.thread(t)!.status === "idle" && !store.nextQueuedRun(t) && !store.activeRun(t);
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

let deltas = 0;
host.subscribe((e) => {
  if ("type" in e && e.type === "delta") deltas++;
});

try {
  // 1. A turn, streaming, on account A.
  const first = await host.execute({ type: "submit", commandId: id(), text: "Reply with exactly: ALPHA", cwd, provider: "claude", account: accountA });
  const t = first.threadId!;
  await until("first turn", () => idle(t));
  check("turn completes", /ALPHA/.test(lastAssistant(t)), JSON.stringify(lastAssistant(t)));
  check("streams deltas live", deltas > 0, `${deltas} deltas`);
  check("native session recorded", !!store.thread(t)!.native_session_id, store.thread(t)!.native_session_id ?? "none");

  // 2. Replies queue while busy and run in order on the same live process.
  await host.execute({ type: "submit", commandId: id(), threadId: t, text: "Remember the code word KESTREL-4. Reply with just OK." });
  await host.execute({ type: "submit", commandId: id(), threadId: t, text: "What code word did I just give you? Reply with only the word." });
  await until("queued turns", () => idle(t));
  check("queued reply ran in order", /KESTREL-4/.test(lastAssistant(t)), JSON.stringify(lastAssistant(t)));

  // 3. A question goes to the Desk and the answer comes back.
  await host.execute({
    type: "submit",
    commandId: id(),
    threadId: t,
    text: "Use the AskUserQuestion tool to ask me to choose between the colors red and blue. After I answer, reply with only the color I chose.",
  });
  const req = await until("question", () => store.openRequests(t)[0]);
  const payload = JSON.parse(req.payload) as { questions: { question: string; options?: { label: string }[] }[] };
  const q = payload.questions[0]!;
  const blue = q.options?.find((o) => /blue/i.test(o.label))?.label ?? "blue";
  check("question reached the Desk", req.kind === "question" && store.thread(t)!.status === "waiting", q.question);
  await host.execute({ type: "answer", commandId: id(), requestId: req.id, answer: { answers: { [q.question]: blue } } });
  await until("answered turn", () => idle(t));
  check("answer reached Claude", /blue/i.test(lastAssistant(t)), JSON.stringify(lastAssistant(t)));

  // 4. Stop interrupts a long turn, and the thread keeps working afterwards.
  const long = await host.execute({ type: "submit", commandId: id(), threadId: t, text: "Run the shell command `sleep 45` with the Bash tool, then reply DONE." });
  await until("sleep tool started", () => store.items(t).some((i) => i.status === "running" && i.name === "Bash"), 120_000);
  await host.execute({ type: "interrupt", commandId: id(), threadId: t });
  await until("interrupt settles", () => store.run(long.runId!)!.status !== "running", 30_000);
  check("interrupt stops the turn", store.run(long.runId!)!.status === "interrupted", store.run(long.runId!)!.status);
  await host.execute({ type: "submit", commandId: id(), threadId: t, text: "Reply with exactly: STILL-HERE" });
  await until("post-interrupt turn", () => idle(t));
  check("thread works after interrupt", /STILL-HERE/.test(lastAssistant(t)), JSON.stringify(lastAssistant(t)));

  // 5. A background task finishes while idle and wakes the thread.
  await host.execute({
    type: "submit",
    commandId: id(),
    threadId: t,
    text: "Start the shell command `sleep 8 && echo BG-FINISHED` in the background (Bash with run_in_background). Reply with just STARTED. When it finishes, tell me its output.",
  });
  await until("wake turn", () => store.runs(t).some((r) => r.source === "wake" && r.status === "completed"), 180_000);
  const woke = store.runs(t).find((r) => r.source === "wake")!;
  const wakeText = store.messages(t).filter((m) => m.run_id === woke.id).map((m) => m.text).join(" ");
  check("background task woke the thread", /BG-FINISHED/.test(wakeText), JSON.stringify(wakeText.slice(0, 120)));
  await until("idle after wake", () => idle(t));

  // 6. The same native session continues on account B.
  const nativeBefore = store.thread(t)!.native_session_id;
  await host.closeAll();
  store.tx(() => store.updateThread(t, { account: accountB }));
  await host.execute({ type: "submit", commandId: id(), threadId: t, text: "What code word did I give you earlier? Reply with only the word." });
  await until("turn on account B", () => idle(t));
  const runB = store.runs(t).at(-1)!;
  check("history continues on account B", /KESTREL-4/.test(lastAssistant(t)), `${JSON.stringify(lastAssistant(t).slice(0, 80))} run=${runB.status} ${runB.failure ?? ""}`);
  check("same native session on account B", store.thread(t)!.native_session_id === nativeBefore, `${nativeBefore}`);
  const lastRun = store.runs(t).at(-1)!;
  check("attempt recorded on account B", store.attempts(lastRun.id)[0]?.account === accountB, store.attempts(lastRun.id)[0]?.account ?? "none");
} finally {
  await host.closeAll();
  store.close();
  const slug = projectSlug(cwd);
  for (const name of [accountA, accountB]) {
    const link = join(configDirOf(runtime.account(name)), "projects", slug);
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
    } catch {}
  }
  rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter((r) => !r[1]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
