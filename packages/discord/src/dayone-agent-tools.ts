import { spawn } from "node:child_process";
import { z } from "zod";
import type { AgentTool } from "@tango/core";

/**
 * Day One journal tools. Day One for Mac ships its own stdio MCP server
 * (`dayone mcp`); these tools drive it once per call so every runtime —
 * including the Ollama clones, which only see governed wellness-server tools —
 * gets the same surface. See agents/tools/dayone.md.
 */

export const DEFAULT_DAYONE_CLI_PATH = "/Applications/Day One.app/Contents/MacOS/dayone";

export type DayOneCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface DayOneOptions {
  /** Replaces the CLI transport (tests). */
  call?: DayOneCall;
  cliPath?: string;
  timeoutMs?: number;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const csv = z.union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value.join(",") : value));

const readSchema = z.object({
  operation: z.enum(["list_journals", "get_entries"]),
  journal_ids: z.array(z.string().min(1)).optional(),
  journal_names: z.array(z.string().min(1)).optional(),
  query: z.string().min(1).max(500).optional(),
  start_date: date.optional(),
  end_date: date.optional(),
  on_this_day: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
}).strict();

const writeSchema = z.object({
  operation: z.enum(["create_entry", "update_entry"]),
  entry_id: z.string().min(1).optional(),
  journal_id: z.string().min(1).optional(),
  journal_name: z.string().min(1).optional(),
  text: z.string().min(1).max(100_000).optional(),
  date: z.string().min(1).optional(),
  tags: csv.optional(),
  attachments: csv.optional(),
  starred: z.boolean().optional(),
  all_day: z.boolean().optional(),
}).strict().superRefine((p, ctx) => {
  if (p.operation === "create_entry" && !p.text) ctx.addIssue({ code: "custom", message: "create_entry requires text" });
  if (p.operation === "update_entry" && !p.entry_id) ctx.addIssue({ code: "custom", message: "update_entry requires entry_id" });
  if (p.operation === "update_entry" && (p.journal_name || p.date)) {
    ctx.addIssue({ code: "custom", message: "update_entry accepts journal_id, not journal_name or date" });
  }
});

function withoutOperation(input: Record<string, unknown>): Record<string, unknown> {
  const { operation: _operation, ...rest } = input;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}

/** Runs one tools/call against `dayone mcp` and returns the parsed tool result. */
export function createDayOneCliCall(cliPath = DEFAULT_DAYONE_CLI_PATH, timeoutMs = 30_000): DayOneCall {
  return (tool, args) => new Promise((resolve, reject) => {
    const child = spawn(cliPath, ["mcp"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Day One did not answer within ${timeoutMs}ms`)), timeoutMs);
    child.on("error", (error) => finish(new Error(`Could not start the Day One CLI at ${cliPath}: ${error.message}`)));
    child.on("exit", (code) => finish(new Error(
      `Day One MCP server exited (code ${code}) before answering. Check that the MCP server is enabled in Day One → Preferences → Labs and that the passcode lock is off.`,
    )));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        let message: { id?: unknown; result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: { message?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 2) continue;
        if (message.error) return finish(new Error(message.error.message ?? "Day One MCP error"));
        const text = (message.result?.content ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
        if (message.result?.isError) return finish(new Error(text || "Day One reported an error"));
        try { return finish(null, JSON.parse(text)); } catch { return finish(null, text); }
      }
    });
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tango", version: "1" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  });
}

export function createDayOneTools(options: DayOneOptions = {}): AgentTool[] {
  const call = options.call
    ?? createDayOneCliCall(options.cliPath ?? process.env.DAYONE_CLI_PATH ?? DEFAULT_DAYONE_CLI_PATH, options.timeoutMs);

  async function read(input: Record<string, unknown>) {
    const p = readSchema.parse(input);
    const result = await call(p.operation, withoutOperation(p));
    if (p.operation === "list_journals" && Array.isArray(result) && result.length === 0) {
      return {
        journals: [],
        note: "No journals are enabled for agent access. The owner turns journals on in Day One → Preferences → Labs → MCP Access Control. This does not mean they have no journals.",
      };
    }
    return p.operation === "list_journals" ? { journals: result } : { entries: result };
  }

  async function write(input: Record<string, unknown>) {
    const p = writeSchema.parse(input);
    return { result: await call(p.operation, withoutOperation(p)) };
  }

  return [{
    name: "dayone_read",
    description: "Read the owner's Day One journal: list_journals (only journals the owner enabled for agents; call first), or get_entries to search and page entries by journal, text query, date range (YYYY-MM-DD) or on_this_day. limit max 50. Journals are private: share only what the owner asked for. See agents/tools/dayone.md.",
    inputSchema: { type: "object", additionalProperties: false, required: ["operation"], properties: {
      operation: { type: "string", enum: ["list_journals", "get_entries"] },
      journal_ids: { type: "array", items: { type: "string" } },
      journal_names: { type: "array", items: { type: "string" } },
      query: { type: "string", description: "Search text" },
      start_date: { type: "string", description: "YYYY-MM-DD" },
      end_date: { type: "string", description: "YYYY-MM-DD" },
      on_this_day: { type: "boolean", description: "Entries from this calendar day in past years" },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 10" },
      offset: { type: "integer", minimum: 0 },
    } },
    handler: read,
  }, {
    name: "dayone_write",
    description: "Write to the owner's Day One journal: create_entry (markdown text; name the journal, otherwise it lands in the default journal) or update_entry by entry_id. tags REPLACES every existing tag on update — merge with the current tags first. attachments are local file paths. Only write when the owner asked for an entry.",
    inputSchema: { type: "object", additionalProperties: false, required: ["operation"], properties: {
      operation: { type: "string", enum: ["create_entry", "update_entry"] },
      entry_id: { type: "string", description: "Required for update_entry" },
      journal_id: { type: "string" },
      journal_name: { type: "string", description: "create_entry only" },
      text: { type: "string", description: "Markdown body; required for create_entry, replaces the body on update" },
      date: { type: "string", description: "ISO-8601; create_entry only" },
      tags: { type: "array", items: { type: "string" } },
      attachments: { type: "array", items: { type: "string" }, description: "Local file paths (photo, video, audio, pdf)" },
      starred: { type: "boolean" },
      all_day: { type: "boolean" },
    } },
    handler: write,
  }];
}
