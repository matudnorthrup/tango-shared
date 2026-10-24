/**
 * Active Threads Tracker — deterministic scheduler handler.
 *
 * Scans Discord for active threads/forum posts every 3 minutes and
 * appends/updates entries in the Obsidian daily note's "In Progress" section.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SnowflakeUtil, type Client, type ThreadChannel } from "discord.js";
import type { DeterministicHandler, DeterministicResult } from "@tango/core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_VAULT_PATH = path.join(os.homedir(), "Documents", "main");
const TZ = "America/Los_Angeles";

function parseEnvSet(name: string): Set<string> {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

/** Generic system channel names to exclude from tracker updates by default. */
const BLACKLIST_PARENT_NAMES = new Set([
  "system-alerts",
  "system-logs",
  "print-notifications",
  "slack-summary",
  "ai-briefing",
  ...parseEnvSet("TANGO_ACTIVE_THREADS_BLACKLIST_NAMES"),
]);

/** Optional installation-specific parent channel IDs to exclude. */
const BLACKLIST_PARENT_IDS = parseEnvSet("TANGO_ACTIVE_THREADS_BLACKLIST_IDS");

/** Optional installation-specific thread IDs to exclude. */
const THREAD_BLACKLIST = parseEnvSet("TANGO_ACTIVE_THREADS_BLACKLIST_THREAD_IDS");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayNoteFile(vaultPath: string, nowMs: number): string {
  return path.join(vaultPath, "Planning", "Daily", `${toLADate(nowMs)}.md`);
}

/** Return the LA calendar date string (YYYY-MM-DD) for an epoch ms. */
function toLADate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Build the dedup key used in note lines: `#channel-name › Thread Name` */
function threadKey(channelName: string, threadName: string): string {
  return `#${channelName} › ${threadName}`;
}

interface ThreadRecord {
  key: string;
  lastActiveMs: number;
}

export interface ActiveThreadsTrackerOptions {
  vaultPath?: string;
  now?: () => number;
}

interface LastActiveResolution {
  lastActiveMs: number;
  source: "last-message-id" | "created-timestamp" | "now";
}

function resolveLastActiveMs(
  thread: Pick<ThreadChannel, "lastMessageId" | "createdTimestamp">,
  fallbackNowMs: number,
): LastActiveResolution {
  if (thread.lastMessageId) {
    try {
      return {
        lastActiveMs: SnowflakeUtil.timestampFrom(thread.lastMessageId),
        source: "last-message-id",
      };
    } catch {
      // Fall through to less precise metadata when Discord returns a malformed ID.
    }
  }

  if (typeof thread.createdTimestamp === "number") {
    return {
      lastActiveMs: thread.createdTimestamp,
      source: "created-timestamp",
    };
  }

  return {
    lastActiveMs: fallbackNowMs,
    source: "now",
  };
}

// ---------------------------------------------------------------------------
// In Progress section parser / updater
// ---------------------------------------------------------------------------

interface ParsedNote {
  before: string;
  inProgressLines: string[];
  after: string;
}

function parseInProgressSection(body: string): ParsedNote | null {
  const lines = body.split("\n");
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^## In Progress\s*$/.test(line)) {
      sectionStart = i;
      continue;
    }
    if (sectionStart !== -1 && /^## /.test(line)) {
      sectionEnd = i;
      break;
    }
  }

  if (sectionStart === -1) return null;

  return {
    before: lines.slice(0, sectionStart + 1).join("\n"),
    inProgressLines: lines.slice(sectionStart + 1, sectionEnd),
    after: lines.slice(sectionEnd).join("\n"),
  };
}

function mergeThreads(
  parsed: ParsedNote,
  records: ThreadRecord[],
): { body: string; newCount: number; updatedCount: number } {
  let newCount = 0;
  let updatedCount = 0;

  const updatedLines = [...parsed.inProgressLines];

  for (const rec of records) {
    const timeStr = formatTime(rec.lastActiveMs);
    let found = false;

    for (let i = 0; i < updatedLines.length; i++) {
      const line = updatedLines[i]!;
      if (!line.includes(rec.key)) continue;
      found = true;

      // Checked items are sacred — never touch them
      if (/^\s*- \[x\]/.test(line)) break;

      // Update timestamp on unchecked items
      updatedLines[i] = line.replace(
        /— last active .+$/,
        `— last active ${timeStr}`,
      );
      updatedCount++;
      break;
    }

    if (!found) {
      updatedLines.push(`- [ ] 🤖 ${rec.key} — last active ${timeStr}`);
      newCount++;
    }
  }

  const body = parsed.before + "\n" + updatedLines.join("\n") + (parsed.after ? "\n" + parsed.after : "");
  return { body, newCount, updatedCount };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createActiveThreadsTracker(
  client: Client,
  options: ActiveThreadsTrackerOptions = {},
): DeterministicHandler {
  return async (_ctx): Promise<DeterministicResult> => {
    if (!client.isReady()) {
      return { status: "skipped", summary: "Discord client not ready" };
    }

    // 1. Fetch active threads from all guilds
    const nowMs = options.now?.() ?? Date.now();
    const todayStr = toLADate(nowMs);
    const records: ThreadRecord[] = [];
    for (const guild of client.guilds.cache.values()) {
      const active = await guild.channels.fetchActiveThreads();
      for (const thread of active.threads.values()) {
        const parentName = thread.parent?.name?.trim().toLowerCase() ?? "";
        if (thread.parentId && BLACKLIST_PARENT_IDS.has(thread.parentId)) continue;
        if (parentName && BLACKLIST_PARENT_NAMES.has(parentName)) continue;
        if (THREAD_BLACKLIST.has(thread.id)) continue;

        // Avoid one network fetch per thread. Discord thread snowflakes already
        // encode creation time, so lastMessageId gives us a precise-enough
        // activity timestamp for "active today" filtering without the N+1 cost.
        const { lastActiveMs } = resolveLastActiveMs(thread, nowMs);

        // Only include threads active today (LA calendar day)
        if (toLADate(lastActiveMs) !== todayStr) continue;

        const channelName = thread.parent?.name ?? "unknown";
        records.push({
          key: threadKey(channelName, thread.name),
          lastActiveMs,
        });
      }
    }

    if (records.length === 0) {
      return { status: "skipped", summary: "No active threads found" };
    }

    // 2. Read the daily note directly from disk
    const noteFile = todayNoteFile(options.vaultPath ?? DEFAULT_VAULT_PATH, nowMs);
    let noteBody: string;
    try {
      noteBody = await fs.readFile(noteFile, "utf-8");
    } catch {
      return { status: "skipped", summary: "Daily note not found" };
    }

    if (!noteBody.trim()) {
      return { status: "skipped", summary: "Daily note is empty" };
    }

    // 3. Parse In Progress section
    const parsed = parseInProgressSection(noteBody);
    if (!parsed) {
      return { status: "skipped", summary: "No '## In Progress' section in daily note" };
    }

    // 4. Merge thread records into the section
    const { body, newCount, updatedCount } = mergeThreads(parsed, records);

    if (newCount === 0 && updatedCount === 0) {
      return { status: "skipped", summary: `${records.length} threads — all already tracked, no changes` };
    }

    // 5. Write back directly to disk
    await fs.writeFile(noteFile, body, "utf-8");

    return {
      status: "ok",
      summary: `${records.length} threads tracked (${newCount} new, ${updatedCount} updated)`,
    };
  };
}
