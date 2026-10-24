import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceTargetDirectory } from "@tango/voice";
import { parseNaturalTextRoute } from "../src/natural-routing.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-discord-natural-routing-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  return dir;
}

function writeAgent(dir: string, fileName: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, "agents", fileName), `${lines.join("\n")}\n`);
}

function writeProject(dir: string, fileName: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, "projects", fileName), `${lines.join("\n")}\n`);
}

function createVoiceTargets(): VoiceTargetDirectory {
  const dir = createConfigDir();
  writeAgent(dir, "dispatch.yaml", [
    "id: dispatch",
    "type: router",
    "display_name: Tango",
    "provider:",
    "  default: claude-oauth",
    "voice:",
    "  call_signs:",
    "    - Tango",
    "  default_prompt_agent: watson"
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
    "    - Malibu"
  ]);
  writeAgent(dir, "sierra.yaml", [
    "id: sierra",
    "type: travel",
    "display_name: Sierra",
    "provider:",
    "  default: codex",
    "voice:",
    "  call_signs:",
    "    - Sierra"
  ]);
  writeProject(dir, "tango.yaml", [
    "id: tango",
    "display_name: Tango MVP",
    "aliases:",
    "  - tango mvp",
    "default_agent: watson",
    "provider:",
    "  default: claude-harness",
    "  fallback:",
    "    - codex"
  ]);
  return new VoiceTargetDirectory(dir);
}

describe("parseNaturalTextRoute", () => {
  it("routes direct agent addresses through the shared call-sign parser", () => {
    const route = parseNaturalTextRoute({
      text: "Watson, say hello in five words",
      voiceTargets: createVoiceTargets()
    });

    expect(route.addressedAgentId).toBe("watson");
    expect(route.promptText).toBe("say hello in five words");
    expect(route.systemCommand).toBeNull();
  });

  it("does not treat a leading agent name as an address when used as the sentence subject", () => {
    const route = parseNaturalTextRoute({
      text: "Sierra was recommending Tlayudas. What's your thoughts there?",
      voiceTargets: createVoiceTargets(),
      focusedAgentId: "malibu"
    });

    expect(route.addressedAgentId).toBe("malibu");
    expect(route.promptText).toBe("Sierra was recommending Tlayudas. What's your thoughts there?");
    expect(route.systemCommand).toBeNull();
  });

  it("still treats a comma-delimited leading agent name as a direct address", () => {
    const route = parseNaturalTextRoute({
      text: "Sierra, what do you think about Tlayudas?",
      voiceTargets: createVoiceTargets(),
      focusedAgentId: "malibu"
    });

    expect(route.addressedAgentId).toBe("sierra");
    expect(route.promptText).toBe("what do you think about Tlayudas?");
    expect(route.systemCommand).toBeNull();
  });

  it("parses Tango focus commands with the same phrasing as voice", () => {
    const route = parseNaturalTextRoute({
      text: "Tango, talk to Malibu",
      voiceTargets: createVoiceTargets()
    });

    expect(route.systemCommand).toEqual({
      type: "focus-agent",
      agentQuery: "malibu"
    });
  });

  it("parses Tango current-agent commands", () => {
    const route = parseNaturalTextRoute({
      text: "Tango, who am I talking to?",
      voiceTargets: createVoiceTargets()
    });

    expect(route.systemCommand).toEqual({ type: "current-agent" });
  });

  it("falls through to the focused agent for plain follow-up text", () => {
    const route = parseNaturalTextRoute({
      text: "keep going",
      voiceTargets: createVoiceTargets(),
      focusedAgentId: "malibu"
    });

    expect(route.addressedAgentId).toBe("malibu");
    expect(route.systemCommand).toBeNull();
  });

  it("keeps Tango-addressed non-command prompts routed through the focused agent", () => {
    const route = parseNaturalTextRoute({
      text: "Tango, continue that thought",
      voiceTargets: createVoiceTargets(),
      focusedAgentId: "watson"
    });

    expect(route.promptText).toBe("continue that thought");
    expect(route.addressedAgentId).toBe("watson");
    expect(route.systemCommand).toBeNull();
  });

  it("parses Tango topic commands", () => {
    const route = parseNaturalTextRoute({
      text: "Tango, open topic auth redesign",
      voiceTargets: createVoiceTargets()
    });

    expect(route.systemCommand).toEqual({
      type: "open-topic",
      topicName: "auth redesign",
      projectName: null,
      standalone: true
    });
  });

  it("parses Tango standalone topic commands", () => {
    const route = parseNaturalTextRoute({
      text: "Tango, open standalone topic auth redesign",
      voiceTargets: createVoiceTargets()
    });

    expect(route.systemCommand).toEqual({
      type: "open-topic",
      topicName: "auth redesign",
      projectName: null,
      standalone: true
    });
  });

  it("parses Tango topic-in-project commands", () => {
    const route = parseNaturalTextRoute({
      text: "Tango, open topic auth redesign in project tango mvp",
      voiceTargets: createVoiceTargets()
    });

    expect(route.systemCommand).toEqual({
      type: "open-topic",
      topicName: "auth redesign",
      projectName: "tango mvp",
      standalone: false
    });
  });

  it("parses Tango move-topic commands", () => {
    const route = parseNaturalTextRoute({
      text: "Tango, move topic auth redesign to project tango mvp",
      voiceTargets: createVoiceTargets()
    });

    expect(route.systemCommand).toEqual({
      type: "move-topic-to-project",
      topicName: "auth redesign",
      projectName: "tango mvp"
    });
  });

  it("parses Tango detach-topic commands", () => {
    const named = parseNaturalTextRoute({
      text: "Tango, detach topic auth redesign from project",
      voiceTargets: createVoiceTargets()
    });
    expect(named.systemCommand).toEqual({
      type: "detach-topic-from-project",
      topicName: "auth redesign"
    });

    const current = parseNaturalTextRoute({
      text: "Tango, make this topic standalone",
      voiceTargets: createVoiceTargets()
    });
    expect(current.systemCommand).toEqual({
      type: "detach-topic-from-project",
      topicName: null
    });
  });

  it("extracts inline topic references for agent-addressed prompts", () => {
    const route = parseNaturalTextRoute({
      text: "Watson, in auth redesign, draft acceptance criteria",
      voiceTargets: createVoiceTargets()
    });

    expect(route.addressedAgentId).toBe("watson");
    expect(route.topicName).toBe("auth redesign");
    expect(route.promptText).toBe("draft acceptance criteria");
  });

  it("extracts inline topic references for Tango-addressed prompts that fall through to the focused agent", () => {
    const route = parseNaturalTextRoute({
      text: "Tango, in auth redesign, continue that thought",
      voiceTargets: createVoiceTargets(),
      focusedAgentId: "watson"
    });

    expect(route.addressedAgentId).toBe("watson");
    expect(route.topicName).toBe("auth redesign");
    expect(route.promptText).toBe("continue that thought");
    expect(route.systemCommand).toBeNull();
  });

  it("parses Tango project commands", () => {
    const route = parseNaturalTextRoute({
      text: "Tango, open project tango mvp",
      voiceTargets: createVoiceTargets()
    });

    expect(route.systemCommand).toEqual({
      type: "open-project",
      projectName: "tango mvp"
    });
  });
});
