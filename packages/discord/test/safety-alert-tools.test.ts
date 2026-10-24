import { describe, expect, it, vi } from "vitest";
import { buildSafetyAlertContent, createSafetyAlertTools } from "../src/safety-alert-tools.js";

function tool(options: Parameters<typeof createSafetyAlertTools>[0]) {
  const [safetyAlert] = createSafetyAlertTools(options);
  return safetyAlert!;
}

describe("safety_alert", () => {
  it("posts to the configured channel, mentions the owner, and links the source", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true });
    const result = await tool({
      env: {
        TANGO_SAFETY_ALERT_CHANNEL_ID: "alerts-1",
        TANGO_SAFETY_ALERT_MENTION_USER_ID: "owner-9",
        DISCORD_TEST_GUILD_ID: "guild-5",
      },
      sender,
    }).handler({
      severity: "urgent",
      summary: "Said he wants to hurt himself tonight.",
      _requester_agent_id: "oscar",
      _channel_id: "chan-2",
    });

    expect(result).toEqual({ sent: true, severity: "urgent" });
    expect(sender).toHaveBeenCalledTimes(1);
    const message = sender.mock.calls[0]![0] as { channelId: string; content: string; mentionUserId?: string };
    expect(message.channelId).toBe("alerts-1");
    expect(message.mentionUserId).toBe("owner-9");
    expect(message.content).toContain("<@owner-9>");
    expect(message.content).toContain("Urgent safety alert");
    expect(message.content).toContain("From: oscar");
    expect(message.content).toContain("https://discord.com/channels/guild-5/chan-2");
    expect(message.content).toContain("hurt himself");
  });

  it("falls back to the scheduler alerts channel", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true });
    await tool({ env: { TANGO_SCHEDULER_ALERTS_CHANNEL_ID: "sched-1" }, sender })
      .handler({ severity: "concern", summary: "Bullying at school for weeks." });
    expect((sender.mock.calls[0]![0] as { channelId: string }).channelId).toBe("sched-1");
  });

  it("rejects bad input and surfaces send failures", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: false, detail: "HTTP 403" });
    const safetyAlert = tool({ env: { TANGO_SAFETY_ALERT_CHANNEL_ID: "a" }, sender });
    await expect(safetyAlert.handler({ severity: "panic", summary: "x" })).rejects.toThrow(/severity/u);
    await expect(safetyAlert.handler({ severity: "urgent", summary: " " })).rejects.toThrow(/summary/u);
    await expect(safetyAlert.handler({ severity: "urgent", summary: "x" })).rejects.toThrow(/HTTP 403/u);
    await expect(tool({ env: {}, sender }).handler({ severity: "urgent", summary: "x" }))
      .rejects.toThrow(/No safety alert channel/u);
  });

  it("prefers the thread link and truncates long summaries", () => {
    const content = buildSafetyAlertContent({
      severity: "concern",
      summary: "a".repeat(2000),
      sourceChannelId: "c",
      sourceThreadId: "t",
      guildId: "g",
    });
    expect(content).toContain("/g/t");
    expect(content.length).toBeLessThan(1700);
  });
});
