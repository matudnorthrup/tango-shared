import { describe, expect, it } from "vitest";
import { isClaudeExtractionModel, resolveExtractionProvider } from "../src/extraction-provider.js";

describe("resolveExtractionProvider", () => {
  const claudeServed = { legacyProvider: { default: "claude-code-v2", failover: [] } } as never;
  const ollamaServed = { legacyProvider: { default: "ollama", failover: [] } } as never;

  it("honours an explicit provider", () => {
    expect(resolveExtractionProvider(claudeServed, "codex", "deepseek-v4-pro:cloud")).toBe("codex");
    expect(resolveExtractionProvider(ollamaServed, "claude-oauth", "deepseek-v4-pro:cloud")).toBe("claude-oauth");
  });

  it("infers the provider from the model, not the serving backend", () => {
    expect(resolveExtractionProvider(claudeServed, undefined, "deepseek-v4-pro:cloud")).toBe("ollama");
    expect(resolveExtractionProvider(claudeServed, undefined, "gpt-oss:20b")).toBe("ollama");
    expect(resolveExtractionProvider(ollamaServed, undefined, "claude-haiku-4-5")).toBe("claude-oauth");
    expect(resolveExtractionProvider(claudeServed, undefined, "claude-opus-4-8")).toBe("claude-oauth");
  });

  it("falls back to the serving backend only when no model is known", () => {
    expect(resolveExtractionProvider(claudeServed, undefined, undefined)).toBe("claude-oauth");
    expect(resolveExtractionProvider(ollamaServed, "", "  ")).toBe("ollama");
    expect(resolveExtractionProvider(undefined, undefined, undefined)).toBe("claude-oauth");
  });

  it("recognises claude model ids", () => {
    for (const model of ["claude-haiku-4-5", "claude:sonnet", "haiku", "Opus"]) expect(isClaudeExtractionModel(model)).toBe(true);
    for (const model of ["deepseek-v4-pro:cloud", "glm-5.2", "", undefined, null]) expect(isClaudeExtractionModel(model)).toBe(false);
  });
});
