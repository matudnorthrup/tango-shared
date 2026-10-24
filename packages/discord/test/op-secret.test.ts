import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const { createClientMock, spawnMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("@1password/sdk", () => ({
  createClient: createClientMock,
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

afterEach(() => {
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
  vi.clearAllMocks();
});

describe("getSecret", () => {
  it("resolves service-account secrets through the SDK without starting the CLI daemon", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_test_token";
    createClientMock.mockResolvedValue({
      secrets: {
        resolve: vi.fn().mockResolvedValue("resolved-secret"),
      },
    });

    const { getSecret } = await import("../src/op-secret.js");

    await expect(getSecret("Example Vault", "Example Item")).resolves.toBe("resolved-secret");
    expect(createClientMock).toHaveBeenCalledWith({
      auth: "ops_test_token",
      integrationName: "tango-runtime",
      integrationVersion: "1.0.0",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("retries SDK initialization after falling back to the CLI", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_fallback_token";
    createClientMock
      .mockRejectedValueOnce(new Error("temporary SDK failure"))
      .mockResolvedValueOnce({
        secrets: {
          resolve: vi.fn().mockResolvedValue("sdk-recovered-secret"),
        },
      });
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdout,
        stderr,
        stdin: { end: vi.fn() },
        killed: false,
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from("cli-fallback-secret\n"));
        child.emit("close", 0);
      });
      return child;
    });

    const { getSecret } = await import("../src/op-secret.js");

    await expect(getSecret("Fallback Vault", "First Item")).resolves.toBe(
      "cli-fallback-secret",
    );
    await expect(getSecret("Fallback Vault", "Second Item")).resolves.toBe(
      "sdk-recovered-secret",
    );
    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenCalledOnce();
  });
});
