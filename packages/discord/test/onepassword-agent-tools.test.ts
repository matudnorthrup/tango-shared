import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { createOnePasswordTools } from "../src/onepassword-agent-tools.js";

describe("onepassword-agent-tools", () => {
  const originalToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  const originalChurchItem = process.env.LIBRARY_ACCOUNT_1PASSWORD_ITEM;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "test-token";
    process.env.LIBRARY_ACCOUNT_1PASSWORD_ITEM = "configured-library-item";
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    } else {
      process.env.OP_SERVICE_ACCOUNT_TOKEN = originalToken;
    }
    if (originalChurchItem === undefined) {
      delete process.env.LIBRARY_ACCOUNT_1PASSWORD_ITEM;
    } else {
      process.env.LIBRARY_ACCOUNT_1PASSWORD_ITEM = originalChurchItem;
    }
  });

  it("blocks direct Library credential retrieval so secrets stay inside study_library login", async () => {
    const tool = createOnePasswordTools()[0];
    if (!tool) throw new Error("Missing onepassword tool");

    const byTitle = await tool.handler({
      action: "get",
      vault: "Watson",
      item: "Owner Library",
      field: "password",
    });
    const byConfiguredId = await tool.handler({
      action: "get",
      vault: "Watson",
      item: "configured-library-item",
      field: "password",
    });

    expect(byTitle).toMatchObject({
      error: expect.stringContaining("Use study_library login"),
    });
    expect(byConfiguredId).toMatchObject({
      error: expect.stringContaining("Use study_library login"),
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
