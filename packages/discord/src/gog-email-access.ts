/**
 * The email MCP tool is Gmail-specific. Accept both the documented
 * `gmail ...` form and the natural shorthand agents often emit (`messages ...`).
 */
export function normalizeGogEmailCommand(command: unknown): string {
  if (typeof command !== "string") {
    return "";
  }
  const withoutExecutable = command.trim().replace(/^gog\s+/iu, "");
  if (!withoutExecutable) {
    return "";
  }
  return /^gmail\b/iu.test(withoutExecutable)
    ? withoutExecutable
    : `gmail ${withoutExecutable}`;
}

function getCommandHead(value: unknown): string[] {
  return normalizeGogEmailCommand(value)
    .toLowerCase()
    .split(/\s+/u)
    .filter((part) => part.length > 0);
}

export function isReadOnlyGogEmailCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  return (
    (
      head[0] === "gmail"
      && head[1] === "messages"
      && ["search", "list", "get", "read"].includes(head[2] ?? "")
    )
    || (
      head[0] === "gmail"
      && ["get", "read", "attachment"].includes(head[1] ?? "")
    )
    || (head[0] === "gmail" && head[1] === "thread" && head[2] !== "modify")
  );
}
