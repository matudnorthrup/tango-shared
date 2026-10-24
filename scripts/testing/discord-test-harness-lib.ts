import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Client,
  GatewayIntentBits,
  WebhookClient,
  type Collection,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type Webhook,
} from "discord.js";
import { TangoStorage, loadUnifiedAgentConfigs, resolveConfigDir, resolveDatabasePath } from "@tango/core";
import { ensureSmokeThread } from "./discord-smoke-thread.js";

dotenv.config({ quiet: true });

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const HARNESS_WEBHOOK_NAME = "Tango Test Harness";
const WEBHOOK_STORE_PATH = path.join(os.homedir(), ".tango", "slots", "webhooks.json");

type WebhookCapableChannel = TextChannel & {
  fetchWebhooks(): Promise<Collection<string, Webhook>>;
  createWebhook(options: { name: string }): Promise<Webhook>;
};

export interface HarnessContext {
  client: Client;
  storage: TangoStorage;
  dbPath: string;
}

export interface HarnessTarget {
  channel: TextChannel | ThreadChannel;
  parentChannel: WebhookCapableChannel;
  kind: "channel" | "thread";
  threadId: string | null;
  channelId: string;
  channelName: string;
  parentChannelId: string;
  parentChannelName: string;
}

export interface HarnessRunInput {
  context: HarnessContext;
  target: HarnessTarget;
  content: string;
  username?: string | null;
  waitForResponse?: boolean;
  /** Wait for a later raw Discord message beginning with this prefix. */
  followUpPrefix?: string | null;
  timeoutMs?: number;
  cleanup?: boolean;
}

export interface HarnessRunResult {
  sentMessageId: string;
  receivedResponse: boolean;
  responseText: string | null;
  responseMessageId: string | null;
  responseRecordId: number | null;
  responseAgentId: string | null;
  responseSessionId: string | null;
  receivedFollowUp: boolean;
  followUpText: string | null;
  followUpMessageId: string | null;
  targetChannelId: string;
  targetChannelName: string;
  targetKind: "channel" | "thread";
  parentChannelId: string;
  parentChannelName: string;
  timeoutMs: number;
}

interface StoredWebhookRecord {
  id: string;
  token: string;
  channelId: string;
  channelName: string;
  name: string;
  updatedAt: string;
}

interface WebhookStoreFile {
  version: 1;
  webhooks: Record<string, StoredWebhookRecord>;
}

function parseFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

export function parseOptionalSlotFlag(): string | null {
  return parseFlagValue("--slot");
}

export function applySlotOverlay(slot: string | null | undefined): void {
  const normalized = slot?.trim() || "";
  if (!normalized) {
    return;
  }
  if (!/^[123]$/.test(normalized)) {
    throw new Error(`Invalid slot '${slot}'. Expected 1, 2, or 3.`);
  }
  process.env.TANGO_PROFILE = `wt-${normalized}`;
  process.env.TANGO_SLOT = normalized;
  process.env.TANGO_VOICE_BRIDGE_ENABLED = "false";
}

function getDiscordToken(): string {
  const token = process.env["DISCORD_TOKEN"]?.trim();
  if (!token) {
    throw new Error("DISCORD_TOKEN is required.");
  }
  return token;
}

export function getResolvedDbPath(): string {
  return resolveDatabasePath(process.env["TANGO_DB_PATH"]);
}

function loadWebhookStore(): WebhookStoreFile {
  try {
    const raw = fs.readFileSync(WEBHOOK_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<WebhookStoreFile>;
    if (!parsed || parsed.version !== 1 || typeof parsed.webhooks !== "object" || parsed.webhooks === null) {
      return { version: 1, webhooks: {} };
    }
    return {
      version: 1,
      webhooks: Object.fromEntries(
        Object.entries(parsed.webhooks).filter((entry): entry is [string, StoredWebhookRecord] => {
          const [, value] = entry;
          return Boolean(
            value
            && typeof value.id === "string"
            && typeof value.token === "string"
            && typeof value.channelId === "string"
            && typeof value.channelName === "string"
            && typeof value.name === "string"
            && typeof value.updatedAt === "string",
          );
        }),
      ),
    };
  } catch {
    return { version: 1, webhooks: {} };
  }
}

function saveWebhookStore(store: WebhookStoreFile): void {
  fs.mkdirSync(path.dirname(WEBHOOK_STORE_PATH), { recursive: true, mode: 0o700 });
  const tempPath = `${WEBHOOK_STORE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tempPath, WEBHOOK_STORE_PATH);
}

function upsertWebhookRecord(record: StoredWebhookRecord): void {
  const store = loadWebhookStore();
  store.webhooks[record.channelId] = record;
  saveWebhookStore(store);
}

function getCachedWebhookRecord(channelId: string): StoredWebhookRecord | null {
  const record = loadWebhookStore().webhooks[channelId];
  return record ?? null;
}

function deleteCachedWebhookRecord(channelId: string): void {
  const store = loadWebhookStore();
  if (!(channelId in store.webhooks)) {
    return;
  }
  delete store.webhooks[channelId];
  saveWebhookStore(store);
}

function loadAgentConfig(agentId: string): { id: string; voice?: { smokeTestChannelId?: string; defaultChannelId?: string } } {
  const config = loadUnifiedAgentConfigs(resolveConfigDir()).find((candidate) => candidate.id === agentId);
  if (!config) {
    throw new Error(`Unknown agent '${agentId}'.`);
  }
  return config;
}

function getSmokeTestParentChannelId(agentId: string): string {
  const config = loadAgentConfig(agentId);
  const channelId = config.voice?.smokeTestChannelId?.trim() || "";
  if (!/^\d+$/.test(channelId)) {
    throw new Error(`Agent '${agentId}' does not have a configured smoke-test channel.`);
  }
  return channelId;
}

function describeChannel(channel: TextChannel | ThreadChannel): string {
  const name = "name" in channel && typeof channel.name === "string" ? channel.name : channel.id;
  return name || channel.id;
}

function isThreadChannel(channel: TextChannel | ThreadChannel): channel is ThreadChannel {
  return typeof channel.isThread === "function" && channel.isThread();
}

function isTextChannel(channel: unknown): channel is TextChannel {
  return Boolean(
    channel
    && typeof channel === "object"
    && "isTextBased" in channel
    && typeof (channel as { isTextBased?: () => boolean }).isTextBased === "function"
    && (channel as { isTextBased: () => boolean }).isTextBased()
    && "isThread" in channel
    && typeof (channel as { isThread?: () => boolean }).isThread === "function"
    && !(channel as { isThread: () => boolean }).isThread()
    && "send" in channel
    && typeof (channel as { send?: unknown }).send === "function",
  );
}

function isThreadSendable(channel: unknown): channel is ThreadChannel {
  return Boolean(
    channel
    && typeof channel === "object"
    && "isThread" in channel
    && typeof (channel as { isThread?: () => boolean }).isThread === "function"
    && (channel as { isThread: () => boolean }).isThread()
    && "send" in channel
    && typeof (channel as { send?: unknown }).send === "function",
  );
}

function isWebhookCapableChannel(channel: unknown): channel is WebhookCapableChannel {
  return isTextChannel(channel)
    && typeof channel.fetchWebhooks === "function"
    && typeof channel.createWebhook === "function";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForClientReady(client: Client): Promise<void> {
  if (client.isReady()) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Discord login timeout")), 15_000);
    client.once("clientReady", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function createHarnessContext(): Promise<HarnessContext> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  const readyPromise = waitForClientReady(client);
  await client.login(getDiscordToken());
  await readyPromise;
  const dbPath = getResolvedDbPath();
  const storage = new TangoStorage(dbPath);
  return { client, storage, dbPath };
}

export async function closeHarnessContext(context: HarnessContext): Promise<void> {
  context.storage.close();
  await context.client.destroy();
}

export async function resolveExplicitHarnessTarget(
  client: Client,
  channelId: string,
): Promise<HarnessTarget> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    throw new Error(`Discord channel '${channelId}' was not found.`);
  }

  if (isThreadSendable(channel)) {
    const parentId = channel.parentId?.trim() || "";
    if (!parentId) {
      throw new Error(`Thread '${channelId}' does not have a parent channel.`);
    }
    const parentChannel = await client.channels.fetch(parentId).catch(() => null);
    if (!isWebhookCapableChannel(parentChannel)) {
      throw new Error(`Parent channel '${parentId}' for thread '${channelId}' cannot manage webhooks.`);
    }
    return {
      channel,
      parentChannel,
      kind: "thread",
      threadId: channel.id,
      channelId: channel.id,
      channelName: describeChannel(channel),
      parentChannelId: parentChannel.id,
      parentChannelName: parentChannel.name,
    };
  }

  if (!isWebhookCapableChannel(channel)) {
    throw new Error(`Channel '${channelId}' is not a sendable text channel.`);
  }

  return {
    channel,
    parentChannel: channel,
    kind: "channel",
    threadId: null,
    channelId: channel.id,
    channelName: describeChannel(channel),
    parentChannelId: channel.id,
    parentChannelName: channel.name,
  };
}

export async function resolveAgentHarnessTarget(
  client: Client,
  input: {
    agentId: string;
    slot?: string | null;
    explicitThreadName?: string | null;
  },
): Promise<HarnessTarget> {
  const normalizedSlot = input.slot?.trim() || "";
  if (normalizedSlot) {
    return await findActiveSlotSmokeThread(client, {
      agentId: input.agentId,
      slot: normalizedSlot,
    });
  }

  const threadId = await ensureSmokeThread({
    token: getDiscordToken(),
    agentId: input.agentId,
    explicitThreadName: input.explicitThreadName ?? undefined,
  });
  if (!threadId) {
    throw new Error(`Could not resolve or create a smoke thread for agent '${input.agentId}'.`);
  }
  return await resolveExplicitHarnessTarget(client, threadId);
}

export async function findActiveSlotSmokeThread(
  client: Client,
  input: { agentId: string; slot: string },
): Promise<HarnessTarget> {
  const parentChannelId = getSmokeTestParentChannelId(input.agentId);
  const parentChannel = await client.channels.fetch(parentChannelId).catch(() => null);
  if (!isWebhookCapableChannel(parentChannel)) {
    throw new Error(
      `Smoke-test parent channel '${parentChannelId}' for agent '${input.agentId}' is unavailable or cannot manage webhooks.`,
    );
  }

  const activeThreads = await parentChannel.threads.fetchActive();
  const prefix = `[wt-${input.slot}] `;
  const candidates = [...activeThreads.threads.values()]
    .filter((thread) => thread.name.startsWith(prefix))
    .sort((left, right) => (right.createdTimestamp ?? 0) - (left.createdTimestamp ?? 0));

  const thread = candidates[0] ?? null;
  if (!thread) {
    throw new Error(
      `No active slot smoke-test thread found for agent '${input.agentId}' and slot '${input.slot}'.`,
    );
  }

  return {
    channel: thread,
    parentChannel,
    kind: "thread",
    threadId: thread.id,
    channelId: thread.id,
    channelName: thread.name,
    parentChannelId: parentChannel.id,
    parentChannelName: parentChannel.name,
  };
}

async function resolveOrCreateHarnessWebhook(
  target: HarnessTarget,
  options?: { forceRefresh?: boolean },
): Promise<{ id: string; token: string }> {
  const cached = options?.forceRefresh ? null : getCachedWebhookRecord(target.parentChannelId);
  if (cached) {
    return { id: cached.id, token: cached.token };
  }

  const existing = [...(await target.parentChannel.fetchWebhooks()).values()]
    .find((candidate) => candidate.name === HARNESS_WEBHOOK_NAME && typeof candidate.token === "string" && candidate.token.length > 0);
  const webhook = existing ?? await target.parentChannel.createWebhook({ name: HARNESS_WEBHOOK_NAME });
  const token = webhook.token?.trim();
  if (!token) {
    throw new Error(`Webhook '${HARNESS_WEBHOOK_NAME}' for channel '${target.parentChannelId}' does not have a usable token.`);
  }

  upsertWebhookRecord({
    id: webhook.id,
    token,
    channelId: target.parentChannelId,
    channelName: target.parentChannelName,
    name: webhook.name ?? HARNESS_WEBHOOK_NAME,
    updatedAt: new Date().toISOString(),
  });

  return { id: webhook.id, token };
}

async function deleteHarnessMessage(
  webhookClient: WebhookClient,
  target: HarnessTarget,
  messageId: string,
): Promise<void> {
  await webhookClient.deleteMessage(messageId, target.threadId ?? undefined).catch(() => undefined);
}

async function deleteDiscordMessage(
  target: HarnessTarget,
  messageId: string,
): Promise<void> {
  const message = await target.channel.messages.fetch(messageId).catch(() => null);
  await message?.delete().catch(() => undefined);
}

async function waitForHarnessResponse(
  input: {
    context: HarnessContext;
    target: HarnessTarget;
    sentMessageId: string;
    timeoutMs: number;
  },
): Promise<{
  responseText: string;
  responseMessageId: string;
  responseRecordId: number | null;
  responseAgentId: string | null;
  responseSessionId: string | null;
} | null> {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < input.timeoutMs) {
    const messages = await input.target.channel.messages.fetch({
      after: input.sentMessageId,
      limit: 50,
    });
    const candidates = [...messages.values()].sort((left, right) => left.createdTimestamp - right.createdTimestamp);

    for (const candidate of candidates) {
      const stored = input.context.storage.getMessageByDiscordMessageId(candidate.id, {
        channelId: input.target.channelId,
      });
      if (stored?.source !== "tango" || stored.direction !== "outbound") {
        continue;
      }
      return {
        responseText: stored.content,
        responseMessageId: candidate.id,
        responseRecordId: stored.id,
        responseAgentId: stored.agentId,
        responseSessionId: stored.sessionId,
      };
    }

    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }

  return null;
}

async function waitForHarnessFollowUp(input: {
  target: HarnessTarget;
  sentMessageId: string;
  prefix: string;
  timeoutMs: number;
}): Promise<{ text: string; messageId: string } | null> {
  const prefix = input.prefix.trim();
  if (!prefix) return null;
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < input.timeoutMs) {
    const messages = await input.target.channel.messages.fetch({
      after: input.sentMessageId,
      limit: 50,
    });
    const followUp = [...messages.values()]
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .find((candidate) => candidate.content.trim().startsWith(prefix));
    if (followUp) return { text: followUp.content, messageId: followUp.id };
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  return null;
}

export async function runHarnessTurn(input: HarnessRunInput): Promise<HarnessRunResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let webhook = await resolveOrCreateHarnessWebhook(input.target);
  let webhookClient = new WebhookClient(webhook);
  let sent: unknown;
  try {
    sent = await webhookClient.send({
      content: input.content,
      username: input.username?.trim() || "Tango Test Harness",
      threadId: input.target.threadId ?? undefined,
      wait: true,
    });
  } catch {
    deleteCachedWebhookRecord(input.target.parentChannelId);
    webhook = await resolveOrCreateHarnessWebhook(input.target, { forceRefresh: true });
    webhookClient = new WebhookClient(webhook);
    sent = await webhookClient.send({
      content: input.content,
      username: input.username?.trim() || "Tango Test Harness",
      threadId: input.target.threadId ?? undefined,
      wait: true,
    });
  }
  const sentMessage = sent as Message;

  let response: Awaited<ReturnType<typeof waitForHarnessResponse>> = null;
  let followUp: Awaited<ReturnType<typeof waitForHarnessFollowUp>> = null;
  try {
    if (input.waitForResponse ?? false) {
      response = await waitForHarnessResponse({
        context: input.context,
        target: input.target,
        sentMessageId: sentMessage.id,
        timeoutMs,
      });
    }
    if (input.followUpPrefix?.trim()) {
      followUp = await waitForHarnessFollowUp({
        target: input.target,
        sentMessageId: sentMessage.id,
        prefix: input.followUpPrefix,
        timeoutMs,
      });
    }
  } finally {
    if (input.cleanup) {
      if (followUp?.messageId) {
        await deleteDiscordMessage(input.target, followUp.messageId);
      }
      if (response?.responseMessageId) {
        await deleteDiscordMessage(input.target, response.responseMessageId);
      }
      await deleteHarnessMessage(webhookClient, input.target, sentMessage.id);
    }
  }

  return {
    sentMessageId: sentMessage.id,
    receivedResponse: Boolean(response),
    responseText: response?.responseText ?? null,
    responseMessageId: response?.responseMessageId ?? null,
    responseRecordId: response?.responseRecordId ?? null,
    responseAgentId: response?.responseAgentId ?? null,
    responseSessionId: response?.responseSessionId ?? null,
    receivedFollowUp: Boolean(followUp),
    followUpText: followUp?.text ?? null,
    followUpMessageId: followUp?.messageId ?? null,
    targetChannelId: input.target.channelId,
    targetChannelName: input.target.channelName,
    targetKind: input.target.kind,
    parentChannelId: input.target.parentChannelId,
    parentChannelName: input.target.parentChannelName,
    timeoutMs,
  };
}

export function formatHarnessTarget(target: HarnessTarget): string {
  return `${target.kind}:${target.channelName} (${target.channelId}) parent=${target.parentChannelName} (${target.parentChannelId})`;
}
