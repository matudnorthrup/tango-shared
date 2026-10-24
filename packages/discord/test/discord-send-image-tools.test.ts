import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig, AgentTool } from "@tango/core";
import {
  createDiscordSendImageTools,
  fetchRemoteImage,
  findOrCreateReplyWebhook,
  loadLocalImage,
  resolveSendTarget,
  resolveSenderPersona,
} from "../src/discord-send-image-tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempImageDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-send-image-test-"));
  tempDirs.push(dir);
  return dir;
}

function writePng(dir: string, name: string, bytes = 64): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
  return filePath;
}

interface RecordedRequest {
  url: string;
  method: string;
  body?: FormData | string;
}

type RouteHandler = (url: string, init?: RequestInit) => Response | null;

function makeFetchMock(routes: RouteHandler[], recorded: RecordedRequest[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    recorded.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { body: init.body as FormData | string } : {}),
    });
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    throw new Error(`unmocked fetch: ${url}`);
  }) as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const TEXT_CHANNEL = { id: "chan-1", type: 0, parent_id: null };
const THREAD_CHANNEL = { id: "thread-1", type: 11, parent_id: "chan-1" };

const AGENTS: AgentConfig[] = [
  {
    id: "sierra",
    displayName: "Sierra",
    avatarURL: "https://cdn.example.com/sierra.png",
  } as AgentConfig,
  {
    id: "watson",
    displayName: "Watson",
    avatarURL: "http://insecure.example.com/watson.png",
  } as AgentConfig,
];

function makeTool(options: {
  routes: RouteHandler[];
  recorded?: RecordedRequest[];
  allowedPathPrefixes?: string[];
  maxBytes?: number;
}): AgentTool {
  const tools = createDiscordSendImageTools({
    botToken: "test-token",
    loadAgents: () => AGENTS,
    fetchImpl: makeFetchMock(options.routes, options.recorded),
    ...(options.allowedPathPrefixes ? { allowedPathPrefixes: options.allowedPathPrefixes } : {}),
    ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
  });
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

describe("loadLocalImage", () => {
  it("rejects relative paths", async () => {
    await expect(
      loadLocalImage("relative/file.png", { allowedPathPrefixes: ["/tmp/"], maxBytes: 1024 }),
    ).rejects.toThrow(/absolute path/);
  });

  it("rejects paths outside the allowlist", async () => {
    const dir = makeTempImageDir();
    const file = writePng(dir, "shot.png");
    await expect(
      loadLocalImage(file, { allowedPathPrefixes: ["/nonexistent-prefix/"], maxBytes: 1024 }),
    ).rejects.toThrow(/allowed upload directories/);
  });

  it("rejects unsupported extensions", async () => {
    const dir = makeTempImageDir();
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "hello");
    await expect(
      loadLocalImage(file, { allowedPathPrefixes: [fs.realpathSync(dir)], maxBytes: 1024 }),
    ).rejects.toThrow(/unsupported image extension/);
  });

  it("rejects oversize files", async () => {
    const dir = makeTempImageDir();
    const file = writePng(dir, "big.png", 2048);
    await expect(
      loadLocalImage(file, { allowedPathPrefixes: [fs.realpathSync(dir)], maxBytes: 1024 }),
    ).rejects.toThrow(/exceeds/);
  });

  it("loads an allowed png with the right content type", async () => {
    const dir = makeTempImageDir();
    const file = writePng(dir, "cart.png");
    const image = await loadLocalImage(file, {
      allowedPathPrefixes: [fs.realpathSync(dir)],
      maxBytes: 1024,
    });
    expect(image.filename).toBe("cart.png");
    expect(image.contentType).toBe("image/png");
    expect(image.buffer.byteLength).toBe(64);
  });
});

describe("fetchRemoteImage", () => {
  it("rejects non-https URLs", async () => {
    await expect(
      fetchRemoteImage("http://example.com/a.png", { maxBytes: 1024, fetchImpl: fetch }),
    ).rejects.toThrow(/https/);
  });

  it("rejects non-image content types", async () => {
    const fetchImpl = makeFetchMock([
      () => new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    ]);
    await expect(
      fetchRemoteImage("https://example.com/page", { maxBytes: 1024, fetchImpl }),
    ).rejects.toThrow(/content-type/);
  });

  it("rejects downloads above the size cap", async () => {
    const fetchImpl = makeFetchMock([
      () => new Response(Buffer.alloc(2048), { status: 200, headers: { "Content-Type": "image/png" } }),
    ]);
    await expect(
      fetchRemoteImage("https://example.com/big.png", { maxBytes: 1024, fetchImpl }),
    ).rejects.toThrow(/exceeds/);
  });

  it("downloads an image and derives a filename", async () => {
    const fetchImpl = makeFetchMock([
      () => new Response(Buffer.alloc(128), { status: 200, headers: { "Content-Type": "image/jpeg" } }),
    ]);
    const image = await fetchRemoteImage("https://example.com/products/photo.jpg", {
      maxBytes: 1024,
      fetchImpl,
    });
    expect(image.filename).toBe("photo.jpg");
    expect(image.contentType).toBe("image/jpeg");

    const renamed = await fetchRemoteImage("https://example.com/dynamic", {
      maxBytes: 1024,
      fetchImpl,
    });
    expect(renamed.filename).toBe("image.jpg");
  });
});

describe("resolveSendTarget", () => {
  it("uses the channel itself for regular channels", async () => {
    const fetchImpl = makeFetchMock([
      (url) => (url.includes("/channels/chan-1") ? jsonResponse(TEXT_CHANNEL) : null),
    ]);
    const target = await resolveSendTarget("chan-1", "tok", fetchImpl);
    expect(target).toEqual({ webhookChannelId: "chan-1" });
  });

  it("routes threads through the parent channel", async () => {
    const fetchImpl = makeFetchMock([
      (url) => (url.includes("/channels/thread-1") ? jsonResponse(THREAD_CHANNEL) : null),
    ]);
    const target = await resolveSendTarget("thread-1", "tok", fetchImpl);
    expect(target).toEqual({ webhookChannelId: "chan-1", threadId: "thread-1" });
  });
});

describe("findOrCreateReplyWebhook", () => {
  it("prefers the agent-specific webhook, then the base webhook", async () => {
    const hooks = [
      { id: "wh-base", name: "Tango Replies", token: "t-base" },
      { id: "wh-sierra", name: "Tango Replies - sierra", token: "t-sierra" },
    ];
    const fetchImpl = makeFetchMock([
      (url) => (url.endsWith("/webhooks") ? jsonResponse(hooks) : null),
    ]);
    const sierra = await findOrCreateReplyWebhook("chan-1", "sierra", "Tango Replies", "tok", fetchImpl);
    expect(sierra).toEqual({ id: "wh-sierra", token: "t-sierra" });
    const watson = await findOrCreateReplyWebhook("chan-1", "watson", "Tango Replies", "tok", fetchImpl);
    expect(watson).toEqual({ id: "wh-base", token: "t-base" });
  });

  it("creates a webhook when none exists", async () => {
    const recorded: RecordedRequest[] = [];
    const fetchImpl = makeFetchMock(
      [
        (url, init) =>
          url.endsWith("/webhooks") && (init?.method ?? "GET") === "GET" ? jsonResponse([]) : null,
        (url, init) =>
          url.endsWith("/webhooks") && init?.method === "POST"
            ? jsonResponse({ id: "wh-new", token: "t-new" })
            : null,
      ],
      recorded,
    );
    const webhook = await findOrCreateReplyWebhook("chan-1", "sierra", "Tango Replies", "tok", fetchImpl);
    expect(webhook).toEqual({ id: "wh-new", token: "t-new" });
    expect(recorded.some((request) => request.method === "POST")).toBe(true);
  });

  it("returns null when webhook listing and creation both fail", async () => {
    const fetchImpl = makeFetchMock([
      () => new Response("forbidden", { status: 403 }),
    ]);
    const webhook = await findOrCreateReplyWebhook("chan-1", "sierra", "Tango Replies", "tok", fetchImpl);
    expect(webhook).toBeNull();
  });
});

describe("resolveSenderPersona", () => {
  it("resolves display name and https avatar from agent config", () => {
    expect(resolveSenderPersona("sierra", AGENTS)).toEqual({
      displayName: "Sierra",
      avatarURL: "https://cdn.example.com/sierra.png",
    });
  });

  it("drops non-https avatars", () => {
    expect(resolveSenderPersona("watson", AGENTS)).toEqual({ displayName: "Watson" });
  });

  it("title-cases unknown agent ids", () => {
    expect(resolveSenderPersona("mystery-agent", AGENTS)).toEqual({
      displayName: "Mystery Agent",
    });
  });
});

describe("discord_send_image handler", () => {
  function happyPathRoutes(messages: RecordedRequest[]): RouteHandler[] {
    return [
      (url, init) =>
        url.includes("/channels/chan-1") && !url.includes("webhook") && (init?.method ?? "GET") === "GET"
          ? jsonResponse(TEXT_CHANNEL)
          : null,
      (url, init) =>
        url.endsWith("/channels/chan-1/webhooks") && (init?.method ?? "GET") === "GET"
          ? jsonResponse([{ id: "wh-1", name: "Tango Replies", token: "t-1" }])
          : null,
      (url, init) => {
        if (url.includes("/webhooks/wh-1/t-1") && init?.method === "POST") {
          messages.push({ url, method: "POST", body: init.body as FormData });
          return jsonResponse({ id: "msg-1" });
        }
        return null;
      },
    ];
  }

  it("sends a local screenshot through the persona webhook", async () => {
    const dir = makeTempImageDir();
    const file = writePng(dir, "cart.png");
    const messages: RecordedRequest[] = [];
    const tool = makeTool({
      routes: happyPathRoutes(messages),
      allowedPathPrefixes: [fs.realpathSync(dir)],
    });

    const result = (await tool.handler({
      source: file,
      channel_id: "chan-1",
      agent_id: "sierra",
      caption: "Confirm this cart?",
    })) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      message_id: "msg-1",
      channel_id: "chan-1",
      delivery: "webhook",
      username: "Sierra",
      filename: "cart.png",
      size_bytes: 64,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.url).toContain("wait=true");
    const form = messages[0]!.body as FormData;
    const payload = JSON.parse(String(form.get("payload_json")));
    expect(payload).toMatchObject({
      content: "Confirm this cart?",
      username: "Sierra",
      avatar_url: "https://cdn.example.com/sierra.png",
    });
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
  });

  it("targets the thread when channel_id is a thread", async () => {
    const dir = makeTempImageDir();
    const file = writePng(dir, "cart.png");
    const messages: RecordedRequest[] = [];
    const tool = makeTool({
      routes: [
        (url, init) =>
          url.includes("/channels/thread-1") && !url.includes("webhook") && (init?.method ?? "GET") === "GET"
            ? jsonResponse(THREAD_CHANNEL)
            : null,
        ...happyPathRoutes(messages),
      ],
      allowedPathPrefixes: [fs.realpathSync(dir)],
    });

    const result = (await tool.handler({
      source: file,
      channel_id: "thread-1",
      agent_id: "sierra",
    })) as Record<string, unknown>;

    expect(result.delivery).toBe("webhook");
    expect(messages[0]!.url).toContain("thread_id=thread-1");
  });

  it("falls back to a bot message when the webhook send fails", async () => {
    const dir = makeTempImageDir();
    const file = writePng(dir, "cart.png");
    const botMessages: RecordedRequest[] = [];
    const tool = makeTool({
      routes: [
        (url, init) =>
          url.includes("/channels/chan-1") && !url.includes("webhook") && !url.includes("messages") && (init?.method ?? "GET") === "GET"
            ? jsonResponse(TEXT_CHANNEL)
            : null,
        (url, init) =>
          url.endsWith("/channels/chan-1/webhooks") && (init?.method ?? "GET") === "GET"
            ? jsonResponse([{ id: "wh-1", name: "Tango Replies", token: "t-1" }])
            : null,
        (url, init) =>
          url.includes("/webhooks/wh-1/t-1") && init?.method === "POST"
            ? new Response("nope", { status: 500 })
            : null,
        (url, init) => {
          if (url.includes("/channels/chan-1/messages") && init?.method === "POST") {
            botMessages.push({ url, method: "POST", body: init.body as FormData });
            return jsonResponse({ id: "msg-2" });
          }
          return null;
        },
      ],
      allowedPathPrefixes: [fs.realpathSync(dir)],
    });

    const result = (await tool.handler({
      source: file,
      channel_id: "chan-1",
      agent_id: "sierra",
      caption: "fallback",
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ message_id: "msg-2", delivery: "bot" });
    expect(botMessages).toHaveLength(1);
  });

  it("returns a tool error for invalid sources instead of throwing", async () => {
    const tool = makeTool({ routes: [], allowedPathPrefixes: ["/nope/"] });
    const result = (await tool.handler({
      source: "/etc/passwd",
      channel_id: "chan-1",
      agent_id: "sierra",
    })) as Record<string, unknown>;
    expect(String(result.error)).toMatch(/unsupported image extension|allowed upload directories|not found/);
  });

  it("requires source, channel_id, and agent_id", async () => {
    const tool = makeTool({ routes: [] });
    expect(((await tool.handler({ channel_id: "c", agent_id: "a" })) as Record<string, unknown>).error).toMatch(/source/);
    expect(((await tool.handler({ source: "/tmp/x.png", agent_id: "a" })) as Record<string, unknown>).error).toMatch(/channel_id/);
    expect(((await tool.handler({ source: "/tmp/x.png", channel_id: "c" })) as Record<string, unknown>).error).toMatch(/agent_id/);
  });
});
