import { afterEach, describe, expect, it, vi } from "vitest";
import { approvedWork, mergeReady, prAsset, readMergeFacts, type MergeFacts } from "../src/merge-facts.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";
const ready = (): MergeFacts => ({ head: "head", observedAt: Date.now(), open: true, green: true, threadsResolved: true, approvalsSatisfied: true });
const asset = { kind: "pr", title: "Change", url: "https://github.com/example/project/pull/42" };
const hosts: LoomHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.closeAll(); });
async function setup(read = vi.fn(async (): Promise<MergeFacts | null> => ready())) {
  const store = new LoomStore(":memory:"), runtime = new FakeRuntime();
  const host = new LoomHost(store, { fake: runtime }, { readMergeFacts: read, memories: () => [] }); hosts.push(host);
  const { threadId } = await host.execute({ type: "submit", commandId: "start", text: "Build the approved feature", cwd: "/repo", provider: "fake" });
  await new Promise(r => setTimeout(r, 5));
  const buildInstruction = store.messages(threadId!).find(m => m.role === "user")!.id;
  return { host, store, runtime, threadId: threadId!, buildInstruction, read };
}
const brief = { requestedAction: "merge", about: "Project change", class: "plan-approval", ask: "Merge the project change?", door: "two-way", blast: "private", standing: "The change is built.", background: "The feature was requested.", options: [{ key: "A", label: "Merge", consequence: "Ship it", recommended: true }, { key: "B", label: "Wait", consequence: "Delay it" }], proposedRule: "Next time, for project changes, merge without asking" };

describe("recorded merge facts", () => {
  it("only takes PR references from typed assets", () => {
    expect(prAsset(asset)).toEqual({ repo: "example/project", number: 42 });
    for (const a of [{ ...asset, kind: "doc" }, { ...asset, url: "https://elsewhere.test/example/project/pull/42" }, { ...asset, url: "merge PR #42" }]) expect(prAsset(a)).toBeNull();
  });
  it("requires every fact and a fresh observation", () => {
    expect(mergeReady(ready(), Date.now())).toBe(true);
    for (const key of ["green", "threadsResolved", "approvalsSatisfied", "open"]) expect(mergeReady({ ...ready(), [key]: false }, Date.now())).toBe(false);
    expect(mergeReady({ ...ready(), observedAt: Date.now() - 31_000 }, Date.now())).toBe(false);
    expect(mergeReady(null, Date.now())).toBe(false);
  });
  it("refuses both typed owner handoffs and briefs before creating owner work", async () => {
    const { host, threadId, buildInstruction, store } = await setup();
    await expect(host.execute({ type: "handoff.record", commandId: "h", threadId, kind: "human", who: "owner", text: "Anything at all", requestedAction: "merge", assets: [asset], buildInstruction })).rejects.toThrow("PR #42 meets merge-when-green on recorded facts");
    await expect(host.execute({ type: "decision.request", commandId: "d", threadId, brief: { ...brief, assets: [asset], buildInstruction } })).rejects.toThrow("merge it and log with decision_log");
    expect(store.openDecisions(threadId)).toHaveLength(0);
    expect(store.db.prepare("SELECT * FROM turn_handoffs").all()).toHaveLength(0);
  });
  it("shares concurrent retries while the facts are being fetched", async () => {
    const { host, threadId, buildInstruction, read } = await setup(vi.fn(async () => null));
    const command = { type: "decision.request" as const, commandId: "retry", threadId, brief: { ...brief, assets: [asset], buildInstruction } };
    const [a, b] = await Promise.all([host.execute(command), host.execute(command)]);
    expect(a.decisionId).toBe(b.decisionId);
    expect(read).toHaveBeenCalledOnce();
  });
  it("inherits recorded approval from a worker's lead, even through another worker", async () => {
    const { host, store, threadId: lead } = await setup();
    store.addDecision({ id: "D-1", thread_id: lead, run_id: null, class: "plan-approval", level: 2, candidate: 0, ask: brief.ask, brief: JSON.stringify(brief), supersedes: null });
    store.resolveDecision("D-1", { status: "answered", decided_by: "person", followed_recommendation: 1 });
    const middle = await host.execute({ type: "submit", commandId: "middle", text: "Implement approved work", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${lead}` });
    const worker = await host.execute({ type: "submit", commandId: "worker", text: "Implement a part", cwd: "/repo", provider: "fake", role: "worker", parentThreadId: `loom:${middle.threadId}` });
    await expect(host.execute({ type: "decision.request", commandId: "worker-ask", threadId: worker.threadId!, brief: { ...brief, assets: [asset] } })).rejects.toThrow("meets merge-when-green");
    store.db.prepare("UPDATE decisions SET reversed_at=1 WHERE id='D-1'").run();
    expect(approvedWork(store, worker.threadId!)).toBe(false);
    store.updateThread(lead, { parent_thread_id: `loom:${worker.threadId}` });
    expect(approvedWork(store, worker.threadId!)).toBe(false); // cycles cannot loop forever
  });

  it("passes through a malformed historical PR wait", async () => {
    const { host, store, threadId, buildInstruction, read } = await setup();
    const id = store.tx(() => host.triggers.create(threadId, "pr", { repo: "example/project", number: 42, until: "approved" }, "check"));
    store.db.prepare("UPDATE triggers SET spec=? WHERE id=?").run("{bad", id);
    await host.execute({ type: "decision.request", commandId: "bad-wait", threadId, brief: { ...brief, buildInstruction } });
    expect(read).not.toHaveBeenCalled();
  });
  it("allows unrelated owner decisions and handoffs despite a ready PR", async () => {
    const { host, store, threadId, buildInstruction, read } = await setup();
    store.tx(() => host.triggers.create(threadId, "pr", { repo: "example/project", number: 42, until: "approved" }, "merge"));
    for (const decisionClass of ["design-direction", "ops-shared-prod"]) {
      await host.execute({ type: "decision.request", commandId: decisionClass, threadId, brief: { ...brief, requestedAction: undefined, class: decisionClass, assets: [asset], buildInstruction } });
    }
    await host.execute({ type: "handoff.record", commandId: "unrelated", threadId, kind: "human", who: "owner", text: "Choose the preferred design", assets: [asset], buildInstruction });
    expect(read).not.toHaveBeenCalled();
  });
  it("uses an armed PR wait without reading its note or the ask", async () => {
    const { host, store, threadId, buildInstruction } = await setup();
    store.tx(() => host.triggers.create(threadId, "pr", { repo: "example/project", number: 42, until: "approved" }, "unrelated prose"));
    await expect(host.execute({ type: "decision.request", commandId: "d", threadId, brief: { ...brief, buildInstruction } })).rejects.toThrow("recorded facts");
  });
  it.each([null, { ...ready(), green: false }])("does not substitute a ready waiting PR for an explicit unready PR (%s)", async facts => {
    const read = vi.fn(async ({ number }: { number: number }): Promise<MergeFacts | null> => number === 42 ? ready() : facts);
    const { host, store, threadId, buildInstruction } = await setup(read);
    store.tx(() => host.triggers.create(threadId, "pr", { repo: "example/project", number: 42, until: "approved" }, "merge"));
    const assets = [{ ...asset, url: "https://github.com/example/project/pull/43" }];
    await host.execute({ type: "decision.request", commandId: "other-pr", threadId, brief: { ...brief, assets, buildInstruction } });
    await host.execute({ type: "handoff.record", commandId: "other-pr-handoff", threadId, kind: "human", who: "owner", text: "Review the requested merge", requestedAction: "merge", assets, buildInstruction });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.every(([pr]) => pr.number === 43)).toBe(true);
  });
  it("passes through on unreadable GitHub, missing approval, prose-only PRs and tripwires", async () => {
    const { host, threadId, buildInstruction, read } = await setup(vi.fn(async () => null));
    await host.execute({ type: "decision.request", commandId: "d", threadId, brief: { ...brief, assets: [asset], buildInstruction } });
    expect(read).toHaveBeenCalledOnce();
    read.mockClear();
    await host.execute({ type: "decision.request", commandId: "missing", threadId, brief: { ...brief, assets: [asset] } });
    await host.execute({ type: "decision.request", commandId: "prose", threadId, brief: { ...brief, buildInstruction, background: "PR #42 can merge." } });
    await host.execute({ type: "decision.request", commandId: "tripwire", threadId, brief: { ...brief, assets: [asset], buildInstruction, tripwire: "security-privacy" } });
    expect(read).not.toHaveBeenCalled();
  });
  it("requires an approved recommendation, not merely an answered or reversed brief", async () => {
    const { store, threadId } = await setup();
    store.addDecision({ id: "D-1", thread_id: threadId, run_id: null, class: "plan-approval", level: 2, candidate: 0, ask: brief.ask, brief: JSON.stringify(brief), supersedes: null });
    store.resolveDecision("D-1", { status: "answered", decided_by: "person", followed_recommendation: 0 });
    expect(approvedWork(store, threadId)).toBe(false);
    store.resolveDecision("D-1", { status: "answered", decided_by: "person", followed_recommendation: 1 });
    expect(approvedWork(store, threadId)).toBe(true);
    store.db.prepare("UPDATE decisions SET reversed_at=1 WHERE id='D-1'").run();
    expect(approvedWork(store, threadId)).toBe(false);
  });
  it("reads CI on the head and both protection sources, never interprets review text", async () => {
    const p = { state: "OPEN", isDraft: false, headRefOid: "head", baseRefName: "main", reviewDecision: null, baseRef: { branchProtectionRule: null }, commits: { nodes: [{ commit: { oid: "head", statusCheckRollup: { state: "SUCCESS" } } }] }, reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false } } };
    let rules: unknown[] = [];
    const command = vi.fn(async (_file: string, args: string[]) => JSON.stringify(args[1] === "graphql" ? { data: { repository: { pullRequest: p } } } : args[1]?.includes("/rules/") ? rules : { protected: rules.length > 0 }));
    expect(mergeReady(await readMergeFacts({ repo: "example/project", number: 42 }, command), Date.now())).toBe(true);
    rules = [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }];
    expect((await readMergeFacts({ repo: "example/project", number: 42 }, command))?.approvalsSatisfied).toBe(false);
    p.reviewThreads.pageInfo.hasNextPage = true;
    expect(await readMergeFacts({ repo: "example/project", number: 42 }, command)).toBeNull();
    expect(await readMergeFacts({ repo: "example/project", number: 42 }, vi.fn(async () => { throw new Error("offline"); }))).toBeNull();
  });
});
