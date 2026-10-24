import type { ChatProvider, ProviderRequest, ProviderResponse } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderFailoverError,
  generateWithFailover,
  resetProviderCircuitStateForTests,
} from "../src/provider-failover.js";

class ScriptedProvider implements ChatProvider {
  readonly calls: ProviderRequest[] = [];

  constructor(
    private readonly impl: (callNumber: number, request: ProviderRequest) => ProviderResponse | Error
  ) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const result = this.impl(this.calls.length, request);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }
}

describe("generateWithFailover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetProviderCircuitStateForTests();
  });

  it("retries primary provider before succeeding without failover", async () => {
    const primary = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) return new Error("primary transient");
      return { text: "primary-ok" };
    });
    const secondary = new ScriptedProvider(() => ({ text: "secondary-ok" }));

    const result = await generateWithFailover(
      [
        { providerName: "primary", provider: primary },
        { providerName: "secondary", provider: secondary }
      ],
      { prompt: "hello" },
      1
    );

    expect(result.providerName).toBe("primary");
    expect(result.usedFailover).toBe(false);
    expect(result.warmStartUsed).toBe(false);
    expect(result.retryResult.attempts).toBe(2);
    expect(result.failures).toHaveLength(0);
    expect(primary.calls).toHaveLength(2);
    expect(secondary.calls).toHaveLength(0);
  });

  it("fails over to secondary provider and reuses continuity only for matching provider", async () => {
    const primary = new ScriptedProvider(() => new Error("primary down"));
    const secondary = new ScriptedProvider((_callNumber, request) => ({
      text: "secondary-ok",
      providerSessionId: request.providerSessionId
    }));

    const result = await generateWithFailover(
      [
        { providerName: "primary", provider: primary },
        { providerName: "secondary", provider: secondary }
      ],
      { prompt: "hello" },
      0,
      { secondary: "sess-2" }
    );

    expect(result.providerName).toBe("secondary");
    expect(result.usedFailover).toBe(true);
    expect(result.warmStartUsed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.providerName).toBe("primary");
    expect(primary.calls[0]?.providerSessionId).toBeUndefined();
    expect(secondary.calls[0]?.providerSessionId).toBe("sess-2");
  });

  it("throws ProviderFailoverError when all providers fail", async () => {
    const primary = new ScriptedProvider(() => new Error("primary down"));
    const secondary = new ScriptedProvider(() => new Error("secondary down"));

    await expect(
      generateWithFailover(
        [
          { providerName: "primary", provider: primary },
          { providerName: "secondary", provider: secondary }
        ],
        { prompt: "hello" },
        0
      )
    ).rejects.toBeInstanceOf(ProviderFailoverError);

    try {
      await generateWithFailover(
        [
          { providerName: "primary", provider: primary },
          { providerName: "secondary", provider: secondary }
        ],
        { prompt: "hello" },
        0
      );
      throw new Error("expected failover error");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderFailoverError);
      const failoverError = error as ProviderFailoverError;
      expect(failoverError.failures).toHaveLength(2);
      expect(failoverError.totalAttempts).toBe(2);
    }
  });

  it("injects warm-start context when switching providers without continuity", async () => {
    const primary = new ScriptedProvider(() => new Error("primary down"));
    const secondary = new ScriptedProvider((_callNumber, request) => ({
      text: request.prompt
    }));

    const result = await generateWithFailover(
      [
        { providerName: "primary", provider: primary },
        { providerName: "secondary", provider: secondary }
      ],
      { prompt: "what's next?" },
      0,
      {},
      { warmStartPrompt: "Context handoff packet:\n- last action completed" }
    );

    expect(result.providerName).toBe("secondary");
    expect(result.usedFailover).toBe(true);
    expect(result.warmStartUsed).toBe(true);
    expect(secondary.calls[0]?.prompt).toContain("Context handoff packet");
    expect(secondary.calls[0]?.prompt).toContain("Current user message");
  });

  it("injects current turn metadata even when continuity skips warm-start", async () => {
    const primary = new ScriptedProvider((_callNumber, request) => ({
      text: request.prompt,
      providerSessionId: request.providerSessionId,
    }));

    const result = await generateWithFailover(
      [{ providerName: "primary", provider: primary }],
      { prompt: "log this in my journal" },
      0,
      { primary: "sess-1" },
      {
        warmStartPrompt: "Context handoff packet:\n- older context",
        currentTurnMetadataPrompt: [
          "Current user message metadata:",
          "- timestamp_utc: 2026-05-19T19:25:11.000Z",
          "- timestamp_source: discord-sent",
        ].join("\n"),
      }
    );

    expect(result.providerName).toBe("primary");
    expect(result.warmStartUsed).toBe(false);
    expect(primary.calls[0]?.providerSessionId).toBe("sess-1");
    expect(primary.calls[0]?.prompt).not.toContain("Context handoff packet");
    expect(primary.calls[0]?.prompt).toContain("Current user message metadata");
    expect(primary.calls[0]?.prompt).toContain("timestamp_source: discord-sent");
    expect(primary.calls[0]?.prompt).toContain("Current user message:\nlog this in my journal");
  });

  it("retries Claude on a fast hard failure before opening circuit and failing over", async () => {
    const claude = new ScriptedProvider(() => new Error("Claude CLI request failed: code=1"));
    const codex = new ScriptedProvider(() => ({ text: "codex-ok" }));

    const result = await generateWithFailover(
      [
        { providerName: "claude-oauth", provider: claude },
        { providerName: "codex", provider: codex },
      ],
      { prompt: "hello" },
      2,
    );

    expect(result.providerName).toBe("codex");
    expect(result.usedFailover).toBe(true);
    expect(claude.calls).toHaveLength(3);
    expect(codex.calls).toHaveLength(1);
    expect(result.failures[0]?.providerName).toBe("claude-oauth");
    expect(result.failures[0]?.attempts).toBe(3);
  });

  it("uses a longer retry backoff for Ollama 429 overloads", async () => {
    vi.useFakeTimers();
    const ollama = new ScriptedProvider((callNumber) => {
      if (callNumber < 3) {
        return new Error('Ollama request failed: status=429 body={"error":"too many concurrent requests"}');
      }
      return { text: "ollama-ok" };
    });

    const resultPromise = generateWithFailover(
      [{ providerName: "ollama", provider: ollama }],
      { prompt: "hello" },
      2,
    );

    await vi.advanceTimersByTimeAsync(1_499);
    expect(ollama.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(ollama.calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(ollama.calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(result.providerName).toBe("ollama");
    expect(result.retryResult.attempts).toBe(3);
    expect(result.retryResult.attemptErrors).toHaveLength(2);
    expect(result.retryResult.response.text).toBe("ollama-ok");
  });

  it("retries Claude on an empty-response failure before opening circuit and failing over", async () => {
    const claude = new ScriptedProvider(() => new Error("Claude CLI request failed: Claude CLI returned an empty response"));
    const codex = new ScriptedProvider(() => ({ text: "codex-ok" }));

    const result = await generateWithFailover(
      [
        { providerName: "claude-oauth", provider: claude },
        { providerName: "codex", provider: codex },
      ],
      { prompt: "hello" },
      2,
    );

    expect(result.providerName).toBe("codex");
    expect(result.usedFailover).toBe(true);
    expect(claude.calls).toHaveLength(3);
    expect(codex.calls).toHaveLength(1);
    expect(result.failures[0]?.providerName).toBe("claude-oauth");
    expect(result.failures[0]?.attempts).toBe(3);
  });

  it("skips Claude while its circuit is open from a recent hard failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const claude = new ScriptedProvider(() => new Error("Claude CLI request failed: code=1"));
    const codex = new ScriptedProvider(() => ({ text: "codex-ok" }));

    await generateWithFailover(
      [
        { providerName: "claude-oauth", provider: claude },
        { providerName: "codex", provider: codex },
      ],
      { prompt: "first" },
      1,
    );

    claude.calls.length = 0;
    codex.calls.length = 0;

    vi.spyOn(Date, "now").mockReturnValue(2_000);

    const result = await generateWithFailover(
      [
        { providerName: "claude-oauth", provider: claude },
        { providerName: "codex", provider: codex },
      ],
      { prompt: "second" },
      1,
    );

    expect(result.providerName).toBe("codex");
    expect(claude.calls).toHaveLength(0);
    expect(codex.calls).toHaveLength(1);
    expect(result.failures[0]?.providerName).toBe("claude-oauth");
    expect(result.failures[0]?.attempts).toBe(0);
    expect(result.failures[0]?.lastError).toContain("circuit-open");
  });

  it("skips Claude while its circuit is open from a recent empty-response failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const claude = new ScriptedProvider(() => new Error("Claude CLI request failed: Claude CLI returned an empty response"));
    const codex = new ScriptedProvider(() => ({ text: "codex-ok" }));

    await generateWithFailover(
      [
        { providerName: "claude-oauth", provider: claude },
        { providerName: "codex", provider: codex },
      ],
      { prompt: "first" },
      1,
    );

    claude.calls.length = 0;
    codex.calls.length = 0;

    vi.spyOn(Date, "now").mockReturnValue(2_000);

    const result = await generateWithFailover(
      [
        { providerName: "claude-oauth", provider: claude },
        { providerName: "codex", provider: codex },
      ],
      { prompt: "second" },
      1,
    );

    expect(result.providerName).toBe("codex");
    expect(claude.calls).toHaveLength(0);
    expect(codex.calls).toHaveLength(1);
    expect(result.failures[0]?.providerName).toBe("claude-oauth");
    expect(result.failures[0]?.attempts).toBe(0);
    expect(result.failures[0]?.lastError).toContain("circuit-open");
  });
});
