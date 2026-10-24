import { describe, expect, it } from "vitest";
import { lintNote, lintUpdate } from "../src/catchup.js";
import { DEFAULT_ROLE_GUIDANCE } from "../src/claude/loom-tools.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

// Catch-up (docs/specs/catch-up.md): leads write news as desk_update lines and the chapter's headline and status as
// chapter_note, Loom keeps both for the desk, and a lead's turn starts with what the owner has already seen.

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(seenBrief?: (threadId: string, since: number) => Promise<string | null>) {
  const store = new LoomStore(":memory:");
  let now = 1_000_000;
  store.now = () => now;
  const runtime = new FakeRuntime();
  const host = new LoomHost(store, { fake: runtime }, { ...(seenBrief ? { seenBrief } : {}) });
  return { store, runtime, host, advance: (ms: number) => { now += ms; } };
}

describe("what a lead may write", () => {
  it("a line is a kind and one finished sentence; links the owner can open; headline and status go in chapter_note", () => {
    expect(lintUpdate({ kind: "shipped", title: "Decided for you is live on the Inbox", refs: [{ url: "https://github.com/o/r/pull/1" }] })).toMatchObject({ errors: [], update: { kind: "shipped", moment: null, refs: [{ label: "github.com/o/r/pull/1" }] } });
    expect(lintUpdate({ kind: "headline", title: "x" }).errors.join()).toMatch(/chapter_note/);
    expect(lintUpdate({ kind: "fyi", title: "word ".repeat(25) }).errors.join()).toMatch(/at most 20 words/);
    expect(lintUpdate({ kind: "fyi", title: "ok", refs: [{ url: "http://localhost:3000" }] }).errors.join()).toMatch(/never localhost/);
    expect(lintUpdate({ kind: "fyi", title: "ok", supersedes: "D-3" }).errors.join()).toMatch(/U-<n>/);
    expect(lintNote({}).errors.join()).toMatch(/headline, a status, or both/);
    expect(lintNote({ status: "Phase 2 is done. Next: phase 3 plan." })).toMatchObject({ errors: [], note: { headline: null } });
  });

  it("the lead's standing instructions say news goes in desk_update and chat points to the chapter", () => {
    expect(DEFAULT_ROLE_GUIDANCE).toContain("Don't restate a worker's ask or another thread's brief. Your row carries it.");
    expect(DEFAULT_ROLE_GUIDANCE).toMatch(/News goes in `loom.desk_update`, not chat/);
    expect(DEFAULT_ROLE_GUIDANCE).toMatch(/Never restate a brief's options in chat/);
  });
});

describe("Loom keeps it for the desk", () => {
  it("posts lines covering the turn's words, chains supersedes, and pages notes and lines together by seq", async () => {
    const { host, store, runtime, advance } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "ship it", cwd: "/repo", provider: "fake" });
    await flush();
    const run = store.activeRun(r.threadId!)!;
    advance(5_000);
    const first = await host.execute({ type: "update.post", commandId: "u1", threadId: r.threadId!, kind: "failed", title: "Backup failed overnight" });
    expect(first.updateId).toBe("U-1");
    const note = await host.execute({ type: "chapter.note", commandId: "n1", threadId: r.threadId!, headline: "Backups broke and were fixed." });
    expect(note.noteId).toBe("N-2");
    const fixed = await host.execute({ type: "update.post", commandId: "u2", threadId: r.threadId!, kind: "fyi", title: "Backup fixed", supersedes: "U-1" });
    expect(fixed.updateId).toBe("U-3");
    await expect(host.execute({ type: "update.post", commandId: "u3", threadId: r.threadId!, kind: "fyi", title: "x", supersedes: "U-9" })).rejects.toThrow(/no update U-9/);
    const all = host.catchup.since(0);
    expect(all.updates.map((u) => [u.id, u.kind, u.supersedes, u.covers_from, u.covers_to])).toEqual([["U-1", "failed", null, run.started_at, 1_005_000], ["U-3", "fyi", "U-1", run.started_at, 1_005_000]]);
    expect(all.notes.map((n) => [n.id, n.headline, n.status])).toEqual([["N-2", "Backups broke and were fixed.", null]]);
    expect(all.last).toBe(3);
    const page = host.catchup.since(0, 2);
    expect([page.updates.map((u) => u.id), page.notes.map((n) => n.id), page.last, page.more]).toEqual([["U-1"], ["N-2"], 2, true]);
    expect(host.catchup.since(2).updates.map((u) => u.id)).toEqual(["U-3"]);
    // The run ends after its final reply: its lines cover through then, read again under new seqs.
    advance(30_000);
    runtime.last.complete();
    await flush();
    const closed = host.catchup.since(3);
    expect(closed.updates.map((u) => [u.id, u.covers_to])).toEqual([["U-1", 1_035_000], ["U-3", 1_035_000]]);
  });

  it("a lead's turn starts with what the owner has seen since its last turn; other threads' don't", async () => {
    const asked: Array<[string, number]> = [];
    const { host, runtime, store, advance } = setup(async (threadId, since) => {
      asked.push([threadId, since]);
      return "The owner has seen: Backup fixed (ok). Don't retell these. Point to them.";
    });
    const lead = await host.execute({ type: "submit", commandId: "c1", text: "how are things?", cwd: "/repo", provider: "fake", role: "default" });
    await flush();
    await flush();
    expect(runtime.last.turns.at(-1)!.text).toMatch(/^The owner has seen: Backup fixed \(ok\)\. Don't retell these\. Point to them\.\n\nhow are things\?$/);
    expect(asked).toEqual([[lead.threadId!, 1_000_000 - 24 * 3600_000]]);
    const firstStart = store.activeRun(lead.threadId!)!.started_at!;
    runtime.last.complete();
    await flush();
    advance(60_000);
    await host.execute({ type: "submit", commandId: "c2", text: "and now?", cwd: "/repo", provider: "fake", threadId: lead.threadId! } as never);
    await flush();
    await flush();
    expect(asked.at(-1)).toEqual([lead.threadId!, firstStart]);
    const plain = await host.execute({ type: "submit", commandId: "c3", text: "do a thing", cwd: "/repo", provider: "fake" });
    await flush();
    await flush();
    expect(runtime.last.turns.at(-1)!.text).toBe("do a thing");
    expect(asked.some(([id]) => id === plain.threadId)).toBe(false);
  });

  it("a Stop while the preamble is read ends the run before it starts", async () => {
    let release: ((text: string | null) => void) | null = null;
    const { host, runtime, store } = setup(() => new Promise((resolve) => { release = resolve; }));
    // The submit's dispatch is held on the preamble: it isn't awaited here.
    const submitted = host.execute({ type: "submit", commandId: "c1", text: "hello", cwd: "/repo", provider: "fake", role: "default" });
    for (let i = 0; i < 20 && !release; i += 1) await flush();
    expect(release).not.toBeNull();
    const threadId = store.db.prepare("SELECT id FROM threads").get() as { id: string };
    const run = store.runs(threadId.id).at(-1)!;
    expect(store.run(run.id)!.status).toBe("queued");
    const stopped = host.execute({ type: "stop", commandId: "s1", threadId: threadId.id });
    await flush();
    release!("[Catch-up] seen");
    await Promise.all([submitted, stopped]);
    await flush();
    expect(runtime.sessions.flatMap((s) => s.turns)).toEqual([]);
    expect(store.run(run.id)!.status).not.toBe("running");
  });

  it("a desk that can't answer leaves the turn as it was", async () => {
    const { host, runtime } = setup(async () => { throw new Error("desk down"); });
    await host.execute({ type: "submit", commandId: "c1", text: "hello", cwd: "/repo", provider: "fake", role: "default" });
    await flush();
    await flush();
    expect(runtime.last.turns.at(-1)!.text).toBe("hello");
  });
});
