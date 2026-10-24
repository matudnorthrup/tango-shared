import { describe, expect, it } from "vitest";
import {
  buildContactNameMap,
  mentionsAnyName,
  normalizeIMessageHandle,
  splitForIMessage
} from "../src/imessage-listener.js";

describe("normalizeIMessageHandle", () => {
  it("normalizes chat identifiers and US phone numbers", () => {
    expect(normalizeIMessageHandle("iMessage;+;15551234567")).toBe("+15551234567");
    expect(normalizeIMessageHandle("(555) 123-4567")).toBe("+15551234567");
  });

  it("normalizes email-style handles", () => {
    expect(normalizeIMessageHandle("MailTo:Example@Example.com")).toBe("example@example.com");
  });
});

describe("buildContactNameMap", () => {
  it("extracts names from array and map-shaped contact data", () => {
    const contacts = buildContactNameMap([
      {
        displayName: "Mom",
        phoneNumbers: [{ value: "+15551234567" }]
      },
      {
        firstName: "John",
        lastName: "Appleseed",
        emails: ["john@example.com"]
      }
    ]);

    expect(contacts.get("+15551234567")).toBe("Mom");
    expect(contacts.get("john@example.com")).toBe("John Appleseed");
  });
});

describe("mentionsAnyName", () => {
  it("matches configured trigger names case-insensitively", () => {
    expect(mentionsAnyName("Hey Tango, check this out", ["tango"])).toBe(true);
    expect(mentionsAnyName("hey watson can you help", ["Tango"])).toBe(false);
  });
});

describe("splitForIMessage", () => {
  it("splits long text on paragraph boundaries when possible", () => {
    const input = [
      "First paragraph has enough text to fill the chunk limit.",
      "Second paragraph should land in its own chunk.",
      "Third paragraph finishes the reply."
    ].join("\n\n");

    const chunks = splitForIMessage(input, 70);

    expect(chunks.length).toBe(3);
    expect(chunks[0]).toContain("First paragraph");
    expect(chunks[1]).toContain("Second paragraph");
    expect(chunks[2]).toContain("Third paragraph");
    expect(chunks.every((chunk) => chunk.length <= 70)).toBe(true);
  });
});
