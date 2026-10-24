import { describe, expect, it } from "vitest";
import { resolveWarmStartContinuityMode } from "../src/orchestrator-continuity.js";

describe("resolveWarmStartContinuityMode", () => {
  it("forces Ollama-backed agents to stateless", () => {
    expect(
      resolveWarmStartContinuityMode({
        isOllamaBacked: true,
        sessionMode: "provider",
      }),
    ).toBe("stateless");
  });

  it("honors stateless session YAML for Claude-backed agents", () => {
    expect(
      resolveWarmStartContinuityMode({
        isOllamaBacked: false,
        sessionMode: "stateless",
      }),
    ).toBe("stateless");
  });

  it("keeps provider mode as the default for Claude-backed agents", () => {
    expect(
      resolveWarmStartContinuityMode({
        isOllamaBacked: false,
      }),
    ).toBe("provider");
  });
});
