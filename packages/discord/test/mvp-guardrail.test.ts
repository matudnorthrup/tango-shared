import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EchoProvider, TangoStorage, type AgentConfig } from "@tango/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildDefaultAccessPolicy, evaluateAccess, resolveAccessPolicy } from "../src/access-control.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorage(): TangoStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-discord-guardrail-"));
  tempDirs.push(dir);
  return new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
}

describe("MVP guardrails e2e", () => {
  it("blocks unauthorized users, queues dead letter on failure, and resolves on replay", async () => {
    const storage = createStorage();
    storage.bootstrapSessions([
      {
        id: "tango-default",
        type: "persistent",
        agent: "dispatch",
        channels: ["discord:channel-1"]
      }
    ]);

    const defaults = buildDefaultAccessPolicy({
      mode: "allowlist",
      allowlistChannelIds: ["channel-1"],
      allowlistUserIds: []
    });
    const watsonAgent: AgentConfig = {
      id: "watson",
      type: "personal",
      provider: { default: "echo" },
      access: {
        mode: "allowlist",
        allowlistUserIds: ["user-allowlisted"]
      }
    };
    const policy = resolveAccessPolicy(watsonAgent, defaults);

    const blocked = evaluateAccess(
      {
        channelId: "channel-1",
        userId: "user-other",
        mentioned: false
      },
      policy
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("user-not-allowlisted");

    const allowed = evaluateAccess(
      {
        channelId: "channel-1",
        userId: "user-allowlisted",
        mentioned: false
      },
      policy
    );
    expect(allowed.allowed).toBe(true);

    const inboundMessageId = storage.insertMessage({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "echo",
      direction: "inbound",
      source: "discord",
      visibility: "public",
      discordChannelId: "channel-1",
      discordUserId: "user-allowlisted",
      discordUsername: "user",
      content: "Please summarize this."
    });

    const deadLetterId = storage.insertDeadLetter({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "echo",
      conversationKey: "tango-default:watson",
      requestMessageId: inboundMessageId,
      discordChannelId: "channel-1",
      discordUserId: "user-allowlisted",
      discordUsername: "user",
      promptText: "Please summarize this.",
      systemPrompt: "You are Watson.",
      responseMode: "concise",
      lastErrorMessage: "Simulated provider failure after retry",
      failureCount: 2
    });

    const pendingBeforeReplay = storage.listDeadLetters({ status: "pending" });
    expect(pendingBeforeReplay).toHaveLength(1);
    expect(pendingBeforeReplay[0]?.id).toBe(deadLetterId);
    expect(pendingBeforeReplay[0]?.failureCount).toBe(2);

    const provider = new EchoProvider();
    const replayTarget = storage.getDeadLetter(deadLetterId);
    expect(replayTarget).toBeTruthy();
    const response = await provider.generate({
      prompt: replayTarget?.promptText ?? "",
      providerSessionId: replayTarget?.providerSessionId ?? undefined,
      systemPrompt: replayTarget?.systemPrompt ?? undefined
    });

    const replayMessageId = storage.insertMessage({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "echo",
      direction: "outbound",
      source: "tango",
      visibility: "internal",
      discordChannelId: "channel-1",
      content: response.text,
      metadata: {
        replaySource: "test",
        deadLetterId
      }
    });

    const replayRunId = storage.insertModelRun({
      sessionId: "tango-default",
      agentId: "watson",
      providerName: "echo",
      conversationKey: "tango-default:watson",
      providerSessionId: response.providerSessionId ?? null,
      responseMode: "concise",
      isError: false,
      requestMessageId: inboundMessageId,
      responseMessageId: replayMessageId,
      metadata: {
        replaySource: "test",
        deadLetterId
      }
    });

    const resolved = storage.resolveDeadLetter({
      id: deadLetterId,
      resolvedMessageId: replayMessageId,
      resolvedModelRunId: replayRunId,
      incrementReplayCount: true,
      metadata: {
        replaySource: "test"
      }
    });
    expect(resolved).toBe(true);

    const deadLetterAfterReplay = storage.getDeadLetter(deadLetterId);
    expect(deadLetterAfterReplay?.status).toBe("resolved");
    expect(deadLetterAfterReplay?.replayCount).toBe(1);
    expect(deadLetterAfterReplay?.resolvedMessageId).toBe(replayMessageId);
    expect(deadLetterAfterReplay?.resolvedModelRunId).toBe(replayRunId);

    const pendingAfterReplay = storage.listDeadLetters({ status: "pending" });
    expect(pendingAfterReplay).toHaveLength(0);
    const health = storage.getHealthSnapshot();
    expect(health.deadLettersPending).toBe(0);
    expect(health.deadLettersTotal).toBe(1);

    storage.close();
  });
});
