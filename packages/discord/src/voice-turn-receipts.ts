import type { VoiceTurnReceiptRecord } from "@tango/core";
import type { VoiceTurnResult } from "@tango/voice";

const DEFAULT_POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 45_000;

export function buildVoiceTurnResultFromReceipt(
  turnId: string | undefined,
  receipt: VoiceTurnReceiptRecord
): VoiceTurnResult | null {
  if (
    receipt.status !== "completed" ||
    !receipt.responseText ||
    !receipt.providerName
  ) {
    return null;
  }

  return {
    turnId,
    deduplicated: true,
    responseText: receipt.responseText,
    providerName: receipt.providerName,
    providerSessionId: receipt.providerSessionId ?? undefined,
    providerUsedFailover: receipt.providerUsedFailover ?? undefined,
    warmStartUsed: receipt.warmStartUsed ?? undefined
  };
}

export async function waitForVoiceTurnReceiptResolution(input: {
  sessionId: string;
  utteranceId: string;
  lookupReceipt: (sessionId: string, utteranceId: string) => VoiceTurnReceiptRecord | null;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<VoiceTurnReceiptRecord | null> {
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollMs = Math.max(10, input.pollMs ?? DEFAULT_POLL_MS);

  while (Date.now() < deadline) {
    const receipt = input.lookupReceipt(input.sessionId, input.utteranceId);
    if (!receipt || receipt.status !== "processing") {
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return input.lookupReceipt(input.sessionId, input.utteranceId);
}
