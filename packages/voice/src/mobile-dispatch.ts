import {
  stripLeadingWakePhrase,
  VoiceTargetDirectory,
} from "./address-routing.js";
import {
  buildDefaultSessionKey,
  buildDiscordChannelSessionKey,
} from "./session-routing.js";
import { TURN, TurnPolicy } from "@tango/tango-voice/turn/turn-policy";
import type { VoiceTurnResult, VoiceTurnInput } from "./index.js";

interface MobileDispatchBody {
  transcript?: unknown;
  text?: unknown;
  dictation?: unknown;
  agentId?: unknown;
  sessionId?: unknown;
  channelId?: unknown;
  discordChannelId?: unknown;
  discordUserId?: unknown;
  utteranceId?: unknown;
  guildId?: unknown;
  voiceChannelId?: unknown;
  messageTimestamp?: unknown;
  messageTimestampSource?: unknown;
  routeByWake?: unknown;
}

export interface MobileVoiceDispatchRoute {
  rawTranscript: string;
  dispatchedTranscript: string;
  agentId: string;
  sessionId: string;
  channelId?: string;
  routedBy: "explicit-address" | "request-agent" | "default-agent";
  matchedCallSign?: string;
  strippedWakePhrase: boolean;
}

export interface MobileVoiceDispatchInput {
  turnInput: VoiceTurnInput;
  route: MobileVoiceDispatchRoute;
}

export interface MobileVoiceDispatchDefaults {
  sessionId?: string;
  agentId?: string;
}

class MobileVoiceDispatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MobileVoiceDispatchValidationError";
  }
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  throw new MobileVoiceDispatchValidationError("Invalid field 'routeByWake'.");
}

function resolveTranscript(body: MobileDispatchBody): string {
  const transcript =
    trimString(body.transcript) ??
    trimString(body.text) ??
    trimString(body.dictation);
  if (!transcript) {
    throw new MobileVoiceDispatchValidationError(
      "Missing required field 'transcript'.",
    );
  }
  return transcript;
}

export function parseMobileVoiceDispatchInput(
  payload: unknown,
  options: {
    defaults?: MobileVoiceDispatchDefaults;
    voiceTargets?: VoiceTargetDirectory;
  } = {},
): MobileVoiceDispatchInput {
  if (!payload || typeof payload !== "object") {
    throw new MobileVoiceDispatchValidationError(
      "Request body must be a JSON object.",
    );
  }

  const body = payload as MobileDispatchBody;
  const rawTranscript = resolveTranscript(body);
  const routeByWake = parseBoolean(body.routeByWake, true);
  const voiceTargets = options.voiceTargets ?? new VoiceTargetDirectory();
  const explicitAddress = routeByWake
    ? voiceTargets.resolveExplicitAddress(rawTranscript)
    : null;
  const bodyAgentId = trimString(body.agentId);
  const defaultAgentId = trimString(options.defaults?.agentId);
  const requestAgentId = bodyAgentId ?? defaultAgentId;
  const explicitAgentId =
    explicitAddress?.kind === "agent" ? explicitAddress.agent.id : null;
  const agentId = explicitAgentId ?? requestAgentId;

  if (!agentId) {
    throw new MobileVoiceDispatchValidationError(
      "Missing required field 'agentId' or explicit agent wake phrase.",
    );
  }

  const routedTranscript =
    explicitAddress?.kind === "agent"
      ? explicitAddress.transcript
      : rawTranscript;
  const dispatchedTranscript =
    explicitAddress?.kind === "agent"
      ? stripLeadingWakePhrase(routedTranscript, explicitAddress.agent.callSigns)
      : rawTranscript;
  const transcript = dispatchedTranscript || rawTranscript;
  const channelId =
    trimString(body.channelId) ?? trimString(body.discordChannelId);
  const sessionId =
    trimString(body.sessionId) ??
    (channelId
      ? buildDiscordChannelSessionKey(agentId, channelId)
      : undefined) ??
    trimString(options.defaults?.sessionId) ??
    buildDefaultSessionKey(agentId);
  const utteranceId = trimString(body.utteranceId);
  const guildId = trimString(body.guildId);
  const voiceChannelId = trimString(body.voiceChannelId);
  const discordUserId = trimString(body.discordUserId);
  const messageTimestamp = trimString(body.messageTimestamp);
  const messageTimestampSource = trimString(body.messageTimestampSource);

  if (
    messageTimestampSource &&
    !["discord-sent", "voice-captured", "voice-finalized", "db-write"].includes(
      messageTimestampSource,
    )
  ) {
    throw new MobileVoiceDispatchValidationError(
      "Invalid field 'messageTimestampSource'.",
    );
  }

  const turnInput: VoiceTurnInput = {
    sessionId,
    agentId,
    transcript,
    ...(utteranceId ? { utteranceId } : {}),
    ...(guildId ? { guildId } : {}),
    ...(voiceChannelId ? { voiceChannelId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(discordUserId ? { discordUserId } : {}),
    ...(messageTimestamp ? { messageTimestamp } : {}),
    ...(messageTimestampSource
      ? {
          messageTimestampSource:
            messageTimestampSource as VoiceTurnInput["messageTimestampSource"],
        }
      : {}),
  };

  return {
    turnInput,
    route: {
      rawTranscript,
      dispatchedTranscript: transcript,
      agentId,
      sessionId,
      ...(channelId ? { channelId } : {}),
      ...(explicitAddress?.kind === "agent"
        ? { matchedCallSign: explicitAddress.matchedName }
        : {}),
      strippedWakePhrase: transcript !== rawTranscript,
      routedBy: explicitAgentId
        ? "explicit-address"
        : bodyAgentId
          ? "request-agent"
          : "default-agent",
    },
  };
}


interface OpenMobileTurn {
  policy: TurnPolicy;
  input: MobileVoiceDispatchInput;
  timer?: ReturnType<typeof setTimeout>;
  rambleStartedAt?: number;
  /** Seen-press keys of the presses folded into this turn. */
  pressKeys: string[];
}

export interface MobileVoicePress {
  input: MobileVoiceDispatchInput;
  result?: VoiceTurnResult;
  turnTaking?: { status: "held" | "cancelled"; say?: string };
}

/** A press the bridge already took: its open turn while held, then the turn's outcome. */
interface SeenPress {
  at: number;
  turn?: OpenMobileTurn;
  outcome?: Promise<MobileVoicePress>;
}

const HOLDING = { status: "held", say: "Holding. Say send it when you're done." } as const;
const QUICK_HOLDING = { status: "held", say: "Go on." } as const;
const CANCELLED = { status: "cancelled", say: "Cancelled." } as const;
const RAMBLE_KEEP_MS = 12 * 60 * 60 * 1000;
const QUICK_HOLD_MS = 20_000;
// Past the longest hold, so a retry can't outlive the record of its press.
const SEEN_KEEP_MS = RAMBLE_KEEP_MS + 60 * 60 * 1000;

/** Text-only Shortcut turns. Each press is a complete segment, not an audio delta. */
export class MobileVoiceTurns {
  private readonly turns = new Map<string, OpenMobileTurn>();
  private readonly seen = new Map<string, SeenPress>();

  constructor(private readonly onTranscript: (input: VoiceTurnInput) => Promise<VoiceTurnResult>) {}

  async press(input: MobileVoiceDispatchInput): Promise<MobileVoicePress> {
    // A caller-supplied session can be shared by several agents; never mix their drafts.
    const key = JSON.stringify([input.turnInput.agentId, input.turnInput.sessionId]);
    // A retried press (same utteranceId) must not add its words again or send a second time.
    const pressKey = input.turnInput.utteranceId ? JSON.stringify([key, input.turnInput.utteranceId]) : undefined;
    this.pruneSeen();
    const prior = pressKey ? this.seen.get(pressKey) : undefined;
    if (prior?.outcome) return prior.outcome;
    if (prior?.turn) return { input, turnTaking: prior.turn.policy.mode() === "ramble" ? HOLDING : QUICK_HOLDING };

    const turn = this.turns.get(key) ?? { policy: new TurnPolicy(), input, pressKeys: [] };
    if (pressKey) {
      turn.pressKeys.push(pressKey);
      this.seen.set(pressKey, { at: Date.now(), turn });
    }
    clearTimeout(turn.timer);
    turn.policy.words(input.turnInput.transcript);
    const decision = turn.policy.pause(TURN.pauseMs, "local");
    if (decision.kind === "cancel") {
      this.turns.delete(key);
      return this.settle(turn, Promise.resolve({ input, turnTaking: CANCELLED }));
    }
    if (decision.kind === "finish") {
      this.turns.delete(key);
      const finished = this.finishedInput(turn, decision.text);
      return this.settle(turn, decision.text
        ? this.onTranscript(finished.turnInput).then((result) => ({ input: finished, result }))
        : Promise.resolve({ input: finished }));
    }

    this.turns.set(key, turn);
    if (decision.mode === "ramble") turn.rambleStartedAt ??= Date.now();
    const delay = decision.mode === "ramble"
      ? Math.max(0, turn.rambleStartedAt! + RAMBLE_KEEP_MS - Date.now())
      : QUICK_HOLD_MS;
    turn.timer = setTimeout(() => {
      if (this.turns.get(key) !== turn) return;
      this.turns.delete(key);
      // The ramble cap expires the draft; only a closer is allowed to send it.
      if (turn.policy.mode() === "ramble") {
        void this.settle(turn, Promise.resolve({ input: turn.input, turnTaking: CANCELLED }));
        return;
      }
      const { text } = turn.policy.explicitFinish();
      const finished = this.finishedInput(turn, text);
      void this.settle(turn, text
        ? this.onTranscript(finished.turnInput).then((result) => ({ input: finished, result }))
        : Promise.resolve({ input: finished })).catch(() => {
        // No HTTP request remains to report a deferred failure to. Do not log dictated text.
        console.error("Mobile voice deferred dispatch failed.");
      });
    }, delay);
    turn.timer.unref();
    return { input, turnTaking: decision.mode === "ramble" ? HOLDING : QUICK_HOLDING };
  }

  stop(): void {
    for (const turn of this.turns.values()) clearTimeout(turn.timer);
    this.turns.clear();
    this.seen.clear();
  }

  /** Every press folded into the turn now answers a retry with the turn's one outcome. */
  private settle(turn: OpenMobileTurn, outcome: Promise<MobileVoicePress>): Promise<MobileVoicePress> {
    outcome.catch(() => {}); // Retries see the rejection; an unretried one is not unhandled.
    for (const pressKey of turn.pressKeys) this.seen.set(pressKey, { at: Date.now(), outcome });
    return outcome;
  }

  private pruneSeen(): void {
    const cutoff = Date.now() - SEEN_KEEP_MS;
    for (const [pressKey, press] of this.seen) {
      if (press.at < cutoff) this.seen.delete(pressKey);
    }
  }

  private finishedInput(turn: OpenMobileTurn, text: string): MobileVoiceDispatchInput {
    return {
      turnInput: { ...turn.input.turnInput, transcript: text },
      route: { ...turn.input.route, dispatchedTranscript: text },
    };
  }
}
