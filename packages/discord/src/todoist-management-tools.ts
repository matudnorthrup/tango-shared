import { createHash, randomUUID } from "node:crypto";
import type { AgentTool } from "@tango/core";
import { zodToJsonSchema } from "zod-to-json-schema";
import { resolveTodoistToken } from "./todoist-agent-tools.js";
import { filterOperations } from "./todoist-management-filters.js";
import { resourceOperations } from "./todoist-management-resources.js";
import { syncTodoistManagement } from "./todoist-management-sync.js";
import type { ManagementClient } from "./todoist-management-types.js";

const operations = { ...resourceOperations, ...filterOperations };
export function todoistManagementOperationLooksReadOnly(operation: unknown): boolean {
  return typeof operation === "string" && Object.hasOwn(operations, operation) && operations[operation]!.readOnly;
}
class SafeApiError extends Error {
  constructor(readonly status: number, readonly retryAt?: number) {
    super(status === 429 ? "Todoist rate limit reached. Wait until retry_at before another attempt; do not loop or replay writes." : `Todoist HTTP ${status}. Verify current state before retrying a write.`);
  }
}
function client(token: string, cooldowns: Map<string, number>): ManagementClient {
  const key = createHash("sha256").update(token).digest("hex");
  async function send(path: string, method: string, body?: string, form = false) {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid request path");
    const retryAt = cooldowns.get(key);
    if (retryAt !== undefined && retryAt > Date.now()) throw new SafeApiError(429, retryAt);
    cooldowns.delete(key);
    const r = await fetch(`https://api.todoist.com/api/v1${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", ...(method !== "GET" ? { "X-Request-Id": randomUUID() } : {}) },
      ...(body !== undefined ? { body } : {}),
    });
    if (!r.ok) {
      let retryAt: number | undefined;
      if (r.status === 429) {
        const header = r.headers.get("Retry-After");
        const seconds = header !== null && /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) : NaN;
        const date = header !== null ? Date.parse(header) : NaN;
        retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Number.isFinite(date) ? Math.max(Date.now(), date) : Date.now() + 60_000;
        if (cooldowns.size >= 16 && !cooldowns.has(key)) cooldowns.delete(cooldowns.keys().next().value!);
        cooldowns.set(key, retryAt);
      }
      throw new SafeApiError(r.status, retryAt);
    }
    const raw = await r.text(); return raw ? JSON.parse(raw) : null;
  }
  return {
    request: (method, path, body) => send(path, method, body === undefined ? undefined : JSON.stringify(body)),
    sync: args => syncTodoistManagement(token, args, async syncArgs => {
      const result = await send("/sync", "POST", new URLSearchParams(syncArgs).toString(), true);
      if (!result || typeof result !== "object" || Array.isArray(result) || result.error) throw new Error("Invalid Sync response");
      return result;
    }),
  };
}
export function createTodoistManagementTools(): AgentTool[] {
  const cooldowns = new Map<string, number>();
  // Expose the union of typed fields while validating each operation against its
  // strict schema before loading credentials or sending anything to Todoist.
  const variants: Record<string, unknown[]> = {};
  for (const op of Object.values(operations)) {
    const schema = zodToJsonSchema(op.schema, { $refStrategy: "none" }) as { properties?: Record<string, unknown> };
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      const entries = variants[key] ??= [];
      if (!entries.some(entry => JSON.stringify(entry) === JSON.stringify(value))) entries.push(value);
    }
  }
  const properties: Record<string, unknown> = Object.fromEntries(Object.entries(variants).map(([key, values]) => [key, values.length === 1 ? values[0] : { anyOf: values }]));
  properties.operation = { type: "string", enum: Object.keys(operations) };
  return [{
    name: "todoist_manage",
    description: `Manage Todoist projects, sections, labels, comments, saved filters and view settings, plus moving/deleting tasks. Operations: ${Object.keys(operations).join(", ")}. Use existing todoist for task create/update/complete/reopen and project/section/label/task lists. Saved filter lists and view options return all active results; comment lists use next_cursor. Read existing IDs first, preserve unspecified fields, verify writes. Query commas form separate dashboard sections. View settings use lowercase enum values; grouped_by:null clears grouping, reset_view_options resets all customizations for one view. Deleting projects/sections can remove contained tasks: require an explicit user request for that deletion and explain its scope. Never retry uncertain writes blindly. On status 429, stop and report retry_at to the user; do not call again before that time. Read agents/tools/todoist.md for operations and examples.`,
    inputSchema: { type: "object", properties, required: ["operation"], additionalProperties: false },
    handler: async input => {
      const name = input.operation;
      if (typeof name !== "string" || !Object.hasOwn(operations, name)) return { error: "Unknown Todoist management operation." };
      const op = operations[name]!; const parsed = op.schema.safeParse(input);
      if (!parsed.success) return { error: "Invalid Todoist management parameters.", fields: parsed.error.issues.map(i => i.path.join(".")) };
      let token: string;
      try { token = await resolveTodoistToken(); } catch { return { error: "Todoist credential configuration unavailable. Check the existing private Todoist token configuration." }; }
      try { return await op.execute(parsed.data, client(token, cooldowns)); }
      catch (e) { return { error: e instanceof SafeApiError ? e.message : "Todoist management request failed or its result could not be verified. Verify current state before retrying; a write may have succeeded.", ...(e instanceof SafeApiError ? { status: e.status, ...(e.retryAt === undefined ? {} : { retry_after: Math.max(0, Math.ceil((e.retryAt - Date.now()) / 1000)), retry_at: new Date(e.retryAt).toISOString() }) } : {}) }; }
    },
  }];
}
