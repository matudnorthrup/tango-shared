import { describe, expect, it } from "vitest";
import { buildMcpListedTool, getMcpToolAnnotations } from "../src/mcp-tool-metadata.js";

describe("mcp tool metadata", () => {
  it("keeps Things reads read-only and writes potentially destructive", () => {
    expect(getMcpToolAnnotations("things_read", null)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(getMcpToolAnnotations("things_write", null)).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });
  it("marks registered read tools as read-only and idempotent", () => {
    expect(getMcpToolAnnotations("health_query", "read")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("marks write tools as non-read-only and potentially destructive", () => {
    expect(getMcpToolAnnotations("fatsecret_api", "write")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("marks open-world search tools appropriately", () => {
    expect(getMcpToolAnnotations("exa_search", "read")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("marks Study Library as an open-world tool", () => {
    expect(getMcpToolAnnotations("study_library", "write")).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
  });

  it("marks spawn_sub_agents as an open-world read tool", () => {
    expect(getMcpToolAnnotations("spawn_sub_agents", "read")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("builds listed tools with annotations even without governance", () => {
    expect(buildMcpListedTool({
      name: "wellnessdb_get_recipe_detail",
      description: "Read recipe details from wellness.db.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      handler: async () => ({ ok: true }),
    }, null)).toMatchObject({
      name: "wellnessdb_get_recipe_detail",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
  });

  it("allows explicit read-only overrides for multi-mode tools", () => {
    expect(buildMcpListedTool({
      name: "fatsecret_api",
      description: "Call the FatSecret API.",
      inputSchema: { type: "object", properties: { method: { type: "string" } }, required: ["method"] },
      handler: async () => ({ ok: true }),
    }, null, "read")).toMatchObject({
      name: "fatsecret_api",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    });
  });
});
