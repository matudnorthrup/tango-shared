/**
 * Live turn activity: what an agent is doing right now, as one short human
 * line per tool call ("Editing media-session.ts", "Running npm test"). Emitted
 * by the runtimes through SendOptions.onEvent while a turn is in flight.
 *
 * Lines are built from tool names and a few safe input fields only (a file's
 * base name, a command's first words, a host name) so they can be shown on a
 * screen without leaking arguments.
 */

export interface RuntimeToolUseEvent {
  type: "tool_use";
  /** Tool name as the runtime saw it (e.g. "Edit", "mcp__memory__memory_search", "screen"). */
  name: string;
  /** One short human line describing the call. */
  activity: string;
  at: number;
}

export type RuntimeTurnEvent = RuntimeToolUseEvent;

export type RuntimeTurnEventListener = (event: RuntimeTurnEvent) => void;

const MAX_ACTIVITY_CHARS = 60;

function stringField(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? filePath;
}

function clip(text: string): string {
  return text.length > MAX_ACTIVITY_CHARS ? `${text.slice(0, MAX_ACTIVITY_CHARS - 1)}…` : text;
}

/** First words of a shell command, skipping `cd x &&`, env assignments and anything secret-shaped. */
function summarizeCommand(command: string): string | undefined {
  const firstLine = command.split("\n")[0] ?? "";
  const segments = firstLine.split(/&&|;|\|\|/u).map((segment) => segment.trim()).filter(Boolean);
  const segment = segments.find((candidate) => !/^cd\s/u.test(candidate)) ?? segments[0];
  if (!segment) return undefined;
  const words: string[] = [];
  for (const word of segment.split(/\s+/u)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word) && words.length === 0) continue;
    if (word.startsWith("-") || word.includes("=") || /["'`$|<>]/u.test(word) || word.length > 32) break;
    // Long letter+digit runs look like tokens or ids; stop before them.
    if (word.length >= 16 && /\d/u.test(word) && /[A-Za-z]/u.test(word)) break;
    words.push(word.includes("/") ? baseName(word) : word);
    if (words.length === 3) break;
  }
  return words.length > 0 ? words.join(" ") : undefined;
}

function hostName(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function prettifyToolName(name: string): string {
  return name.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

/**
 * One short line for a tool call. Claude Code built-ins get verbs; MCP tools
 * (`mcp__server__tool` from Claude, bare tool ids from the Ollama loop) read
 * as "Using memory search", with a short `action` when the tool takes one.
 */
export function describeToolUse(name: string, input?: Record<string, unknown>): string {
  const file = stringField(input, "file_path", "notebook_path", "path");
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return clip(file ? `Editing ${baseName(file)}` : "Editing a file");
    case "Write":
      return clip(file ? `Writing ${baseName(file)}` : "Writing a file");
    case "Read":
      return clip(file ? `Reading ${baseName(file)}` : "Reading a file");
    case "Bash": {
      const command = stringField(input, "command");
      const summary = command ? summarizeCommand(command) : undefined;
      return clip(summary ? `Running ${summary}` : "Running a command");
    }
    case "Grep":
    case "Glob":
    case "LS":
      return "Searching files";
    case "WebSearch":
      return "Searching the web";
    case "WebFetch": {
      const url = stringField(input, "url");
      const host = url ? hostName(url) : undefined;
      return clip(host ? `Reading ${host}` : "Reading a web page");
    }
    case "Task":
    case "Agent":
      return "Starting a sub-agent";
    case "TodoWrite":
      return "Updating the plan";
    default:
      break;
  }

  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name);
  const toolName = mcp ? mcp[2]! : name;
  const action = stringField(input, "action", "operation", "mode");
  const label = prettifyToolName(toolName) || "a tool";
  const actionLabel = action && action.length <= 24 && /^[\w-]+$/u.test(action) ? ` (${prettifyToolName(action)})` : "";
  return clip(`Using ${label}${actionLabel}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Calls the listener and swallows whatever it throws: activity must never break a turn. */
export function emitRuntimeTurnEvent(listener: RuntimeTurnEventListener | undefined, event: RuntimeTurnEvent): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    // Observers are best-effort.
  }
}

/**
 * Incremental parser for Claude CLI `--output-format stream-json` stdout.
 * Feed raw chunks as they arrive; each complete line that is an assistant
 * message with tool_use blocks produces one event per block. Partial lines are
 * buffered until their newline. Malformed lines are ignored.
 */
export function createClaudeStreamActivityParser(
  listener: RuntimeTurnEventListener,
  now: () => number = Date.now,
): { push(chunk: string): void; flush(): void } {
  let buffer = "";

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    const record = asRecord(event);
    if (record?.type !== "assistant") return;
    const content = asRecord(record.message)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const entry = asRecord(block);
      if (entry?.type !== "tool_use" || typeof entry.name !== "string") continue;
      emitRuntimeTurnEvent(listener, {
        type: "tool_use",
        name: entry.name,
        activity: describeToolUse(entry.name, asRecord(entry.input)),
        at: now(),
      });
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer) handleLine(buffer);
      buffer = "";
    },
  };
}
