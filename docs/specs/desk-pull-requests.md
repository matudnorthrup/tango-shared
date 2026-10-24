# Desk: Pull Requests on Rows and Threads

Status: **accepted** (owner decision D-342, October 21, 2026). Builds on
[Desk Status](desk-status.md); changes nothing in it.

## Why

The desk can't answer two questions at a glance: *did this thread's work
ship?* and *did it leave a PR open that nothing is watching?* Idle looks the
same either way. A thread's PRs are split across three sources that never
reconcile:

- `facts.prWatches`: explicit watches, the only PRs polled for review and CI;
  a PR drops off when it merges or closes.
- `item.artifacts`: links scraped from the newest agent message that has
  links, so a PR vanishes once the agent stops repeating it. These are never
  polled, and the client shows at most 3 (`prsOf`, `public/desk/list.js`).
- Loom `pr` waits: polled by Loom itself, mirrored into `facts.waits`.

`facts.pullRequest` and `facts.linkedPullRequests` have had no writer since T3
was retired.

Multiple PRs per thread are common. Of the 49 Loom threads that ran
`gh pr create` (October 21), 9 opened more than one, up to 5. Mentions are much
noisier: coordinators cite 8 or more PRs they don't own. So the design
separates **PRs this thread (or its workers) opened** from **PRs it only
mentioned**.

## The rule

PR state is a **quiet fact**. It never sets a pill, count, sort position or
wake (R-21, desk-status.md "The rule"). The row chip is neutral. The pill
still says who acts. The chip says what shipped.

## The thread's PR list

The server keeps one durable list per desk item: `ThreadPr[]`. Entries are
added and never dropped. State changes; membership doesn't.

```ts
type ThreadPr = {
  url: string;              // canonical https://github.com/owner/repo/pull/N, the key
  repo: string;             // owner/repo
  number: number;
  title: string | null;
  state: 'open' | 'draft' | 'merged' | 'closed';
  review: 'pending' | 'approved' | 'changes_requested' | null;  // null = none required / unknown
  checks: 'passing' | 'failing' | 'running' | null;             // null = no checks / unknown
  relation: 'opened' | 'worker' | 'watched' | 'mentioned';
  via?: { itemId: string; title: string };  // relation 'worker': the worker that opened it
  watched: boolean;         // a desk prWatch or an armed Loom pr wait covers it right now
  mergedAt?: number; closedAt?: number;
  firstSeenAt: number;
  checkedAt: number | null; // last successful GitHub read
  error?: string;           // last read failed (kept with the last known state)
};
```

**Relation**, strongest wins when several sources name the same PR:
`opened` › `worker` › `watched` › `mentioned`.

- **opened**: this thread created it. Sources:
  1. Loom records each `gh pr create` in `side_effects` (`check_kind = 'pr'`),
     but not the URL. On the `result` phase, Loom also records the PR URL
     parsed from the tool output (`packages/loom/src/ledger.ts`). The desk reads
     it through the Loom source.
  2. The thread's branch (`threads.worktree_branch`, Loom) resolves through
     `gh pr list --head <branch>` once, then again only while no PR is found.
- **worker**: a PR opened by a worker or job that reports to this thread
  (recursively). Shown on the lead with `via`. The worker's own row shows it
  as `opened`.
- **watched**: a desk `prWatch` or Loom `pr` wait names it, and nothing above
  applies.
- **mentioned**: a PR URL in any agent message in the thread, not just the
  newest. Mentioned-only PRs never show on the row.

**Polling.** One batched GitHub GraphQL read (through `gh api graphql`, so
`gh` keeps the auth) covers every non-terminal PR in all lists:
state/isDraft, title, reviewDecision, the check rollup, mergedAt and
closedAt. It runs every 5 minutes, and right away when a PR is added.
Merged and closed are terminal, so they're read once more and then never
again. A mentioned PR is read when it's first seen, for its title and state,
and is then polled only while it is open and the list shows it, at most
every 30 minutes. A failed read keeps the last state and records `error` and
`checkedAt`. It never deletes an entry.

The existing review poller (`source-github.ts`) keeps its job: waking agents
and posting feed items. This list is display only. Reuse its parsing
(`reviewFact`, `checksFact`) instead of writing a second one. Where the batched
read already has the fields, the poller may read from it instead of making its
own `gh pr view` call per PR.

The list is sent to the client as `item.prs` (`presentItem`, `view.ts`), sorted
by relation, then open › draft › merged › closed, then by newest.

## Row chip

Shown when the list has at least one PR whose relation isn't `mentioned`.
It sits in the meta row right after the status pill (and after the
"N reporting" chip when there is one). It's neutral: outlined, `--fg-2` text,
no state color, per "Status owns color".

- **Icon:** the state of the most important PR: open › draft › merged ›
  closed. There are four glyphs (open, draft, merged, closed), all monochrome
  on the row.
- **Words:**
  - one PR: `open`, `draft`, `merged` or `closed`;
  - several PRs: nonzero counts in that order, e.g. `1 open · 2 merged`;
  - `· not watched` is appended when an open or draft PR has
    `watched: false` *and* the row's pill is Idle or Finished. That makes it a
    recorded-fact stall hint, e.g. `open · not watched`.
- No PR numbers on the row.
- **Hover** (pointer: fine) or **tap** (touch) opens a small popover. Tapping
  the chip doesn't open the row; it uses the same pattern as the `.nx-kids`
  chip. The popover lists each non-mentioned PR as one line: a colored state
  icon (colors below), `#N title` (truncated), and a short state (`review
  pending`, `CI failing`, `merged 2h`). Each line links to GitHub. A footer
  reads "All pull requests" and opens the thread's Pull requests tab. Esc,
  tapping outside, or moving the pointer away closes it.
- The thread page header shows the same chip beside the kind chip.

## Thread page: Pull requests tab

- A new tab, **Pull requests (n)**, in `tabsFor`, placed before Links and
  shown when the list isn't empty. `n` counts non-mentioned PRs, and mentioned
  ones when they're the only PRs.
- PR artifacts leave the Links tab and its count (no repeats, D-306). The
  reply's `↗ links` pill counts them as before, but opens Pull requests when
  the only links are PRs.
- **Groups:** Open (open and draft), Merged, Closed, then **Mentioned (n)**,
  folded by default.
- **Each row:**
  - the colored state icon;
  - `#N title`;
  - the relation in muted text (`opened here`, `by worker <title>`,
    `watched`, `mentioned`);
  - on the right, the state (`review pending`, `approved`, `merged 1h`,
    `closed 3d`);
  - a sub-line: CI (`CI failing`, `CI running`, `CI passing`), `watching` when
    watched, `checked 2m ago`, and the error if the last read failed.
- Tapping a row opens the PR on GitHub.
- The repo is shown only when the list spans more than one repo.
- The phone layout (`LinksBody`, `conversation.js`) gets a Pull requests
  section before Links, with the same rows.

## Color (tab and popover only)

The row stays neutral. The tab and the popover color the state icon, plus the
CI and review words on the sub-line:

| Meaning | Token | Dark | Light |
| --- | --- | --- | --- |
| Open, nothing in progress or failing | `--pr-open` | `#3fb950` | `#1a7f37` |
| Merged | `--pr-merged` | `#a371f7` | `#8250df` |
| Closed, CI failing, changes requested | `--pr-bad` | `var(--danger)` | `var(--danger)` |
| CI running or review pending (in progress) | `--pr-wait` | `var(--watching)` | `var(--watching)` |
| Draft | `--pr-draft` | `var(--muted)` | `var(--muted)` |

An open PR's icon color, by precedence: failing CI or changes requested
(`--pr-bad`), then CI running or review pending (`--pr-wait`), then
`--pr-open`. Amber is never used, because it means the owner.

## Out of scope

- Any change to `deskStatus`, pills, counts or wakes.
- Feed and catch-up (Shipped already comes from merges).
- Showing PRs on Discord or in voice.
- Resolving `pullRequest` and `linkedPullRequests`: delete them only if
  nothing reads them after this.

## Also fixed

The header comment in `source-github.ts` says an approved PR becomes "your
move". That contradicts desk-status.md: approval wakes the agent, and merging
is the agent's job under the delegation board. Correct the comment. Behavior
doesn't change.

## Build

There are two PRs, built in parallel against the `ThreadPr` contract above:

1. **Server:** the list, its sources (including Loom recording the
   `gh pr create` URL), the batched poll, `item.prs`, the comment fix, and
   tests.
2. **Client:** the chip, popover, tab, phone section, colors, and fixtures
   covering one PR, several PRs, worker PRs, not watched, mentioned-only,
   errors and cross-repo. It's checked on the test desk (`npm run desk:test`)
   with fixtures until the server PR lands.
