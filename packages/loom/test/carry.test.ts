import { describe, expect, it } from "vitest";
import { renderCarry } from "../src/carry.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("carried state", () => {
  it("rebuilds a thread's waits, owner messages and worktree from the store", async () => {
    const store = new LoomStore(":memory:");
    const runtime = new FakeRuntime();
    const host = new LoomHost(store, { fake: runtime });
    const r = await host.execute({ type: "submit", commandId: "c1", text: "Build the carry block", cwd: "/repo", provider: "fake" });
    runtime.last.complete();
    await flush();
    const wait = host.triggers.create(r.threadId!, "file", { path: "/nonexistent/loom-carry", exists: true }, "resume the build when the file lands");
    const text = host.carry(r.threadId!)!;
    expect(text).toContain(`loom:${r.threadId}`);
    expect(text).toContain("Working directory: /repo");
    expect(text).toContain(wait);
    expect(text).toContain("your note: resume the build when the file lands");
    expect(text).toContain("Build the carry block");
    expect(host.carry("missing")).toBeUndefined();
  });

  it("labels an ask that answers another agent's mail as that agent's, not the owner's", () => {
    const base = { thread: { id: "t", title: "T", role: "interactive", parent: null, cwd: "/w", branch: null, repo: null }, children: [], waits: [], briefs: [], tasks: [], owner: [], now: 0 } as const;
    expect(renderCarry({ ...base, ask: "confirm the milestones", askTo: "T3 cutover" })).toContain("Your open ask to T3 cutover (another agent, not the owner)");
    expect(renderCarry({ ...base, ask: "confirm the milestones", askTo: "T3 cutover" })).not.toContain("Your open ask to the owner");
    expect(renderCarry({ ...base, ask: "merge #12" })).toContain("Your open ask to the owner");
    expect(renderCarry({ ...base, ask: "x", askTo: "N".repeat(50_000) }).length).toBeLessThan(2_000);
  });

  it("lists briefs, tasks and children, and leaves empty sections out", () => {
    const base = { thread: { id: "t", title: "Lead", role: "default", parent: null, cwd: "/w", branch: "b", repo: "tango" }, children: [], waits: [], briefs: [], ask: null, tasks: [], owner: [], now: 0 };
    const empty = renderCarry(base);
    expect(empty).not.toContain("## ");
    const full = renderCarry({ ...base, ask: "merge #12", briefs: [{ id: "D-7", class: "plan-approval", ask: "Approve the plan", created_at: 0, standing: "Spec is up", background: "Calls carry 300k", default: "A", options: [{ key: "A", label: "Approve", consequence: "phase 1 ships", action: "Ship phase 1 today" }, { key: "B", label: "Wait", consequence: "burn continues" }] }], tasks: [{ id: "bg1", kind: "local_bash", description: "npm test", ambient: false }], children: [{ id: "w1", title: "Worker", status: "running", role: "worker" }] });
    for (const piece of ["D-7 (plan-approval): Approve the plan", "default A", "where it stood: Spec is up", "background: Calls carry 300k", "A Approve (phase 1 ships) → Ship phase 1 today; B Wait (burn continues)", "merge #12", "bg1 · local_bash: npm test", "loom:w1 · Worker · worker · running", "branch b"]) expect(full).toContain(piece);
  });

  it("bounds the header, so a very long title leaves the sections their room", () => {
    const text = renderCarry({ thread: { id: "t", title: "T".repeat(100_000), role: "worker", parent: null, cwd: "/w", branch: null, repo: null }, children: [], waits: [{ id: "w1", text: "waiting", note: "", expires_at: 0 }], briefs: [], ask: null, tasks: [], owner: [{ text: "keep me", at: 0 }], now: 0 });
    expect(text).toContain("w1: waiting");
    expect(text).toContain("keep me");
  });

  it("stays a bounded block however long the inputs are", () => {
    const long = "x".repeat(50_000);
    const text = renderCarry({ thread: { id: "t", title: null, role: "worker", parent: "loom:p", cwd: "/w", branch: null, repo: null }, children: [], waits: Array.from({ length: 200 }, (_, i) => ({ id: `w${i}`, text: long, note: long, expires_at: 0 })), briefs: [], ask: null, tasks: [], owner: [{ text: long, at: 0 }], now: 0 });
    expect(text.length).toBeLessThanOrEqual(24_000);
    // A long section never pushes a later one out: the owner's message is still there, and the waits say how many more.
    expect(text).toContain("## The owner's latest messages, verbatim");
    expect(text).toMatch(/…and \d+ more/);
  });
});
