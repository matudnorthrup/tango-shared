import type { AccessLevel } from "@tango/core";

export type ListedToolAccessLevel = "read" | "write";

export interface ToolVisibilityGovernance {
  getToolAccessType(toolName: string): AccessLevel | null | undefined;
  hasPermission(principalId: string, toolName: string, accessLevel: AccessLevel): boolean;
}

export function getListedToolAccessLevel(
  governance: ToolVisibilityGovernance | null,
  principalId: string | null,
  toolName: string,
): ListedToolAccessLevel | null {
  if (!governance || !principalId) {
    return null;
  }

  const registeredLevel = governance.getToolAccessType(toolName);
  if (
    (registeredLevel === "read" || registeredLevel === "write")
    && governance.hasPermission(principalId, toolName, registeredLevel)
  ) {
    return registeredLevel;
  }

  if (governance.hasPermission(principalId, toolName, "read")) {
    return "read";
  }

  if (governance.hasPermission(principalId, toolName, "write")) {
    return "write";
  }

  return null;
}
