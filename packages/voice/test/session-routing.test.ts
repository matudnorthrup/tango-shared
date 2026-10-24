import { describe, expect, it } from "vitest";
import {
  buildDefaultSessionKey,
  buildDiscordChannelSessionKey,
  countOpenAiUserPrefixes,
  extractChannelIdFromSessionKey,
  normalizeCompletionSessionKey,
  stripOpenAiUserPrefixes
} from "../src/index.js";

describe("session routing helpers", () => {
  it("builds canonical default and discord channel session keys", () => {
    expect(buildDefaultSessionKey("main")).toBe("agent:main:main");
    expect(buildDiscordChannelSessionKey("main", "12345")).toBe(
      "agent:main:discord:channel:12345"
    );
  });

  it("normalizes nested openai-user aliases back to the canonical channel key", () => {
    const canonical = buildDiscordChannelSessionKey("main", "12345");
    const nested =
      "agent:main:openai-user:agent:main:openai-user:" + canonical;

    expect(countOpenAiUserPrefixes("main", nested)).toBe(2);
    expect(stripOpenAiUserPrefixes("main", nested)).toBe(canonical);
    expect(normalizeCompletionSessionKey("main", nested)).toBe(canonical);
  });

  it("preserves non-channel session keys after stripping openai-user prefixes", () => {
    const aliased = "agent:main:openai-user:agent:main:utility";

    expect(stripOpenAiUserPrefixes("main", aliased)).toBe("agent:main:utility");
    expect(normalizeCompletionSessionKey("main", aliased)).toBe("agent:main:utility");
  });

  it("extracts discord channel ids from canonical and aliased session keys", () => {
    const canonical = buildDiscordChannelSessionKey("main", "987654321");
    const aliased = `agent:main:openai-user:${canonical}`;

    expect(extractChannelIdFromSessionKey(canonical)).toBe("987654321");
    expect(extractChannelIdFromSessionKey(aliased)).toBe("987654321");
  });
});
