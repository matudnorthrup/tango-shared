import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AttachmentFiles, decodeImages, MAX_IMAGES } from "../src/attachments.js";
import { userContent } from "../src/claude/claude-runtime.js";
import { LIMIT_CONTINUE_NOTE, LoomHost } from "../src/host.js";
import { createLoomServer } from "../src/http.js";
import { AccountPool } from "../src/pool.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const png = (name = "shot.png") => ({ name, mimeType: "image/png", dataUrl: `data:image/png;base64,${PNG.toString("base64")}` });
const flush = () => new Promise((r) => setTimeout(r, 5));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loom-att-"));
  const store = new LoomStore(":memory:");
  const runtime = new FakeRuntime();
  const files = new AttachmentFiles(join(dir, "attachments"));
  const host = new LoomHost(store, { fake: runtime }, { attachments: files });
  return { dir, store, runtime, files, host };
}

describe("decodeImages", () => {
  it("takes the four image types and refuses everything else with a reason", () => {
    expect(decodeImages([png()])[0]).toMatchObject({ name: "shot.png", mimeType: "image/png" });
    expect(() => decodeImages([{ name: "a.pdf", mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,AAAA" }])).toThrow(/PNG, JPEG, GIF or WebP/);
    expect(() => decodeImages([{ name: "x", mimeType: "image/png", dataUrl: "data:image/jpeg;base64,AAAA" }])).toThrow(/matching its type/);
    expect(() => decodeImages(Array.from({ length: MAX_IMAGES + 1 }, () => png()))).toThrow(/At most 8/);
    expect(() => decodeImages([{ name: "big", mimeType: "image/png", dataUrl: `data:image/png;base64,${Buffer.alloc(11 * 1024 * 1024).toString("base64")}` }])).toThrow(/10 MB/);
    expect(decodeImages(undefined)).toEqual([]);
  });
});

describe("userContent", () => {
  it("puts images before the words, as Claude content blocks", () => {
    expect(userContent("hi")).toBe("hi");
    expect(userContent("look", [{ mimeType: "image/png", data: "AAA" }])).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      { type: "text", text: "look" },
    ]);
    expect(userContent("", [{ mimeType: "image/png", data: "AAA" }])).toHaveLength(1);
  });
});

describe("images on messages", () => {
  it("keeps them on disk, lists them on the message, and hands them to the turn", async () => {
    const { store, runtime, host, dir } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "What's wrong here?", cwd: "/r", provider: "fake", attachments: [png(), png("two.png")] });
    expect(runtime.last.turns[0]!.images).toEqual([
      { mimeType: "image/png", data: PNG.toString("base64") },
      { mimeType: "image/png", data: PNG.toString("base64") },
    ]);
    expect(readdirSync(join(dir, "attachments", r.threadId!))).toHaveLength(2);
    const message = host.detail(r.threadId!)!.messages[0] as { attachments?: { name: string; mime_type: string; size_bytes: number }[] };
    expect(message.attachments!.map((a) => [a.name, a.mime_type, a.size_bytes])).toEqual([["shot.png", "image/png", PNG.length], ["two.png", "image/png", PNG.length]]);
    expect(JSON.stringify(host.detail(r.threadId!))).not.toContain(dir);
    expect(host.attachmentFile(store.runAttachments(r.runId!)[0]!.id)!.bytes.equals(PNG)).toBe(true);
  });

  it("refuses a bad image, writes nothing, and records the refusal", async () => {
    const { store, host, dir } = setup();
    await expect(host.execute({ type: "submit", commandId: "c1", text: "x", cwd: "/r", provider: "fake", attachments: [{ name: "a", mimeType: "text/plain", dataUrl: "data:text/plain;base64,AAAA" }] })).rejects.toMatchObject({ code: "invalid" });
    expect(store.threads()).toEqual([]);
    expect(existsSync(join(dir, "attachments"))).toBe(false);
  });

  it("removes the files when the command's transaction rolls back", async () => {
    const { store, host, dir } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/r", provider: "fake", attachments: [png()] });
    const folder = join(dir, "attachments", r.threadId!);
    expect(readdirSync(folder)).toHaveLength(1);
    // Fails after the image is written, inside the same transaction.
    const original = store.writeReceipt.bind(store);
    store.writeReceipt = () => {
      throw new Error("disk full");
    };
    await expect(host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "two", attachments: [png()] })).rejects.toThrow("disk full");
    store.writeReceipt = original;
    expect(readdirSync(folder)).toHaveLength(1);
    expect(store.messages(r.threadId!)).toHaveLength(1);
  });

  it("sends images that arrive mid-turn into the turn, and none on a continue after a limit", async () => {
    const { store, runtime, host } = setup();
    const pool = new AccountPool([{ provider: "fake", name: "a" }, { provider: "fake", name: "b" }]);
    const pooled = new LoomHost(store, { fake: runtime }, { pool, attachments: (host as any).options.attachments });
    const r = await pooled.execute({ type: "submit", commandId: "c1", text: "look", cwd: "/r", provider: "fake", account: "a", attachments: [png()] });
    await pooled.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "and this", steer: true, attachments: [png("b.png")] });
    expect(runtime.last.injectedImages.at(-1)).toHaveLength(1);
    runtime.last.emit({ type: "turn.failed", runId: r.runId!, failure: { kind: "usage_limit", message: "limit" } });
    await flush();
    expect(runtime.last.turns.at(-1)).toEqual({ runId: r.runId, text: LIMIT_CONTINUE_NOTE });
  });

  it("sends the run again in full, images included, when the next account opens a new native thread", async () => {
    const { store, runtime, host } = setup();
    const pool = new AccountPool([{ provider: "fake", name: "a" }, { provider: "fake", name: "b" }]);
    const pooled = new LoomHost(store, { fake: runtime }, { pool, attachments: (host as any).options.attachments });
    const open = runtime.open.bind(runtime);
    runtime.open = async (options, emit) => {
      const session = await open(options, emit);
      if (options.nativeSessionId) (session as any).hello = { nativeSessionId: "fresh-thread", release: "test", instanceId: "i" };
      return session;
    };
    const r = await pooled.execute({ type: "submit", commandId: "c1", text: "look", cwd: "/r", provider: "fake", account: "a", attachments: [png()] });
    runtime.last.emit({ type: "session.native", nativeSessionId: "old-thread" });
    runtime.last.emit({ type: "turn.failed", runId: r.runId!, failure: { kind: "usage_limit", message: "limit" } });
    await flush();
    expect(runtime.last.options.nativeSessionId).toBe("old-thread");
    expect(runtime.last.turns.at(-1)).toMatchObject({ runId: r.runId, text: "look" });
    expect(runtime.last.turns.at(-1)!.images).toHaveLength(1);
  });

  it("never delivers a steered image the transcript failed to keep", async () => {
    const { store, runtime, host } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "work", cwd: "/r", provider: "fake" });
    const original = store.addAttachment.bind(store);
    store.addAttachment = () => {
      throw new Error("disk full");
    };
    await expect(host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "see", steer: true, attachments: [png()] })).rejects.toThrow("disk full");
    store.addAttachment = original;
    expect(runtime.last.injected).toEqual([]);
  });

  it("keeps a thread's images when its delete rolls back", async () => {
    const { store, host, dir } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "x", cwd: "/r", provider: "fake", attachments: [png()] });
    const original = store.writeReceipt.bind(store);
    store.writeReceipt = () => {
      throw new Error("disk full");
    };
    await expect(host.execute({ type: "delete", commandId: "c2", threadId: r.threadId! })).rejects.toThrow("disk full");
    store.writeReceipt = original;
    expect(store.thread(r.threadId!)).toBeTruthy();
    expect(readdirSync(join(dir, "attachments", r.threadId!))).toHaveLength(1);
  });

  it("deletes a thread's images with the thread", async () => {
    const { host, dir } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "x", cwd: "/r", provider: "fake", attachments: [png()] });
    await host.execute({ type: "delete", commandId: "c2", threadId: r.threadId! });
    expect(existsSync(join(dir, "attachments", r.threadId!))).toBe(false);
  });

  it("serves an image over the API with the token, and 404s an unknown one", async () => {
    const { store, host } = setup();
    const r = await host.execute({ type: "submit", commandId: "c1", text: "x", cwd: "/r", provider: "fake", attachments: [png()] });
    const server = createLoomServer(host, { token: "t", heartbeatMs: 60_000 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const id = store.runAttachments(r.runId!)[0]!.id;
    const ok = await fetch(`${base}/attachments/${id}`, { headers: { authorization: "Bearer t" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await fetch(`${base}/attachments/${id}`)).status).toBe(401);
    expect((await fetch(`${base}/attachments/nope`, { headers: { authorization: "Bearer t" } })).status).toBe(404);
    server.close();
  });
});

describe("AttachmentFiles", () => {
  it("refuses paths that would leave its folder", () => {
    const files = new AttachmentFiles(mkdtempSync(join(tmpdir(), "loom-att2-")));
    expect(() => files.read("/etc/hosts")).toThrow(/escapes/);
    expect(() => files.write("../x", { name: "a", mimeType: "image/png", bytes: PNG })).toThrow(/bad thread id/);
  });
});
