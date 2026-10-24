# Model Bake-Off Evals

First-class model selection fixtures for Tango.

## Principle

Choose the cheapest and fastest model that **consistently** completes the task
contract. Reliability dominates: a failed job costs trust, redone tokens, and
the user's attention — far more than the price difference between models. So the
harness gates on pass-rate across repeated runs first; cost and speed only rank
the models that pass.

## How a bake-off works (harness v2)

```
fixture (eval contract)
  → N runs per candidate model (sequential, identical task)
      → GATES  per run: machine-checked — tool contract incl. argument checks,
               output assertions, forbidden actions   → pass/fail
      → RUBRIC per run: blind Claude-CLI judge scores the fixture's weighted
               quality dimensions 0..1
  → eligibility: passRate ≥ passRateThreshold AND rubric mean ≥ rubricThreshold
                 AND worst-run rubric ≥ rubricFloor (default threshold − 0.1) —
                 consistency is a reliability property: a model that swings
                 between brilliant and below-bar is not dependable
  → ranking: pass rate desc, then cost-per-successful-run, then latency
  → hysteresis: a challenger only displaces `incumbentModel` by strictly beating
    it (never ties) — assignments don't churn on marginal wins
```

Infra failures (MCP server down, auth, rate limits) are detected, retried once,
and excluded from the pass-rate denominator — environment flakiness never
masquerades as model unreliability. If a fixture's contract tools aren't visible
to the worker on :9100, the harness aborts with an INFRA error *before* running
any model, so missing governance permissions can't fail every candidate.

## Running

```bash
npm run eval:validate          # fixture contract check (CI-gateable)
npm run eval:test              # harness unit tests (gates + verdict logic)

# Full bake-off from a fixture (runs, candidates, judge all from the fixture):
node scripts/model-bakeoff.mjs --task agents/evals/model-bakeoff/tasks/<fixture>.json

# Overrides:
#   --models a,b,c        candidate set        --runs N        runs per candidate
#   --benchmarks claude:sonnet,claude:opus     subscription benchmarks (never assignable)
#   --no-judge --judge-model <m> --full --no-tools --results-dir <dir>

# Quick ad-hoc comparison (v1-style):
node scripts/model-bakeoff.mjs --prompt "<task>" --worker watson-ollama --full
```

Requires `OLLAMA_API_KEY` in `.env` (when Ollama models run), the `:9100` MCP
server for tool fixtures, and a logged-in `claude` CLI for the judge and any
Claude candidates/benchmarks.

Claude models are first-class **assignable candidates** as of 2026-07-17
(headless subscription use confirmed unmetered, retiring the old
"print mode is never assignable" rule). Name them in `candidateModels` using
bare runtime ids exactly as agent configs do (`claude-opus-4-8`,
`claude-haiku-4-5`); `claude:` CLI aliases (`claude:sonnet`) also work. They
run through the same MCP worker tools, gates, and rubric as Ollama candidates.
Limits: vision fixtures auto-exclude Claude candidates (the CLI runner has no
image input), and subscription pricing means they rank by tokens-per-success
like every other subscription model (see `pricing.json` note).

## Production-faithful runs (added 2026-09-24)

These fields and flags make a bake-off measure the agent as production runs it:

- `systemFromAgent: "<agentId>"`: the run starts with that agent's **production**
  prompt (layered v2 config, soul/rules/knowledge, profile overlays), resolved at
  run time and never committed. `system` is then appended as "Scenario context".
  These fixtures also get production's current-turn metadata (date, time,
  timezone). Set `now` (ISO) to pin the clock when the scenario names a date.
- `history: [{ role, content }]`: earlier turns, rendered as a transcript ahead of
  the current message. Most real traffic is follow-ups, not cold opens.
- `judge: { models: ["sonnet", "deepseek-v4-pro"] }`: a **judge panel**. Run
  scores are the mean across judges, and verdicts record `rubricByJudge`. Since
  Claude models became candidates, a Claude-only judge could favor its own
  family. The Sept 2026 bake-off found no such bias: the Sonnet judge scored
  Claude and open candidates about 0.08 below the DeepSeek judge, equally for
  both families.
- Claude candidates accept an effort suffix (`claude-opus-5-5@high`), so
  effort levels can be baked off against each other.
- Claude CLI runs use an isolated `CLAUDE_CONFIG_DIR`. Otherwise the operator's
  global `~/.claude/CLAUDE.md` would leak into candidate and judge context.
- Scoring uses the **user-visible reply**, the same `composeVisibleReply` rule
  production applies. A model that answers, calls a tool, and then says "Saved."
  is scored on everything it showed the user.
- The `empty` gate fails any run with no visible reply.
- `toolContract` entries may be `{ oneOfTools: [{ name, ... }, ...] }` when any
  one of several tools is a valid way to ground the answer.

CLI flags: `--judges a,b`, `--concurrency N` (candidates in parallel; each
candidate's own runs stay sequential), `--judge-concurrency N`,
`--provider claude|ollama` (split passes when one provider is rate-limited),
`--no-verdict` (screens and partial passes don't overwrite committed verdicts),
`--rejudge <results> --fill-missing` (backfill only the judges missing from a
stored run).

**Ollama Cloud has a session usage limit, and production shares it.** A full
fleet bake-off used up the session on 2026-09-24, and every production Ollama
call returned 429 until it reset. Check `GET https://ollama.com/api/usage`
(`limits.session.usage`, 0–1) and keep bake-off traffic well below 1.0.

## Where results go

- **Full per-run records** (transcripts, tool outputs — may contain personal
  data): `~/.tango/evals/results/<fixture-id>/<stamp>.json`. Never committed.
- **Verdict summaries** (stats only, committed-safe): `verdicts/<fixture-id>.json`
  with a capped history, so assignments stay reviewable and trendable in git.
- **Prices**: `pricing.json`. Only verified prices — unknown prices stay null and
  the harness ranks by measured tokens instead. Never guess a price.

## Fixture contract (schema v2)

Required: `id, title, category, worker, taskShape, safetyTier, tools,
candidateModels, system, prompt, successCriteria, knownFailureModes, rubric`
(weights sum to 1).

Scoring fields:

- `toolContract`: `[{ name, minCalls?, argChecks?, anyOf? } | { oneOfTools: [...] }]` — argument-level
  gates. `argChecks: [{ path, exists?|equals?|matches? }]`; path `"."` matches
  against the whole argument object's JSON. `anyOf` branches let a contract
  accept alternative shapes (e.g. "two driving_route calls OR one call with a
  routes[] comparison array"). Legacy `requiredTools` still works.
- `outputAssertions`: `[{ type: includes|notIncludes|matches|notMatches, value }]`
- `forbiddenTools`: tools that must NOT be called (e.g. submit/purchase paths)
- `runs` / `passRateThreshold`: default by `safetyTier` — read tiers 3 runs @ 0.8,
  write tiers 5 runs @ 1.0 (failure on write paths is unacceptable)
- `rubricThreshold` (default 0.7), `judge: { model }` (default sonnet)
- `incumbentModel`: current production assignment, enables hysteresis
- `benchmarkModels`: e.g. `["claude:sonnet", "claude:opus"]` — run for comparison
  only, never recommended. Any model here is benchmark-only by list membership;
  to make a Claude model assignable, put it in `candidateModels` instead.

Validate with `npm run eval:validate`. Per-category contract rules (e.g. travel
route fixtures must gate on `driving_route`) live in the validator's
`CATEGORY_RULES` table — add rules as data, not code.

## Coverage Strategy

Use the Obsidian "Tango Jobs — Manual Test Checklist" as the coverage inventory.
Tier jobs before running expensive bake-offs:

- **Tier 0: high trust impact** — travel, finance, health, calendar commitments,
  live purchasing, and anything that can waste the user's time or money.
- **Tier 1: recurring operations** — scheduled jobs and common assistant tasks
  where consistency matters more than creativity.
- **Tier 2: ad hoc research/judgment** — ambiguous planning or synthesis where
  deeper models may be worth the latency.
- **Tier 3: low-risk bounded tasks** — cheap models should win unless they miss
  required tools or formatting.

For each job family, first establish the golden path with the most capable
process (Claude/Fable or by hand), then bake off candidate models against that
fixed contract, then record the assignment. **No new scheduled job or intent
ships without a fixture** — the golden-path transcript is the fixture draft.

Write-path fixtures may touch live services for the user's OWN data with cleanup
baked into the task (create-then-delete an Obsidian note, update-then-revert a
Notion page). Never third parties, never the `-ollama` Discord channels (the user
dogfoods those); Discord-loop evals go through `-test` channels.
