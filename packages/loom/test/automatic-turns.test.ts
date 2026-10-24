import { describe, it, expect } from "vitest";
import { LoomStore } from "../src/store.js";
import { LoomHost } from "../src/host.js";
import { FakeRuntime } from "./fake-runtime.js";
import { STALL_WAKE_TEXT } from "../src/handoff.js";

const mail = (n: number) => ({ type: "submit" as const, commandId: `m${n}`, text: `✉️ Mail from lead: item ${n}`, origin: { kind: "peer" as const, name: "Lead", from: "loom:lead", mailId: `m-${n}` } });

async function started(settle = 0) {
  const store = new LoomStore(":memory:"), runtime = new FakeRuntime(store);
  let now = Date.now(); store.now = () => now;
  const host = new LoomHost(store, { fake: runtime }, { automaticSettleMs: settle });
  const { threadId } = await host.execute({ type: "submit", commandId: "start", cwd: "/tmp", provider: "fake", text: "work" });
  return { store, runtime, host, id: threadId!, advance: (ms: number) => { now += ms; } };
}

describe("automatic turns", () => {
  it("folds wakes and mail queued behind a turn into one turn, with their messages", async () => {
    const { store, runtime, host, id } = await started();
    try {
      store.tx(() => { store.createRun(id, "wake", "Loom: the trigger you set fired: CI"); });
      await host.execute({ ...mail(1), threadId: id });
      runtime.last.complete(); await host.kick(id);
      expect(runtime.last.turns).toHaveLength(2);
      const turn = runtime.last.turns[1]!;
      expect(turn.text).toContain("the trigger you set fired");
      expect(turn.text).toContain("item 1");
      const runs = store.runs(id);
      expect(runs.map((r) => r.status)).toEqual(["completed", "running", "canceled"]);
      expect(JSON.parse(runs[2]!.failure!).code).toBe("folded");
      expect(store.messages(id).filter((m) => m.text.includes("item 1")).every((m) => m.run_id === runs[1]!.id)).toBe(true);
    } finally { await host.closeAll(); store.close(); }
  });

  it("never folds the owner's words: they start their own turn after the automatic ones", async () => {
    const { store, runtime, host, id } = await started();
    try {
      store.tx(() => { store.createRun(id, "wake", "wake one"); });
      await host.execute({ type: "submit", commandId: "own", threadId: id, text: "owner says" });
      store.tx(() => { store.createRun(id, "wake", "wake two"); });
      runtime.last.complete(); await host.kick(id);
      expect(runtime.last.turns[1]!.text).toBe("wake one");
      runtime.last.complete(); await host.kick(id);
      expect(runtime.last.turns[2]!.text).toBe("owner says");
      runtime.last.complete(); await host.kick(id);
      expect(runtime.last.turns[3]!.text).toBe("wake two");
    } finally { await host.closeAll(); store.close(); }
  });

  it("never folds a stall correction: its outcome is read by its exact text", async () => {
    const { store, runtime, host, id } = await started();
    try {
      store.tx(() => { store.createRun(id, "wake", STALL_WAKE_TEXT); });
      await host.execute({ ...mail(3), threadId: id });
      runtime.last.complete(); await host.kick(id);
      expect(runtime.last.turns[1]!.text).toBe(STALL_WAKE_TEXT);
      expect(store.runs(id)[1]!.text).toBe(STALL_WAKE_TEXT);
      runtime.last.complete(); await host.kick(id);
      expect(runtime.last.turns[2]!.text).toContain("item 3");
    } finally { await host.closeAll(); store.close(); }
  });

  it("holds an automatic turn for the settle window so a burst starts one turn, but not the owner's words", async () => {
    const { store, runtime, host, id, advance } = await started(60_000);
    try {
      runtime.last.complete(); await host.kick(id);
      store.tx(() => { store.createRun(id, "wake", "Loom: the trigger you set fired: Codex"); });
      await host.kick(id);
      expect(runtime.last.turns).toHaveLength(1); // still settling
      advance(30_000); await host.execute({ ...mail(2), threadId: id }); await host.kick(id);
      expect(runtime.last.turns).toHaveLength(1);
      advance(31_000); await host.kick(id);
      expect(runtime.last.turns).toHaveLength(2);
      expect(runtime.last.turns[1]!.text).toContain("Codex");
      expect(runtime.last.turns[1]!.text).toContain("item 2");
      runtime.last.complete(); await host.kick(id);
      store.tx(() => { store.createRun(id, "wake", "another wake"); });
      await host.execute({ type: "submit", commandId: "own", threadId: id, text: "owner now" }); await host.kick(id);
      expect(runtime.last.turns).toHaveLength(3); // the owner is queued: no wait
      expect(runtime.last.turns[2]!.text).toBe("another wake");
    } finally { await host.closeAll(); store.close(); }
  });
});
