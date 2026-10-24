import type { VoiceTurnReceiptRecord } from "@tango/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVoiceTurnResultFromReceipt,
  waitForVoiceTurnReceiptResolution
} from "../src/voice-turn-receipts.js";

function makeReceipt(
  overrides: Partial<VoiceTurnReceiptRecord> = {}
): VoiceTurnReceiptRecord {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    agentId: "watson",
    utteranceId: "utt-1",
    status: "completed",
    providerName: "codex",
    providerSessionId: "provider-session-1",
    responseText: "ready",
    providerUsedFailover: false,
    warmStartUsed: true,
    requestMessageId: 1,
    responseMessageId: 2,
    modelRunId: 3,
    errorMessage: null,
    metadata: null,
    createdAt: "2026-03-05T00:00:00Z",
    updatedAt: "2026-03-05T00:00:01Z",
    ...overrides
  };
}

describe("buildVoiceTurnResultFromReceipt", () => {
  it("maps completed receipts to deduplicated voice turn results", () => {
    const result = buildVoiceTurnResultFromReceipt("turn-1", makeReceipt());

    expect(result).toEqual({
      turnId: "turn-1",
      deduplicated: true,
      responseText: "ready",
      providerName: "codex",
      providerSessionId: "provider-session-1",
      providerUsedFailover: false,
      warmStartUsed: true
    });
  });

  it("returns null for non-completed receipts", () => {
    const result = buildVoiceTurnResultFromReceipt(
      "turn-1",
      makeReceipt({ status: "processing", responseText: null })
    );

    expect(result).toBeNull();
  });
});

describe("waitForVoiceTurnReceiptResolution", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for processing receipts to resolve", async () => {
    vi.useFakeTimers();

    let currentReceipt = makeReceipt({
      status: "processing",
      responseText: null,
      providerName: null,
      providerSessionId: null,
      providerUsedFailover: null,
      warmStartUsed: null,
      requestMessageId: null,
      responseMessageId: null,
      modelRunId: null
    });

    const lookupReceipt = vi.fn(() => currentReceipt);
    const resultPromise = waitForVoiceTurnReceiptResolution({
      sessionId: "session-1",
      utteranceId: "utt-1",
      lookupReceipt,
      pollMs: 100,
      timeoutMs: 1000
    });

    await vi.advanceTimersByTimeAsync(100);
    currentReceipt = makeReceipt();
    await vi.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result).toEqual(makeReceipt());
    expect(lookupReceipt).toHaveBeenCalled();
  });
});
