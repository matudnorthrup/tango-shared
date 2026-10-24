import { Client, GatewayIntentBits, type TextChannel, type ThreadChannel } from "discord.js";
import { loadUnifiedAgentConfigs, resolveConfigDir } from "@tango/core";

function readAgentVoiceSmokeTestChannel(agentId: string): string | null {
  const agent = loadUnifiedAgentConfigs(resolveConfigDir()).find((candidate) => candidate.id === agentId);
  const value =
    agent?.voice?.smokeTestChannelId?.trim()
    || agent?.voice?.defaultChannelId?.trim()
    || "";
  if (!/^\d+$/.test(value)) {
    return null;
  }
  return value;
}

export async function ensureSmokeThread(input: {
  token: string;
  agentId: string;
  explicitChannelId?: string | null;
  explicitThreadName?: string | null;
}): Promise<string | null> {
  const explicitChannelId = input.explicitChannelId?.trim() || null;
  if (explicitChannelId) {
    return explicitChannelId;
  }

  const baseChannelId = readAgentVoiceSmokeTestChannel(input.agentId);
  if (!baseChannelId) {
    return null;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  try {
    await client.login(input.token);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Discord login timeout")), 15_000);
      client.once("clientReady", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const baseChannel = await client.channels.fetch(baseChannelId);
    if (!baseChannel || !baseChannel.isTextBased() || baseChannel.isThread()) {
      throw new Error(
        `Agent '${input.agentId}' default voice channel '${baseChannelId}' is not a thread-capable text channel.`,
      );
    }

    const parent = baseChannel as TextChannel;
    const activeThreads = await parent.threads.fetchActive();
    const threadName = input.explicitThreadName?.trim() || `codex-${input.agentId}-live-smoke`;
    let thread = activeThreads.threads.find((candidate) => candidate.name === threadName) ?? null;
    if (!thread) {
      thread = await parent.threads.create({
        name: threadName,
        autoArchiveDuration: 60,
        reason: "Codex live smoke testing",
      });
    }

    return (thread as ThreadChannel).id;
  } finally {
    await client.destroy();
  }
}
