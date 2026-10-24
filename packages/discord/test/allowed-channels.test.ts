import { describe, expect, it } from "vitest";
import { isChannelAllowed, parseAllowedChannels } from "../src/allowed-channels.js";

describe("parseAllowedChannels", () => {
  it("returns null when the env var is unset or blank", () => {
    expect(parseAllowedChannels(undefined)).toBeNull();
    expect(parseAllowedChannels("")).toBeNull();
    expect(parseAllowedChannels("   ")).toBeNull();
  });

  it("parses a single allowed channel id", () => {
    expect(parseAllowedChannels("111")).toEqual(new Set(["111"]));
  });

  it("parses multiple allowed channel ids", () => {
    expect(parseAllowedChannels("111,222,333")).toEqual(new Set(["111", "222", "333"]));
  });

  it("trims whitespace around ids", () => {
    expect(parseAllowedChannels("  111 , 222  ,  333  ")).toEqual(
      new Set(["111", "222", "333"]),
    );
  });

  it("drops empty tokens between commas", () => {
    expect(parseAllowedChannels("111,,222")).toEqual(new Set(["111", "222"]));
  });
});

describe("isChannelAllowed", () => {
  it("allows all channels when no allowlist is configured", () => {
    expect(isChannelAllowed("111", null)).toBe(true);
  });

  it("allows channels present in the allowlist", () => {
    expect(isChannelAllowed("111", new Set(["111", "222"]))).toBe(true);
  });

  it("rejects channels that are not allowlisted", () => {
    expect(isChannelAllowed("333", new Set(["111", "222"]))).toBe(false);
    expect(isChannelAllowed("", new Set(["111"]))).toBe(false);
  });
});
