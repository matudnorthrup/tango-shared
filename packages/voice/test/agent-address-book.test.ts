import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadVoiceAddressAgents,
  toVoiceAddressAgent,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-voice-addresses-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

describe("toVoiceAddressAgent", () => {
  it("returns null when an agent has no call signs", () => {
    expect(
      toVoiceAddressAgent({
        id: "dispatch",
        type: "router",
        provider: { default: "claude-oauth" },
      }),
    ).toBeNull();
  });

  it("deduplicates and normalizes call signs", () => {
    const agent = toVoiceAddressAgent({
      id: "watson",
      type: "personal",
      displayName: "Watson",
      defaultTopic: "personal/default",
      defaultProject: "personal",
      provider: { default: "codex" },
      voice: {
        callSigns: [" Watson ", "watson", "Wats"],
        defaultPromptAgent: "dispatch",
        kokoroVoice: "bm_george",
      },
    });

    expect(agent).toEqual({
      id: "watson",
      type: "personal",
      displayName: "Watson",
      callSigns: ["Watson", "Wats"],
      defaultTopic: "personal/default",
      defaultProject: "personal",
      defaultPromptAgent: "dispatch",
      kokoroVoice: "bm_george",
    });
  });
});

describe("loadVoiceAddressAgents", () => {
  it("loads only agents with voice call signs from config", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "dispatch.yaml"),
      [
        "id: dispatch",
        "type: router",
        "display_name: Tango",
        "provider:",
        "  default: claude-oauth",
        "voice:",
        "  call_signs:",
        "    - Tango",
        "  default_prompt_agent: watson",
        "  kokoro_voice: bm_george"
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "agents", "watson.yaml"),
      [
        "id: watson",
        "type: personal",
        "display_name: Watson",
        "provider:",
        "  default: codex",
        "voice:",
        "  call_signs:",
        "    - Watson",
        "  default_prompt_agent: dispatch",
        "  kokoro_voice: bm_george",
        "default_topic: personal/default",
        "default_project: personal"
      ].join("\n"),
    );

    expect(loadVoiceAddressAgents(dir)).toEqual([
      {
        id: "dispatch",
        type: "router",
        displayName: "Tango",
        callSigns: ["Tango"],
        defaultTopic: undefined,
        defaultProject: undefined,
        defaultPromptAgent: "watson",
        kokoroVoice: "bm_george",
      },
      {
        id: "watson",
        type: "personal",
        displayName: "Watson",
        callSigns: ["Watson"],
        defaultTopic: "personal/default",
        defaultProject: "personal",
        defaultPromptAgent: "dispatch",
        kokoroVoice: "bm_george",
      },
    ]);
  });
});
