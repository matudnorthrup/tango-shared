import { describe, expect, it } from "vitest";
import { isReadOnlyGogEmailCommand, normalizeGogEmailCommand } from "../src/gog-email-access.js";

describe("gog email access classification", () => {
  it("treats Gmail search, message read, and attachment read commands as read-only", () => {
    expect(isReadOnlyGogEmailCommand("gmail messages search \"Opening Remarks\"")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail messages list newer_than:7d")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail get 198ae0570be212b7")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail messages get 198ae0570be212b7")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail attachment 198ae0570be212b7 library-publication.pdf")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gmail thread 198ae0570be212b7")).toBe(true);
    expect(isReadOnlyGogEmailCommand("messages search \"Opening Remarks\"")).toBe(true);
    expect(isReadOnlyGogEmailCommand("gog gmail messages search \"Opening Remarks\"")).toBe(true);
  });

  it("treats Gmail mutation commands as write operations", () => {
    expect(isReadOnlyGogEmailCommand("gmail thread modify 198ae0570be212b7 --archive")).toBe(false);
    expect(isReadOnlyGogEmailCommand("gmail messages send --to someone@example.com")).toBe(false);
    expect(isReadOnlyGogEmailCommand("gmail draft create --to someone@example.com")).toBe(false);
  });

  it("normalizes optional executable and Gmail prefixes", () => {
    expect(normalizeGogEmailCommand("messages search is:unread")).toBe("gmail messages search is:unread");
    expect(normalizeGogEmailCommand("gog gmail messages search is:unread")).toBe("gmail messages search is:unread");
    expect(normalizeGogEmailCommand("gmail messages search is:unread")).toBe("gmail messages search is:unread");
  });
});
