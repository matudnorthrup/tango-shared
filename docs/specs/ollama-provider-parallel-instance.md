# Ollama Provider — Design Spec

This is a forward-looking design spec, not a description of the current system.
It defines (1) a first-class `ollama` model provider and (2) how it is evaluated
live — on dedicated channels of the **existing** Tango bot (per-agent provider
routing), alongside production without disruption.

Related: [`../guides/parallel-dev.md`](../guides/parallel-dev.md) (the profile +
slot isolation this builds on), [`../guides/profile-model.md`](../guides/profile-model.md).

---

## Section 1: Motivation

Effective **2026-06-15**, Anthropic splits *programmatic* Claude usage
(`claude --print` / Agent SDK / GitHub Actions / subscription-authenticated
third-party apps) out of the flat subscription pool into a separate metered
credit pool billed at API rates (Pro ~$20 / Max5x ~$100 / Max20x ~$200 monthly
credit, no rollover), then standard API rates beyond.

Tango's runtime is exactly this: every bot turn spawns `claude --print` via
`ClaudeCodeAdapter`, authenticated by the on-machine `claudeAiOauth`
subscription credential (no `ANTHROPIC_API_KEY` set). So the bot's hot loop
moves to the metered pool.

**Measured cost**: a few hundred dollars a month at API-equivalent rates. ~90% is Sonnet; the dominant line item
is **cache-creation** (context re-send), not output.

This spec pursues the **open-weight, flat-rate** alternative: route some/all
agent traffic to **Ollama Cloud** (flat subscription, GPU-time metered, runs
DeepSeek V4 Pro / Qwen / gpt-oss), via a first-class provider, validated on
**dedicated channels of the existing bot** (per-agent provider routing) so
production is never at risk.

---

## Section 2: Provider architecture

Tango already has a provider seam. Adding Ollama is a *peer implementation*, not
an adaptation of the existing Codex adapter.

- Interface (`packages/core/src/provider.ts`):
  `interface ChatProvider { generate(request: ProviderRequest): Promise<ProviderResponse> }`
- Existing implementations: `ClaudeCliProvider`, `CodexExecProvider`,
  `EchoProvider`.
- Registry: `createBuiltInProviderRegistry()` in
  `packages/core/src/provider-registry.ts` — add `providers.set("ollama", new OllamaProvider(options.ollama))`.
- Per-agent selection is config-driven (`AgentConfig.provider`):
  `default`, `model`, `reasoningEffort`, `fallback[]`. Routing an agent to
  Ollama is a YAML change *for the registry/failover path* — but the v2 Discord
  runtime is a **separate seam** that does NOT consult the registry (see §2.4),
  so Discord routing also needed a small runtime adapter (built in Phase 1b).

### 2.1 The one hard problem: who owns the tool loop

**Today, the Claude/Codex CLIs own the agentic tool-execution loop.** Tango
hands MCP server configs to the CLI via `--mcp-config`; the CLI shows tools to
the model, executes tool calls, feeds results back, and loops — Tango only
records the resulting `toolCalls[]`.

Ollama's OpenAI-compatible endpoint is a **raw model**: it returns "call tool X"
and *something in Tango* must execute X and continue. Nothing does that today.
A first-class Ollama provider therefore requires a **provider-agnostic
tool-execution loop** inside Tango:

1. Translate MCP tool definitions → OpenAI function-schema format.
2. Execute tool calls — reuse `packages/core/src/mcp-proxy.ts`, which already
   bridges MCP over HTTP (port 9100), instead of reinventing MCP transport.
3. Loop call → execute → feed-back with iteration caps, parallel-call handling,
   and error recovery.
4. Manage conversation history (see 2.2).

This loop is the bulk of the effort and nearly all of the risk. Once built it is
reusable for any future HTTP/OpenAI-compatible provider.

> Do **not** shim this by pointing `CLAUDE_CLI_COMMAND` at an Ollama endpoint.
> Route through the real `OllamaProvider` selected via per-agent config.

### 2.2 Context ownership (statelessness as an advantage)

Claude/Codex persist sessions server-side; Tango stores only the opaque
`providerSessionId` in the `provider_sessions` table and resumes via `--resume`.
Tango never sees or controls the resulting context window — compaction,
truncation, and continuity all happen inside the harness, and Tango can only
*influence* them indirectly (warm-start injection, `--append-system-prompt`).
Much of today's context handling is working *around* that opacity.

Ollama is stateless: `OllamaProvider` assembles and sends the full message array
on every turn. The obvious framing is "extra work," but the real consequence is
**control** — Tango owns exactly what enters the context window each turn. This
is strictly more capable than the CLI path, and it converges with the in-flight
Unified Memory System work (per-thread state files, the context meter, governed
retrieval): context assembly becomes the *native* path instead of a layer
fighting the harness. Two long-standing constraints relax:

- **Thread-scoped context** becomes natural — the provider builds a
  per-channel/thread array instead of inheriting one opaque server-side session.
- **Compaction is ours to design** — summarize-and-replace, sliding window, or
  retrieval-augmented context on *our* policy and at *our* threshold, rather than
  the harness's heuristic.

The cost of this control is that we must build it well: naive full-history
replay is *worse* than Claude's compaction — it will overflow the model's
context window on long Discord threads. A deliberate context-assembly +
compaction strategy is therefore part of Phase 1, not an afterthought. Storage:
in-memory is fine for a single-process pilot; **DB-backed history is required
before multi-process / wider rollout.**

### 2.3 Tool parity: MCP carries over, Claude built-ins do not

The Phase 2 tool loop translates **MCP** tool definitions → OpenAI function
schemas. That covers the overwhelming majority of Tango's tool surface: ~24 MCP
servers (memory/Atlas, obsidian, slack, linear, google, **browser** (Playwright),
exa, receipts, expensedesk, etc.), almost all bridged through `mcp-proxy.ts` on port
9100. All of it is provider-agnostic and carries over unchanged.

The gap is the handful of tools that are **Claude CLI built-ins**, passed via
`--allowedTools` (`packages/core/src/provider.ts`) rather than `--mcp-config`.
These are NOT MCP and would be lost on a raw endpoint:

| Built-in | Who uses it | Replacement on Ollama |
|---|---|---|
| `WebSearch` | Watson, Sierra, Charlie, Papa (allowlist) | **`exa` MCP** — already wired, already used by Sierra/Charlie for search. Swap `WebSearch`→exa in the allowlists. |
| `WebFetch` | same agents | `exa` content retrieval. **Confirm** it covers arbitrary fetch-by-URL as well as `WebFetch` did. |
| `Bash` / file built-ins | appears only in a **test** config (`provider.test.ts`), not live personas | Confirm no live persona/worker depends on it; if so, no work. |

Net: browser automation (the obvious worry) is **already an MCP server** and
needs no work. The only genuine loss is `WebSearch`/`WebFetch`, and Tango already
ships `exa` as the replacement. Juliet's `memory_*` tools and every other persona
capability are MCP-backed and portable. "Tool parity" is therefore a small,
well-bounded task inside Phase 2 — not a from-scratch rebuild.

### 2.4 The v2 runtime is a second seam (discovered in Phase 1b)

Routing via `AgentConfig.provider` only reaches the **provider registry**
(`ChatProvider` / `generateWithFailover`), which today serves voice, attachments,
and dead-letter replay. **Discord agent turns run exclusively through the v2
runtime** (`TangoRouter` → `SessionLifecycleManager` → `RuntimePool` → an
`AgentRuntime`), which was hardwired to `ClaudeCodeAdapter` and never consults
the registry; the legacy Discord exec path is removed (it refuses non-v2 agents
with "not migrated to v2"). So a registry `OllamaProvider` is **necessary but not
sufficient** for Discord — the original "Phase 0 + flip config" assumption was
incomplete.

The v2 runtime is correctly built against the `AgentRuntime` interface, so the
fix is a peer implementation, not a hack: **`OllamaRuntimeAdapter implements
AgentRuntime`** wrapping `OllamaProvider`, selected in `RuntimePool.getOrCreate`
via a new `AgentRuntimeConfig.backend` discriminator (from `legacyProvider.default`).
Shipped + live-validated in Phase 1b (PR #74). The thin wrapper is a stateless,
text-only v0; it grows into a first-class runtime that owns history assembly +
compaction (Phase 1) and the tool loop (Phase 2). NB: there are now two model
abstractions — `ChatProvider` (stateless) and `AgentRuntime` (stateful) — both
wrapping the Ollama client; consolidation is tracked as cleanup.

---

## Section 3: Topology — same bot, per-channel routing

The evaluation runs on the **existing Tango instance and bot** — not a separate
process or profile. Provider *and* model are already per-agent config, so routing
traffic to Ollama is the same mechanism as "this agent uses Sonnet, that one uses
Opus": point an agent at `provider.default: ollama` and pin it to its own
channel(s). (This revises an earlier draft's second-process / second-token
design — below is what that bought and why it is no longer needed.)

- **No second process or bot token.** Once the provider is merged it is a
  first-class peer in the same codebase; a dedicated channel + agent is all that's
  required. A second `DISCORD_TOKEN` / `TANGO_PROFILE=ollama` process is warranted
  *only* to run a **divergent build** in parallel with prod, or for a visibly
  distinct identity — neither is needed here.
- **Channels:** dedicated channels (e.g. `#watson-ollama`) via
  `DISCORD_ALLOWED_CHANNELS` (`packages/discord/src/allowed-channels.ts`) on the
  existing bot. Claude-backed and Ollama-backed channels run side by side.
- **Agent/provider config:** the Ollama-routed agent's YAML sets
  `provider.default: ollama`; Claude agents stay `claude-oauth`.
- **No fallback during the eval.** Ollama-routed agents set **no `fallback`**
  (`fallback: []`). A Claude fallback would silently absorb Ollama failures and
  produce a false-positive "it works" — during setup/testing we want failures
  *visible*. Add fallback later, once Ollama is trusted.
- **Blast radius:** with no fallback, an Ollama failure surfaces as a visible
  error confined to its own channel — exactly the signal we want; Claude channels
  are unaffected.

### 3.1 The split is temporary

During development the provider lives on a feature branch in a worktree; prod
runs `main`. **Once merged there is no separate instance at all** — Ollama is
just another provider any agent selects by config. One codebase, per-agent
config; not a maintained fork.

---

## Section 4: Data sharing policy

Same bot = **everything is shared**; there is no per-profile isolation. The user
has accepted this. Implications by layer:

| Data | Store | Scope | Policy |
|---|---|---|---|
| Sessions, messages, `model_runs`, `obsidian_index` | shared `tango.sqlite` | shared | **A/B by query, not by database.** `model_runs` stamps `provider_name` + `agent_id` per turn, so Ollama-vs-Claude cost/quality is a filter over one table. |
| Atlas semantic memory (memories, pinned_facts, embeddings, conversation_summaries) | global `~/.tango/atlas/memory.db` | shared read + write | **Shared.** Process-level write-isolation is no longer possible. In Phase 0 this is largely moot — text-only agents (`tools.mode: off`) have no memory tools to write with. For wider rollout, manage per-agent (route Ollama to agents that don't write Atlas, or accept it). **To confirm:** whether background conversation-summarization writes Atlas regardless of agent tool mode. |
| Obsidian vault (markdown files) | global, `TANGO_OBSIDIAN_VAULT` → `~/Documents/main` (`packages/core/src/obsidian-indexer.ts`) | shared read + write | **Shared** (unchanged). File-backed + versioned, so writes are recoverable. |

### 4.1 Concurrency notes

`tango.sqlite` and Atlas use WAL (`journal_mode=WAL`, Atlas `busy_timeout=5000`):
many readers + one writer. Running on **one** bot/process actually *reduces*
contention versus the earlier two-process design. For shared Obsidian, use the
project's direct-filesystem I/O convention (not `obsidian-cli`, which steals app
focus in background jobs).

---

## Section 5: Phased plan

**Pilot first (Phases 0–1), then the hard loop (Phase 2).** Dedicated Ollama
channels on the existing bot are the live, zero-prod-risk test bed for each phase.

| Phase | Work | Size | Unlocks |
|---|---|---|---|
| **0 — Provider plumbing** | `OllamaProvider implements ChatProvider`; register in `provider-registry.ts`; env + YAML config (`OLLAMA_BASE_URL`=`https://ollama.com/v1`, `OLLAMA_MODEL`=`deepseek-v4-pro:cloud`, key via `getSecret`); map response → `ProviderResponse` (usage + `reasoning`/`thinking` handling per §7.1; `totalCostUsd` null — flat sub); record to `model_runs`. **Text-only, `tools.mode: off`.** | S (~½ day) | Route text-only workers to DeepSeek on Ollama Cloud; validate connectivity, model selection, accounting. |
| **1 — Context ownership** | Assemble + persist the per-`providerSessionId` message array (in-memory pilot → DB-backed for prod), **including a context-assembly + compaction policy** (see 2.2). Converges with the Unified Memory System. | M | Multi-turn continuity; thread-scoped context; deterministic, Tango-owned compaction. |
| **1b — Ollama channel routing** | On the existing bot: add dedicated channel(s) via `DISCORD_ALLOWED_CHANNELS` + an agent YAML with `provider.default: ollama` and **`fallback: []`** (no fallback — failures must be visible). No second token/process. | S | First real Discord turn; live A/B surface; dogfood without touching prod. |
| **2 — Agentic tool loop** | Provider-agnostic executor: MCP→OpenAI schema translation, tool exec via mcp-proxy, loop control. **Plus built-in-tool parity** (swap `WebSearch`/`WebFetch`→`exa`; see 2.3). **The real cost and risk.** | L | Tool-using agents on any non-CLI provider. |
| **3 — Usage/cost + parity** | Map Ollama usage into `model_runs`; map/handle `reasoningEffort`. | M | Accurate accounting; routing parity. |
| **4 — Live validation** | Side-by-side on real traffic, workers/classifiers first, then user-facing. (`done-means-live-tested`.) | M | Trust before promoting. |

Early win: Phases 0 + 1 + 1b alone move the existing Haiku-class worker/
classifier traffic onto Ollama Cloud and measure real cost + quality **before**
committing to Phase 2.

**Implementation status (2026-06-06):** **Phase 0 built + live-verified.**
`OllamaProvider` (fetch-based, OpenAI-compat) + pure `buildOllamaChatBody` /
`parseOllamaChatResponse` in `packages/core/src/provider.ts`; registered as
`ollama` in `provider-registry.ts`; `OLLAMA_BASE_URL` / `OLLAMA_MODEL` /
`OLLAMA_API_KEY` env + call-site block in `packages/discord/src/main.ts` with a
lazy `getSecret("<vault>", "<item>")` key resolver. 7 unit
tests pass (core builds clean; 326 core + 337 discord tests green). Live smoke
test: a real `generate()` to `deepseek-v4-pro:cloud` returned correct text,
`usage {inputTokens,outputTokens}`, `stopReason`, reasoning kept in `raw` (not
`text`), and no `providerSessionId`. Provider returns no session id by design, so
the discord failover layer re-injects warm-start history — **no Phase 1 history
replay is needed for basic continuity**. **Committed +
[PR #73](https://github.com/your-org/tango/pull/73).** The full Discord-turn
validation is gated on deploy (merge → rebuild → restart) + a dedicated Ollama
channel/agent (Phase 1b) — no second instance needed.

---

## Section 6: Locked decisions

- **Pilot scope:** Phases 0–1 first (text-only worker routing), then evaluate.
- **Hosting:** Ollama Cloud (flat-rate, no local hardware).
- **Pilot model:** DeepSeek V4 Pro (`deepseek-v4-pro:cloud`; paid Ollama Cloud
  tier — active 2026-06-06).
- **Topology (revised 2026-06-06):** same bot, per-channel/per-agent routing —
  **no second bot token or process.** A second token is optional, only for a
  divergent build or distinct identity.
- **No fallback during eval:** Ollama-routed agents run with `fallback: []` so
  failures are *visible* — a Claude fallback would be a false-positive.
- **Data (revised 2026-06-06):** shared (no profile isolation) — accepted. A/B
  via `model_runs.provider_name`; Atlas + Obsidian shared read + write (Phase 0
  text-only agents have no memory tools, so Atlas writes are minimal).
- **Context ownership:** Tango owns the message array — provider-side context
  assembly + compaction (see 2.2), converging with the Unified Memory System; no
  attempt to mirror Claude's opaque server-side sessions.
- **Tool parity:** `WebSearch`/`WebFetch` → `exa` MCP; everything else is already
  MCP-backed and portable (see 2.3).
- **End state:** one codebase, per-agent config selects the provider.

---

## Section 7: Open questions

### 7.1 Confirmed during setup (2026-06-06, live-tested)

- **Endpoints:** native `https://ollama.com/api` (e.g. `/api/generate`);
  OpenAI-compatible `https://ollama.com/v1` (e.g. `/v1/chat/completions`) — note
  `/v1`, **not** `/api/v1`. Auth header: `Authorization: Bearer <OLLAMA_API_KEY>`.
  Both paths verified HTTP 200 with the live key.
- **Pilot model tag:** `deepseek-v4-pro:cloud` — 1.6T/49B MoE, **1M-token
  context**, tool use + three reasoning modes. **Requires a paid Ollama Cloud
  subscription** (free tier 403s "requires a subscription"); subscription active
  as of 2026-06-06.
- **Usage IS returned** (so `model_runs` accounting works): native →
  `prompt_eval_count` / `eval_count`; OpenAI-compat →
  `usage.{prompt_tokens,completion_tokens,total_tokens}`. `totalCostUsd` is null
  (flat subscription).
- **Reasoning is exposed separately** from the answer: native → `thinking`;
  OpenAI-compat → `choices[].message.reasoning`. The provider must read/strip/
  store this, not treat it as answer content.
- **API key source:** 1Password **Watson** vault, item **`Ollama API Credential
  Tango`**, field `credential` — fetch via
  `getSecret("<vault>", "<item>")`
  (`packages/discord/src/op-secret.ts`; requires `OP_SERVICE_ACCOUNT_TOKEN`). No
  device/SSH key needed (HTTP API, not the `ollama` CLI).

### 7.2 Still open / to confirm during build

- `reasoningEffort` → reasoning-mode mapping (no-thinking / thinking / max-
  thinking). Likely wire in Phase 3; pilot default TBD.
- Whether the Ollama instance's worker/classifier targets are genuinely
  LLM-backed vs deterministic (route only the LLM-backed ones).
- Tier volume cap under sustained bot traffic — does it throttle? (Validate
  during pilot.)
- Does `exa` cover arbitrary fetch-by-URL to full `WebFetch` parity, or only
  search + content for search results?
- Confirm no live persona/worker depends on the Claude `Bash`/file built-ins
  (only seen in a test config so far).

---

## Section 8: Risk register

- **Tool-calling reliability** of open models against Tango's MCP toolset — the
  primary quality risk; Phase 2 gates user-facing promotion.
- **New shared infrastructure** (the tool loop) — bugs affect any non-CLI
  provider; build behind dedicated Ollama channels (no fallback, failures visible).
- **mcp-proxy reuse** assumption needs validation for non-Claude callers.
- **Flat-rate durability** — open-weight hosting incentives differ from
  Anthropic's eroding subsidy, but a flat consumer plan driven by an automated
  agent could still be re-metered; treat the flat rate as advantageous, not
  permanent.
- **In-memory history** is fine on the single shared bot; **DB-backed history is
  required before any multi-process use** (e.g. a future divergent-build instance).
- **Context-assembly is now ours to get right** — owning the message array is a
  capability win (2.2), but naive full replay overflows the model's context
  window; the compaction policy is load-bearing, not optional.
- **No fallback is intentional during the eval** — Ollama-routed channels can
  hard-fail visibly; that's the desired signal. Revisit before user-facing
  promotion.
