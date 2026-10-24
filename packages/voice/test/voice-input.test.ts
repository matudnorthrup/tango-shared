import { describe, expect, it } from "vitest";
import {
  VoiceTargetDirectory,
  parseMobileVoiceDispatchInput,
  parseVoiceTurnInput,
  resolveVoiceApiKey
} from "../src/index.js";

const fakeVoiceTargets = {
  resolveExplicitAddress(transcript: string) {
    if (!/^hey[, ]+sierra\b/iu.test(transcript)) return null;
    return {
      kind: "agent",
      agent: {
        id: "sierra",
        type: "travel",
        displayName: "Sierra",
        callSigns: ["Sierra"]
      },
      matchedName: "Sierra",
      transcript
    };
  }
} as unknown as VoiceTargetDirectory;

describe("parseVoiceTurnInput", () => {
  it("parses required fields and optional metadata", () => {
    const result = parseVoiceTurnInput(
      {
        sessionId: "voice-main",
        agentId: "watson",
        transcript: "hello",
        utteranceId: "utt-001",
        guildId: "guild-1",
        voiceChannelId: "voice-channel-1",
        channelId: "call-main",
        discordUserId: "caller-1",
        messageTimestamp: "2026-05-19T19:25:11.000Z",
        messageTimestampSource: "voice-finalized"
      },
      {}
    );

    expect(result).toEqual({
      sessionId: "voice-main",
      agentId: "watson",
      transcript: "hello",
      utteranceId: "utt-001",
      guildId: "guild-1",
      voiceChannelId: "voice-channel-1",
      channelId: "call-main",
      discordUserId: "caller-1",
      messageTimestamp: "2026-05-19T19:25:11.000Z",
      messageTimestampSource: "voice-finalized"
    });
  });

  it("uses defaults when session/agent are omitted", () => {
    const result = parseVoiceTurnInput(
      {
        transcript: "what changed?"
      },
      {
        sessionId: "voice-default",
        agentId: "watson"
      }
    );

    expect(result.sessionId).toBe("voice-default");
    expect(result.agentId).toBe("watson");
    expect(result.transcript).toBe("what changed?");
  });

  it("throws validation errors for missing required fields", () => {
    expect(() => parseVoiceTurnInput({}, {})).toThrow(/sessionId/u);
    expect(() =>
      parseVoiceTurnInput(
        {
          sessionId: "voice-main"
        },
        {}
      )
    ).toThrow(/agentId/u);
    expect(() =>
      parseVoiceTurnInput(
        {
          sessionId: "voice-main",
          agentId: "watson"
        },
        {}
      )
    ).toThrow(/transcript/u);
    expect(() =>
      parseVoiceTurnInput(
        {
          sessionId: "voice-main",
          agentId: "watson",
          transcript: "hello",
          messageTimestampSource: "wall-clock"
        },
        {}
      )
    ).toThrow(/messageTimestampSource/u);
  });
});

describe("resolveVoiceApiKey", () => {
  it("prefers bearer authorization header", () => {
    expect(
      resolveVoiceApiKey({
        authorization: "Bearer secret-token"
      })
    ).toBe("secret-token");
  });

  it("falls back to x-tango-api-key header", () => {
    expect(
      resolveVoiceApiKey({
        "x-tango-api-key": "secret-token"
      })
    ).toBe("secret-token");
  });
});

describe("parseMobileVoiceDispatchInput", () => {
  it("routes by explicit wake phrase and strips the wake phrase before dispatch", () => {
    const result = parseMobileVoiceDispatchInput(
      {
        text: "Hey Sierra, what temperature will it be in Costa Sur?",
        channelId: "12345",
        utteranceId: "ios-1"
      },
      {
        voiceTargets: fakeVoiceTargets
      }
    );

    expect(result.turnInput).toEqual({
      sessionId: "agent:sierra:discord:channel:12345",
      agentId: "sierra",
      transcript: "what temperature will it be in Costa Sur?",
      utteranceId: "ios-1",
      channelId: "12345"
    });
    expect(result.route).toMatchObject({
      rawTranscript: "Hey Sierra, what temperature will it be in Costa Sur?",
      dispatchedTranscript: "what temperature will it be in Costa Sur?",
      agentId: "sierra",
      routedBy: "explicit-address",
      matchedCallSign: "Sierra",
      strippedWakePhrase: true
    });
  });

  it("uses the request/default agent when no wake phrase is present", () => {
    const result = parseMobileVoiceDispatchInput(
      {
        transcript: "what temperature will it be in Costa Sur?",
        channelId: "99999"
      },
      {
        defaults: {
          agentId: "watson"
        },
        voiceTargets: fakeVoiceTargets
      }
    );

    expect(result.turnInput).toEqual({
      sessionId: "agent:watson:discord:channel:99999",
      agentId: "watson",
      transcript: "what temperature will it be in Costa Sur?",
      channelId: "99999"
    });
    expect(result.route.routedBy).toBe("default-agent");
  });

  it("prefers channel-backed sessions over the bridge default session", () => {
    const result = parseMobileVoiceDispatchInput(
      {
        transcript: "what temperature will it be in Costa Sur?",
        agentId: "sierra",
        channelId: "99999"
      },
      {
        defaults: {
          sessionId: "voice-main",
          agentId: "watson"
        },
        voiceTargets: fakeVoiceTargets
      }
    );

    expect(result.turnInput.sessionId).toBe(
      "agent:sierra:discord:channel:99999"
    );
    expect(result.route.routedBy).toBe("request-agent");
  });

  it("allows shortcuts to disable wake routing for fixed-agent buttons", () => {
    const result = parseMobileVoiceDispatchInput(
      {
        transcript: "Hey Sierra, keep these exact words",
        agentId: "watson",
        routeByWake: false
      },
      {
        voiceTargets: fakeVoiceTargets
      }
    );

    expect(result.turnInput).toEqual({
      sessionId: "agent:watson:main",
      agentId: "watson",
      transcript: "Hey Sierra, keep these exact words"
    });
    expect(result.route.strippedWakePhrase).toBe(false);
  });
});
