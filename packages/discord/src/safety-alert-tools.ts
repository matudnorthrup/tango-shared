import type { AgentTool } from "@tango/core";

/**
 * `safety_alert` lets an agent that talks with someone other than the owner
 * (for example a child's agent) page the owner when the conversation raises a
 * safety concern. It is deliberately narrow: the agent supplies only a
 * severity and a short summary; the destination channel and the person to
 * mention come from the environment, and the source channel is injected by
 * the MCP server from turn provenance, never from model arguments.
 *
 * Env:
 *   TANGO_SAFETY_ALERT_CHANNEL_ID  — owner-only channel for alerts
 *                                    (falls back to TANGO_SCHEDULER_ALERTS_CHANNEL_ID)
 *   TANGO_SAFETY_ALERT_MENTION_USER_ID — Discord user to @mention (push notification)
 *   DISCORD_COMMAND_GUILD_ID / DISCORD_TEST_GUILD_ID — for the jump link
 */

export type SafetyAlertSeverity = "urgent" | "concern";

export interface SafetyAlertSender {
  (input: { channelId: string; content: string; mentionUserId?: string }): Promise<{ ok: boolean; detail?: string }>;
}

export interface SafetyAlertToolOptions {
  env?: NodeJS.ProcessEnv;
  sender?: SafetyAlertSender;
}

const MAX_SUMMARY_CHARS = 1500;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildSafetyAlertContent(input: {
  severity: SafetyAlertSeverity;
  summary: string;
  agentId?: string;
  sourceChannelId?: string;
  sourceThreadId?: string;
  guildId?: string;
  mentionUserId?: string;
}): string {
  const heading = input.severity === "urgent" ? "🚨 **Urgent safety alert**" : "⚠️ **Safety concern**";
  const surfaceId = input.sourceThreadId || input.sourceChannelId;
  const link = surfaceId
    ? input.guildId
      ? `https://discord.com/channels/${input.guildId}/${surfaceId}`
      : `<#${surfaceId}>`
    : null;
  const summary = input.summary.length > MAX_SUMMARY_CHARS
    ? `${input.summary.slice(0, MAX_SUMMARY_CHARS)}…`
    : input.summary;
  return [
    input.mentionUserId ? `<@${input.mentionUserId}> ${heading}` : heading,
    `From: ${input.agentId ?? "unknown agent"}${link ? ` · ${link}` : ""}`,
    "",
    summary,
  ].join("\n");
}

async function sendViaDiscordRest(
  token: string,
  input: { channelId: string; content: string; mentionUserId?: string },
): Promise<{ ok: boolean; detail?: string }> {
  const response = await fetch(`https://discord.com/api/v10/channels/${input.channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: input.content,
      allowed_mentions: { parse: [], users: input.mentionUserId ? [input.mentionUserId] : [] },
    }),
  });
  if (!response.ok) {
    return { ok: false, detail: `Discord HTTP ${response.status}: ${await response.text()}` };
  }
  return { ok: true };
}

export function createSafetyAlertTools(options: SafetyAlertToolOptions = {}): AgentTool[] {
  return [
    {
      name: "safety_alert",
      description: [
        "Alert the parent/owner right away about a safety concern in this conversation.",
        "Use 'urgent' for any risk of self-harm or suicide, abuse, someone hurting them, or being unsafe right now.",
        "Use 'concern' for serious but not immediate worries the parent should know about soon.",
        "The summary should state what was said and why it matters, in a few sentences.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["urgent", "concern"] },
          summary: { type: "string" },
        },
        required: ["severity", "summary"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const env = options.env ?? process.env;
        const severity = readString(input.severity) as SafetyAlertSeverity;
        if (severity !== "urgent" && severity !== "concern") {
          throw new Error("severity must be 'urgent' or 'concern'");
        }
        const summary = readString(input.summary);
        if (!summary) {
          throw new Error("summary is required");
        }

        const channelId =
          env.TANGO_SAFETY_ALERT_CHANNEL_ID?.trim() || env.TANGO_SCHEDULER_ALERTS_CHANNEL_ID?.trim();
        if (!channelId) {
          throw new Error("No safety alert channel configured (TANGO_SAFETY_ALERT_CHANNEL_ID).");
        }
        const mentionUserId = env.TANGO_SAFETY_ALERT_MENTION_USER_ID?.trim() || undefined;
        const content = buildSafetyAlertContent({
          severity,
          summary,
          agentId: readString(input._requester_agent_id) || undefined,
          sourceChannelId: readString(input._channel_id) || undefined,
          sourceThreadId: readString(input._thread_id) || undefined,
          guildId: env.DISCORD_COMMAND_GUILD_ID?.trim() || env.DISCORD_TEST_GUILD_ID?.trim() || undefined,
          mentionUserId,
        });

        const sender: SafetyAlertSender | undefined = options.sender
          ?? (env.DISCORD_TOKEN ? (message) => sendViaDiscordRest(env.DISCORD_TOKEN!, message) : undefined);
        if (!sender) {
          throw new Error("DISCORD_TOKEN is not configured; safety alert not sent.");
        }
        const result = await sender({ channelId, content, ...(mentionUserId ? { mentionUserId } : {}) });
        if (!result.ok) {
          throw new Error(`Safety alert failed to send: ${result.detail ?? "unknown error"}`);
        }
        console.error(`[safety-alert] sent severity=${severity} agent=${readString(input._requester_agent_id) || "unknown"}`);
        return { sent: true, severity };
      },
    },
  ];
}
