import * as fs from "node:fs";
import * as path from "node:path";

interface SmokeTestWebhookChannelLike {
  isThread?: () => boolean;
  parentId?: string | null;
}

interface SmokeTestWebhookMessageLike {
  webhookId?: string | null;
  channel?: SmokeTestWebhookChannelLike | null;
}

/** Cache of harness webhook IDs loaded from ~/.tango/slots/webhooks.json */
let harnessWebhookIds: Set<string> | null = null;
let harnessWebhookIdsLoadedAt = 0;
const CACHE_TTL_MS = 30_000; // re-read file every 30s

export function loadReplyWebhookIds(): Set<string> {
  const now = Date.now();
  if (harnessWebhookIds && now - harnessWebhookIdsLoadedAt < CACHE_TTL_MS) {
    return harnessWebhookIds;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const filePath = path.join(home, ".tango", "slots", "webhooks.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const ids = new Set<string>();
    if (parsed?.webhooks && typeof parsed.webhooks === "object") {
      for (const entry of Object.values(parsed.webhooks)) {
        const id = (entry as { id?: string })?.id?.trim();
        if (id) ids.add(id);
      }
    }
    harnessWebhookIds = ids;
    harnessWebhookIdsLoadedAt = now;
    return ids;
  } catch {
    // File doesn't exist or is malformed — no harness webhooks known
    harnessWebhookIds = new Set();
    harnessWebhookIdsLoadedAt = now;
    return harnessWebhookIds;
  }
}

export function isSmokeTestThreadWebhookMessage(
  message: SmokeTestWebhookMessageLike,
  smokeTestChannelIds: ReadonlySet<string>,
): boolean {
  const webhookId = message.webhookId?.trim();
  if (!webhookId) {
    return false;
  }

  // Only accept messages from known harness webhooks — reject bot's own
  // reply webhooks to prevent infinite feedback loops.
  const knownHarnessIds = loadReplyWebhookIds();
  if (!knownHarnessIds.has(webhookId)) {
    return false;
  }

  const channel = message.channel;
  if (!channel || typeof channel.isThread !== "function" || !channel.isThread()) {
    return false;
  }

  const parentId = channel.parentId?.trim();
  return Boolean(parentId && smokeTestChannelIds.has(parentId));
}
