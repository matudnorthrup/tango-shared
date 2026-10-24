import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LoomHost } from "../src/host.js";
import { createLoomServer } from "../src/http.js";
import { generalizeRule, heldOpen, parseProposedRule, Rules, similarOption, similarScope } from "../src/rules.js";
import { lintBrief, loadBoard, scopeCovers } from "../src/decisions.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

// The learning loop (docs/specs/decisions-and-delegation.md, phase 3): the owner's rulings become standing rules,
// reversals suspend them and demote classes, unused rules retire, and the profile's rules file mirrors it all.

const DAY = 86_400_000;
const flush = () => new Promise((r) => setTimeout(r, 0));

const FILE = [
  "# Standing decision rules", "", "Private preamble the owner wrote.", "", "Format:", "## R-<n> · <class> · active|suspended", "- Scope: <the situation>", "", "---", "",
  "## R-1 · policy · active", "- Scope: level 3 defaults", "- Do: run them after the veto window", "- From: the design thread, 2026-10-18", "",
  "## R-2 · policy · active", "- Scope: promotion", "- Do: promote on the first approval", "",
  "## R-3 · product-choice-in-scope · active", "- Scope: small display additions to a desk card", "- Do: put them on the card only", "- Guard: the card already exists", "- Why: rows stay one line", "- From: D-5, 2026-10-19", "",
].join("\n");

function setup(file: string | null = FILE) {
  const store = new LoomStore(":memory:");
  let now = 100 * DAY;
  store.now = () => now;
  const runtime = new FakeRuntime();
  const rulesFile = join(mkdtempSync(join(tmpdir(), "loom-rules-")), "rules.md");
  if (file !== null) writeFileSync(rulesFile, file);
  const host = new LoomHost(store, { fake: runtime }, { rulesFile });
  // A read covers up to the millisecond before it (a same-millisecond write comes in the next one): reads step the clock.
  const read = host.decided.bind(host);
  host.decided = (since: number, limit?: number) => { now += 1; return read(since, limit); };
  const thread = async () => (await host.execute({ type: "submit", commandId: `s-${Math.random()}`, text: "go", cwd: "/repo", provider: "fake" })).threadId!;
  const mirror = async () => { await flush(); return readFileSync(rulesFile, "utf8"); };
  return { store, runtime, host, rulesFile, thread, mirror, advance: (ms: number) => { now += ms; } };
}
const cmd = () => `c-${Math.random()}`;
const brief = (over: Record<string, unknown> = {}) => ({
  default: "A", class: "product-choice-in-scope", ask: "Label the countdown in active time? Recommend: yes.", door: "two-way", blast: "private",
  about: "Desk countdown", standing: "Countdowns run.", background: "D-1 set the window in active time.", proposedRule: "Next time, for desk timer copy, use active time without asking",
  options: [{ key: "A", label: "Active time", consequence: "Honest", recommended: true }, { key: "B", label: "Clock", consequence: "Wrong when idle" }],
  ...over,
});
const log = (threadId: string, over: Record<string, unknown> = {}) => ({ type: "decision.log" as const, commandId: cmd(), threadId, class: "merge-when-green", summary: "Merged #12 once CI was green", undo: "Revert the merge", ...over });

describe("the rules table and its mirror", () => {
  it("imports the profile's rules once, keeping their ids, and writes the file back as the table's mirror", async () => {
    const { host, store, mirror, thread } = setup();
    expect(host.rules.all().map((r) => [r.id, r.class, r.state, r.scope])).toEqual([
      ["R-1", "policy", "active", "level 3 defaults"], ["R-2", "policy", "active", "promotion"], ["R-3", "product-choice-in-scope", "active", "small display additions to a desk card"],
    ]);
    expect(host.rules.rule("R-3")).toMatchObject({ action: "put them on the card only", guard: "the card already exists", reason: "rows stay one line", origin: "D-5, 2026-10-19", level: 4 });
    const text = await mirror();
    expect(text).toMatch(/^<!-- Loom keeps this file/);
    expect(text).toContain("Private preamble the owner wrote.");
    // The format template in the preamble (an "## R-<n>" line that is no rule) is kept, not cut.
    expect(text).toContain("Format:\n## R-<n> · <class> · active|suspended\n- Scope: <the situation>");
    expect(text).toContain("## R-3 · product-choice-in-scope · active\n- Scope: small display additions to a desk card\n- Do: put them on the card only\n- Level: 4\n- Guard: the card already exists\n- Why: rows stay one line\n- From: D-5, 2026-10-19");
    // A second host on the same store doesn't import twice; decision_check reads the table.
    const again = new LoomHost(store, { fake: new FakeRuntime() });
    expect(again.rules.all()).toHaveLength(3);
    const check = host.decisionCheck(await thread(), "product-choice-in-scope") as { rules: { id: string }[] };
    expect(check.rules.map((r) => r.id)).toEqual(["R-1", "R-2", "R-3"]);
  });

  it("picks up a rule appended off Loom and a suspension marked there, and never revives one from the file", async () => {
    const { host, rulesFile, mirror, thread } = setup();
    await mirror();
    appendFileSync(rulesFile, "\n## R-4 · pr-housekeeping · active\n- Scope: draft PRs\n- Do: close superseded drafts\n");
    writeFileSync(rulesFile, readFileSync(rulesFile, "utf8").replace("## R-3 · product-choice-in-scope · active", "## R-3 · product-choice-in-scope · suspended"));
    // Any change makes Loom write the file, reading what was added first.
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    const text = await mirror();
    expect(host.rules.rule("R-4")).toMatchObject({ class: "pr-housekeeping", scope: "draft PRs" });
    // Appended after the first import, it is news: a rule-created line. The first import's rules weren't.
    expect(host.rules.events(0).filter((e) => e.kind === "rule-created").map((e) => e.rule_id).sort()).toEqual(["R-4", "R-5"]);
    expect(host.rules.rule("R-3")!.state).toBe("suspended");
    expect(host.rules.rule("R-5")).toMatchObject({ scope: "desk timer copy", action: "use active time" });
    expect(text).toContain("## R-4 · pr-housekeeping · active");
    expect(text).toContain("## R-5 · product-choice-in-scope · active");
    writeFileSync(rulesFile, readFileSync(rulesFile, "utf8").replace("## R-3 · product-choice-in-scope · suspended", "## R-3 · product-choice-in-scope · active"));
    host.rules.changed();
    expect(await mirror()).toContain("## R-3 · product-choice-in-scope · suspended");
  });

  it("started with no rules, the first one appended to the file later is announced", async () => {
    const { host, rulesFile, mirror } = setup(null);
    expect(host.rules.all()).toEqual([]);
    writeFileSync(rulesFile, "## R-1 · pr-housekeeping · active\n- Scope: draft PRs\n- Do: close superseded drafts\n");
    host.store.tx(() => host.rules.importFile());
    await mirror();
    expect(host.rules.events(0).map((e) => [e.kind, e.rule_id])).toEqual([["rule-created", "R-1"]]);
  });

  it("a rule appended while Loom rewrites the file isn't written over: the rewrite starts again and takes it in", () => {
    const store = new LoomStore(":memory:");
    const file = join(mkdtempSync(join(tmpdir(), "loom-rules-")), "rules.md");
    writeFileSync(file, FILE);
    let appended = false;
    const rules = new Rules(store, { file, board: () => loadBoard(), beforeReplace: () => {
      if (appended) return;
      appended = true;
      appendFileSync(file, "\n## R-4 · pr-housekeeping · active\n- Scope: draft PRs\n- Do: close superseded drafts\n");
    } });
    store.tx(() => rules.importFile());
    rules.writeMirror();
    expect(rules.rule("R-4")).toMatchObject({ scope: "draft PRs" });
    expect(readFileSync(file, "utf8")).toContain("## R-4 · pr-housekeeping · active");
  });

  it("an appended rule that took the id Loom just used comes in under a fresh id, not dropped", async () => {
    const { host, rulesFile, thread, mirror } = setup();
    const t = await thread();
    await mirror();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    // Off Loom, an agent picks R-4 from the file it read before Loom made its own R-4.
    const stale = readFileSync(rulesFile, "utf8");
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    await mirror();
    appendFileSync(rulesFile, "\n## R-4 · pr-housekeeping · active\n- Scope: draft PRs\n- Do: close superseded drafts\n");
    expect(stale).not.toContain("## R-4");
    host.store.tx(() => host.rules.importFile());
    const text = await mirror();
    expect(host.rules.rule("R-4")).toMatchObject({ scope: "desk timer copy" });
    expect(host.rules.rule("R-5")).toMatchObject({ class: "pr-housekeeping", scope: "draft PRs" });
    expect(text).toContain("## R-5 · pr-housekeeping · active");
    // Read again, the file has nothing new: no third copy.
    host.store.tx(() => host.rules.importFile());
    expect(host.rules.all().filter((r) => r.scope === "draft PRs")).toHaveLength(1);
  });

  it("an answer with an unknown rule choice is refused and the brief stays open", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await expect(host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "oncee" as never })).rejects.toMatchObject({ code: "invalid" });
    expect(store.decision("D-4")!.status).toBe("open");
  });

  it("an append that recreates the file after Loom moved it aside is taken in, never written over", () => {
    const store = new LoomStore(":memory:");
    const file = join(mkdtempSync(join(tmpdir(), "loom-rules-")), "rules.md");
    writeFileSync(file, FILE);
    let once = false;
    const rules = new Rules(store, { file, board: () => loadBoard(), afterMove: () => {
      if (once) return;
      once = true;
      // The file is gone for a moment: the agent's append creates it again with only its own section.
      appendFileSync(file, "## R-4 · pr-housekeeping · active\n- Scope: draft PRs\n- Do: close superseded drafts\n");
    } });
    store.tx(() => rules.importFile());
    rules.writeMirror();
    expect(rules.rule("R-4")).toMatchObject({ scope: "draft PRs" });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("## R-3 · product-choice-in-scope · active");
    expect(text).toContain("## R-4 · pr-housekeeping · active");
    expect(text).toContain("Private preamble the owner wrote.");
    // The retry moved the recreated file to a copy of its own: the first copy wasn't replaced.
    expect(readdirSync(dirname(file)).filter((n) => n.startsWith("rules.md.prev-"))).toHaveLength(2);
  });

  it("a moved copy is kept until it has gone a minute unchanged, and what a late writer appends to it comes in", () => {
    const store = new LoomStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "loom-rules-"));
    const file = join(dir, "rules.md");
    writeFileSync(file, FILE);
    const rules = new Rules(store, { file, board: () => loadBoard() });
    store.tx(() => rules.importFile());
    rules.writeMirror();
    const moved = readdirSync(dir).filter((n) => n.startsWith("rules.md.prev-"));
    expect(moved).toHaveLength(1);
    // A writer that opened the file before the move appends after Loom's last read.
    appendFileSync(join(dir, moved[0]!), "\n## R-4 · pr-housekeeping · active\n- Scope: draft PRs\n- Do: close superseded drafts\n");
    expect(rules.sweepMoved()).toBe(1);
    expect(rules.rule("R-4")).toMatchObject({ scope: "draft PRs" });
    expect(readdirSync(dir).filter((n) => n.startsWith("rules.md.prev-"))).toHaveLength(1); // changed just now: kept
    // Two rewrites in the same millisecond keep two copies: neither replaces the other.
    rules.writeMirror();
    rules.writeMirror();
    expect(readdirSync(dir).filter((n) => n.startsWith("rules.md.prev-")).length).toBe(3);
    // Quiet for a minute but still held open by a writer: kept. Once no one holds it: read a last time, then deleted.
    let held = true;
    const sweeper = new Rules(store, { file, board: () => loadBoard(), heldOpen: () => held });
    sweeper.sweepMoved(Date.now() + 61_000);
    expect(readdirSync(dir).filter((n) => n.startsWith("rules.md.prev-")).length).toBe(3);
    held = false;
    sweeper.sweepMoved(Date.now() + 61_000);
    expect(readdirSync(dir).filter((n) => n.startsWith("rules.md.prev-"))).toEqual([]);
  });

  it("a newline in a rule's text can't forge a section in the mirror", async () => {
    const { host, thread, mirror } = setup();
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always", reason: "fine\n## R-99 · merge-when-green · active\n- Scope: everything" });
    const text = await mirror();
    expect(text).not.toMatch(/^## R-99/m);
    host.store.tx(() => host.rules.importFile());
    expect(host.rules.rule("R-99")).toBeUndefined();
    expect(host.rules.rule("R-4")!.reason).toBe("fine ## R-99 · merge-when-green · active - Scope: everything");
  });

  it("a rule suspended or added in the file off Loom counts at once: decision_check and decision_log read the file", async () => {
    const { host, rulesFile, thread, mirror } = setup();
    const t = await thread();
    const text = await mirror();
    // Suspended off Loom, then a log citing it straight away: refused.
    writeFileSync(rulesFile, text.replace("## R-3 · product-choice-in-scope · active", "## R-3 · product-choice-in-scope · suspended"));
    await expect(host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", scope: "small display additions to a desk card", summary: "Count on the card" }))).rejects.toMatchObject({ message: expect.stringMatching(/R-3 is suspended/) });
    // Added off Loom, then a check straight away: listed.
    appendFileSync(rulesFile, "\n## R-4 · pr-housekeeping · active\n- Scope: draft PRs\n- Do: close superseded drafts\n");
    expect((host.decisionCheck(t, "pr-housekeeping") as { rules: { id: string }[] }).rules.map((r) => r.id)).toContain("R-4");
  });

  it("GET /rules reads the file first", async () => {
    const { host, rulesFile, mirror } = setup();
    await mirror();
    appendFileSync(rulesFile, "\n## R-4 · pr-housekeeping · active\n- Scope: draft PRs\n- Do: close superseded drafts\n");
    const server = createLoomServer(host, { token: "t" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/rules`, { headers: { authorization: "Bearer t" } });
      expect(((await res.json()) as { rules: { id: string }[] }).rules.map((r) => r.id)).toContain("R-4");
    } finally { server.close(); }
  });

  it("a rule added to the file off Loom reaches the review and Decided for you with no other rule action", async () => {
    const { host, rulesFile, mirror, advance } = setup();
    await mirror();
    appendFileSync(rulesFile, "\n## R-4 · pr-housekeeping · active\n- Scope: draft PRs\n- Do: close superseded drafts\n");
    // The read imports it now; the next read (a millisecond on: reads end the millisecond before) lists it.
    expect(host.review(0).created).toEqual([]);
    advance(1);
    expect(host.review(0).created.map((e) => e.rule)).toEqual(["R-4"]);
    appendFileSync(rulesFile, "\n## R-5 · pr-housekeeping · active\n- Scope: labels\n- Do: add the area label\n");
    host.decided(0); // takes it in
    advance(1);
    // A rule is the owner's, not something decided for them: in the review, never in Decided for you.
    expect(host.decided(0).rules.map((e) => e.rule)).not.toContain("R-5");
    expect(host.review(0).created.map((e) => e.rule)).toContain("R-5");
  });

  it("asks the OS whether a moved copy is still held open, and never says 'free' for an open one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "loom-rules-")), "held");
    writeFileSync(path, "x");
    const fd = openSync(path, "a");
    // true where lsof answers; null where it can't (some sandboxes): never false while a writer holds it.
    try { expect(heldOpen(path)).not.toBe(false); } finally { closeSync(fd); }
  });

  it("a moved copy lsof can't vouch for is kept a day, then let go", () => {
    const store = new LoomStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "loom-rules-"));
    const file = join(dir, "rules.md");
    writeFileSync(file, FILE);
    const rules = new Rules(store, { file, board: () => loadBoard(), heldOpen: () => null });
    store.tx(() => rules.importFile());
    rules.writeMirror();
    rules.sweepMoved(Date.now() + 2 * 60_000);
    expect(readdirSync(dir).filter((n) => n.startsWith("rules.md.prev-"))).toHaveLength(1);
    rules.sweepMoved(Date.now() + 25 * 60 * 60_000);
    expect(readdirSync(dir).filter((n) => n.startsWith("rules.md.prev-"))).toEqual([]);
  });

  it("without a rules file, keeps rules in the table only", async () => {
    const store = new LoomStore(":memory:");
    const host = new LoomHost(store, { fake: new FakeRuntime() });
    expect(host.rules.all()).toEqual([]);
  });

  it("reads a proposed rule's scope and what to do", () => {
    expect(parseProposedRule("Next time, for desk timer copy, use active time without asking")).toEqual({ scope: "desk timer copy", action: "use active time" });
    expect(parseProposedRule("Next time for label copy, do sentence case.")).toEqual({ scope: "label copy", action: "sentence case" });
    // A scope may hold commas: ", do" is the delimiter when it is there.
    expect(parseProposedRule("Next time, for PRs with green CI, resolved threads, do merge without asking")).toEqual({ scope: "PRs with green CI, resolved threads", action: "merge" });
    // A newline anywhere reads the same as a space, for every caller.
    expect(parseProposedRule("Next time, for desk timer\ncopy,\ndo use active time")).toEqual({ scope: "desk timer copy", action: "use active time" });
    expect(parseProposedRule("Always sentence case")).toEqual({ scope: "Always sentence case", action: "Always sentence case" });
  });
});

describe("promotion (D-2)", () => {
  it("the first unchanged approval of a candidate makes its rule at level 4, with the owner's reason", async () => {
    const { host, store, thread, mirror } = setup(null);
    const t = await thread();
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() })).toMatchObject({ candidate: true });
    const answered = await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always", reason: "Idle time isn't mine" });
    expect(answered).toMatchObject({ rule: "R-1" });
    expect(host.rules.rule("R-1")).toMatchObject({ class: "product-choice-in-scope", scope: "desk timer copy", action: "use active time", level: 4, reason: "Idle time isn't mine", source: '["D-4"]', state: "active" });
    expect(store.decision("D-4")).toMatchObject({ rule_choice: "always", rule_id: "R-1" });
    expect(store.messages(t).at(-1)!.text).toContain('That is now standing rule R-1: for desk timer copy, use active time.');
    // The owner's own rule isn't "decided for you": Decided for you leaves it out; the weekly review lists it.
    expect(host.decided(0).rules).toEqual([]);
    expect(host.review(0, store.now() + 1).created).toMatchObject([{ rule: "R-1", decision: "D-4" }]);
    // No file was given: nothing is written.
    await mirror().catch(() => null);
    // The same scope again is the rule's to decide: the brief is refused, naming it.
    await expect(host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ ask: "Countdown copy again? Recommend: active." }) })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/R-1 already covers "desk timer copy".*rule: "R-1"/) });
  });

  it("the decision page reads back its saved rule and subsequent withdrawal", async () => {
    const { host, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    expect(host.decisionDetail("D-4")?.rule).toBeNull();
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect(host.decisionDetail("D-4")?.rule).toMatchObject({ id: "R-1", state: "active", scope: "desk timer copy", do: "use active time" });
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "next-time" });
    expect(host.decisionDetail("D-4")).toMatchObject({ rule_choice: "next-time", rule: { id: "R-1", state: "retired" } });
  });

  it("D-61: a first approval is a precedent; a second similar one proposes one rule, confirmed with one tap", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    // First approval, as recommended, no chip touched: "Just this once", kept as a precedent.
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A" });
    expect(store.decision("D-4")).toMatchObject({ rule_choice: "once", precedent: 1, rule_id: null });
    expect(host.rules.all()).toEqual([]);
    expect(store.messages(t).at(-1)!.text).toContain("it's a precedent, not a rule");
    // decision_check lists it, so agents can cite it.
    expect((host.decisionCheck(t, "product-choice-in-scope") as { precedents: { id: string }[] }).precedents.map((p) => p.id)).toEqual(["D-4"]);
    // Ask me next time doesn't count as one.
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ proposedRule: "Next time, for button copy, use verbs" }) });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A", rule: "next-time" });
    expect(store.decision("D-5")!.precedent).toBe(0);
    // A second similar call: the brief knows its precedent, and approving it the same way proposes a rule.
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ ask: "Label the badge timer in active time? Recommend: yes.", proposedRule: "Next time, for desk timer copy on badges, use active time without asking" }) })).toMatchObject({ decisionId: "D-6", precedent: "D-4" });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-6", option: "A" });
    expect(host.rules.all()).toEqual([]);
    const proposal = JSON.parse(store.decision("D-6")!.proposal!);
    expect(proposal).toMatchObject({ from: ["D-4", "D-6"], state: "proposed", scope: "desk timer copy", action: "use active time", written: "plain" });
    expect(store.messages(t).at(-1)!.text).toContain("Loom proposes a standing rule for me to confirm: Next time, for desk timer copy, use active time without asking");
    // One tap, with the text the owner saw (without it, a pending proposal can't be confirmed): both decisions behind it.
    await expect(host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-6", rule: "always" })).rejects.toMatchObject({ code: "changed" });
    expect(await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-6", rule: "always", proposal: proposal.text })).toMatchObject({ rule: "R-1", ruleState: "active" });
    expect(host.rules.rule("R-1")).toMatchObject({ scope: "desk timer copy", action: "use active time", source: '["D-4","D-6"]' });
    expect(JSON.parse(store.decision("D-6")!.proposal!).state).toBe("made");
    // The earlier approval backs the rule now: linked, no longer a free precedent.
    expect(store.decision("D-4")).toMatchObject({ rule_id: "R-1", rule_choice: "always", precedent: 0 });
    expect((host.decisionCheck(t, "product-choice-in-scope") as { precedents: { id: string }[] }).precedents.map((p) => p.id)).not.toContain("D-4");
    // A different subject is no match: no proposal.
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ ask: "Put the count on the row? Recommend: yes.", proposedRule: "Next time, for row layout, put counts on the row" }) });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-7", option: "A" });
    expect(store.decision("D-7")!.proposal).toBeNull();
    // Always on a first approval still makes a rule at once.
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ ask: "Badge colors? Recommend: theme.", proposedRule: "Next time, for badge colors, use the theme" }) });
    expect(await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-8", option: "A", rule: "always" })).toMatchObject({ rule: "R-2" });
  });

  it("D-61: a proposal set aside (Not now / Just this once) makes no rule and isn't proposed again", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    for (const id of ["D-4", "D-5"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "A" });
    }
    expect(JSON.parse(store.decision("D-5")!.proposal!).state).toBe("proposed");
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-5", rule: "once" });
    expect(JSON.parse(store.decision("D-5")!.proposal!).state).toBe("dismissed");
    expect(host.rules.all()).toEqual([]);
    // Both are spent on that pair: decision_check doesn't offer them to cite.
    expect((host.decisionCheck(t, "product-choice-in-scope") as { precedents: unknown[] }).precedents).toEqual([]);
    // A third similar call pairs with neither (each pair proposes once)... until a fresh precedent: D-6 alone isn't a pair.
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-6", option: "A" });
    expect(store.decision("D-6")!.proposal).toBeNull();
  });

  it("D-61: an open similar brief is promised a precedent the moment one is made", async () => {
    const { host, store, thread } = setup(null);
    const [a, b] = [await thread(), await thread()];
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: a, brief: brief() });
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: b, brief: brief() })).not.toHaveProperty("precedent");
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A" });
    expect(store.decision("D-5")!.precedent_of).toBe("D-4");
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A" });
    expect(JSON.parse(store.decision("D-5")!.proposal!)).toMatchObject({ from: ["D-4", "D-5"], state: "proposed" });
  });

  it("D-61: the card promises a proposal only when the answer would make one; a rewritten proposal can't be confirmed blind", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A" });
    // A similar brief whose recommendation is a different kind of option: no promise.
    const other = brief({ options: [{ key: "A", label: "Keep the clock", consequence: "Familiar", recommended: true }, { key: "B", label: "Active time", consequence: "Honest" }] });
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: other })).not.toHaveProperty("precedent");
    await host.execute({ type: "decision.close", commandId: cmd(), threadId: t, decisionId: "D-5", outcome: "withdrawn" });
    // A matching one: promised, and the answer proposes.
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() })).toMatchObject({ precedent: "D-4" });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-6", option: "A" });
    // D-4 is used by that proposal now: a later similar brief isn't promised another.
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() })).not.toHaveProperty("precedent");
    // Confirming text the owner didn't see is refused; the text they saw goes through.
    await expect(host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-6", rule: "always", proposal: "Next time, for something older, do it" })).rejects.toMatchObject({ code: "changed" });
    const text = JSON.parse(store.decision("D-6")!.proposal!).text;
    expect(await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-6", rule: "always", proposal: text })).toMatchObject({ rule: "R-1" });
  });

  it("D-61: a proposal can't be confirmed once set aside, or once an answer it leaned on stops counting", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    for (const id of ["D-4", "D-5"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "A" });
    }
    const text = JSON.parse(store.decision("D-5")!.proposal!).text;
    // The earlier answer switched to "Ask me next time": the proposal no longer stands, and confirming it is refused.
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "next-time" });
    expect(JSON.parse(store.decision("D-5")!.proposal!).state).toBe("dismissed");
    await expect(host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-5", rule: "always", proposal: text })).rejects.toMatchObject({ code: "changed", message: expect.stringMatching(/set aside/) });
    expect(host.rules.all()).toEqual([]);
    expect(store.decision("D-4")).toMatchObject({ rule_choice: "next-time", rule_id: null });
  });

  it("D-61: a revised brief's promise follows the revision", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A" });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ proposedRule: "Next time, for button copy, use verbs" }) });
    expect(store.decision("D-5")!.precedent_of).toBeNull();
    await host.execute({ type: "decision.update", commandId: cmd(), threadId: t, decisionId: "D-5", changes: { proposedRule: "Next time, for desk timer copy, use active time" }, why: "Same as the timers" });
    expect(store.decision("D-5")!.precedent_of).toBe("D-4");
    await host.execute({ type: "decision.update", commandId: cmd(), threadId: t, decisionId: "D-5", changes: { proposedRule: "Next time, for button copy, use verbs" }, why: "No, buttons" });
    expect(store.decision("D-5")!.precedent_of).toBeNull();
  });

  it("a brief whose scope a wider rule takes in is refused, naming the rule to act under", async () => {
    const { host, thread } = setup();
    const t = await thread();
    await expect(host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ proposedRule: "Next time, for small display additions to a desk card's footer, put them on the card" }) }))
      .rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/R-3 covers "small display additions to a desk card", which takes in/) });
  });

  it("containment and similarity go by whole words, and opposite options aren't the same call", () => {
    expect(scopeCovers("ads", "badges")).toBe(false);
    expect(scopeCovers("ads", "ads on the desk")).toBe(true);
    // A hyphen joins words: a production rule doesn't take in non-production.
    expect(scopeCovers("production deployments", "non-production deployments")).toBe(false);
    expect(similarScope("production deployments", "non-production deployments")).toBe(false);
    // A negating qualifier makes the opposite case: not covered, not similar.
    expect(scopeCovers("changes with owner approval", "changes without owner approval")).toBe(false);
    expect(scopeCovers("deploys", "deploys not on fridays")).toBe(false);
    expect(scopeCovers("deploy changes", "don't deploy changes")).toBe(false);
    // What a negation negates: a rule against deploying doesn't cover a case that deploys and doesn't notify.
    expect(scopeCovers("do not deploy changes", "deploy changes but do not notify owner")).toBe(false);
    expect(scopeCovers("do not notify owner", "deploy changes but do not notify owner")).toBe(true);
    expect(similarScope("do not deploy changes", "deploy changes but do not notify owner")).toBe(false);
    expect(similarOption("Deploy", "Don’t deploy")).toBe(false);
    expect(generalizeRule("Next time, for app release policy, do ship it without asking", "Next time, for dapp release policy, do ship it without asking").scope).toBe("dapp release policy");
    expect(generalizeRule("Next time, for release policy, do ship it without asking", "Next time, for app release policy, do ship it without asking").scope).toBe("release policy");
    expect(scopeCovers("deploy changes", "can’t deploy changes")).toBe(false);
    expect(scopeCovers("changes that don't need review", "small changes that don’t need review")).toBe(true);
    expect(similarScope("changes with owner approval", "changes without owner approval")).toBe(false);
    expect(scopeCovers("changes with owner approval", "small changes with owner approval")).toBe(true);
    expect(similarScope("ads", "badges")).toBe(false);
    expect(similarOption("Do not deploy", "Deploy")).toBe(false);
    expect(similarOption("Deploy now", "Deploy")).toBe(true);
    expect(similarOption("Active time", "Active time")).toBe(true);
    expect(similarOption("Enable production deploy", "Disable production deploy")).toBe(false);
  });

  it("D-61: a precedent another brief's proposal used is no longer promised to a second open brief", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread(), u = await thread(), v = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A" });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: u, brief: brief() });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: v, brief: brief() });
    expect([store.decision("D-5")!.precedent_of, store.decision("D-6")!.precedent_of]).toEqual(["D-4", "D-4"]);
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A" });
    expect(JSON.parse(store.decision("D-5")!.proposal!).from).toEqual(["D-4", "D-5"]);
    // Both D-4 and D-5 are in that proposal now: no unused precedent is left, so D-6 is promised none.
    expect(store.decision("D-6")!.precedent_of).toBe(null);
  });

  it("D-61: a precedent that stops counting is no longer promised to an open brief", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A" });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: await thread(), brief: brief() });
    expect(store.decision("D-5")!.precedent_of).toBe("D-4");
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "next-time" });
    expect(store.decision("D-5")!.precedent_of).toBeNull();
  });

  it("D-61: an answer switched back to Just this once is offered to an open brief with no precedent", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "next-time" });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: await thread(), brief: brief() });
    expect(store.decision("D-5")!.precedent_of).toBeNull();
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "once" });
    expect(store.decision("D-5")!.precedent_of).toBe("D-4");
  });

  it("D-61: the agent is told an answer is a precedent only when it counts as one", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "B", rule: "once" });
    expect(store.decision("D-4")!.precedent).toBe(0);
    expect(store.messages(t).at(-1)!.text).toContain("Just this once: not a rule, and not a precedent to cite.");
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A" });
    expect(store.decision("D-5")!.precedent).toBe(1);
    expect(store.messages(t).at(-1)!.text).toContain("it's a precedent, not a rule");
  });

  it("an exact rule and a wider one that disagree are one conflict set, and a conflict brief may name them", async () => {
    const extra = "\n## R-4 · product-choice-in-scope · active\n- Scope: desk card\n- Do: keep them plain\n";
    const { host, thread } = setup(FILE + extra);
    const t = await thread();
    // R-3 is exactly this scope, R-4 is wider; they disagree: a conflict, not "act under R-3".
    await expect(host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ proposedRule: "Next time, for small display additions to a desk card, put them on the card" }) }))
      .rejects.toMatchObject({ message: expect.stringMatching(/R-3 and R-4 all take in/) });
    const options = [{ key: "A", label: "Keep R-3", consequence: "On the card", recommended: true, rule: "R-3" }, { key: "B", label: "Keep R-4", consequence: "Plain", rule: "R-4" }];
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", ask: "R-3 or R-4? Recommend: R-3.", proposedRule: "Next time, for small display additions to a desk card, put them on the card", options }) })).toMatchObject({ level: 1 });
  });

  it("settling a conflict also settles a rule that came since and takes in the case another way", async () => {
    const extra = "\n## R-4 · product-choice-in-scope · active\n- Scope: desk card\n- Do: keep them plain\n";
    const { host, thread, rulesFile, mirror } = setup(FILE + extra);
    const t = await thread();
    const options = [{ key: "A", label: "Keep R-3", consequence: "On the card", recommended: true, rule: "R-3" }, { key: "B", label: "Keep R-4", consequence: "Plain", rule: "R-4" }];
    const { decisionId } = await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", ask: "R-3 or R-4? Recommend: R-3.", proposedRule: "Next time, for small display additions to a desk card, put them on the card", options }) }) as { decisionId: string };
    await mirror();
    // Added off Loom while the brief was open: wider still, and it says otherwise than R-3.
    appendFileSync(rulesFile, "\n## R-5 · product-choice-in-scope · active\n- Scope: desk\n- Do: leave the card alone\n");
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId, option: "A" });
    expect(Object.fromEntries(host.rules.all().filter((r) => ["R-3", "R-4", "R-5"].includes(r.id)).map((r) => [r.id, r.state]))).toEqual({ "R-3": "active", "R-4": "superseded", "R-5": "superseded" });
  });

  it("D-61: deleting the thread of a precedent lets go of the brief promised it and the proposal built on it", async () => {
    const { host, store, thread } = setup(null);
    const first = await thread(), second = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: first, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A" });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: second, brief: brief() });
    expect(store.decision("D-5")!.precedent_of).toBe("D-4");
    await host.execute({ type: "delete", commandId: cmd(), threadId: first });
    expect(store.decision("D-4")).toBeFalsy();
    expect(store.decision("D-5")!.precedent_of).toBeNull();
    // Answered after its pair is gone, it is a fresh precedent: no proposal.
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A" });
    expect(store.decision("D-5")!.proposal).toBeNull();
    const third = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: third, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-6", option: "A" });
    expect(JSON.parse(store.decision("D-6")!.proposal!)).toMatchObject({ from: ["D-5", "D-6"], state: "proposed" });
    await host.execute({ type: "delete", commandId: cmd(), threadId: second });
    expect(JSON.parse(store.decision("D-6")!.proposal!).state).toBe("dismissed");
  });

  it("D-61: a proposal's earlier decision switched to Always sets the proposal aside", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    for (const id of ["D-4", "D-5"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "A" });
    }
    expect(JSON.parse(store.decision("D-5")!.proposal!).state).toBe("proposed");
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always" });
    expect(JSON.parse(store.decision("D-5")!.proposal!).state).toBe("dismissed");
    expect(host.rules.all().filter((r) => r.state === "active").map((r) => r.id)).toEqual(["R-1"]);
  });

  it("two differently scoped rules that both take in a case and disagree are a conflict, for briefs and logs", async () => {
    const extra = "\n## R-4 · product-choice-in-scope · active\n- Scope: desk card\n- Do: keep them plain\n";
    const { host, thread } = setup(FILE + extra);
    const t = await thread();
    // "small display additions to a desk card" (R-3) and "desk card" (R-4) both take in this one.
    await expect(host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ proposedRule: "Next time, for small display additions to a desk card on phones, put them on the card" }) }))
      .rejects.toMatchObject({ message: expect.stringMatching(/R-3 and R-4 all take in .* precedent conflict/) });
    await expect(host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", scope: "small display additions to a desk card on phones", summary: "x" })))
      .rejects.toMatchObject({ message: expect.stringMatching(/R-4 also takes in/) });
  });

  it("D-61: a model writes the proposed rule for the pattern when one is configured; the plain one stays otherwise", async () => {
    const store = new LoomStore(":memory:");
    const seen: string[][] = [];
    const host = new LoomHost(store, { fake: new FakeRuntime() }, { ruleWriter: async (briefs) => { seen.push(briefs.map((b) => b.proposedRule)); return "Next time, for timer copy on the desk, use active time without asking"; } });
    const t = (await host.execute({ type: "submit", commandId: cmd(), text: "go", cwd: "/repo", provider: "fake" })).threadId!;
    for (const id of ["D-4", "D-5"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "A" });
    }
    await vi.waitFor(() => expect(JSON.parse(store.decision("D-5")!.proposal!)).toMatchObject({ written: "model", scope: "timer copy on the desk", action: "use active time" }));
    expect(seen).toHaveLength(1);
  });

  it("D-61: an approval taken back from a shared rule and given Always again rejoins that rule", async () => {
    const store = new LoomStore(":memory:");
    const host = new LoomHost(store, { fake: new FakeRuntime() }, { rulesFile: join(mkdtempSync(join(tmpdir(), "loom-rules-")), "rules.md"), ruleWriter: async () => "Next time, for timer copy on the desk, use active time without asking" });
    const t = (await host.execute({ type: "submit", commandId: cmd(), text: "go", cwd: "/repo", provider: "fake" })).threadId!;
    for (const id of ["D-4", "D-5"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "A" });
    }
    await vi.waitFor(() => expect(JSON.parse(store.decision("D-5")!.proposal!)).toMatchObject({ written: "model" }));
    const text = JSON.parse(store.decision("D-5")!.proposal!).text as string;
    const { rule } = await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-5", rule: "always", proposal: text }) as { rule: string };
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "once" });
    expect(host.rules.rule(rule)!.state).toBe("active");
    const back = await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always" }) as { rule: string };
    expect(back.rule).toBe(rule);
    expect(host.rules.all().filter((r) => r.state === "active").map((r) => r.id)).toEqual([rule]);
    expect(JSON.parse(host.rules.rule(rule)!.source)).toEqual(expect.arrayContaining(["D-4", "D-5"]));
  });

  it("D-61: the shared rule is rejoined when the model kept a source's scope but reworded its action", async () => {
    const store = new LoomStore(":memory:");
    const host = new LoomHost(store, { fake: new FakeRuntime() }, { rulesFile: join(mkdtempSync(join(tmpdir(), "loom-rules-")), "rules.md"), ruleWriter: async (briefs) => { const own = parseProposedRule(briefs[0]!.proposedRule); return `Next time, for ${own.scope}, show the active time and say it pauses without asking`; } });
    const t = (await host.execute({ type: "submit", commandId: cmd(), text: "go", cwd: "/repo", provider: "fake" })).threadId!;
    for (const id of ["D-4", "D-5"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "A" });
    }
    await vi.waitFor(() => expect(JSON.parse(store.decision("D-5")!.proposal!)).toMatchObject({ written: "model" }));
    const text = JSON.parse(store.decision("D-5")!.proposal!).text as string;
    const { rule } = await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-5", rule: "always", proposal: text }) as { rule: string };
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "once" });
    expect((await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always" }) as { rule: string }).rule).toBe(rule);
    expect(host.rules.all().filter((r) => r.state === "active").map((r) => r.id)).toEqual([rule]);
  });

  it("D-61: a proposal a wider, disagreeing rule now takes in is refused on confirm, not made into a conflict", async () => {
    const { host, store, thread, rulesFile, mirror } = setup(null);
    const t = await thread();
    for (const id of ["D-4", "D-5"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "A" });
    }
    const proposal = JSON.parse(store.decision("D-5")!.proposal!) as { text: string; scope: string };
    await mirror();
    appendFileSync(rulesFile, `\n## R-9 · product-choice-in-scope · active\n- Scope: ${proposal.scope.split(" ").slice(-2).join(" ")}\n- Do: leave it as it is\n`);
    await expect(host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-5", rule: "always", proposal: proposal.text }))
      .rejects.toMatchObject({ code: "changed", message: expect.stringMatching(/R-9 .* overlaps/) });
    expect(host.rules.all().filter((r) => r.state === "active").map((r) => r.id)).toEqual(["R-9"]);
  });

  it("D-61: a proposal that now takes in a narrower, disagreeing rule is refused on confirm too", async () => {
    const { host, store, thread, rulesFile, mirror } = setup(null);
    const t = await thread();
    for (const id of ["D-4", "D-5"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "A" });
    }
    const proposal = JSON.parse(store.decision("D-5")!.proposal!) as { text: string; scope: string };
    await mirror();
    appendFileSync(rulesFile, `\n## R-9 · product-choice-in-scope · active\n- Scope: ${proposal.scope} on phones\n- Do: leave it as it is\n`);
    await expect(host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-5", rule: "always", proposal: proposal.text }))
      .rejects.toMatchObject({ code: "changed", message: expect.stringMatching(/R-9 .* overlaps/) });
  });

  it("an Always answer makes no rule beside an overlapping one that came since and says otherwise; a later Always tap is refused", async () => {
    const { host, store, thread, rulesFile, mirror } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await mirror();
    appendFileSync(rulesFile, "\n## R-9 · product-choice-in-scope · active\n- Scope: timer copy\n- Do: use clock time\n");
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect(store.decision("D-4")!.rule_id).toBeNull();
    expect(host.rules.all().filter((r) => r.state === "active").map((r) => r.id)).toEqual(["R-9"]);
    await expect(host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always" }))
      .rejects.toMatchObject({ code: "changed", message: expect.stringMatching(/R-9 .* overlaps/) });
  });

  it("another option, or the owner's own words, makes no rule even with Always; a tripwire never does", async () => {
    const { host, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "B", rule: "always" });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A", text: "but say it pauses", rule: "always" });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ class: "spend", tripwire: "money", ask: "Buy the font? Recommend: yes." }) });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-6", option: "A", rule: "always" });
    expect(host.rules.all()).toEqual([]);
  });

  it("an approval answered in chat promotes too, unless the agent records the owner's next-time or once", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    expect(await host.execute({ type: "decision.close", commandId: cmd(), threadId: t, decisionId: "D-4", outcome: "answered-in-chat", option: "A", rule: "always", note: "Owner: yes, active time", reason: "Idle time isn't mine" })).toMatchObject({ rule: "R-1" });
    expect(store.decision("D-4")).toMatchObject({ decided_by: "person-chat", rule_choice: "always", rule_id: "R-1", answer_reason: "Idle time isn't mine" });
    expect(host.rules.rule("R-1")!.reason).toBe("Idle time isn't mine");
    // And it can be changed afterwards, as a desk answer can.
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "next-time" });
    expect(host.rules.rule("R-1")!.state).toBe("retired");
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ proposedRule: "Next time, for button copy, use verbs" }) });
    await host.execute({ type: "decision.close", commandId: cmd(), threadId: t, decisionId: "D-5", outcome: "answered-in-chat", option: "A", rule: "once" });
    // D-61: "Just this once" keeps it as a precedent (it no longer declines the scope).
    expect(store.decision("D-5")).toMatchObject({ rule_choice: "once", rule_id: null, precedent: 1 });
  });

  it("an explicit Always on a brief that recommends nothing makes the rule from the owner's pick; one that can't is not recorded as a rule", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    const options = [{ key: "A", label: "Feature name", consequence: "Plain" }, { key: "B", label: "A pun", consequence: "Fun" }];
    const level1 = brief({ class: "creative-published", ask: "Title the changelog post?", options, proposedRule: "Next time, for changelog titles, use the feature name" });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: level1 });
    expect(await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" })).toMatchObject({ rule: "R-1" });
    // Always with the owner's own words instead: no rule, and the ledger and the turn say so.
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: { ...level1, proposedRule: "Next time, for release titles, use the version" } });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", text: "Something else", rule: "always" });
    expect(store.decision("D-5")).toMatchObject({ rule_choice: null, rule_id: null });
    expect(store.messages(t).at(-1)!.text).toContain("Not a standing rule");
  });

  it("a non-candidate becomes a rule only on an explicit Always", async () => {
    const { host, thread } = setup(null);
    const t = await thread();
    const nonCandidate = brief({ class: "creative-published", ask: "Title the post 'Active time'? Recommend: yes.", proposedRule: "Next time, for changelog titles, use the feature name" });
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: nonCandidate })).toMatchObject({ level: 1, candidate: false });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A" });
    expect(host.rules.all()).toEqual([]);
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: nonCandidate });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A", rule: "always" });
    expect(host.rules.rule("R-1")).toMatchObject({ class: "creative-published", scope: "changelog titles", level: 4 });
  });

  it("after answering, the owner can change how it counts: next time withdraws the rule, Always makes it again", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "once", reason: "one-off copy" });
    expect(host.rules.rule("R-1")).toMatchObject({ state: "retired", state_why: "the owner said just this once" });
    expect(store.decision("D-4")).toMatchObject({ rule_choice: "once", answer_reason: "one-off copy", precedent: 1 });
    // Always again revives the same rule: one decision, one rule.
    expect(await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always" })).toMatchObject({ rule: "R-1", ruleState: "active" });
    expect(host.rules.rule("R-1")).toMatchObject({ state: "active", state_why: null, source: '["D-4"]' });
    expect(host.rules.rule("R-2")).toBeUndefined();
    expect(host.rules.declined("product-choice-in-scope", "desk timer copy")).toBe(false);
    // Once keeps it a precedent; Ask me next time stops it counting.
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "once" });
    expect(store.decision("D-4")!.precedent).toBe(1);
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "next-time" });
    expect(store.decision("D-4")!.precedent).toBe(0);
    // Only a brief the owner answered, and only a rule they approved as it stood.
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ proposedRule: "Next time, for button copy, use verbs" }) });
    await expect(host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-5", rule: "always" })).rejects.toMatchObject({ code: "not_answered" });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "B" });
    await expect(host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-5", rule: "always" })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/recommendation/) });
  });
});

describe("acting under a rule, and demotion", () => {
  it("a log cites the rule that covers a level 3 case; an Undo of it suspends the rule at once", async () => {
    const { host, store, thread, mirror } = setup();
    const t = await thread();
    await expect(host.execute(log(t, { class: "product-choice-in-scope", summary: "Put the count on the card" }))).rejects.toMatchObject({ message: expect.stringMatching(/bring a brief.*or cite the standing rule/) });
    await expect(host.execute(log(t, { class: "merge-when-green", rule: "R-3" }))).rejects.toMatchObject({ message: expect.stringMatching(/R-3 is for product-choice-in-scope/) });
    // A rule covers its scope literally: no scope, or a near miss, is no authority.
    await expect(host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", summary: "x" }))).rejects.toMatchObject({ message: expect.stringMatching(/scope: with rule/) });
    await expect(host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", scope: "a new settings page", summary: "x" }))).rejects.toMatchObject({ message: expect.stringMatching(/R-3 covers "small display additions to a desk card", not "a new settings page"/) });
    await expect(host.execute(log(t, { dissent: "no" }))).rejects.toMatchObject({ message: expect.stringMatching(/dissent: only with the rule/) });
    const logged = await host.execute(log(t, { class: "product-choice-in-scope", summary: "Put the count on the card", rule: "R-3", scope: "Small display additions  to a desk card", dissent: "rows have room" }));
    expect(logged).toMatchObject({ decisionId: "D-4", level: 4, rule: "R-3" });
    expect(store.decision("D-4")).toMatchObject({ status: "acted", decided_by: "rule:R-3", rule_id: "R-3", dissent: "rows have room" });
    expect(host.rules.rule("R-3")!.last_used_at).toBe(store.now());

    const undone = await host.execute({ type: "decision.reverse", commandId: cmd(), decisionId: "D-4", undo: true, note: "rows need it" });
    expect(undone).toMatchObject({ suspended: "R-3", demoted: null });
    expect(host.rules.rule("R-3")).toMatchObject({ state: "suspended", state_why: "Undo on D-4: rows need it" });
    expect(store.messages(t).at(-1)!.text).toContain("Standing rule R-3 is suspended: the next case like this asks again.");
    expect(await mirror()).toContain("## R-3 · product-choice-in-scope · suspended");
    await expect(host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", scope: "small display additions to a desk card" }))).rejects.toMatchObject({ message: expect.stringMatching(/R-3 is suspended/) });
    expect(host.decided(0).rules.map((e) => e.kind)).toEqual(["rule-suspended"]);
  });

  it("two reversals in 30 days drop the class a level, with an FYI; a clean 30 days restores it", async () => {
    const { host, thread, advance } = setup(null);
    const t = await thread();
    await host.execute(log(t));
    await host.execute(log(t));
    await host.execute({ type: "decision.reverse", commandId: cmd(), decisionId: "D-4", undo: false });
    expect(host.decisionCheck(t, "merge-when-green")).toMatchObject({ level: 4 });
    advance(DAY);
    expect(await host.execute({ type: "decision.reverse", commandId: cmd(), decisionId: "D-5", undo: false, note: "wait for review" })).toMatchObject({ demoted: { from: 4, to: 3 } });
    expect(host.decisionCheck(t, "merge-when-green")).toMatchObject({ level: 3, demoted: { level: 3, board_level: 4, why: "2 reversals in 30 days" } });
    expect(host.decided(0).rules).toMatchObject([{ kind: "class-demoted", class: "merge-when-green", from_level: 4, to_level: 3 }]);
    // Now it's a level 3 class: no log, a brief with a default.
    await expect(host.execute(log(t))).rejects.toMatchObject({ message: expect.stringMatching(/level 3/) });
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ class: "merge-when-green", ask: "Merge #13 now? Recommend: yes.", proposedRule: "Next time, for docs PRs, merge when green" }) })).toMatchObject({ level: 3 });

    advance(29 * DAY);
    host.rules.tick();
    expect(host.rules.classLevel("merge-when-green")).toBeDefined();
    advance(2 * DAY);
    expect(host.rules.tick()).toMatchObject({ restored: ["merge-when-green"] });
    expect(host.decisionCheck(t, "merge-when-green")).toMatchObject({ level: 4 });
    expect(host.rules.classLevel("merge-when-green")).toBeUndefined();
  });

  it("a demotion lowers the class's open briefs too, so a level 3 default no longer runs", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread(), u = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: u, brief: brief({ proposedRule: "Next time, for button copy, use verbs" }) });
    expect(store.decision("D-4")!.level).toBe(3);
    for (const id of ["D-5", "D-6"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "B" });
    }
    expect(host.decisionCheck(t, "product-choice-in-scope")).toMatchObject({ level: 2 });
    expect(store.decision("D-4")).toMatchObject({ status: "open", level: 2 });
    expect(host.snapshot().threads.find((x) => x.id === u)!.decision).toMatchObject({ id: "D-4", level: 2, veto: null, candidate: 1 });
  });

  it("a brief demoted to level 1 is no longer a candidate: approving it makes no rule unless the owner says Always", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread(), u = await thread();
    const plan = (rule: string) => brief({ class: "plan-approval", ask: "Ship as planned? Recommend: yes.", proposedRule: rule });
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: u, brief: plan("Next time, for phase plans, go ahead") })).toMatchObject({ level: 2, candidate: true });
    // Two reversals in the class drop plan-approval from level 2 to 1 while D-4 is still open.
    for (const id of ["D-5", "D-6"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: plan(`Next time, for plan ${id}, go ahead`) });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "A", rule: "once" });
    }
    host.store.tx(() => { for (const id of ["D-5", "D-6"]) { host.store.reverseDecision(id, { reversal: "disagree", reversal_note: null }); host.rules.reversed({ id, class: "plan-approval", rule_id: null }, "test"); } });
    expect(host.decisionCheck(t, "plan-approval")).toMatchObject({ level: 1 });
    expect(store.decision("D-4")).toMatchObject({ level: 1, candidate: 0 });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A" });
    expect(store.decision("D-4")!.rule_choice).toBeNull();
    expect(host.rules.all()).toEqual([]);
  });

  it("reversals in the same millisecond as a demotion still count: four at once drop the class twice", async () => {
    const { host, thread } = setup(null);
    const t = await thread();
    for (let i = 0; i < 4; i++) await host.execute(log(t, { summary: `Merged #${i}` }));
    for (const id of ["D-4", "D-5", "D-6", "D-7"]) await host.execute({ type: "decision.reverse", commandId: cmd(), decisionId: id, undo: false });
    expect(host.decisionCheck(t, "merge-when-green")).toMatchObject({ level: 2 });
    expect(host.rules.reversals("merge-when-green")).toBe(0);
  });

  it("an answer that overrides a level 3 default counts as a reversal", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    for (const id of ["D-4", "D-5"]) {
      await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
      await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: id, option: "B" });
    }
    expect(store.decision("D-4")).toMatchObject({ reversal: "override" });
    expect(host.decisionCheck(t, "product-choice-in-scope")).toMatchObject({ level: 2 });
  });

  it("so does an answer in the owner's own words instead of the default, on the desk or in chat", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", text: "Neither: hide the countdown" });
    expect(store.decision("D-4")).toMatchObject({ reversal: "override", reversal_note: "Neither: hide the countdown" });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.close", commandId: cmd(), threadId: t, decisionId: "D-5", outcome: "answered-in-chat", note: "Owner said: no countdown at all" });
    expect(store.decision("D-5")).toMatchObject({ reversal: "override" });
    expect(host.decisionCheck(t, "product-choice-in-scope")).toMatchObject({ level: 2 });
  });
});

describe("D-61 changes", () => {
  it("a logged case inside a rule's scope (the same, or narrower and containing it) is covered; a different subject isn't", async () => {
    const { host, thread } = setup();
    const t = await thread();
    const at = (scope: string) => host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", scope, summary: `Under R-3: ${scope}` }));
    await expect(at("small display additions to a desk card: carrying out D-61")).resolves.toMatchObject({ rule: "R-3" });
    await expect(at("small display additions (a count) to a desk card")).resolves.toMatchObject({ rule: "R-3" });
    await expect(at("a new settings page")).rejects.toMatchObject({ message: expect.stringMatching(/R-3 covers .* A near miss asks/) });
    await expect(at("small display additions")).rejects.toMatchObject({ message: expect.stringMatching(/near miss/) });
  });

  it("rules.keepAsPrecedents turns the named rules back into precedents; others stay", async () => {
    const { host, store, thread } = setup();
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect(host.rules.rule("R-4")!.state).toBe("active");
    expect(await host.execute({ type: "rules.keepAsPrecedents", commandId: cmd(), ruleIds: ["R-4", "R-99"] })).toMatchObject({ kept: ["R-4"] });
    expect(host.rules.rule("R-4")).toMatchObject({ state: "retired", state_why: "D-61: kept as a precedent" });
    expect(store.decision("D-4")).toMatchObject({ precedent: 1, rule_choice: "once" });
    expect(host.rules.rule("R-3")!.state).toBe("active");
    // The precedent is there for the next similar call.
    expect((host.decisionCheck(t, "product-choice-in-scope") as { precedents: { id: string }[] }).precedents.map((p) => p.id)).toEqual(["D-4"]);
  });

  it("rule.retire records explicit policy retirement and keeps its reason in the mirror", async () => {
    const { host } = setup();
    await host.execute({ type: "rule.retire", commandId: cmd(), ruleId: "R-2", reason: "Approved policy moved to the board" });
    expect(host.rules.rule("R-2")).toMatchObject({ state: "retired", state_why: "Approved policy moved to the board" });
    await expect(host.execute({ type: "rule.retire", commandId: cmd(), ruleId: "R-99", reason: "Moved" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rule.update rewrites a rule's words (the owner's own policy) and the mirror follows", async () => {
    const { host, mirror } = setup();
    await host.execute({ type: "rule.update", commandId: cmd(), ruleId: "R-2", do: "propose a rule on the second similar approval; Always makes one at once" });
    expect(host.rules.rule("R-2")).toMatchObject({ scope: "promotion", action: "propose a rule on the second similar approval; Always makes one at once", state: "active" });
    expect(await mirror()).toContain("- Do: propose a rule on the second similar approval; Always makes one at once");
    await expect(host.execute({ type: "rule.update", commandId: cmd(), ruleId: "R-99", do: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rule.update right after keepAsPrecedents: no older copy of the file brings the old words back as a new rule", async () => {
    const { host, store, thread, mirror, rulesFile } = setup();
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    await mirror();
    // keepAsPrecedents rewrites the mirror, moving aside a copy that still has R-2's old words.
    await host.execute({ type: "rules.keepAsPrecedents", commandId: cmd(), ruleIds: ["R-4"] });
    await mirror();
    const ids = host.rules.all().map((r) => r.id);
    await host.execute({ type: "rule.update", commandId: cmd(), ruleId: "R-2", do: "propose a rule on the second similar approval" });
    await mirror();
    host.rules.sweepMoved(Date.now() + 2 * DAY);
    // An agent off Loom appending the old words under the old id later is the same rule too.
    appendFileSync(rulesFile, "\n## R-2 · policy · active\n- Scope: promotion\n- Do: promote on the first approval\n");
    host.rules.importFile();
    expect(host.rules.all().map((r) => r.id)).toEqual(ids);
    expect(host.rules.rule("R-2")).toMatchObject({ action: "propose a rule on the second similar approval", state: "active" });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM rule_events WHERE kind = 'rule-created'").get()).toEqual({ n: 1 });
    host.rules.writeMirror();
    expect(await mirror()).not.toContain("promote on the first approval");
    // An owner's edit off Loom on that old copy still counts: marked suspended, the rule is suspended.
    host.rules.importFile("## R-2 · policy · suspended\n- Scope: promotion\n- Do: promote on the first approval\n");
    expect(host.rules.rule("R-2")).toMatchObject({ action: "propose a rule on the second similar approval", state: "suspended" });
    expect(host.rules.all().map((r) => r.id)).toEqual(ids);
  });

  it("a rule edited while inactive can't stand again beside an overlapping active one that says otherwise", async () => {
    const { host, thread } = setup();
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "once" });
    expect(host.rules.rule("R-4")!.state).toBe("retired");
    // Edited while retired onto a scope R-3 takes in, saying otherwise: allowed (it isn't standing)...
    await host.execute({ type: "rule.update", commandId: cmd(), ruleId: "R-4", scope: "small display additions to a desk card on phones" });
    // ...but Always on its decision can't bring it back beside R-3.
    await expect(host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always" })).rejects.toMatchObject({ code: "changed", message: expect.stringMatching(/R-3 .* R-4 can't stand again/) });
    expect(host.rules.rule("R-4")!.state).toBe("retired");
  });

  it("rule.update refuses to land a rule on another active one that says otherwise", async () => {
    const { host } = setup(FILE + "\n## R-4 · product-choice-in-scope · active\n- Scope: timer copy\n- Do: use active time\n");
    // Onto R-3's scope, saying otherwise: refused. Onto a scope R-3 takes in: refused too.
    await expect(host.execute({ type: "rule.update", commandId: cmd(), ruleId: "R-4", scope: "small display additions to a desk card" })).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/conflict with R-3/) });
    await expect(host.execute({ type: "rule.update", commandId: cmd(), ruleId: "R-4", scope: "small display additions to a desk card on phones" })).rejects.toMatchObject({ message: expect.stringMatching(/conflict with R-3/) });
    expect(host.rules.rule("R-4")!.scope).toBe("timer copy");
    // Saying the same thing, it may: no conflict.
    await host.execute({ type: "rule.update", commandId: cmd(), ruleId: "R-4", scope: "small display additions to a desk card on phones", do: "put them on the card only" });
    expect(host.rules.rule("R-4")!.state).toBe("active");
  });
});

describe("expiry, conflicts and the review", () => {
  it("a long backlog's rule changes come with the page they fall inside, so Seen never skips one", async () => {
    const { host, thread, advance } = setup();
    const t = await thread();
    advance(1000);
    await host.execute(log(t, { class: "pr-housekeeping", summary: "First" }));
    // A change the system made between them: R-3 retires, unused for 90 days.
    advance(91 * DAY);
    host.store.tx(() => host.rules.tick());
    for (const summary of ["Second", "Third", "Fourth"]) { advance(1000); await host.execute(log(t, { class: "pr-housekeeping", summary })); }
    // A page of 2 (First and Second, shown newest first): the change made between them comes with it.
    const first = host.decided(0, 2);
    expect(first).toMatchObject({ more: true, decisions: [{ summary: "Second" }, { summary: "First" }] });
    expect(first.rules.map((e) => e.kind)).toEqual(["rule-retired"]);
    // The next page starts after Second: nothing new about rules in it.
    expect(host.decided(first.decisions[0]!.at + 1, 2).rules).toEqual([]);
  });

  it("a review ends the millisecond before it was read, so a change in that same millisecond is in the next one", async () => {
    const { host, thread } = setup(null);
    const t = await thread();
    const shown = host.review(0);
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect(shown.created).toEqual([]);
    expect(host.rules.review(shown.until + 1).created.map((e) => e.rule)).toEqual([]);
    expect(host.rules.review(shown.until + 1, host.store.now() + 1).created.map((e) => e.rule)).toEqual(["R-1"]);
  });

  it("rules unused for 90 days retire; policy rules don't", async () => {
    const { host, thread, advance } = setup();
    const t = await thread();
    advance(60 * DAY);
    await host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", scope: "small display additions to a desk card", summary: "Count on the card" }));
    advance(80 * DAY);
    expect(host.rules.tick().retired).toEqual([]);
    advance(11 * DAY);
    expect(host.rules.tick().retired).toEqual(["R-3"]);
    expect(host.rules.all().map((r) => r.state)).toEqual(["active", "active", "retired"]);
  });

  it("two active rules for the same class and scope are a precedent-conflict tripwire", async () => {
    const { host, thread } = setup(FILE + "\n## R-4 · product-choice-in-scope · active\n- Scope: Small display additions to a desk card\n- Do: put them on the row\n");
    const t = await thread();
    expect(host.decisionCheck(t, "product-choice-in-scope")).toMatchObject({ tripwire: "precedent-conflict", conflicts: [["R-3", "R-4"]], what: expect.stringMatching(/R-3 and R-4 cover the same scope/) });
    // A brief for that exact scope must say it is a precedent conflict, naming both: never a third rule on its own.
    await expect(host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ ask: "Count on the card? Recommend: yes.", proposedRule: "Next time, for small display additions to a desk card, put them on the card" }) }))
      .rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/R-3 and R-4 all take in.*precedent-conflict/) });
    // Another tripwire doesn't hide the conflict: it still has to be named.
    await expect(host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "surprise", ask: "Count on the card? Recommend: yes.", proposedRule: "Next time, for small display additions to a desk card, put them on the card" }) }))
      .rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/precedent-conflict/) });
    expect(host.decisionCheck(t, "merge-when-green")).not.toHaveProperty("tripwire");
    // Neither conflicting rule is authority for a log until the owner rules between them.
    await expect(host.execute(log(t, { class: "product-choice-in-scope", rule: "R-4", scope: "small display additions to a desk card", summary: "Count on the row" }))).rejects.toMatchObject({ code: "invalid", message: expect.stringMatching(/R-3 and R-4 cover the same scope/) });
    // The conflict brief names the rules, one option per rule kept.
    const conflict = (options: unknown[]) => brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "R-3 or R-4 for the count? Recommend: R-3.", options });
    await expect(host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: conflict(brief().options) })).rejects.toMatchObject({ message: expect.stringMatching(/every rule in the conflict.*R-3 and R-4/) });
    const keep = [{ key: "A", label: "Keep R-3", consequence: "On the card", recommended: true, rule: "R-3" }, { key: "B", label: "Keep R-4", consequence: "On the row", rule: "R-4" }];
    expect(await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: conflict(keep) })).toMatchObject({ decisionId: "D-4", level: 1 });
    // The owner keeps R-3: R-4 is superseded by it, the conflict is gone, and R-3 is authority again.
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect(host.rules.rule("R-4")).toMatchObject({ state: "superseded", superseded_by: "R-3" });
    expect(host.decisionCheck(t, "product-choice-in-scope")).not.toHaveProperty("tripwire");
    expect(await host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", scope: "small display additions to a desk card", summary: "Count on the card" }))).toMatchObject({ rule: "R-3" });
  });

  it("a conflict brief must name every rule in the group, each once, so the answer settles them all", async () => {
    const extra = "\n## R-4 · product-choice-in-scope · active\n- Scope: Small display additions to a desk card\n- Do: put them on the row\n\n## R-5 · product-choice-in-scope · active\n- Scope: small display additions to a desk card\n- Do: leave them out\n";
    const { host, thread } = setup(FILE + extra);
    const t = await thread();
    const ask = (options: unknown[]) => host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "Which rule? Recommend: R-3.", options }) });
    const opt = (key: string, rule: string, recommended = false) => ({ key, label: `Keep ${rule}`, consequence: "It stands", rule, ...(recommended ? { recommended } : {}) });
    await expect(ask([opt("A", "R-3", true), opt("B", "R-4")])).rejects.toMatchObject({ message: expect.stringMatching(/every rule in the conflict.*R-3 and R-4 and R-5/) });
    await expect(ask([opt("A", "R-3", true), opt("B", "R-4"), opt("C", "R-4")])).rejects.toMatchObject({ code: "invalid" });
    await ask([opt("A", "R-3", true), opt("B", "R-4"), opt("C", "R-5")]);
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect(host.rules.all().filter((r) => r.class === "product-choice-in-scope").map((r) => `${r.id}:${r.state}`)).toEqual(["R-3:active", "R-4:superseded", "R-5:superseded"]);
    expect(host.decisionCheck(t, "product-choice-in-scope")).not.toHaveProperty("tripwire");
  });

  it("two briefs on one scope answered in turn: the same ruling reuses its rule, a different one supersedes it", async () => {
    const { host, thread } = setup(null);
    const t = await thread(), u = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: u, brief: brief() });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: await thread(), brief: brief({ proposedRule: "Next time, for desk timer copy, use clock time" }) });
    expect(await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" })).toMatchObject({ rule: "R-1" });
    expect(await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A", rule: "always" })).toMatchObject({ rule: "R-1" });
    expect(host.rules.rule("R-1")!.source).toBe('["D-4","D-5"]');
    // The second approval is recorded (and stays out of Decided for you: both are the owner's own answers).
    expect(host.rules.events(0).filter((e) => e.rule_id === "R-1").map((e) => [e.kind, e.decision_id])).toEqual([["rule-reaffirmed", "D-5"], ["rule-created", "D-4"]]);
    expect(host.decided(0).rules).toEqual([]);
    expect(await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-6", option: "A", rule: "always" })).toMatchObject({ rule: "R-2" });
    expect(host.rules.rule("R-1")).toMatchObject({ state: "superseded", superseded_by: "R-2" });
    expect(host.decisionCheck(t, "product-choice-in-scope")).not.toHaveProperty("tripwire");
  });

  it("a rule's state change reaches the threads whose answers made it (their answered brief shows it)", async () => {
    const { host, store, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    const seq = store.highWater();
    // Retired by the hourly sweep, with no command on the thread: the thread still changes.
    store.now = (() => { const later = store.now() + 91 * DAY; return () => later; })();
    store.tx(() => host.rules.tick());
    expect(host.rules.rule("R-1")!.state).toBe("retired");
    expect(store.changesAfter(seq, 1000).some((c) => c.thread_id === t)).toBe(true);
    expect(host.detail(t)!.decisions.find((d) => d.id === "D-4")!.rule).toMatchObject({ id: "R-1", state: "retired" });
  });

  it("Always again on a decision whose rule was suspended brings that rule back, not a second one", async () => {
    const { host, thread } = setup(null);
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    await host.execute(log(t, { class: "product-choice-in-scope", rule: "R-1", scope: "desk timer copy", summary: "Active time on the badge" }));
    await host.execute({ type: "decision.reverse", commandId: cmd(), decisionId: "D-5", undo: false });
    expect(host.rules.rule("R-1")!.state).toBe("suspended");
    expect(await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always" })).toMatchObject({ rule: "R-1", ruleState: "active" });
    expect(host.rules.all().map((r) => r.id)).toEqual(["R-1"]);
  });

  it("a rule two approvals back stands until neither says Always", async () => {
    const { host, thread } = setup(null);
    const t = await thread(), u = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: u, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A", rule: "always" });
    // The answer says the rule still stands, so the desk doesn't tell the owner "no rule".
    expect(await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "next-time" })).toMatchObject({ ruleState: "active" });
    expect(host.rules.rule("R-1")).toMatchObject({ state: "active", source: '["D-5"]' });
    // Back to Always: its backing returns, so the other answer leaving no longer retires the rule.
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always" });
    expect(host.rules.rule("R-1")!.source).toBe('["D-5","D-4"]');
    // Always again with a new reason: the rule it backs learns it too.
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always", reason: "Idle time isn't mine" });
    expect(host.rules.rule("R-1")!.reason).toBe("Idle time isn't mine");
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-5", rule: "next-time" });
    expect(host.rules.rule("R-1")).toMatchObject({ state: "active", source: '["D-4"]' });
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "next-time" });
    expect(host.rules.rule("R-1")!.state).toBe("retired");
  });

  it("a reused rule takes the later approval's reason, and its Always clears an earlier just-this-once", async () => {
    const { host, thread } = setup(null);
    const t = await thread(), u = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: u, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A", rule: "always", reason: "Idle time isn't mine" });
    expect(host.rules.rule("R-1")).toMatchObject({ source: '["D-4","D-5"]', reason: "Idle time isn't mine", last_used_at: host.store.now() });
    // Always after a pre-D-61 decline clears it (a decline from before D-61 is still honoured until then).
    host.store.tx(() => host.rules.decline("product-choice-in-scope", "Next time, for desk timer copy, use active time", "D-1"));
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "once" });
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "always" });
    expect(host.rules.declined("product-choice-in-scope", "desk timer copy")).toBe(false);
  });

  it("a conflict brief has no option cap: one option per rule, however many", () => {
    const options = Array.from({ length: 13 }, (_, i) => ({ key: `K${i}`, label: `Keep R-${i + 1}`, consequence: "It stands", rule: `R-${i + 1}`, ...(i === 0 ? { recommended: true } : {}) }));
    expect(lintBrief(brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "Which rule? Recommend: R-1.", options }), loadBoard()).errors).toEqual([]);
    expect(lintBrief(brief({ options: options.slice(0, 5).map(({ rule: _rule, ...o }) => o) }), loadBoard()).errors.join()).toMatch(/4 at most/);
  });

  it("a stale conflict brief answered after another: the rule the owner keeps last stands", async () => {
    const { host, thread } = setup(FILE + "\n## R-4 · product-choice-in-scope · active\n- Scope: Small display additions to a desk card\n- Do: put them on the row\n");
    const t = await thread(), u = await thread();
    const options = [{ key: "A", label: "Keep R-3", consequence: "On the card", recommended: true, rule: "R-3" }, { key: "B", label: "Keep R-4", consequence: "On the row", rule: "R-4" }];
    const conflict = brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "R-3 or R-4? Recommend: R-3.", options });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: conflict });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: u, brief: conflict });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "B" });
    expect([host.rules.rule("R-3")!.state, host.rules.rule("R-4")!.state]).toEqual(["superseded", "active"]);
    expect(host.rules.rule("R-3")!.superseded_by).toBe("R-4");
  });

  it("settling a conflict takes in a same-scope rule appended to the file while the brief was open", async () => {
    const { host, rulesFile, thread, mirror } = setup(FILE + "\n## R-4 · product-choice-in-scope · active\n- Scope: Small display additions to a desk card\n- Do: put them on the row\n");
    const t = await thread();
    await mirror();
    const options = [{ key: "A", label: "Keep R-3", consequence: "On the card", recommended: true, rule: "R-3" }, { key: "B", label: "Keep R-4", consequence: "On the row", rule: "R-4" }];
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "R-3 or R-4? Recommend: R-3.", options }) });
    appendFileSync(rulesFile, "\n## R-5 · product-choice-in-scope · active\n- Scope: small display additions to a desk card\n- Do: leave them out\n");
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect(["R-3", "R-4", "R-5"].map((id) => host.rules.rule(id)!.state)).toEqual(["active", "superseded", "superseded"]);
    expect(host.decisionCheck(t, "product-choice-in-scope")).not.toHaveProperty("tripwire");
  });

  it("a rule the owner kept after an earlier 'neither' stays restored when the mirror is rewritten", async () => {
    const { host, thread, mirror } = setup(FILE + "\n## R-4 · product-choice-in-scope · active\n- Scope: Small display additions to a desk card\n- Do: put them on the row\n");
    const t = await thread(), u = await thread();
    const options = [{ key: "A", label: "Keep R-3", consequence: "On the card", recommended: true, rule: "R-3" }, { key: "B", label: "Keep R-4", consequence: "On the row", rule: "R-4" }];
    const conflict = brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "R-3 or R-4? Recommend: R-3.", options });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: conflict });
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: u, brief: conflict });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", text: "Neither for now" });
    expect(await mirror()).toMatch(/## R-3 · product-choice-in-scope · suspended[\s\S]*by Loom\)/);
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-5", option: "A", rule: "always" });
    const text = await mirror();
    expect(host.rules.rule("R-3")!.state).toBe("active");
    expect(text).toContain("## R-3 · product-choice-in-scope · active");
    // An edit off Loom (an active rule's heading marked suspended) is still honoured.
    host.store.tx(() => host.rules.importFile(text.replace("## R-3 · product-choice-in-scope · active", "## R-3 · product-choice-in-scope · suspended")));
    expect(host.rules.rule("R-3")!.state).toBe("suspended");
  });

  it("a rule restored by a conflict answer starts its unused clock again", async () => {
    const { host, thread, advance } = setup(FILE + "\n## R-4 · product-choice-in-scope · active\n- Scope: Small display additions to a desk card\n- Do: put them on the row\n");
    const t = await thread();
    const options = [{ key: "A", label: "Keep R-3", consequence: "On the card", recommended: true, rule: "R-3" }, { key: "B", label: "Keep R-4", consequence: "On the row", rule: "R-4" }];
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "R-3 or R-4? Recommend: R-3.", options }) });
    // The brief sits long enough for both to retire unused.
    advance(91 * DAY);
    expect(host.rules.tick().retired).toEqual(["R-3", "R-4"]);
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect(host.rules.rule("R-3")!.state).toBe("active");
    advance(60 * 60_000);
    expect(host.rules.tick().retired).toEqual([]);
    expect(host.rules.rule("R-3")!.state).toBe("active");
  });

  it("settling a stale conflict covers every rule active on its scope now, even one that came after the brief", async () => {
    const { host, thread } = setup(FILE + "\n## R-4 · product-choice-in-scope · active\n- Scope: Small display additions to a desk card\n- Do: put them on the row\n");
    const t = await thread();
    const options = [{ key: "A", label: "Keep R-3", consequence: "On the card", recommended: true, rule: "R-3" }, { key: "B", label: "Keep R-4", consequence: "On the row", rule: "R-4" }];
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "R-3 or R-4? Recommend: R-3.", options }) });
    // A third rule on that scope arrives from the rules file while the brief is open.
    host.store.tx(() => host.store.db.prepare("INSERT INTO rules (id, class, scope, action, level, source, state, created_at, changed_at) VALUES ('R-9', 'product-choice-in-scope', 'small display additions to a desk card', 'leave them out', 4, '[]', 'active', 0, 0)").run());
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect(["R-3", "R-4", "R-9"].map((id) => host.rules.rule(id)!.state)).toEqual(["active", "superseded", "superseded"]);
    expect(host.decisionCheck(t, "product-choice-in-scope")).not.toHaveProperty("tripwire");
  });

  it("a conflict of more than four rules can still be settled: one option per rule", async () => {
    const more = [4, 5, 6, 7].map((n) => `\n## R-${n} · product-choice-in-scope · active\n- Scope: small display additions to a desk card\n- Do: option ${n}\n`).join("");
    const { host, thread } = setup(FILE + more);
    const t = await thread();
    const options = [3, 4, 5, 6, 7].map((n, i) => ({ key: String.fromCharCode(65 + i), label: `Keep R-${n}`, consequence: "It stands", rule: `R-${n}`, ...(n === 3 ? { recommended: true } : {}) }));
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "Which of five? Recommend: R-3.", options }) });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    expect([3, 4, 5, 6, 7].map((n) => host.rules.rule(`R-${n}`)!.state)).toEqual(["active", "superseded", "superseded", "superseded", "superseded"]);
  });

  it("an imported rule stands on its own: an approval that reused it can leave without retiring it", async () => {
    const { host, rulesFile, thread, mirror } = setup();
    const t = await thread();
    await mirror();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    // Appended off Loom while the brief is open: the approval finds it rather than making a second rule.
    appendFileSync(rulesFile, "\n## R-4 · product-choice-in-scope · active\n- Scope: desk timer copy\n- Do: use active time\n");
    expect(await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" })).toMatchObject({ rule: "R-4" });
    expect(host.rules.all().filter((r) => r.state === "active" && r.scope === "desk timer copy").map((r) => r.id)).toEqual(["R-4"]);
    await host.execute({ type: "decision.rule", commandId: cmd(), decisionId: "D-4", rule: "next-time" });
    expect(host.rules.rule("R-4")).toMatchObject({ state: "active", source: "[]", origin: "the rules file" });
  });

  it("reusing a rule settles a disagreeing sibling the file brought in at the same time", async () => {
    const { host, rulesFile, thread, mirror } = setup();
    const t = await thread();
    await mirror();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    appendFileSync(rulesFile, "\n## R-4 · product-choice-in-scope · active\n- Scope: desk timer copy\n- Do: use active time\n\n## R-5 · product-choice-in-scope · active\n- Scope: desk timer copy\n- Do: use clock time\n");
    expect(await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" })).toMatchObject({ rule: "R-4" });
    expect(host.rules.rule("R-5")).toMatchObject({ state: "superseded", superseded_by: "R-4" });
    expect(host.decisionCheck(t, "product-choice-in-scope")).not.toHaveProperty("tripwire");
  });

  it("a conflict brief needs a real conflict to settle", async () => {
    const { host, thread } = setup();
    const t = await thread();
    await expect(host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "Which? Recommend: A." }) }))
      .rejects.toMatchObject({ message: expect.stringMatching(/no active product-choice-in-scope rules conflict/) });
  });

  it("a conflict brief can't name rules that don't conflict", async () => {
    const { host, thread } = setup();
    const t = await thread();
    const options = [{ key: "A", label: "Keep R-1", consequence: "x", recommended: true, rule: "R-1" }, { key: "B", label: "Keep R-3", consequence: "y", rule: "R-3" }];
    await expect(host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "R-1 or R-3? Recommend: R-1.", options }) }))
      .rejects.toMatchObject({ message: expect.stringMatching(/no active product-choice-in-scope rules conflict/) });
    expect(host.rules.all().every((r) => r.state === "active")).toBe(true);
  });

  it("a conflict answered with neither rule suspends both, so the next case asks", async () => {
    const { host, thread } = setup(FILE + "\n## R-4 · product-choice-in-scope · active\n- Scope: Small display additions to a desk card\n- Do: put them on the row\n");
    const t = await thread();
    const options = [{ key: "A", label: "Keep R-3", consequence: "On the card", recommended: true, rule: "R-3" }, { key: "B", label: "Keep R-4", consequence: "On the row", rule: "R-4" }];
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief({ tripwire: "precedent-conflict", proposedRule: undefined, ask: "R-3 or R-4? Recommend: R-3.", options }) });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", text: "Neither: ask me each time" });
    expect([host.rules.rule("R-3")!.state, host.rules.rule("R-4")!.state]).toEqual(["suspended", "suspended"]);
    // The owner's own answer did it: not listed in Decided for you.
    expect(host.decided(0).rules.filter((e) => e.kind === "rule-suspended")).toEqual([]);
  });

  it("the weekly review lists rules created, suspended and demoted, rules due, and recurring dissent, over HTTP", async () => {
    const { host, thread, advance } = setup();
    const t = await thread();
    await host.execute({ type: "decision.request", commandId: cmd(), threadId: t, brief: brief() });
    await host.execute({ type: "decision.answer", commandId: cmd(), decisionId: "D-4", option: "A", rule: "always" });
    await host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", scope: "small display additions to a desk card", summary: "Count on the card", dissent: "rows have room" }));
    await host.execute(log(t, { class: "product-choice-in-scope", rule: "R-3", scope: "small display additions to a desk card", summary: "Timer on the card", dissent: "still think rows" }));
    await host.execute(log(t, { class: "product-choice-in-scope", rule: "R-4", scope: "desk timer copy", summary: "Active time on the timer", dissent: "once" }));
    await host.execute({ type: "decision.reverse", commandId: cmd(), decisionId: "D-6", undo: false });
    advance(DAY);
    const server = createLoomServer(host, { token: "t" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const get = async (path: string) => (await fetch(base + path, { headers: { authorization: "Bearer t" } })).json() as Promise<Record<string, unknown>>;
      const review = await get("/decisions/review");
      expect(review).toMatchObject({
        created: [{ rule: "R-4", decision: "D-4" }],
        suspended: [{ rule: "R-3", kind: "rule-suspended" }],
        demoted: [],
        dissent: [{ rule: "R-3", count: 2, notes: [{ decision: "D-5", text: "rows have room" }, { decision: "D-6", text: "still think rows" }] }],
      });
      const rules = await get("/rules") as { rules: { id: string; state: string }[]; class_levels: unknown[] };
      expect(rules.rules.map((r) => `${r.id}:${r.state}`)).toEqual(["R-1:active", "R-2:active", "R-3:suspended", "R-4:active"]);
      expect(rules.class_levels).toEqual([]);
      const decided = await get(`/decisions?since=1`) as { rules: { kind: string }[] };
      expect(decided.rules.map((e) => e.kind)).toEqual(["rule-suspended"]);
      advance(85 * DAY);
      expect(((await get("/decisions/review")) as { due: { id: string }[] }).due.map((r) => r.id)).toEqual(["R-4"]);
      // Read: R-4 comes up again after another review period, not in every weekly digest.
      await host.execute({ type: "rules.reviewed", commandId: cmd(), ruleIds: ["R-4"] });
      expect(host.rules.rule("R-4")!.review_at).toBe(host.store.now() + 90 * DAY);
      expect(((await get("/decisions/review")) as { due: unknown[] }).due).toEqual([]);
    } finally {
      server.close();
    }
  });
});
