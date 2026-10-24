import type { V2AgentConfig } from "@tango/core";

/** True for Claude model ids (`claude-*`, `claude:*`, bare `haiku`/`sonnet`/`opus`). */
export function isClaudeExtractionModel(model: string | null | undefined): boolean {
  return typeof model === "string" && /^(?:claude(?:-|:)|haiku|sonnet|opus)/iu.test(model.trim());
}

/**
 * Provider used for post-turn extraction work (memory capture, active-task
 * continuation, state reconciliation and supersession).
 *
 * Explicit config always wins. Otherwise the provider is inferred from the
 * MODEL rather than from the agent's serving backend: the 2026-07-18
 * claude-primary flip (TGO-809) moved turns to the Claude CLI but kept
 * `extraction_model: deepseek-v4-pro:cloud` on purpose, and the old
 * backend-based default sent that Ollama tag to the Claude CLI, which
 * rejected it on every turn until 2026-09-04 (TGO-867). A Claude model id
 * routes to `claude-oauth`; anything else routes to `ollama`. Only when no
 * model is known at all do we fall back to the serving backend.
 */
export function resolveExtractionProvider(
  v2Config: Pick<V2AgentConfig, "legacyProvider"> | null | undefined,
  explicitProvider: string | null | undefined,
  model: string | null | undefined,
): string {
  if (explicitProvider && explicitProvider.trim()) return explicitProvider;
  if (typeof model === "string" && model.trim()) {
    return isClaudeExtractionModel(model) ? "claude-oauth" : "ollama";
  }
  return v2Config?.legacyProvider?.default === "ollama" ? "ollama" : "claude-oauth";
}
