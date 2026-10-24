// What a thread carries across a compaction or a fresh session (docs/specs/loom-context-management.md):
// Loom's own record of the thread, rebuilt from the store every time, so a summary that drops something
// never loses a wait, a brief or the worktree. The session's SessionStart hook injects it.

/** Asks Claude Code's compaction to keep what a thread needs and drop what Loom or git already holds. */
export const COMPACT_GUIDANCE = [
  "This session runs on Loom, which re-adds the thread's open waits, decision briefs, open ask, background tasks and worktree after compaction, so the summary need not repeat them.",
  "Keep: what the owner asked for, in their words where it matters; decisions made and why; what is done, what is next, and what is blocked; the files, PRs and docs that matter, by path or link.",
  "Drop: command output, file contents and logs that can be read again; steps that are finished and verified.",
].join(" ");

export interface CarryInput {
  thread: { id: string; title: string | null; role: string; parent: string | null; cwd: string; branch: string | null; repo: string | null };
  children: { id: string; title: string | null; status: string; role: string }[];
  waits: { id: string; text: string; note: string; expires_at: number }[];
  /** Each open brief with what its options would do: an answer arrives as just a key and label. */
  briefs: { id: string; class: string; ask: string; created_at: number; standing?: string; background?: string; default?: string | null; options?: { key: string; label: string; consequence?: string; action?: string }[] }[];
  ask: string | null;
  /** Who the open ask is for when not the owner: the agent whose mail started that turn. */
  askTo?: string | null;
  tasks: { id: string; kind: string; description: string; ambient: boolean }[];
  /** The owner's latest messages, oldest first. */
  owner: { text: string; at: number }[];
  /** What Tango's memory learned from this thread and its lead (memory.ts). */
  memories?: string[];
  /** A worker's lead's latest handoff: the project's rolling summary. */
  lead?: { id: string; title: string | null; body: string; at: number } | null;
  denials?: { tool: string; source: string | null; at: number; run: string }[];
  now: number;
}

/** Where a block stops: the state is a pointer list, not a transcript. */
const MAX_CHARS = 36_000;
/** Each section's share, so a long one (two hundred waits) never pushes the rest out. They sum under MAX_CHARS. */
const BUDGET = { waits: 6_000, briefs: 6_000, ask: 600, tasks: 2_000, children: 3_000, owner: 5_000, memories: 4_000, lead: 6_000 } as const;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const when = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

export function renderCarry(input: CarryInput): string {
  const t = input.thread;
  const lines = [
    "# Loom: this thread's state",
    "Loom keeps this record; it is current as of " + when(input.now) + ". Trust it over anything earlier in the conversation.",
    "",
    // Header fields are bounded too: a long title must not leave the sections no room.
    `- Thread: loom:${t.id}${t.title ? ` · ${clip(t.title, 200)}` : ""} · role ${t.role}${t.parent ? ` · reports to ${clip(t.parent, 200)}` : ""}`,
    `- Working directory: ${clip(t.cwd, 500)}${t.branch ? ` · branch ${clip(t.branch, 200)}` : ""}${t.repo ? ` · repo ${clip(t.repo, 200)}` : ""}`,
  ];
  const section = (title: string, items: string[], budget: number) => {
    if (!items.length) return;
    lines.push("", `## ${title}`);
    let used = 0;
    for (const [index, item] of items.entries()) {
      const line = `- ${item}`;
      if (used + line.length > budget && index > 0) {
        lines.push(`- …and ${items.length - index} more; the Desk lists them all`);
        return;
      }
      lines.push(clip(line, budget));
      used += line.length;
    }
  };
  section("Open waits (Loom wakes you when one fires; don't wait for them another way)", input.waits.map((w) => `${w.id}: ${clip(w.text, 300)}${w.note ? ` · your note: ${clip(w.note, 400)}` : ""} · expires ${when(w.expires_at)}`), BUDGET.waits);
  section("Open decision briefs (don't ask again; the answer arrives as a turn naming an option)", input.briefs.map((b) => {
    // Enough to carry out an answer cold: the wake turn names only the chosen key and label.
    const options = (b.options ?? []).map((o) => `${o.key} ${clip(o.label, 120)}${o.consequence ? ` (${clip(o.consequence, 200)})` : ""}${o.action ? ` → ${clip(o.action, 200)}` : ""}`).join("; ");
    return `${b.id} (${b.class}): ${clip(b.ask, 300)} · raised ${when(b.created_at)}${b.standing ? ` · where it stood: ${clip(b.standing, 300)}` : ""}${b.background ? ` · background: ${clip(b.background, 300)}` : ""}${b.default ? ` · default ${b.default}` : ""}${options ? ` · options: ${options}` : ""}`;
  }), BUDGET.briefs);
  if (input.ask) section(input.askTo ? `Your open ask to ${clip(input.askTo, 80)} (another agent, not the owner)` : "Your open ask to the owner", [clip(input.ask, 400)], BUDGET.ask);
  section("Recorded settings denials", (input.denials ?? []).map(d => `${when(d.at)} · run ${d.run} · ${d.tool}: blocked by a settings rule (${d.source ?? "SDK did not supply the rule/source"}), not by the owner`), 2_000);
  section("Background tasks still running", input.tasks.map((task) => `${task.id} · ${task.kind}${task.ambient ? " (watcher)" : ""}: ${clip(task.description, 200)}`), BUDGET.tasks);
  section("Threads that report to this one", input.children.map((c) => `loom:${c.id}${c.title ? ` · ${c.title}` : ""} · ${c.role} · ${c.status}`), BUDGET.children);
  section("The owner's latest messages, verbatim", input.owner.map((m) => `${when(m.at)}: ${clip(m.text, 2_000)}`), BUDGET.owner);
  if (input.lead) section(`Your lead's latest handoff (loom:${input.lead.id}${input.lead.title ? ` · ${input.lead.title}` : ""}, ${when(input.lead.at)})`, [clip(input.lead.body.replace(/\n/g, " · "), BUDGET.lead - 4)], BUDGET.lead);
  section("What Tango's memory kept from this thread and its lead", (input.memories ?? []).map((m) => clip(m, 400)), BUDGET.memories);
  return clip(lines.join("\n"), MAX_CHARS);
}
