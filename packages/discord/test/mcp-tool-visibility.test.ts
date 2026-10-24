import { describe, expect, it } from "vitest";
import type { AccessLevel } from "@tango/core";
import { getListedToolAccessLevel, type ToolVisibilityGovernance } from "../src/mcp-tool-visibility.js";

function governanceWithPermissions(
  registeredAccess: AccessLevel,
  permissions: Record<string, AccessLevel[]>,
): ToolVisibilityGovernance {
  return {
    getToolAccessType: () => registeredAccess,
    hasPermission: (principalId, toolName, accessLevel) => {
      return permissions[`${principalId}:${toolName}`]?.includes(accessLevel) ?? false;
    },
  };
}

describe("mcp tool visibility", () => {
  it("lists a write-registered multi-mode tool when the worker only has read permission", () => {
    const governance = governanceWithPermissions("write", {
      "worker:papa-ollama:gog_email": ["read"],
    });

    expect(getListedToolAccessLevel(governance, "worker:papa-ollama", "gog_email")).toBe("read");
  });

  it("keeps write annotations when the worker has write permission", () => {
    const governance = governanceWithPermissions("write", {
      "worker:foxtrot:gog_email": ["write"],
    });

    expect(getListedToolAccessLevel(governance, "worker:foxtrot", "gog_email")).toBe("write");
  });

  it("does not list a governed tool without a matching permission", () => {
    const governance = governanceWithPermissions("write", {});

    expect(getListedToolAccessLevel(governance, "worker:papa-ollama", "gog_email")).toBeNull();
  });
});
