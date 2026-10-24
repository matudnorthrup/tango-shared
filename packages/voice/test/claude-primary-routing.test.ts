import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceTargetDirectory, isStrongAddressMatch } from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-voice-claude-primary-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  return dir;
}

function writeAgent(dir: string, fileName: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, "agents", fileName), `${lines.join("\n")}\n`);
}

// 2026-07-18 claude-primary flip (TGO-809): inverse of the June Ollama-primary
// scheme (PR #110). Bare names, greetings, and nicknames reach the original
// Claude-backed agents again; the clones keep "Bravo X" and gain "Zulu X" as
// escape-hatch wake words.
describe("Claude-primary call-sign scheme", () => {
  function buildPairDirectory(options?: { systemDefault?: string }): VoiceTargetDirectory {
    const dir = createConfigDir();
    fs.writeFileSync(path.join(dir, "system.yaml"), [
      "display_name: Tango",
      "voice:",
      "  call_signs:",
      "    - Tango",
      `  default_prompt_agent: ${options?.systemDefault ?? "malibu"}`,
      ""
    ].join("\n"));
    writeAgent(dir, "watson.yaml", [
      "id: watson",
      "type: personal",
      "display_name: Watson",
      "provider:",
      "  default: claude-oauth",
      "voice:",
      "  call_signs:",
      "    - Watson"
    ]);
    writeAgent(dir, "watson-ollama.yaml", [
      "id: watson-ollama",
      "type: personal",
      "display_name: Watson (Ollama)",
      "provider:",
      "  default: ollama",
      "voice:",
      "  call_signs:",
      '    - "Bravo Watson"',
      '    - "Zulu Watson"'
    ]);
    return new VoiceTargetDirectory(dir);
  }

  it("routes the bare name and hey/hello greetings to the original", () => {
    const directory = buildPairDirectory();
    for (const transcript of [
      "Watson, status update",
      "watson",
      "hello Watson, status update",
      "hey watson what's up"
    ]) {
      expect(directory.resolveExplicitAddress(transcript)).toMatchObject({
        agent: { id: "watson" }
      });
    }
  });

  it("routes Bravo forms to the clone, including Whisper comma variants", () => {
    const directory = buildPairDirectory();
    expect(directory.resolveExplicitAddress("Bravo Watson, status")).toMatchObject({
      agent: { id: "watson-ollama" },
      matchedName: "Bravo Watson"
    });
    expect(directory.resolveExplicitAddress("bravo, watson status")).toMatchObject({
      agent: { id: "watson-ollama" },
      matchedName: "Bravo Watson"
    });
  });

  it("routes Zulu forms to the clone, including greeting and comma variants", () => {
    const directory = buildPairDirectory();
    for (const transcript of [
      "Zulu Watson, status",
      "zulu, watson, status",
      "hello Zulu Watson, status"
    ]) {
      expect(directory.resolveExplicitAddress(transcript)).toMatchObject({
        agent: { id: "watson-ollama" },
        matchedName: "Zulu Watson"
      });
    }
  });

  it("keeps Zulu forms strong addresses that survive cross-agent downgrade checks", () => {
    expect(isStrongAddressMatch("Zulu Watson", "zulu watson check the queue")).toBe(true);
    expect(isStrongAddressMatch("Zulu Watson", "zulu, watson,")).toBe(true);
  });

  it("leaves the Tango system call sign untouched", () => {
    const directory = buildPairDirectory();
    expect(directory.resolveExplicitAddress("Tango, settings")).toMatchObject({
      kind: "system",
      agent: { id: "system" }
    });
  });

  it("prefers the configured default prompt agent", () => {
    const directory = buildPairDirectory({ systemDefault: "watson" });
    expect(directory.resolveDefaultPromptAgent(null)?.id).toBe("watson");
  });

  it("falls back to watson before watson-ollama when no default is configured", () => {
    const directory = buildPairDirectory();
    expect(directory.resolveDefaultPromptAgent(null)?.id).toBe("watson");
  });
});

describe("shipped repo config call-sign matrix", () => {
  interface RepoAgent {
    id: string;
    type?: string;
    callSigns: string[];
  }

  function loadRepoAgents(): RepoAgent[] {
    const agentsDir = path.join(repoRoot, "config/v2/agents");
    const agents: RepoAgent[] = [];
    for (const fileName of fs.readdirSync(agentsDir)) {
      if (!fileName.endsWith(".yaml")) continue;
      const parsed = yaml.load(
        fs.readFileSync(path.join(agentsDir, fileName), "utf8")
      ) as { id: string; type?: string; voice?: { call_signs?: string[] } };
      const callSigns = parsed.voice?.call_signs ?? [];
      if (callSigns.length === 0) continue;
      agents.push({ id: parsed.id, type: parsed.type, callSigns });
    }
    return agents;
  }

  function buildRepoDirectory(): VoiceTargetDirectory {
    // Rebuild the live address book from the real repo call signs. The live
    // profile overlay only flips `enabled` and channel ids — call signs come
    // from these repo files — so this exercises the shipped routing data
    // with the production matcher regardless of repo-side enabled flags.
    const dir = createConfigDir();
    fs.copyFileSync(path.join(repoRoot, "config/defaults/system.yaml"), path.join(dir, "system.yaml"));
    for (const agent of loadRepoAgents()) {
      writeAgent(dir, `${agent.id}.yaml`, [
        `id: ${agent.id}`,
        `type: ${agent.type ?? "personal"}`,
        "provider:",
        "  default: claude-oauth",
        "voice:",
        "  call_signs:",
        ...agent.callSigns.map((sign) => `    - ${JSON.stringify(sign)}`)
      ]);
    }
    return new VoiceTargetDirectory(dir);
  }

  const PAIRED_NAMES = [
    "Watson",
    "Sierra",
    "Malibu",
    "Victor",
    "Charlie",
    "Foxtrot",
    "Juliet"
  ];

  it("routes every wake form of every clone pair to the intended agent", () => {
    const directory = buildRepoDirectory();
    for (const name of PAIRED_NAMES) {
      const clone = `${name.toLowerCase()}-ollama`;
      const original = name.toLowerCase();
      const expectations: Array<[string, string]> = [
        [`${name}, status update`, original],
        [`hello ${name}, status update`, original],
        [`hey ${name} what's up`, original],
        [`Bravo ${name}, status update`, clone],
        [`bravo, ${name.toLowerCase()} status`, clone],
        [`Zulu ${name}, status update`, clone],
        [`zulu, ${name.toLowerCase()}, status`, clone]
      ];
      for (const [transcript, expectedAgentId] of expectations) {
        const resolved = directory.resolveExplicitAddress(transcript);
        expect(resolved?.agent.id, `"${transcript}" should reach ${expectedAgentId}`).toBe(
          expectedAgentId
        );
      }
    }
  });

  it("keeps nickname aliases on the originals", () => {
    const directory = buildRepoDirectory();
    expect(directory.resolveExplicitAddress("Mali, hi")?.agent.id).toBe("malibu");
    expect(directory.resolveExplicitAddress("Coach Malibu, hi")?.agent.id).toBe("malibu");
  });

  it("keeps unpaired agents on their bare names", () => {
    const directory = buildRepoDirectory();
    expect(directory.resolveExplicitAddress("Kilo, balance check")?.agent.id).toBe("kilo");
    expect(directory.resolveExplicitAddress("Tango, settings")?.kind).toBe("system");
  });

  it("defaults unaddressed speech to watson", () => {
    const directory = buildRepoDirectory();
    expect(directory.resolveDefaultPromptAgent(null)?.id).toBe("watson");
  });

  it("keeps kilo on the Ollama backend (TGO-735, unchanged by TGO-809)", () => {
    const kilo = yaml.load(
      fs.readFileSync(path.join(repoRoot, "config/v2/agents/kilo.yaml"), "utf8")
    ) as { provider?: { default?: string }; runtime?: { model?: string } };
    expect(kilo.provider?.default).toBe("ollama");
    expect(kilo.runtime?.model).toBe("role:kid-ledger");
  });
});
