import fs from "node:fs";
import path from "node:path";
import { loadSystemIdentity, resolveConfigDir } from "@tango/core";
import { loadVoiceAddressAgents, type VoiceAddressAgent } from "./agent-address-book.js";

export interface MatchedWakeWord {
  matchedName: string;
  transcript: string;
}

export interface ResolvedVoiceAddress {
  kind: "system" | "agent";
  agent: VoiceAddressAgent;
  matchedName: string;
  transcript: string;
}

type WakeNamesInput = string | string[];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex fragment matching a wake name while tolerating the punctuation
 * Whisper inserts between the words of a multi-word call sign
 * ("Bravo Malibu" is often transcribed as "bravo, malibu").
 */
export function wakeNamePattern(wakeName: string): string {
  return wakeName
    .trim()
    .split(/\s+/)
    .map(escapeRegex)
    .join("[,.]?\\s+");
}

/**
 * True when a resolved address is clearly intentional: a multi-word call
 * sign ("Bravo Malibu"), a greeting prefix ("hey malibu ..."), a comma or
 * colon right after the name ("Malibu, check this"), or the utterance
 * ending at the name (a bare wake like "malibu."). Subject references
 * ("Malibu says hi") stay false so channel context can claim them.
 */
export function isStrongAddressMatch(matchedName: string, transcript: string): boolean {
  const trimmed = transcript.trim();
  if (!trimmed) return false;

  // Multi-word call signs exist precisely to be unambiguous addresses.
  if (/\s/.test(matchedName.trim())) return true;

  const namePattern = wakeNamePattern(matchedName);
  const greetingPrefix = new RegExp(`^(?:hey|hello)[,\\s]+${namePattern}(?:\\b|[,:])`, "i");
  if (greetingPrefix.test(trimmed)) return true;

  const nameMatch = trimmed.match(new RegExp(namePattern, "i"));
  if (nameMatch?.index === undefined) return false;
  const afterName = trimmed.slice(nameMatch.index + nameMatch[0].length);
  if (/^[,:]/.test(afterName)) return true;
  return /^[\s.!?;]*$/.test(afterName);
}

function normalizeWakeNames(input: WakeNamesInput): string[] {
  const values = Array.isArray(input) ? input : [input];
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function matchWakeNameAtStart(transcript: string, wakeNames: string[]): MatchedWakeWord | null {
  const fillerWords = "(?:and|so|okay|oh|um|uh|well|like|but|now|of)";

  for (const wakeName of wakeNames) {
    const wakeCore = `(?:(?:hey|hello),?\\s+)?${wakeNamePattern(wakeName)}\\b`;

    if (new RegExp(`^${wakeCore}`, "i").test(transcript)) {
      return { matchedName: wakeName, transcript };
    }

    if (new RegExp(`^${fillerWords}[,.]?\\s+${wakeCore}`, "i").test(transcript)) {
      const wakeMatch = transcript.match(new RegExp(wakeCore, "i"));
      if (wakeMatch?.index !== undefined) {
        return {
          matchedName: wakeName,
          transcript: transcript.slice(wakeMatch.index)
        };
      }
    }
  }

  return null;
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreAgentQuery(query: string, agent: VoiceAddressAgent): number {
  const normalizedQuery = normalizeMatchText(query);
  if (!normalizedQuery) return 0;

  if (normalizeMatchText(agent.id) === normalizedQuery) return 400;
  if (normalizeMatchText(agent.displayName) === normalizedQuery) return 350;

  for (const callSign of agent.callSigns) {
    const normalizedCallSign = normalizeMatchText(callSign);
    if (normalizedCallSign === normalizedQuery) return 500;
    if (
      normalizedCallSign.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedCallSign)
    ) {
      return 250;
    }
  }

  const normalizedDisplay = normalizeMatchText(agent.displayName);
  if (
    normalizedDisplay.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedDisplay)
  ) {
    return 200;
  }

  const normalizedId = normalizeMatchText(agent.id);
  if (normalizedId.includes(normalizedQuery) || normalizedQuery.includes(normalizedId)) {
    return 150;
  }

  return 0;
}

export function extractNamedWakeWord(
  transcript: string,
  wakeNamesInput: WakeNamesInput
): MatchedWakeWord | null {
  const trimmed = transcript.trim();
  if (!trimmed) return null;

  const wakeNames = normalizeWakeNames(wakeNamesInput);
  if (wakeNames.length === 0) return null;

  const direct = matchWakeNameAtStart(trimmed, wakeNames);
  if (direct) return direct;

  const segments = trimmed.split(/(?<=[.!?\n])\s+/);
  if (segments.length > 1) {
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]?.replace(/^[.!?\s]+/, "").trim();
      if (!segment) continue;

      const match = matchWakeNameAtStart(segment, wakeNames);
      if (!match) continue;

      const remaining = segments.slice(i + 1).join(" ");
      return {
        matchedName: match.matchedName,
        transcript: `${match.transcript}${remaining ? ` ${remaining}` : ""}`.trim()
      };
    }
  }

  // Fallback: scan for greeting+name pattern mid-transcript (handles Whisper preamble)
  for (const wakeName of wakeNames) {
    const greetingPattern = new RegExp(`(?:hey|hello),?\\s+${wakeNamePattern(wakeName)}\\b`, "i");
    const greetingMatch = trimmed.match(greetingPattern);
    if (greetingMatch && greetingMatch.index !== undefined) {
      return {
        matchedName: wakeName,
        transcript: trimmed.slice(greetingMatch.index),
      };
    }
  }

  return null;
}

export function extractFromWakeWord(
  transcript: string,
  wakeNamesInput: WakeNamesInput
): string | null {
  return extractNamedWakeWord(transcript, wakeNamesInput)?.transcript ?? null;
}

export function matchesWakeWord(
  transcript: string,
  wakeNamesInput: WakeNamesInput
): boolean {
  return extractFromWakeWord(transcript, wakeNamesInput) !== null;
}

export function mentionsWakeName(
  transcript: string,
  wakeNamesInput: WakeNamesInput
): boolean {
  const trimmed = transcript.trim();
  if (!trimmed) return false;
  return normalizeWakeNames(wakeNamesInput).some((wakeName) =>
    new RegExp(`\\b${wakeNamePattern(wakeName)}\\b`, "i").test(trimmed)
  );
}

export function stripLeadingWakePhrase(
  transcript: string,
  wakeNamesInput: WakeNamesInput
): string {
  const source = transcript.trim();
  const wakeNames = normalizeWakeNames(wakeNamesInput);
  for (const wakeName of wakeNames) {
    const trigger = new RegExp(
      `^(?:(?:hey|hello),?\\s+)?${wakeNamePattern(wakeName)}[,.]?\\s*`,
      "i"
    );
    const stripped = source.replace(trigger, "").trim();
    if (stripped !== source || trigger.test(source)) {
      return stripped;
    }
  }
  return source;
}

export class VoiceTargetDirectory {
  private readonly agents: VoiceAddressAgent[];
  private readonly agentsById: Map<string, VoiceAddressAgent>;
  private readonly systemAgent: VoiceAddressAgent | null;

  constructor(configDir?: string) {
    this.systemAgent = toSystemAddress(configDir);
    const agents = loadVoiceAddressAgents(configDir);
    this.agents = this.systemAgent ? [this.systemAgent, ...agents] : agents;
    this.agentsById = new Map(this.agents.map((agent) => [agent.id, agent]));
  }

  listAgents(): VoiceAddressAgent[] {
    return [...this.agents];
  }

  getAgent(agentId: string | null | undefined): VoiceAddressAgent | null {
    if (!agentId) return null;
    return this.agentsById.get(agentId) ?? null;
  }

  getSystemAgent(): VoiceAddressAgent | null {
    return this.systemAgent;
  }

  getSystemCallSigns(): string[] {
    return this.systemAgent?.callSigns ?? [];
  }

  getAllCallSigns(): string[] {
    return this.agents.flatMap((agent) => agent.callSigns);
  }

  mentionsAnyCallSign(transcript: string): boolean {
    return mentionsWakeName(transcript, this.getAllCallSigns());
  }

  isSystemAgent(agentId: string | null | undefined): boolean {
    if (!agentId) return false;
    return this.systemAgent?.id === agentId;
  }

  resolveExplicitAddress(transcript: string): ResolvedVoiceAddress | null {
    let bestMatch: ResolvedVoiceAddress | null = null;

    for (const agent of this.agents) {
      const wakeMatch = extractNamedWakeWord(transcript, agent.callSigns);
      if (!wakeMatch) continue;

      if (!bestMatch || wakeMatch.matchedName.length > bestMatch.matchedName.length) {
        bestMatch = {
          kind: this.isSystemAgent(agent.id) ? "system" : "agent",
          agent,
          matchedName: wakeMatch.matchedName,
          transcript: wakeMatch.transcript
        };
      }
    }

    return bestMatch;
  }

  resolveAgentQuery(query: string, options?: { includeSystem?: boolean }): VoiceAddressAgent | null {
    const includeSystem = options?.includeSystem ?? false;
    const candidates = includeSystem
      ? this.agents
      : this.agents.filter((agent) => !this.isSystemAgent(agent.id));

    let bestAgent: VoiceAddressAgent | null = null;
    let bestScore = 0;
    for (const agent of candidates) {
      const score = scoreAgentQuery(query, agent);
      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    return bestScore > 0 ? bestAgent : null;
  }

  resolveDefaultPromptAgent(routeAgentId: string | null | undefined): VoiceAddressAgent | null {
    const routedAgent = this.getAgent(routeAgentId);
    if (routedAgent && !this.isSystemAgent(routedAgent.id)) {
      return routedAgent;
    }

    const configuredDefaultPromptAgentId = this.systemAgent?.defaultPromptAgent;
    if (configuredDefaultPromptAgentId) {
      const configured = this.getAgent(configuredDefaultPromptAgentId);
      if (configured && !this.isSystemAgent(configured.id)) {
        return configured;
      }
    }

    // 2026-07-18 claude-primary flip (TGO-809): the original Claude-backed
    // watson is the default voice target again; the clone is the escape hatch.
    for (const fallbackId of ["watson", "watson-ollama"]) {
      const fallback = this.getAgent(fallbackId);
      if (fallback && !this.isSystemAgent(fallback.id)) return fallback;
    }

    return (
      this.agents.find((agent) => !this.isSystemAgent(agent.id)) ??
      routedAgent ??
      this.systemAgent
    );
  }
}

// Id of the system's address entry; no agent config may use it.
const SYSTEM_ADDRESS_ID = "system";

// The system identity (system.yaml) is addressable by its call signs but is
// not an agent: addressing it parses system commands, and unaddressed speech
// goes to its default prompt agent.
function toSystemAddress(configDir?: string): VoiceAddressAgent | null {
  const identity = loadSystemIdentity(resolveConfigDir(configDir));
  if (identity.callSigns.length === 0) return null;
  return {
    id: SYSTEM_ADDRESS_ID,
    type: "system",
    displayName: identity.displayName,
    callSigns: identity.callSigns,
    defaultPromptAgent: identity.defaultPromptAgent,
  };
}

function directoryHasAgentConfigs(configDir: string): boolean {
  return fs.existsSync(path.join(configDir, "agents"));
}

function resolveBundledConfigDir(): string {
  return resolveConfigDir();
}

function resolveDefaultVoiceConfigDir(): string {
  const explicitEnvDir = process.env.TANGO_CONFIG_DIR?.trim();
  if (explicitEnvDir) {
    return resolveConfigDir(explicitEnvDir);
  }

  const cwdConfigDir = path.resolve("./config");
  if (directoryHasAgentConfigs(cwdConfigDir)) {
    return cwdConfigDir;
  }

  const bundledConfigDir = resolveBundledConfigDir();
  if (directoryHasAgentConfigs(bundledConfigDir)) {
    return bundledConfigDir;
  }

  return cwdConfigDir;
}

let cachedDirectory: VoiceTargetDirectory | null = null;
let cachedDirectoryConfigDir: string | null = null;

export function getDefaultVoiceTargetDirectory(): VoiceTargetDirectory {
  const configDir = resolveDefaultVoiceConfigDir();
  if (cachedDirectory && cachedDirectoryConfigDir === configDir) {
    return cachedDirectory;
  }
  cachedDirectory = new VoiceTargetDirectory(configDir);
  cachedDirectoryConfigDir = configDir;
  return cachedDirectory;
}

export function getPreferredSystemWakeName(): string {
  return getDefaultVoiceTargetDirectory().getSystemCallSigns()[0] ?? "Tango";
}
