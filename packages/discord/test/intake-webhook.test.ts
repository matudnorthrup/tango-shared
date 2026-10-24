import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  intakeSenderId,
  loadIntakeWebhookEntries,
  resolveIntakeWebhookMessage,
} from "../src/intake-webhook.js";

const entries = [{
  webhookId: "intake-1",
  channelId: "channel-1",
  agentId: "papa",
  label: "form-intake",
}];

describe("intake webhooks", () => {
  const tempDirs: string[] = [];
  afterEach(() => tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  it("accepts a configured webhook only in its bound channel", () => {
    expect(resolveIntakeWebhookMessage(
      { webhookId: "intake-1", channelId: "channel-1", content: "request" },
      entries,
      new Set(),
    )).toEqual(entries[0]);
    expect(resolveIntakeWebhookMessage(
      { webhookId: "intake-1", channelId: "channel-2", content: "request" },
      entries,
      new Set(),
    )).toBeNull();
  });

  it("rejects unconfigured and reply webhook ids", () => {
    expect(resolveIntakeWebhookMessage(
      { webhookId: "unknown", channelId: "channel-1" }, entries, new Set(),
    )).toBeNull();
    expect(resolveIntakeWebhookMessage(
      { webhookId: "intake-1", channelId: "channel-1" }, entries, new Set(["intake-1"]),
    )).toBeNull();
    expect(resolveIntakeWebhookMessage(
      { webhookId: "intake-1", channelId: "channel-1", content: "\u200Bsynced reply" },
      entries,
      new Set(),
    )).toBeNull();
  });

  it("uses a non-user synthetic sender identity", () => {
    expect(intakeSenderId(entries[0])).toBe("intake-webhook:intake-1");
  });

  it("lets the profile overlay replace repo defaults", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "intake-webhook-"));
    tempDirs.push(root);
    const defaultsDir = path.join(root, "defaults");
    const profileDir = path.join(root, "profile");
    fs.mkdirSync(defaultsDir, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(defaultsDir, "intake-webhooks.yaml"), [
      "intake_webhooks:",
      "  - webhook_id: default", "    channel_id: default-channel",
      "    agent_id: papa", "    label: default-label", "",
    ].join("\n"));
    fs.writeFileSync(path.join(profileDir, "intake-webhooks.yaml"), [
      "intake_webhooks:",
      "  - webhook_id: profile", "    channel_id: profile-channel",
      "    agent_id: papa", "    label: profile-label", "",
    ].join("\n"));

    expect(loadIntakeWebhookEntries({ defaultsConfigDir: defaultsDir, profileConfigDir: profileDir }))
      .toEqual([{ webhookId: "profile", channelId: "profile-channel", agentId: "papa", label: "profile-label" }]);
  });
});
