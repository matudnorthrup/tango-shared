import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { resolveTangoProfileConfigDir } from "@tango/core";

const intakeWebhookEntrySchema = z.object({
  webhook_id: z.string().min(1),
  channel_id: z.string().min(1),
  agent_id: z.string().min(1),
  label: z.string().min(1),
}).strict();

const intakeWebhookConfigSchema = z.object({
  intake_webhooks: z.array(intakeWebhookEntrySchema).default([]),
}).strict();

export interface IntakeWebhookEntry {
  webhookId: string;
  channelId: string;
  agentId: string;
  label: string;
}

export interface IntakeWebhookMessageLike {
  webhookId?: string | null;
  channelId: string;
  content?: string;
}

function resolveRepoDefaultsConfigDir(baseDir = process.cwd()): string | undefined {
  let current = path.resolve(baseDir);
  while (true) {
    const candidate = path.join(current, "config", "defaults");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readEntries(filePath: string): IntakeWebhookEntry[] | undefined {
  try {
    const parsed = intakeWebhookConfigSchema.parse(yaml.load(fs.readFileSync(filePath, "utf8")));
    return parsed.intake_webhooks.map((entry) => ({
      webhookId: entry.webhook_id.trim(),
      channelId: entry.channel_id.trim(),
      agentId: entry.agent_id.trim(),
      label: entry.label.trim(),
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Profile config replaces repo placeholders, matching the channels.yaml overlay convention. */
export function loadIntakeWebhookEntries(options?: {
  defaultsConfigDir?: string;
  profileConfigDir?: string;
}): IntakeWebhookEntry[] {
  const defaultsConfigDir = options?.defaultsConfigDir ?? resolveRepoDefaultsConfigDir();
  const profileConfigDir = options?.profileConfigDir ?? resolveTangoProfileConfigDir();
  const defaults = defaultsConfigDir
    ? readEntries(path.join(defaultsConfigDir, "intake-webhooks.yaml"))
    : undefined;
  const profile = readEntries(path.join(profileConfigDir, "intake-webhooks.yaml"));
  return profile ?? defaults ?? [];
}

export function resolveIntakeWebhookMessage(
  message: IntakeWebhookMessageLike,
  entries: readonly IntakeWebhookEntry[],
  replyWebhookIds: ReadonlySet<string>,
): IntakeWebhookEntry | null {
  const webhookId = message.webhookId?.trim();
  if (!webhookId || replyWebhookIds.has(webhookId)) return null;
  if (message.content?.startsWith("\u200B")) return null;
  return entries.find(
    (entry) => entry.webhookId === webhookId && entry.channelId === message.channelId,
  ) ?? null;
}

export function intakeSenderId(entry: IntakeWebhookEntry): string {
  return `intake-webhook:${entry.webhookId}`;
}
