import { randomUUID } from "node:crypto";
import { readProfileConfigString, type AgentTool } from "@tango/core";
import { z } from "zod";
import { getSecret } from "./op-secret.js";

const BASE = "https://api.todoist.com/api/v1";
const operations = ["list_projects", "list_sections", "list_labels", "list_tasks", "get_task", "create_task", "update_task", "complete_task", "reopen_task"] as const;
const reads = new Set<string>(operations.slice(0, 5));
export function todoistOperationLooksReadOnly(operation: unknown): boolean {
  return typeof operation === "string" && reads.has(operation);
}

const text = z.string().trim().min(1);
const page = { cursor: text.optional(), limit: z.number().int().min(1).max(200).optional() };
const taskFields = {
  content: text.optional(), description: z.string().optional(),
  labels: z.array(text).optional(), priority: z.number().int().min(1).max(4).optional(),
  due_string: text.optional(), due_date: z.string().date().optional(),
  due_datetime: z.string().datetime({ offset: true }).optional(), due_lang: text.optional(),
};
const schemas = {
  list_projects: z.object({ operation: z.literal("list_projects"), ...page }).strict(),
  list_sections: z.object({ operation: z.literal("list_sections"), project_id: text.optional(), ...page }).strict(),
  list_labels: z.object({ operation: z.literal("list_labels"), ...page }).strict(),
  list_tasks: z.object({ operation: z.literal("list_tasks"), project_id: text.optional(), label: text.optional(), filter: text.optional(), ...page }).strict(),
  get_task: z.object({ operation: z.literal("get_task"), task_id: text }).strict(),
  create_task: z.object({ operation: z.literal("create_task"), ...taskFields, content: text, project_id: text.optional(), section_id: text.optional(), parent_id: text.optional() }).strict(),
  update_task: z.object({ operation: z.literal("update_task"), task_id: text, ...taskFields }).strict(),
  complete_task: z.object({ operation: z.literal("complete_task"), task_id: text }).strict(),
  reopen_task: z.object({ operation: z.literal("reopen_task"), task_id: text }).strict(),
};

const SETUP = "Todoist is not configured. Set TODOIST_API_TOKEN, or TODOIST_1PASSWORD_VAULT and TODOIST_1PASSWORD_ITEM (optional TODOIST_1PASSWORD_FIELD, default credential). Find your API token in Todoist Settings > Integrations > Developer. Keep credentials in the private runtime environment.";
export async function resolveTodoistToken(): Promise<string> {
  const direct = process.env.TODOIST_API_TOKEN?.trim();
  if (direct) return direct;
  const vault = readProfileConfigString({ relativePath: "todoist/onepassword-vault.txt", envValueVar: "TODOIST_1PASSWORD_VAULT" });
  const item = readProfileConfigString({ relativePath: "todoist/onepassword-item.txt", envValueVar: "TODOIST_1PASSWORD_ITEM" });
  if (vault && item) {
    const secret = await getSecret(vault, item, readProfileConfigString({ relativePath: "todoist/onepassword-field.txt", envValueVar: "TODOIST_1PASSWORD_FIELD" }) || "credential");
    if (secret?.trim()) return secret.trim();
  }
  throw new Error(SETUP);
}

export function createTodoistTools(): AgentTool[] {
  return [{
    name: "todoist",
    description: "Manage Todoist tasks: list_projects, list_sections, list_labels, list_tasks, get_task, create_task, update_task, complete_task, reopen_task. Lists return one page: follow next_cursor with unchanged filters. list_tasks filter uses Todoist syntax (today | overdue; search: text); do not combine filter with project_id/label. Resolve IDs by reading first, never guess. API priority is 4=urgent (UI p1), 1=normal (UI p4). Supply only one due_string/due_date/due_datetime; due_string supports recurrence and 'no date'. Completing recurring tasks advances their schedule. Writes require user authorization; never retry an uncertain write without checking current state. Read agents/tools/todoist.md for setup and examples.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: [...operations] },
        task_id: { type: "string" }, project_id: { type: "string" }, section_id: { type: "string" }, parent_id: { type: "string" },
        content: { type: "string" }, description: { type: "string" },
        labels: { type: "array", items: { type: "string" } }, label: { type: "string" },
        priority: { type: "integer", minimum: 1, maximum: 4, description: "4=urgent (UI p1); 1=normal (UI p4)" },
        due_string: { type: "string" }, due_date: { type: "string", description: "YYYY-MM-DD" },
        due_datetime: { type: "string", description: "RFC3339 with timezone" }, due_lang: { type: "string" },
        filter: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["operation"], additionalProperties: false,
    },
    handler: async (input) => {
      const op = input.operation;
      if (typeof op !== "string" || !operations.includes(op as typeof operations[number])) return { error: "Unknown Todoist operation." };
      const parsed = schemas[op as keyof typeof schemas].safeParse(input);
      if (!parsed.success) return { error: "Invalid Todoist parameters.", fields: parsed.error.issues.map(i => i.path.join(".")) };
      const data = parsed.data as Record<string, unknown>;
      if (["due_string", "due_date", "due_datetime"].filter(k => data[k] !== undefined).length > 1) return { error: "Supply only one due_string, due_date, or due_datetime." };
      if (op === "list_tasks" && data.filter && (data.project_id || data.label)) return { error: "Do not combine filter with project_id or label; include all conditions in filter." };
      if (op === "update_task" && Object.keys(data).length === 2) return { error: "update_task requires at least one changed field." };
      if (data.due_lang && !data.due_string) return { error: "due_lang requires due_string." };
      let token: string;
      try { token = await resolveTodoistToken(); } catch { return { error: SETUP }; }
      const method = reads.has(op) ? "GET" : "POST";
      let path: string;
      const params = new URLSearchParams();
      const { operation: _operation, task_id, ...body } = data;
      if (op.startsWith("list_")) {
        path = `/${op.slice(5)}`;
        for (const [key, value] of Object.entries(body)) {
          params.set(key === "filter" ? "query" : key, String(value));
        }
        if (data.filter) path = "/tasks/filter";
      } else {
        path = op === "create_task" ? "/tasks" : `/tasks/${encodeURIComponent(String(task_id))}`;
        if (op === "complete_task") path += "/close";
        if (op === "reopen_task") path += "/reopen";
      }
      try {
        const res = await fetch(`${BASE}${path}${params.size ? `?${params}` : ""}`, {
          method, redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(method === "POST" ? { "X-Request-Id": randomUUID() } : {}) },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        });
        if (!res.ok) {
          const hints: Record<number, string> = { 400: "Check the task parameters.", 401: "Check or rotate the configured API token.", 403: "The account cannot access this resource.", 404: "Resource not found; re-read IDs.", 429: "Rate limited; wait before retrying." };
          const retry = res.headers.get("retry-after");
          return { error: `Todoist HTTP ${res.status}. ${hints[res.status] ?? "Request failed; verify state before retrying writes."}`, status: res.status, ...(res.status === 429 && retry && /^\d+$/.test(retry) ? { retry_after: Number(retry) } : {}) };
        }
        const raw = await res.text();
        const result = raw ? JSON.parse(raw) : null;
        if (op === "complete_task" || op === "reopen_task") return { success: true, task_id, operation: op };
        if (op.startsWith("list_")) {
          if (!result || !Array.isArray(result.results) || !(result.next_cursor === null || typeof result.next_cursor === "string")) return { error: "Unexpected Todoist list response." };
        } else if (!result || typeof result.id !== "string") return { error: "Unexpected Todoist task response. Verify state before retrying writes." };
        return result;
      } catch {
        return { error: "Todoist request failed or timed out. Verify current state before retrying a write; its outcome may be unknown." };
      }
    },
  }];
}
