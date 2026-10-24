/**
 * Slack Tools — Universal Slack Web API tool.
 *
 * Provides a single `slack` tool that wraps the Slack Web API, letting agents
 * list channels, read history, resolve users, and search — without embedding
 * workflow logic in the handler.
 *
 * Auth: Bot token fetched from 1Password (Watson vault, "Watson Slack Bot Token").
 * `saved_items` and `remove_star` use a Slack user token for the native stars API.
 */

import type { AgentTool } from "@tango/core";
import { getSecret } from "./op-secret.js";

const SLACK_API = "https://slack.com/api";
const READ_ONLY_SLACK_ACTIONS = new Set([
  "list_channels",
  "search_messages",
  "channel_history",
  "user_info",
  "thread_replies",
  "saved_items",
  "my_user_id",
]);

export function slackActionLooksReadOnly(action: unknown): boolean {
  return typeof action === "string" && READ_ONLY_SLACK_ACTIONS.has(action.trim().toLowerCase());
}

class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string,
  ) {
    super(`Slack ${method}: ${slackError}`);
  }
}

class SlackRateLimitError extends Error {
  constructor(
    public readonly retryAfterSeconds: number,
  ) {
    super(`Slack search rate limited; retry after ${retryAfterSeconds} seconds`);
  }
}

const SLACK_SEARCH_WINDOW_MS = 60_000;
const SLACK_SEARCH_REQUESTS_PER_WINDOW = 9;
const slackSearchRequestTimes: number[] = [];

function claimSlackSearchBudget(): void {
  const now = Date.now();
  while (
    slackSearchRequestTimes.length > 0 &&
    now - slackSearchRequestTimes[0]! >= SLACK_SEARCH_WINDOW_MS
  ) {
    slackSearchRequestTimes.shift();
  }

  if (slackSearchRequestTimes.length >= SLACK_SEARCH_REQUESTS_PER_WINDOW) {
    const retryAfterMs = SLACK_SEARCH_WINDOW_MS - (now - slackSearchRequestTimes[0]!);
    throw new SlackRateLimitError(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  }

  slackSearchRequestTimes.push(now);
}

let cachedToken: string | null = null;
async function getSlackToken(): Promise<string> {
  if (!cachedToken) {
    const token = await getSecret("Watson", "Watson Slack Bot Token");
    if (!token) throw new Error("Slack bot token not found in 1Password (Watson vault, item 'Watson Slack Bot Token')");
    cachedToken = token;
  }
  return cachedToken;
}

let cachedUserToken: string | null = null;
async function getSlackUserToken(): Promise<string> {
  if (!cachedUserToken) {
    const token = await getSecret("Watson", "Watson Slack User Token");
    if (!token) throw new Error("Slack user token not found in 1Password (Watson vault, item 'Watson Slack User Token')");
    cachedUserToken = token;
  }
  return cachedUserToken;
}

async function slackApiWithToken(
  token: string,
  method: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_API}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (!body.ok) throw new SlackApiError(method, String(body.error ?? "unknown_error"));
  return body;
}

async function slackApi(
  method: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const token = await getSlackToken();
  return slackApiWithToken(token, method, params);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function slackApiPostWithToken(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    throw new SlackRateLimitError(
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 60,
    );
  }
  if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);

  const body: unknown = await res.json();
  if (!isRecord(body)) throw new Error(`Slack ${method} returned an invalid response`);
  if (!body.ok && ["rate_limited", "ratelimited"].includes(String(body.error))) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    throw new SlackRateLimitError(
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 60,
    );
  }
  if (!body.ok) throw new SlackApiError(method, String(body.error ?? "unknown_error"));
  return body;
}

function selectFields(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in value) selected[field] = value[field];
  }
  return selected;
}

export function createSlackTools(): AgentTool[] {
  return [
    {
      name: "slack",
      description: [
        "Slack Web API access for Watson, including native saved items.",
        "",
        "Actions:",
        "",
        "  list_channels — List all channels the bot is in.",
        "    Returns: array of { id, name, is_private, num_members }",
        "",
        "  search_messages — Search public Slack messages and files with real-time search.",
        "    Params: query (required), limit (default 20, max 20), cursor (optional)",
        "    Returns: matching messages and files with permalinks and surrounding context",
        "    Search is limited to 9 calls per minute; each paginated request uses the same budget.",
        "",
        "  channel_history — Get recent messages from a channel.",
        "    Params: channel_id (required), hours (default 24), limit (default 200)",
        "    Returns: array of messages with user, text, ts, reply_count, reactions",
        "",
        "  user_info — Resolve a user ID to profile info.",
        "    Params: user_id (required)",
        "    Returns: { id, display_name, real_name, title }",
        "",
        "  thread_replies — Get replies in a message thread.",
        "    Params: channel_id (required), thread_ts (required)",
        "    Returns: array of reply messages",
        "",
        "  saved_items — List all Slack saved messages via stars.list API.",
        "    Params: limit (default 100), since_hours (default 48; set 0 to include all)",
        "    Returns: { count, since_hours, skipped_older_count, items: [{ type, channel_id, text, user, ts, permalink, date_create }] }",
        "",
        "  remove_star — Remove a star from a message (unsave it).",
        "    Params: channel_id (required), timestamp (required)",
        "    Returns: { ok: true }",
        "",
        "  my_user_id — Get the authenticated user's Slack user ID.",
        "    Returns: { user_id, user }",
        "",
        "Tips:",
        "- Call list_channels first to discover what's available.",
        "- For digests, fetch channel_history for each channel, then synthesize.",
        "- reply_count >= 2 and reaction counts indicate engaged discussions.",
        "- Filter out messages with subtype (joins/leaves) or bot_id (bot noise).",
        "- User IDs look like U0XXXXXXXXX — resolve with user_info for display names.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list_channels", "search_messages", "channel_history", "user_info", "thread_replies", "saved_items", "remove_star", "my_user_id"],
            description: "The Slack operation to perform",
          },
          query: {
            type: "string",
            description: "Slack search query, including filters such as in:, from:, before:, or after:",
          },
          cursor: {
            type: "string",
            description: "Pagination cursor returned by search_messages",
          },
          channel_id: {
            type: "string",
            description: "Channel ID (for channel_history, thread_replies, remove_star)",
          },
          user_id: {
            type: "string",
            description: "User ID (for user_info)",
          },
          thread_ts: {
            type: "string",
            description: "Thread timestamp (for thread_replies)",
          },
          timestamp: {
            type: "string",
            description: "Message timestamp (for remove_star)",
          },
          hours: {
            type: "number",
            description: "How many hours of history to fetch (default 24, for channel_history)",
          },
          limit: {
            type: "number",
            description: "Max items to return (20 for search_messages, 200 for channel_history, 100 for saved_items)",
          },
          since_hours: {
            type: "number",
            description: "Only return saved messages created in this many hours. Defaults to 48; set 0 to include all saved messages.",
          },
        },
        required: ["action"],
      },
      handler: async (input) => {
        const action = String(input.action);

        switch (action) {
          case "search_messages": {
            const query = String(input.query || "").trim();
            if (!query) return { error: "query is required" };

            const requestedLimit = Number(input.limit);
            const limit = Number.isFinite(requestedLimit)
              ? Math.min(20, Math.max(1, Math.floor(requestedLimit)))
              : 20;
            const cursor = String(input.cursor || "").trim();
            const payload: Record<string, unknown> = {
              query,
              channel_types: ["public_channel"],
              content_types: ["messages", "files"],
              include_context_messages: true,
              include_message_blocks: true,
              limit,
            };
            if (cursor) payload.cursor = cursor;

            let body: Record<string, unknown>;
            try {
              claimSlackSearchBudget();
              const userToken = await getSlackUserToken();
              body = await slackApiPostWithToken(
                userToken,
                "assistant.search.context",
                payload,
              );
            } catch (error) {
              if (error instanceof SlackRateLimitError) {
                return {
                  ok: false,
                  error: "rate_limited",
                  retry_after_seconds: error.retryAfterSeconds,
                };
              }
              throw error;
            }
            const results = isRecord(body.results) ? body.results : {};
            const messages: Array<Record<string, unknown>> = [];
            const files: Array<Record<string, unknown>> = [];

            if (Array.isArray(results.messages)) {
              for (const message of results.messages) {
                const selected = selectFields(message, [
                  "author_name",
                  "author_user_id",
                  "channel_id",
                  "channel_name",
                  "message_ts",
                  "content",
                  "permalink",
                  "is_author_bot",
                  "blocks",
                  "context_messages",
                ]);
                if (selected) messages.push(selected);
              }
            }

            if (Array.isArray(results.files)) {
              for (const file of results.files) {
                const selected = selectFields(file, [
                  "file_id",
                  "title",
                  "file_type",
                  "permalink",
                  "content",
                  "author_name",
                  "author_user_id",
                  "date_created",
                  "date_updated",
                ]);
                if (selected) files.push(selected);
              }
            }

            const responseMetadata = isRecord(body.response_metadata)
              ? body.response_metadata
              : {};
            return {
              query,
              messages,
              files,
              next_cursor: String(responseMetadata.next_cursor || ""),
            };
          }

          case "list_channels": {
            const body = await slackApi("users.conversations", {
              types: "public_channel,private_channel",
              limit: "200",
            });
            const channels = (body.channels as Array<Record<string, unknown>>) ?? [];
            return {
              channels: channels.map((ch) => ({
                id: ch.id,
                name: ch.name,
                is_private: ch.is_private,
                num_members: ch.num_members,
              })),
            };
          }

          case "channel_history": {
            const channelId = String(input.channel_id || "");
            if (!channelId) return { error: "channel_id is required" };
            const hours = Number(input.hours) || 24;
            const limit = Number(input.limit) || 200;
            const oldest = String((Date.now() - hours * 3600_000) / 1000);

            const body = await slackApi("conversations.history", {
              channel: channelId,
              oldest,
              limit: String(limit),
            });
            const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
            return {
              channel_id: channelId,
              message_count: messages.length,
              messages: messages.map((m) => ({
                user: m.user,
                text: m.text,
                ts: m.ts,
                subtype: m.subtype,
                bot_id: m.bot_id,
                reply_count: m.reply_count,
                reactions: m.reactions,
              })),
            };
          }

          case "user_info": {
            const userId = String(input.user_id || "");
            if (!userId) return { error: "user_id is required" };

            const body = await slackApi("users.info", { user: userId });
            const user = body.user as Record<string, unknown> | undefined;
            const profile = user?.profile as Record<string, string> | undefined;
            return {
              id: user?.id,
              display_name: profile?.display_name || profile?.real_name || userId,
              real_name: profile?.real_name,
              title: profile?.title,
            };
          }

          case "thread_replies": {
            const channelId = String(input.channel_id || "");
            const threadTs = String(input.thread_ts || "");
            if (!channelId || !threadTs) return { error: "channel_id and thread_ts are required" };

            const body = await slackApi("conversations.replies", {
              channel: channelId,
              ts: threadTs,
              limit: "100",
            });
            const messages = (body.messages as Array<Record<string, unknown>>) ?? [];
            return {
              channel_id: channelId,
              thread_ts: threadTs,
              reply_count: messages.length,
              messages: messages.map((m) => ({
                user: m.user,
                text: m.text,
                ts: m.ts,
              })),
            };
          }

          case "saved_items": {
            const limit = Number(input.limit) || 100;
            const rawSinceHours = input.since_hours === undefined ? 48 : Number(input.since_hours);
            const sinceHours = Number.isFinite(rawSinceHours) && rawSinceHours > 0 ? rawSinceHours : 0;
            const cutoffSeconds =
              sinceHours > 0 ? Math.floor(Date.now() / 1000 - sinceHours * 3600) : undefined;
            const userToken = await getSlackUserToken();
            const body = await slackApiWithToken(userToken, "stars.list", {
              count: String(limit),
            });
            const items = (body.items as Array<Record<string, unknown>>) ?? [];

            const messageItems: Array<Record<string, unknown>> = [];
            let skippedOlderCount = 0;
            let skippedNonMessageCount = 0;

            for (const item of items) {
              if (String(item.type) !== "message") {
                skippedNonMessageCount++;
                continue;
              }

              const dateCreate = Number(item.date_create);
              if (
                cutoffSeconds !== undefined &&
                Number.isFinite(dateCreate) &&
                dateCreate < cutoffSeconds
              ) {
                skippedOlderCount++;
                continue;
              }

              const channelId = String(item.channel || "");
              const message = item.message as Record<string, unknown> | undefined;
              const ts = String(message?.ts || "");

              if (!channelId || !message || !ts) continue;

              let permalink = "";
              try {
                const linkBody = await slackApi("chat.getPermalink", {
                  channel: channelId,
                  message_ts: ts,
                });
                permalink = String(linkBody.permalink || "");
              } catch {
                // Permalinks are best-effort only.
              }

              messageItems.push({
                type: "message",
                channel_id: channelId,
                text: message.text,
                user: message.user,
                ts,
                permalink,
                date_create: item.date_create,
              });
            }

            return {
              count: messageItems.length,
              total_items: items.length,
              since_hours: sinceHours,
              skipped_older_count: skippedOlderCount,
              skipped_non_message_count: skippedNonMessageCount,
              items: messageItems,
            };
          }

          case "remove_star": {
            const channelId = String(input.channel_id || "");
            const timestamp = String(input.timestamp || "");
            if (!channelId || !timestamp) {
              return { error: "remove_star requires channel_id and timestamp" };
            }
            const userToken = await getSlackUserToken();
            try {
              await slackApiWithToken(userToken, "stars.remove", {
                channel: channelId,
                timestamp,
              });
            } catch (error) {
              if (error instanceof SlackApiError && error.slackError === "missing_scope") {
                return {
                  ok: false,
                  error: "missing_scope",
                  required_scope: "stars:write",
                  remediation:
                    "Reauthorize the Watson Slack user token with the stars:write user scope, or manually unsave the item in Slack.",
                };
              }
              throw error;
            }
            return { ok: true };
          }

          case "my_user_id": {
            const userToken = await getSlackUserToken();
            const body = await slackApiWithToken(userToken, "auth.test", {});
            return { user_id: body.user_id, user: body.user };
          }

          default:
            return { error: `Unknown action: ${action}. Use list_channels, search_messages, channel_history, user_info, thread_replies, saved_items, remove_star, or my_user_id.` };
        }
      },
    },
  ];
}
