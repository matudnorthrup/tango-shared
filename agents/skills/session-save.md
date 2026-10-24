# session_save

When and how to persist session context before it is lost — rotation, `/tango new`, or the operator asking for a save.

**Applies to:** all Tango agents unless a domain skill overrides (e.g. legal matter save adds thread-file rules).

Installations extend this doc via profile overlay (`~/.tango/profiles/<profile>/prompts/skills/session-save.md`).

---

## Where does this go? (three layers)

Ask **one question per candidate fact** — do not copy the same content to all three.

| Layer | Question | What belongs here | What does **not** belong |
| --- | --- | --- | --- |
| **Thread file** | *What exactly was decided and proved for **this project**?* | Test results, architecture decisions, open tasks, Quick Read status, Decisions Log bullets, file pointers | Partnership texture, "who we are," session narration, duplicate Atlas memories |
| **Daily log** | *What happened today — **one headline** for the fleet calendar?* | Dated one-liners: "Phase 1b smoke complete," "First multi-agent exchange" | Test matrices, decision detail, relationship depth |
| **Atlas** | *Who are we / how do we work together — **durable recall**?* | Preferences, corrections, partnership milestones, origin stories, lessons that shape future behavior | Raw test output, Open Items checklists, channel activity logs |

**Sorting shortcuts**

- *How to run the project* → **thread file**
- *What we did today (headline)* → **daily log**
- *How to work with the operator / what this relationship is* → **Atlas**
- *Session narration, smoke codewords, throwaway repro* → **nowhere** (drop)

**Example routing**

| Fact | Layer | Why |
| --- | --- | --- |
| Write guard blocked full overwrite; Edit patch passed | **Thread** | Project evidence — Decisions Log + Open Items |
| Infrastructure smoke complete (headline) | **Daily log** | Fleet-visible "what happened today" |
| Insight about invisible hook infrastructure | **Atlas** | Durable lesson, not infra spec |
| Throwaway probe string from a test | **Thread** (or nowhere after test) | Test artifact — not Atlas |

**Until daily log append is wired:** do **not** put daily-log headlines into Atlas as a substitute. Mention in your save confirmation: *"Would append to daily log: …"* and put durable meaning in the right layer above.

---

## When to run

| Trigger | Action |
| --- | --- |
| Operator says **save**, **checkpoint**, or similar | Run full save pass; confirm what you stored |
| **`/tango save`** queued on this turn | Same as above (platform injects save-pass context and turn whisper) |
| Before **`/tango new`** when the session had substance | Run save pass first unless the operator explicitly skips |
| Natural breakpoint (significant decisions, long arc) | Use judgment — proactive save without announcing every turn |

Do not save smoke-test codewords, throwaway repro chatter, or duplicate what post-turn extraction already captured unless this session added context Haiku would miss.

---

## 1. Atlas — primary memory (always)

Use `memory_add` for anything that would hurt to lose: decisions, insights, corrections, commitments, preferences, partnership texture, and durable findings from the work.

**Platform stamps Discord location automatically** on every `memory_add` during a Discord turn — `channel_id`, `thread_id`, and `conversation_key` in metadata (same provenance Haiku post-turn uses). Agents do not need to pass channel IDs manually.

**Agent-initiated saves carry more weight** than automatic post-turn extraction. You have full session context Haiku does not. Write memories that stand alone — include enough **why** and **so what** that they remain useful weeks later.

- **No importance number required** — platform defaults are fine.
- **Source:** `manual` (or as the tool specifies).
- **Metadata:** set `captured_by` to `agent_save` (normal save) or `save_pass` (when `/tango save` triggered the turn).
- **Confirm to the operator** what you saved — briefly, not a transcript dump.

### What Haiku post-turn is (and is not)

After each turn, a lightweight model may extract atomic facts into Atlas automatically.

| | Agent save (`memory_add`) | Haiku post-turn |
| --- | --- | --- |
| **Atlas `source`** | `manual` | `conversation` |
| **Typical metadata** | `captured_by: agent_save` or `save_pass` | `captured_by: post_turn_extraction` |
| **Context** | Full session judgment | Last user + agent message only |
| **Weight** | **Higher** — intentional, richer | Background capture |

Do not re-`memory_add` facts already stored this session unless you are **correcting** or **adding context** Haiku would not have.

---

## 2. Thread file — when linked

If this channel has a linked thread file (whisper shows `Linked: …`):

- **Patch, never full overwrite** existing authored content.
- **Frozen anchors** (Quick Read, Open Items, frontmatter) — tools may key off these; keep them current when status or tasks change.
- **Body sections** — flexible. Use as many headings as the thread needs (decisions tables, file pointers, phase notes, etc.). Only the declared anchors are machine contract; the rest is yours to shape.

On save: update **Open Items** and **Quick Read** if they changed this session. Other sections only if this session touched them.

---

## 3. Daily log — fleet chronological record (when enabled)

**Path:** `~/.tango/profiles/<profile>/memory/YYYY-MM-DD.md`  
**One file per calendar day, all agents append.**

When daily log is wired for your agent, append a short block. **Always include Discord location** — agent + time alone is not enough to trace where work happened.

```markdown
## {agent_id} · {YYYY-MM-DD HH:MM TZ} · channel:{channel_id} · thread:{thread_id}
- One to three bullets: what happened this session worth a dated record.
```

| Field | Required | Notes |
| --- | --- | --- |
| `agent_id` | Yes | Who saved |
| Timestamp | Yes | When |
| `channel_id` | Yes | Discord channel (forum parent for thread conversations) |
| `thread_id` | When in a thread | Omit the `· thread:…` segment for top-level channels only |

Use the **same channel/thread ids** the platform injects for Atlas. Do not paraphrase channel names — ids are what make grep and later tooling reliable.

Purpose: **chronological search** ("what did we do today?", "what happened in this channel?") — not a replacement for Atlas semantic recall. Keep bullets factual; put durable meaning in Atlas.

**Concurrency:** append-only. If the file does not exist, create it with a `# YYYY-MM-DD` title first.

*Status: daily log append policy is defined here; tool/guard wiring may follow. Until then, mention would-append lines in save confirmation.*

---

## Save pass checklist

1. Review the session — what would be lost on rotation?
2. `memory_add` durable items (rich context; confirm to the operator).
3. If linked — patch thread file anchors/sections that changed.
4. If daily log enabled — append dated block with **agent id + timestamp + channel_id (+ thread_id when in a thread)**.
5. Reply with a short confirmation by layer — not a full session recap.

---

## Related

- Thread contract: frozen anchors vs free body — see profile thread-file playbooks
- Cod-E tools: `agents/assistants/cod-e/knowledge.md` → Memory section
- Platform: `/tango save` injection — `packages/discord/src/session-ops.ts`
