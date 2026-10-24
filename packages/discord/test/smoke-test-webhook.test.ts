import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isSmokeTestThreadWebhookMessage } from "../src/smoke-test-webhook.js";

describe("isSmokeTestThreadWebhookMessage", () => {
  const smokeTestChannelIds = new Set(["parent-smoke"]);
  const originalHome = process.env.HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-test-webhook-"));
  const slotsDir = path.join(tempHome, ".tango", "slots");

  fs.mkdirSync(slotsDir, { recursive: true });
  fs.writeFileSync(
    path.join(slotsDir, "webhooks.json"),
    JSON.stringify({
      webhooks: {
        harness: { id: "webhook-123" },
      },
    }),
    "utf8",
  );
  process.env.HOME = tempHome;

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("accepts webhook messages in smoke-test threads", () => {
    expect(
      isSmokeTestThreadWebhookMessage(
        {
          webhookId: "webhook-123",
          channel: {
            isThread: () => true,
            parentId: "parent-smoke",
          },
        },
        smokeTestChannelIds,
      ),
    ).toBe(true);
  });

  it("rejects direct webhook messages in the smoke-test parent channel", () => {
    expect(
      isSmokeTestThreadWebhookMessage(
        {
          webhookId: "webhook-123",
          channel: {
            isThread: () => false,
            parentId: "parent-smoke",
          },
        },
        smokeTestChannelIds,
      ),
    ).toBe(false);
  });

  it("rejects webhook messages outside configured smoke-test parents", () => {
    expect(
      isSmokeTestThreadWebhookMessage(
        {
          webhookId: "webhook-123",
          channel: {
            isThread: () => true,
            parentId: "parent-other",
          },
        },
        smokeTestChannelIds,
      ),
    ).toBe(false);
  });

  it("rejects non-webhook messages", () => {
    expect(
      isSmokeTestThreadWebhookMessage(
        {
          webhookId: null,
          channel: {
            isThread: () => true,
            parentId: "parent-smoke",
          },
        },
        smokeTestChannelIds,
      ),
    ).toBe(false);
  });
});
