import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VoiceTargetDirectory,
  extractFromWakeWord,
  extractNamedWakeWord,
  isStrongAddressMatch,
  mentionsWakeName,
  stripLeadingWakePhrase
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-voice-address-routing-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function writeSystem(dir: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, "system.yaml"), `${lines.join("\n")}\n`);
}

function writeAgent(dir: string, fileName: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, "agents", fileName), `${lines.join("\n")}\n`);
}

describe("address routing helpers", () => {
  it("extracts wake words with the same filler-word handling used by voice", () => {
    expect(extractNamedWakeWord("And hello Watson, status", ["Tango", "Watson"])).toEqual({
      matchedName: "Watson",
      transcript: "hello Watson, status"
    });
    expect(extractNamedWakeWord("of Watson continue from the last message", ["Tango", "Watson"])).toEqual({
      matchedName: "Watson",
      transcript: "Watson continue from the last message"
    });
    expect(extractFromWakeWord("Bad luck. Hello Tango, settings", ["Tango", "Watson"])).toBe(
      "Hello Tango, settings"
    );
    expect(mentionsWakeName("I was talking to Watson about it", ["Tango", "Watson"])).toBe(true);
    expect(stripLeadingWakePhrase("Hello Watson, add that to my list", "Watson")).toBe(
      "add that to my list"
    );
  });

  describe("extractNamedWakeWord mid-transcript greeting detection", () => {
    it("detects wake word after comma-separated preamble", () => {
      const result = extractNamedWakeWord("testing, hello, Juliet.", "Juliet");
      expect(result).not.toBeNull();
      expect(result!.matchedName).toBe("Juliet");
      expect(result!.transcript).toBe("hello, Juliet.");
    });

    it("detects wake word after multiple preamble clauses", () => {
      const result = extractNamedWakeWord("okay so, um, hello Watson, how are you?", "Watson");
      expect(result).not.toBeNull();
      expect(result!.matchedName).toBe("Watson");
    });

    it("still matches a bare name at the transcript start", () => {
      const result = extractNamedWakeWord("Juliet says hello to everyone", "Juliet");
      expect(result).not.toBeNull();
    });

    it("does not match name mentioned as subject mid-transcript", () => {
      const result = extractNamedWakeWord("I told Juliet about it", "Juliet");
      expect(result).toBeNull();
    });

    it("handles hey prefix mid-transcript", () => {
      const result = extractNamedWakeWord("blah blah, hey Malibu, check this", "Malibu");
      expect(result).not.toBeNull();
      expect(result!.matchedName).toBe("Malibu");
      expect(result!.transcript).toBe("hey Malibu, check this");
    });
  });

  describe("multi-word call signs with Whisper punctuation", () => {
    it("matches a call sign with a comma inserted between its words", () => {
      const result = extractNamedWakeWord("bravo, malibu,", ["Bravo Malibu"]);
      expect(result).not.toBeNull();
      expect(result!.matchedName).toBe("Bravo Malibu");
    });

    it("still matches the clean two-word form", () => {
      const result = extractNamedWakeWord("bravo malibu", ["Bravo Malibu"]);
      expect(result).not.toBeNull();
      expect(result!.matchedName).toBe("Bravo Malibu");
    });

    it("matches with a period between the words", () => {
      const result = extractNamedWakeWord("Bravo. Malibu, status", ["Bravo Malibu"]);
      expect(result).not.toBeNull();
      expect(result!.matchedName).toBe("Bravo Malibu");
    });

    it("mentionsWakeName tolerates the comma variant", () => {
      expect(mentionsWakeName("I said bravo, malibu earlier", ["Bravo Malibu"])).toBe(true);
    });

    it("stripLeadingWakePhrase removes the comma variant prefix", () => {
      expect(stripLeadingWakePhrase("Bravo, Malibu, status update", ["Bravo Malibu"])).toBe(
        "status update"
      );
    });
  });

  describe("isStrongAddressMatch", () => {
    it("treats multi-word call signs as always strong", () => {
      expect(isStrongAddressMatch("Bravo Malibu", "bravo malibu")).toBe(true);
      expect(isStrongAddressMatch("Bravo Malibu", "bravo, malibu,")).toBe(true);
      expect(isStrongAddressMatch("Bravo Malibu", "bravo malibu check the queue")).toBe(true);
    });

    it("treats a bare name as a strong wake when the utterance ends at the name", () => {
      expect(isStrongAddressMatch("Malibu", "malibu")).toBe(true);
      expect(isStrongAddressMatch("Malibu", "Malibu.")).toBe(true);
      expect(isStrongAddressMatch("Malibu", "malibu!")).toBe(true);
    });

    it("keeps comma/colon-after-name and greeting prefixes strong", () => {
      expect(isStrongAddressMatch("Malibu", "Malibu, check this")).toBe(true);
      expect(isStrongAddressMatch("Watson", "Watson: do this")).toBe(true);
      expect(isStrongAddressMatch("Malibu", "hey malibu what's up")).toBe(true);
      expect(isStrongAddressMatch("Malibu", "hello, malibu, status")).toBe(true);
    });

    it("leaves subject references weak", () => {
      expect(isStrongAddressMatch("Malibu", "malibu says hi")).toBe(false);
      expect(isStrongAddressMatch("Malibu", "malibu's report is due")).toBe(false);
    });
  });
});

describe("VoiceTargetDirectory", () => {
  it("resolves system and agent call signs separately", () => {
    const dir = createConfigDir();
    writeSystem(dir, [
      "display_name: Tango",
      "voice:",
      "  call_signs:",
      "    - Tango"
    ]);
    writeAgent(dir, "watson.yaml", [
      "id: watson",
      "type: personal",
      "display_name: Watson",
      "provider:",
      "  default: codex",
      "voice:",
      "  call_signs:",
      "    - Watson"
    ]);

    const directory = new VoiceTargetDirectory(dir);

    expect(directory.getSystemAgent()).toMatchObject({ id: "system", displayName: "Tango" });
    expect(directory.resolveExplicitAddress("Tango, settings")).toMatchObject({
      kind: "system",
      agent: { id: "system" },
      matchedName: "Tango",
      transcript: "Tango, settings"
    });
    expect(directory.resolveExplicitAddress("Watson, add that to my list")).toMatchObject({
      kind: "agent",
      agent: { id: "watson" },
      matchedName: "Watson",
      transcript: "Watson, add that to my list"
    });
  });

  it("uses the configured default prompt agent and fuzzy agent lookup", () => {
    const dir = createConfigDir();
    writeSystem(dir, [
      "display_name: Tango",
      "voice:",
      "  call_signs:",
      "    - Tango",
      "  default_prompt_agent: malibu"
    ]);
    writeAgent(dir, "watson.yaml", [
      "id: watson",
      "type: personal",
      "display_name: Watson",
      "provider:",
      "  default: codex",
      "voice:",
      "  call_signs:",
      "    - Watson"
    ]);
    writeAgent(dir, "malibu.yaml", [
      "id: malibu",
      "type: fitness",
      "display_name: Malibu",
      "provider:",
      "  default: codex",
      "voice:",
      "  call_signs:",
      "    - Malibu",
      "    - Coach Malibu"
    ]);

    const directory = new VoiceTargetDirectory(dir);

    expect(directory.resolveDefaultPromptAgent(null)?.id).toBe("malibu");
    expect(directory.resolveDefaultPromptAgent("malibu")?.id).toBe("malibu");
    expect(directory.resolveAgentQuery("coach mal")).toMatchObject({ id: "malibu" });
    expect(directory.resolveAgentQuery("tango")).toBeNull();
    expect(directory.resolveAgentQuery("tango", { includeSystem: true })).toMatchObject({
      id: "system"
    });
  });
});
