#!/usr/bin/env tsx
/**
 * Regenerate all session summaries using current truncation limits.
 *
 * Reads existing summaries, finds the original messages for each window,
 * and re-builds the summary text with the updated buildDeterministicConversationSummary.
 *
 * Usage:
 *   npx tsx scripts/refresh-session-summaries.ts [--dry-run]
 */

import {
  buildDeterministicConversationSummary,
  estimateTokenCount,
  resolveDatabasePath,
  TangoStorage,
} from "../packages/core/src/index.ts";
import type { StoredMessageRecord } from "../packages/core/src/storage.ts";

interface SummaryRow {
  id: number;
  sessionId: string;
  agentId: string;
  summaryText: string;
  tokenCount: number;
  coversThroughMessageId: number | null;
  createdAt: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const dbPath = resolveDatabasePath();
  const storage = new TangoStorage(dbPath);

  try {
    const db = storage.getDatabase();

    // Get all summaries
    const summaries = db
      .prepare(
        `SELECT
          id,
          session_id AS sessionId,
          agent_id AS agentId,
          summary_text AS summaryText,
          token_count AS tokenCount,
          covers_through_message_id AS coversThroughMessageId,
          created_at AS createdAt
        FROM session_summaries
        ORDER BY id ASC`
      )
      .all() as SummaryRow[];

    console.log(`Total summaries: ${summaries.length}`);
    console.log(`Dry run: ${dryRun}`);

    // Group by session+agent to build the message ranges
    // Each summary covers a window of messages up to coversThroughMessageId
    // We need to find the previous summary's coversThroughMessageId to know the start

    // Group summaries by (sessionId, agentId) to find windows
    const groups = new Map<string, SummaryRow[]>();
    for (const s of summaries) {
      const key = `${s.sessionId}::${s.agentId}`;
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }

    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const [key, groupSummaries] of groups) {
      // Sort by coversThroughMessageId
      groupSummaries.sort(
        (a, b) =>
          (a.coversThroughMessageId ?? 0) - (b.coversThroughMessageId ?? 0)
      );

      const [sessionId, agentId] = key.split("::");
      if (!sessionId || !agentId) continue;

      // Load all messages for this session+agent
      const allMessages = db
        .prepare(
          `SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE session_id = ? AND agent_id = ?
            AND (direction = 'inbound' OR direction = 'outbound')
          ORDER BY id ASC`
        )
        .all(sessionId, agentId) as Array<
        Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null }
      >;

      const messages: StoredMessageRecord[] = allMessages.map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        agentId: row.agentId,
        providerName: row.providerName,
        direction: row.direction,
        source: row.source,
        visibility: row.visibility,
        discordMessageId: row.discordMessageId,
        discordChannelId: row.discordChannelId,
        discordUserId: row.discordUserId,
        discordUsername: row.discordUsername,
        content: row.content,
        metadata: null,
        createdAt: row.createdAt,
      }));

      let prevCoveredId = 0;

      for (const summary of groupSummaries) {
        const coveredId = summary.coversThroughMessageId ?? 0;
        if (coveredId === 0) {
          skipped++;
          prevCoveredId = coveredId;
          continue;
        }

        // Find messages in this window: after prevCoveredId, up to and including coveredId
        const windowMessages = messages.filter(
          (m) => m.id > prevCoveredId && m.id <= coveredId
        );

        if (windowMessages.length === 0) {
          skipped++;
          prevCoveredId = coveredId;
          continue;
        }

        const newSummaryText =
          buildDeterministicConversationSummary(windowMessages);
        const newTokenCount = estimateTokenCount(newSummaryText);

        if (newSummaryText === summary.summaryText) {
          unchanged++;
        } else {
          updated++;
          if (!dryRun) {
            storage.upsertSessionMemorySummary({
              sessionId,
              agentId,
              summaryText: newSummaryText,
              tokenCount: newTokenCount,
              coversThroughMessageId: coveredId,
            });
          }
          if (updated <= 3) {
            console.log(`\nExample update (summary #${summary.id}):`);
            console.log(
              `  OLD (${summary.summaryText.length} chars): ${summary.summaryText.slice(0, 200)}...`
            );
            console.log(
              `  NEW (${newSummaryText.length} chars): ${newSummaryText.slice(0, 200)}...`
            );
          }
        }

        prevCoveredId = coveredId;
      }
    }

    console.log(`\nResults:`);
    console.log(`  Updated: ${updated}`);
    console.log(`  Unchanged: ${unchanged}`);
    console.log(`  Skipped (no messages found): ${skipped}`);
  } finally {
    storage.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
