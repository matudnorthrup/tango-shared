/**
 * Discord Send Image Tool — outbound images/screenshots to Discord channels.
 *
 * Tools:
 *   - discord_send_image: Send a local image file or https image URL to a
 *     channel/thread, presented under the calling agent's persona via the
 *     same "Tango Replies" webhooks the reply presenter uses.
 *
 * Runs inside the persistent MCP tool server (separate process from the
 * Discord client), so delivery goes through the Discord REST API directly,
 * mirroring discord_manage. Images send mid-turn, which is what
 * confirm-before-purchase flows need: the screenshot lands while the agent
 * waits for the user's reply.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  loadAgentConfigs,
  resolveConfigDir,
  resolveTangoDataDir,
  type AgentConfig,
  type AgentTool,
} from "@tango/core";
import { resolveSpeakerDisplayName } from "./reply-presentation.js";

const DEFAULT_WEBHOOK_NAME = "Tango Replies";
const DEFAULT_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 20_000;
// Discord channel types that are threads (parent channel owns the webhook).
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const ALLOWED_IMAGE_MIME_TYPES = new Set(Object.values(IMAGE_MIME_BY_EXTENSION));

export interface DiscordSendImageConfig {
  botToken?: string;
  webhookName?: string;
  maxBytes?: number;
  allowedPathPrefixes?: string[];
  loadAgents?: () => AgentConfig[];
  fetchImpl?: typeof fetch;
}

interface ResolvedSendImageConfig {
  botToken: string;
  webhookName: string;
  maxBytes: number;
  allowedPathPrefixes: string[];
  loadAgents: () => AgentConfig[];
  fetchImpl: typeof fetch;
}

interface LoadedImage {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

interface SendTarget {
  webhookChannelId: string;
  threadId?: string;
}

function defaultAllowedPathPrefixes(): string[] {
  const prefixes = ["/tmp/tango-", "/private/tmp/tango-"];
  try {
    prefixes.push(resolveTangoDataDir());
  } catch {
    // Data dir resolution requires a profile; path uploads stay tmp-only then.
  }
  return prefixes;
}

function resolveSendImageConfig(overrides?: DiscordSendImageConfig): ResolvedSendImageConfig {
  const envMax = Number.parseInt(process.env.TANGO_DISCORD_UPLOAD_MAX_BYTES ?? "", 10);
  return {
    botToken: overrides?.botToken ?? process.env.DISCORD_TOKEN ?? "",
    webhookName:
      overrides?.webhookName
      ?? process.env.TANGO_REPLY_WEBHOOK_NAME
      ?? DEFAULT_WEBHOOK_NAME,
    maxBytes:
      overrides?.maxBytes
      ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_UPLOAD_BYTES),
    allowedPathPrefixes: overrides?.allowedPathPrefixes ?? defaultAllowedPathPrefixes(),
    loadAgents: overrides?.loadAgents ?? (() => loadAgentConfigs(resolveConfigDir())),
    fetchImpl: overrides?.fetchImpl ?? fetch,
  };
}

export function isAllowedImagePath(realPath: string, allowedPrefixes: string[]): boolean {
  return allowedPrefixes.some((prefix) => prefix.length > 0 && realPath.startsWith(prefix));
}

export async function loadLocalImage(
  source: string,
  options: { allowedPathPrefixes: string[]; maxBytes: number },
): Promise<LoadedImage> {
  if (!path.isAbsolute(source)) {
    throw new Error(`source must be an absolute path or https URL, got: ${source}`);
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(source);
  } catch {
    throw new Error(`source file not found: ${source}`);
  }

  if (!isAllowedImagePath(realPath, options.allowedPathPrefixes)) {
    throw new Error(
      `source path is outside the allowed upload directories: ${realPath}. `
      + `Allowed prefixes: ${options.allowedPathPrefixes.join(", ")}`,
    );
  }

  const contentType = IMAGE_MIME_BY_EXTENSION[path.extname(realPath).toLowerCase()];
  if (!contentType) {
    throw new Error(
      `unsupported image extension on ${realPath}; supported: ${Object.keys(IMAGE_MIME_BY_EXTENSION).join(", ")}`,
    );
  }

  const stat = await fs.stat(realPath);
  if (!stat.isFile()) {
    throw new Error(`source is not a regular file: ${realPath}`);
  }
  if (stat.size > options.maxBytes) {
    throw new Error(
      `image is ${stat.size} bytes which exceeds the ${options.maxBytes} byte upload limit`,
    );
  }

  return {
    buffer: await fs.readFile(realPath),
    filename: path.basename(realPath),
    contentType,
  };
}

export async function fetchRemoteImage(
  source: string,
  options: { maxBytes: number; fetchImpl: typeof fetch },
): Promise<LoadedImage> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(`source is not a valid URL: ${source}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`only https image URLs are supported, got: ${url.protocol}//`);
  }

  const response = await options.fetchImpl(url.toString(), {
    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`image fetch failed: HTTP ${response.status} from ${url.hostname}`);
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
    throw new Error(
      `URL did not return a supported image content-type (got "${contentType || "none"}"); `
      + `supported: ${[...ALLOWED_IMAGE_MIME_TYPES].join(", ")}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > options.maxBytes) {
    throw new Error(
      `downloaded image is ${buffer.byteLength} bytes which exceeds the ${options.maxBytes} byte upload limit`,
    );
  }

  const urlBasename = path.basename(url.pathname);
  const extension = path.extname(urlBasename).toLowerCase();
  const filename = IMAGE_MIME_BY_EXTENSION[extension] === contentType && urlBasename.length > 1
    ? urlBasename
    : `image${mimeExtension(contentType)}`;

  return { buffer, filename, contentType };
}

function mimeExtension(contentType: string): string {
  for (const [extension, mime] of Object.entries(IMAGE_MIME_BY_EXTENSION)) {
    if (mime === contentType) return extension;
  }
  return ".png";
}

async function discordApi(
  method: string,
  endpoint: string,
  botToken: string,
  fetchImpl: typeof fetch,
): Promise<{ status: number; data: unknown }> {
  const response = await fetchImpl(`https://discord.com/api/v10${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

async function discordMultipart(
  endpoint: string,
  payload: Record<string, unknown>,
  image: LoadedImage,
  fetchImpl: typeof fetch,
  botToken?: string,
): Promise<{ status: number; data: unknown }> {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append(
    "files[0]",
    new Blob([new Uint8Array(image.buffer)], { type: image.contentType }),
    image.filename,
  );
  const response = await fetchImpl(`https://discord.com/api/v10${endpoint}`, {
    method: "POST",
    ...(botToken ? { headers: { Authorization: `Bot ${botToken}` } } : {}),
    body: form,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

export async function resolveSendTarget(
  channelId: string,
  botToken: string,
  fetchImpl: typeof fetch,
): Promise<SendTarget> {
  const { status, data } = await discordApi("GET", `/channels/${channelId}`, botToken, fetchImpl);
  if (status !== 200) {
    throw new Error(`could not resolve channel ${channelId}: HTTP ${status}`);
  }
  const channel = data as { type?: number; parent_id?: string | null };
  if (typeof channel.type === "number" && THREAD_CHANNEL_TYPES.has(channel.type)) {
    if (!channel.parent_id) {
      throw new Error(`thread ${channelId} has no parent channel for webhook delivery`);
    }
    return { webhookChannelId: channel.parent_id, threadId: channelId };
  }
  return { webhookChannelId: channelId };
}

interface WebhookRef {
  id: string;
  token: string;
}

export async function findOrCreateReplyWebhook(
  webhookChannelId: string,
  agentId: string,
  webhookName: string,
  botToken: string,
  fetchImpl: typeof fetch,
): Promise<WebhookRef | null> {
  const agentWebhookName = `${webhookName} - ${agentId}`.slice(0, 80);
  try {
    const { status, data } = await discordApi(
      "GET",
      `/channels/${webhookChannelId}/webhooks`,
      botToken,
      fetchImpl,
    );
    if (status === 200 && Array.isArray(data)) {
      const hooks = data as Array<{ id?: string; name?: string; token?: string }>;
      const usable = (predicate: (name: string) => boolean) =>
        hooks.find((hook) => hook.id && hook.token && hook.name && predicate(hook.name));
      const match =
        usable((name) => name === agentWebhookName)
        ?? usable((name) => name === webhookName)
        ?? usable((name) => name.startsWith(webhookName));
      if (match) {
        return { id: match.id!, token: match.token! };
      }
    }

    const created = await fetchImpl(`https://discord.com/api/v10/channels/${webhookChannelId}/webhooks`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: webhookName }),
    });
    if (!created.ok) {
      return null;
    }
    const webhook = (await created.json()) as { id?: string; token?: string };
    return webhook.id && webhook.token ? { id: webhook.id, token: webhook.token } : null;
  } catch {
    return null;
  }
}

export function resolveSenderPersona(
  agentId: string,
  agents: AgentConfig[],
): { displayName: string; avatarURL?: string } {
  const speaker = agents.find((agent) => agent.id === agentId) ?? null;
  const displayName = resolveSpeakerDisplayName(speaker ?? { id: agentId });
  const avatarURL = speaker?.avatarURL?.trim();
  return {
    displayName,
    // Webhook execute payloads only accept real URLs (no data URIs / file paths).
    ...(avatarURL && avatarURL.startsWith("https://") ? { avatarURL } : {}),
  };
}

export function createDiscordSendImageTools(overrides?: DiscordSendImageConfig): AgentTool[] {
  const config = resolveSendImageConfig(overrides);
  let cachedAgents: AgentConfig[] | null = null;

  function agents(): AgentConfig[] {
    if (!cachedAgents) {
      try {
        cachedAgents = config.loadAgents();
      } catch {
        cachedAgents = [];
      }
    }
    return cachedAgents;
  }

  return [
    {
      name: "discord_send_image",
      description: [
        "Send an image to a Discord channel or thread, shown under your own agent persona.",
        "Use this to show the user what you see: a screenshot of a queued-up cart or booking",
        "before submitting (confirm-before-purchase), a product photo, a map, or any visual aid.",
        "",
        "Inputs:",
        "  source — absolute local image path (e.g. a browser screenshot like",
        "           /tmp/tango-screenshot-1718046000123.png) OR an https image URL",
        "  channel_id — destination. Use discord_thread_id from 'Current user message metadata'",
        "           when present, otherwise discord_channel_id, to reply in the current conversation.",
        "  agent_id — your own agent id (lowercase, e.g. \"sierra\") so the image is presented as you",
        "  caption — optional message sent with the image",
        "",
        "Confirm-before-purchase protocol: screenshot the final review state, send it with a caption",
        "that summarizes the key details (items, total price, address, dates) and explicitly asks the",
        "user to confirm, then END YOUR TURN and wait. Never submit an order, booking, or payment",
        "until the user replies affirmatively.",
        "",
        "Supported formats: png, jpg, jpeg, gif, webp. Max 8MB.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Absolute local image path or https image URL",
          },
          channel_id: {
            type: "string",
            description: "Destination channel or thread ID (prefer the current conversation's id from turn metadata)",
          },
          agent_id: {
            type: "string",
            description: "Calling agent's id, used to present the image under that agent's persona",
          },
          caption: {
            type: "string",
            description: "Optional message text to send with the image",
          },
        },
        required: ["source", "channel_id", "agent_id"],
      },
      handler: async (input) => {
        const source = String(input.source ?? "").trim();
        const channelId = String(input.channel_id ?? "").trim();
        const agentId = String(input.agent_id ?? "").trim().toLowerCase();
        const caption = typeof input.caption === "string" ? input.caption.trim() : "";

        if (!config.botToken) return { error: "No Discord bot token configured" };
        if (!source) return { error: "source required" };
        if (!channelId) return { error: "channel_id required" };
        if (!agentId) return { error: "agent_id required" };
        if (caption.length > 1900) {
          return { error: "caption exceeds 1900 characters; shorten it" };
        }

        let image: LoadedImage;
        let target: SendTarget;
        try {
          image = source.startsWith("https://") || source.startsWith("http://")
            ? await fetchRemoteImage(source, config)
            : await loadLocalImage(source, config);
          target = await resolveSendTarget(channelId, config.botToken, config.fetchImpl);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }

        const persona = resolveSenderPersona(agentId, agents());

        const webhook = await findOrCreateReplyWebhook(
          target.webhookChannelId,
          agentId,
          config.webhookName,
          config.botToken,
          config.fetchImpl,
        );
        if (webhook) {
          const query = new URLSearchParams({ wait: "true" });
          if (target.threadId) query.set("thread_id", target.threadId);
          const { status, data } = await discordMultipart(
            `/webhooks/${webhook.id}/${webhook.token}?${query.toString()}`,
            {
              content: caption,
              username: persona.displayName,
              ...(persona.avatarURL ? { avatar_url: persona.avatarURL } : {}),
            },
            image,
            config.fetchImpl,
          );
          if (status === 200) {
            const message = data as { id?: string };
            return {
              message_id: message.id,
              channel_id: channelId,
              delivery: "webhook",
              username: persona.displayName,
              filename: image.filename,
              size_bytes: image.buffer.byteLength,
            };
          }
          console.error(
            `[discord_send_image] webhook delivery failed channel=${channelId} status=${status}, falling back to bot send`,
          );
        }

        const { status, data } = await discordMultipart(
          `/channels/${channelId}/messages`,
          { content: caption },
          image,
          config.fetchImpl,
          config.botToken,
        );
        if (status !== 200 && status !== 201) {
          return { error: `image delivery failed: HTTP ${status}`, data };
        }
        const message = data as { id?: string };
        return {
          message_id: message.id,
          channel_id: channelId,
          delivery: "bot",
          username: persona.displayName,
          filename: image.filename,
          size_bytes: image.buffer.byteLength,
          note: "sent as the bot account; webhook persona delivery was unavailable",
        };
      },
    },
  ];
}
