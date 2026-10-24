export type SharedProjectSystemCommand =
  | { type: "open-project"; projectName: string }
  | { type: "current-project" }
  | { type: "clear-project" };

const PROJECT_SESSION_SCOPE_DELIMITER = "#";

function normalizeSpacing(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/g, "").trim();
}

export function buildProjectSessionId(projectId: string): string {
  return `project:${projectId}`;
}

export function buildProjectScopedSessionId(projectId: string, scope: string): string {
  const normalizedProjectId = projectId.trim();
  const normalizedScope = scope.trim().replace(/\s+/g, "-");
  if (!normalizedProjectId) {
    throw new Error("projectId is required.");
  }
  if (!normalizedScope) {
    throw new Error("scope is required.");
  }
  return `project:${normalizedProjectId}${PROJECT_SESSION_SCOPE_DELIMITER}${normalizedScope}`;
}

export function parseProjectSessionId(sessionId: string | null | undefined): string | null {
  const normalized = sessionId?.trim();
  if (!normalized?.startsWith("project:")) return null;

  const projectToken = normalized.slice("project:".length).trim();
  const projectId = projectToken.split(PROJECT_SESSION_SCOPE_DELIMITER, 1)[0]?.trim() ?? "";
  return projectId.length > 0 ? projectId : null;
}

export function parseSharedProjectSystemCommand(
  promptText: string,
): SharedProjectSystemCommand | null {
  const source = stripTrailingPunctuation(normalizeSpacing(promptText));
  if (!source) return null;

  const lowered = source.toLowerCase();
  if (
    /^(?:what\s+project\s+am\s+i\s+in|which\s+project(?:\s+am\s+i\s+in)?|current\s+project|active\s+project)$/.test(
      lowered,
    )
  ) {
    return { type: "current-project" };
  }

  if (
    /^(?:clear\s+project|leave\s+project|exit\s+project|back\s+to\s+no\s+project|back\s+to\s+default\s+project)$/.test(
      lowered,
    )
  ) {
    return { type: "clear-project" };
  }

  const openMatch = source.match(
    /^(?:open|resume|use|switch\s+to|go\s+to)\s+project\s+(.+)$/i,
  );
  if (!openMatch?.[1]) return null;

  const projectName = normalizeSpacing(openMatch[1]);
  if (!projectName) return null;
  return { type: "open-project", projectName };
}
