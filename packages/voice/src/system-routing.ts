export type SharedSystemRoutingCommand =
  | { type: "focus-agent"; agentQuery: string }
  | { type: "clear-focus" }
  | { type: "current-agent" };

function normalizeCommandText(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[.!?,]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSharedSystemRoutingCommand(
  promptText: string
): SharedSystemRoutingCommand | null {
  const rest = normalizeCommandText(promptText);
  if (!rest) return null;

  if (
    /^(?:back\s+to\s+tango|back\s+to\s+system|talk\s+to\s+tango|talk\s+to\s+the\s+system|clear\s+focus|exit\s+focus|stop\s+focusing|leave\s+focus(?:\s+mode)?)$/.test(
      rest
    )
  ) {
    return { type: "clear-focus" };
  }

  if (
    /^(?:who\s+am\s+i\s+talking\s+to|which\s+agent(?:\s+am\s+i\s+talking\s+to)?|current\s+agent|active\s+agent|who'?s\s+active)$/.test(
      rest
    )
  ) {
    return { type: "current-agent" };
  }

  const focusMatch = rest.match(
    /^(?:talk|speak|work)\s+(?:to|with)\s+(.+)$|^focus\s+on\s+(.+)$|^switch\s+agent\s+to\s+(.+)$/
  );
  if (!focusMatch) return null;

  const agentQuery = (focusMatch[1] || focusMatch[2] || focusMatch[3] || "").trim();
  if (!agentQuery) return null;

  return { type: "focus-agent", agentQuery };
}
