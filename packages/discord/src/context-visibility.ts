import {
  DEFAULT_CONTEXT_PRESSURE_ALERT_THRESHOLD,
  formatCompactTokenCount,
  formatContextUsageSummary,
  type LastContextUsageSnapshot,
} from "@tango/core";
import { STALE_CONTEXT_READING_MS, type PersistedContextReading } from "./context-snapshots.js";

export function buildContextPressureInThreadAlert(
  agentId: string,
  usage: Pick<LastContextUsageSnapshot, "fraction" | "totalTokens" | "contextWindow">,
): string {
  const percent = Math.round(usage.fraction * 100);
  const rotationPercent = 80;

  return [
    `**Context ${percent}% — ${agentId}**`,
    formatContextUsageSummary(usage),
    `You are in the last stretch before automatic rotation at ${rotationPercent}%. Run \`/tango save\` if you want a checkpoint.`,
    `You will get another in-thread notice when the session rotates at ${rotationPercent}%. Use \`/tango new\` when you are ready to rotate on your own schedule.`,
  ].join("\n");
}

export function buildContextRotationInThreadAlert(agentId: string): string {
  return [
    `**Session rotated at 80% context — ${agentId}**`,
    "The provider session was reset. Message history is preserved for warm-start on your next turn.",
    "This was rotation, not a save pass. Run `/tango save` if anything important might be missing from Atlas.",
  ].join("\n");
}

function formatReadingAge(recordedAt: Date, now: Date): string {
  const ageMs = Math.max(now.getTime() - recordedAt.getTime(), 0);
  if (ageMs < 60_000) {
    return "just now";
  }

  const totalMinutes = Math.floor(ageMs / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ago`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function formatReadingLine(
  label: string,
  reading: Pick<PersistedContextReading, "fraction" | "usedTokens" | "contextWindow" | "recordedAt">,
  now: Date,
): string {
  const percent = Math.round(reading.fraction * 100);
  const tokens = reading.contextWindow > 0
    ? ` (${formatCompactTokenCount(reading.usedTokens)} / ${formatCompactTokenCount(reading.contextWindow)} tokens)`
    : "";
  const stale = now.getTime() - reading.recordedAt.getTime() > STALE_CONTEXT_READING_MS
    ? " (old reading)"
    : "";
  return `${label}: ${percent}%${tokens} — ${formatReadingAge(reading.recordedAt, now)}${stale}`;
}

export function buildContextSlashReply(input: {
  agentId: string;
  conversationKey: string;
  usage?: LastContextUsageSnapshot;
  contextPressureAlertSent?: boolean;
  idleTimeoutHours: number;
  lifecycleIdleTimeoutHours: number;
  /** T-I-035: freshest persisted reading for the typed session (RAM fallback). */
  persistedTyped?: PersistedContextReading;
  /** T-I-035: freshest persisted reading for the voice session in this post. */
  persistedVoice?: PersistedContextReading;
  /** T-I-035: true when the snapshot store itself failed — say so, honestly. */
  persistedUnavailable?: boolean;
  /** T-I-035: RAM session creation time, for rotation honesty. */
  sessionCreatedAt?: Date;
  /** Injectable clock for tests. */
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  // Persisted-aware mode: any T-I-035 field present switches to per-session
  // source lines. Callers that pass none get the legacy single-summary reply.
  const persistedAware =
    input.persistedTyped !== undefined
    || input.persistedVoice !== undefined
    || input.persistedUnavailable === true
    || input.sessionCreatedAt !== undefined;

  const lines = [`**${input.agentId}** · \`${input.conversationKey}\``];

  if (!persistedAware) {
    lines.push(formatContextUsageSummary(input.usage));
    if (input.usage?.recordedAt) {
      lines.push(`Last reading: ${input.usage.recordedAt.toISOString()}`);
    }
  } else {
    // Typed session line — RAM first (freshest possible), then persisted with
    // rotation honesty: a session recreated AFTER the persisted reading means
    // that reading describes a context that no longer exists.
    if (input.usage) {
      lines.push(formatReadingLine("typed", {
        fraction: input.usage.fraction,
        usedTokens: input.usage.totalTokens,
        contextWindow: input.usage.contextWindow,
        recordedAt: input.usage.recordedAt,
      }, now));
    } else if (input.persistedTyped) {
      const rotatedAfterReading =
        input.sessionCreatedAt !== undefined
        && input.sessionCreatedAt.getTime() > input.persistedTyped.recordedAt.getTime();
      if (rotatedAfterReading) {
        const percent = Math.round(input.persistedTyped.fraction * 100);
        lines.push(
          `typed: session rotated ${formatReadingAge(input.sessionCreatedAt!, now)} — context reset `
          + `(last reading before rotation: ${percent}% — ${formatReadingAge(input.persistedTyped.recordedAt, now)})`,
        );
      } else {
        lines.push(formatReadingLine("typed", input.persistedTyped, now));
      }
    } else if (input.persistedUnavailable) {
      lines.push("typed: no reading (persisted snapshot store unavailable)");
    } else {
      lines.push("typed: no reading yet for this session");
    }

    // Voice session line — this post genuinely has a second context when a
    // voice session shares the forum post (the two-sessions model).
    if (input.persistedVoice) {
      lines.push(formatReadingLine("voice", input.persistedVoice, now));
    } else if (input.persistedUnavailable) {
      lines.push("voice: no reading (persisted snapshot store unavailable)");
    }
  }

  const thresholdPercent = Math.round(DEFAULT_CONTEXT_PRESSURE_ALERT_THRESHOLD * 100);
  if (input.contextPressureAlertSent) {
    lines.push(`In-thread alert: already sent at ${thresholdPercent}%+ for this provider session.`);
  } else {
    lines.push(`In-thread alert: will post once when this conversation reaches ${thresholdPercent}%.`);
  }

  lines.push(
    "At 80% context the provider session rotates automatically; you will get an in-thread notice when that happens.",
    `Idle timeout: agent config ${input.idleTimeoutHours}h; v2 lifecycle currently closes idle runtimes after ${input.lifecycleIdleTimeoutHours}h.`,
    "If the runtime closes from idle, your next message starts fresh and context % resets.",
  );

  return lines.join("\n");
}
