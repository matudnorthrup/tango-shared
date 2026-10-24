import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, classify, upgradeNote } from "../src/ledger.js";
import { LoomStore } from "../src/store.js";
import { LoomHost } from "../src/host.js";
import { FakeRuntime } from "./fake-runtime.js";
import { git } from "../src/git.js";

describe("side effect classifier", () => {
  for (const command of ["git push origin main", "gh pr create", "gh pr merge 1", "gh pr comment 1", "gh pr review 1", "gh pr close 1", "gh release create v1", "gh api repos/x -X POST", "gh api x --method=PATCH", "curl -X PUT https://example.test", "curl -d '{}' https://example.test", "http POST https://example.test", "launchctl kickstart service", "launchctl bootstrap gui/1 x", "launchctl bootout gui/1/x"]) {
    it(command, () => expect(classify("Bash", JSON.stringify({ command }))).not.toBeNull());
  }
  for (const command of ["git status", "gh pr view", "gh api repos/x", "curl https://example.test", "http GET https://example.test", "gh api -X GET search/issues -f q=bug"]) it(command, () => expect(classify("Bash", command)).toBeNull());
  // Codex review on #685: fields switch gh api to POST.
  for (const command of ["gh api repos/o/r/issues/1/comments -f body=hello", "gh api repos/o/r/labels -F name=x", "gh api graphql --raw-field query=mutation"]) it(`implicit POST: ${command}`, () => expect(classify("Bash", command)).not.toBeNull());
  it("records MCP mutations without payloads", () => {
    expect(classify("mcp__mail__send", '{"password":"private"}')).toEqual({ summary: "mcp__mail__send", check: null });
    expect(classify("mcp__mail__list")).toBeNull();
    expect(classify("send_message")).not.toBeNull();
    expect(classify("Bash", "curl -d 'secret' https://example.test")?.summary).not.toContain("secret");
  });
});

it("opens and closes tasks, preserves watchers and deduplicates tool events", () => {
  const store = new LoomStore(":memory:"); const ledger = new Ledger(store);
  try {
    const t = store.tx(() => store.createThread({ kind: "test", cwd: "/repo", provider: "fake" }));
    ledger.background(t, [{ id: "a", kind: "shell", description: "build" }, { id: "w", kind: "monitor", ambient: true, description: "watch PR" }]);
    ledger.background(t, [{ id: "w", kind: "monitor", ambient: true, description: "watch PR" }]);
    expect(ledger.rows(t.id)).toEqual([expect.objectContaining({ ref: "a", outcome: "done" }), expect.objectContaining({ ref: "w", kind: "watcher", outcome: null })]);
    const e = { type: "tool.updated" as const, runId: "r", itemId: "push", name: "Bash", input: "git push", status: "running" as const };
    ledger.tool(t, e); ledger.tool(t, e); ledger.tool(t, { ...e, status: "completed", input: undefined });
    expect(store.db.prepare("SELECT phase FROM side_effects ORDER BY rowid").all()).toEqual([{ phase: "intent" }, { phase: "result" }]);
  } finally { store.close(); }
});

for (const pushed of [false, true]) it(`restart reports lost tasks and checks push (${pushed})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-ledger-"));
  let store = new LoomStore(join(dir, "state.sqlite"));
  const runtime = new FakeRuntime(); let host = new LoomHost(store, { fake: runtime });
  try {
    const cwd = join(dir, "repo"); const remote = join(dir, "remote.git");
    await git(["init", "--bare", remote], { cwd: dir }); await git(["init", "-b", "main", cwd], { cwd: dir });
    await git(["-c", "user.name=Loom", "-c", "user.email=loom@localhost", "commit", "--allow-empty", "-m", "initial"], { cwd });
    await git(["remote", "add", "origin", remote], { cwd });
    if (pushed) await git(["push", "origin", "main"], { cwd });
    const r = await host.execute({ type: "submit", commandId: "s", cwd, provider: "fake", text: "work" });
    runtime.last.emit({ type: "session.native", nativeSessionId: "native" });
    runtime.last.emit({ type: "background.changed", tasks: [{ id: "build", kind: "shell", description: "compile widgets" }] });
    runtime.last.emit({ type: "tool.updated", runId: r.runId!, itemId: "push", name: "Bash", input: "git push origin main", status: "running" });
    await host.detachAll();
    store.close(); store = new LoomStore(join(dir, "state.sqlite"));
    host = new LoomHost(store, { fake: runtime });
    expect(await host.recover()).toEqual({ interrupted: 1, continued: 1 });
    const note = store.runs(r.threadId!).find(x => x.source === "continue")!.text;
    expect(note).toContain("Lost shell: compile widgets (build)");
    expect(note).toContain(pushed ? "pushed (matches local HEAD)" : "not pushed (does not match local HEAD)");
    expect(host.ledger.rows(r.threadId!).find(x => x.ref === "build")!.outcome).toBe("lost");
  } finally { await host.detachAll(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("records turn-end checkpoints, skips unchanged snapshots and records changed ones", async () => {
  const home = mkdtempSync(join(tmpdir(), "loom-checkpoints-test-"));
  const store = new LoomStore(":memory:"); const runtime = new FakeRuntime(); const host = new LoomHost(store, { fake: runtime }, { loomHome: home });
  try {
    const cwd = join(home, "worktrees", "repo");
    await git(["init", cwd], { cwd: home });
    await git(["-c", "user.name=Loom", "-c", "user.email=loom@localhost", "commit", "--allow-empty", "-m", "initial"], { cwd });
    const r = await host.execute({ type: "submit", commandId: "s", cwd, provider: "fake", text: "work" });
    writeFileSync(join(cwd, "new.txt"), "one"); runtime.last.complete(); await host.ledger.drain();
    const t = store.thread(r.threadId!)!;
    await host.ledger.checkpoint(t);
    expect(host.ledger.timeline(t.id).filter(e => e.kind === "checkpoint")).toHaveLength(1);
    writeFileSync(join(cwd, "new.txt"), "two"); await host.ledger.checkpoint(t);
    expect(host.ledger.timeline(t.id).filter(e => e.kind === "checkpoint")).toHaveLength(2);
    expect((await git(["show", `refs/loom/checkpoints/${t.id}:new.txt`], { cwd })).stdout).toBe("two");
    const events = host.ledger.timeline(t.id); expect(events.map(e => e.at)).toEqual(events.map(e => e.at).sort((a,b) => a-b));
  } finally { await host.detachAll(); store.close(); rmSync(home, { recursive: true, force: true }); }
});

it("uses tasks frozen by the host for the move note", () => {
  const note = upgradeNote("next", [{ id: "actual", kind: "shell", description: "actual work" }, { id: "w", kind: "monitor", description: "watch changes", ambient: true }]);
  expect(note).toContain("actual work (actual)"); expect(note).toContain("watch changes (w)"); expect(upgradeNote("next", [])).toBeNull();
});

it('captures canonical PR URLs from successful create output without retaining other output', () => {
  const store = new LoomStore(':memory:'); const ledger = new Ledger(store);
  try {
    const t = store.tx(() => store.createThread({ kind: 'test', cwd: '/repo', provider: 'fake' }));
    const event = { type: 'tool.updated' as const, runId: 'r', itemId: 'create', name: 'Bash', input: 'gh pr create', status: 'running' as const };
    ledger.tool(t, event);
    ledger.tool(t, { ...event, input: undefined, status: 'completed', output: 'Creating PR…\nhttps://github.com/acme/widgets/pull/42\nDone.' });
    expect(ledger.openedPrUrls(t.id)).toEqual(['https://github.com/acme/widgets/pull/42']);
    ledger.tool(t, { ...event, itemId: 'failed', status: 'failed', output: 'https://github.com/acme/widgets/pull/43' });
    expect(ledger.openedPrUrls(t.id)).toHaveLength(1);
    expect(new Ledger(store).openedPrUrls(t.id)).toHaveLength(1);
  } finally { store.close(); }
});

it('records when a thread last merged a PR, ignoring failed merges and other commands', () => {
  const store = new LoomStore(':memory:'); const ledger = new Ledger(store);
  try {
    const t = store.tx(() => store.createThread({ kind: 'test', cwd: '/repo', provider: 'fake' }));
    expect(classify('Bash', 'gh pr merge 7 --squash')?.check).toBe('merge');
    expect(ledger.lastPrMergeAt(t.id)).toBeNull();
    const event = { type: 'tool.updated' as const, runId: 'r', itemId: 'fail', name: 'Bash', input: 'gh pr merge 7', status: 'running' as const };
    ledger.tool(t, event); ledger.tool(t, { ...event, input: undefined, status: 'failed' });
    ledger.tool(t, { ...event, itemId: 'comment', input: 'gh pr comment 7 -b hi' }); ledger.tool(t, { ...event, itemId: 'comment', input: undefined, status: 'completed' });
    expect(ledger.lastPrMergeAt(t.id)).toBeNull();
    ledger.tool(t, { ...event, itemId: 'ok' }); ledger.tool(t, { ...event, itemId: 'ok', input: undefined, status: 'completed' });
    expect(ledger.lastPrMergeAt(t.id)).toEqual(expect.any(Number));
  } finally { store.close(); }
});

it('exposes only completed legacy PR creations with no captured URL for desk backfill', () => {
  const store = new LoomStore(':memory:'); const ledger = new Ledger(store);
  try {
    const thread = store.tx(() => store.createThread({ kind: 'test', cwd: '/repo', provider: 'fake' }));
    const event = { type: 'tool.updated' as const, runId: 'r', itemId: 'legacy', name: 'Bash', input: 'gh pr create', status: 'completed' as const };
    ledger.tool(thread, event);
    ledger.tool(thread, { ...event, itemId: 'failed', status: 'failed' });
    ledger.tool(thread, { ...event, itemId: 'intent', status: 'running' });
    ledger.tool(thread, { ...event, itemId: 'captured', output: 'https://github.com/acme/widgets/pull/7' });
    ledger.tool(thread, { ...event, itemId: 'push', input: 'git push' });
    expect(ledger.legacyPrCreates(thread.id)).toEqual([{ id: expect.any(String), at: expect.any(Number) }]);
    const legacy = store.db.prepare("SELECT id, at FROM side_effects WHERE call_id = 'legacy'").get();
    expect(ledger.legacyPrCreates(thread.id)).toEqual([legacy]);
  } finally { store.close(); }
});
