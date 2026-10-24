function getCommandHead(command: unknown): string[] {
  if (typeof command !== "string") {
    return [];
  }
  return command.trim().toLowerCase().split(/\s+/u).filter((part) => part.length > 0);
}

const READ_ONLY_GOG_DOCS_COMMANDS = new Set([
  "list",
  "cat",
  "read",
  "export",
  "info",
  "list-tabs",
  "structure",
]);

export function isReadOnlyGogDocsCommand(command: unknown): boolean {
  const head = getCommandHead(command);
  return head[0] === "docs" && READ_ONLY_GOG_DOCS_COMMANDS.has(head[1] ?? "");
}
