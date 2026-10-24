import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ManagementClient, ManagementOperation } from "./todoist-management-types.js";

const text = z.string().trim().min(1);
const filterFields = { name: text.optional(), query: text.optional(), description: z.string().optional(), color: text.optional(), is_favorite: z.boolean().optional(), order_key: text.optional() };
const viewType = z.enum(["today", "upcoming", "assigned_to_me", "project", "label", "filter", "workspace_filter"]);
const objectViews = new Set(["project", "label", "filter", "workspace_filter"]);
const viewFields = {
  grouped_by: z.enum(["assignee", "added_date", "due_date", "deadline", "label", "priority", "project", "workspace"]).nullable().optional(),
  sorted_by: z.enum(["alphabetically", "assignee", "added_date", "due_date", "deadline", "label", "priority", "project", "workspace", "manual"]).nullable().optional(),
  sort_order: z.enum(["asc", "desc"]).optional(),
  view_mode: z.enum(["list", "board", "calendar"]).optional(),
  filtered_by: z.string().nullable().optional(), deadline: z.string().nullable().optional(),
  show_completed_tasks: z.boolean().optional(),
  calendar_settings: z.object({ layout: z.enum(["WEEK", "MONTH"]), visible_day_count: z.union([z.literal(1), z.literal(3), z.literal(7)]).optional(), color: z.enum(["PRIORITY", "LABEL", "PROJECT"]).optional() }).strict().nullable().optional(),
};
const target = { view_type: viewType, object_id: text.optional() };
function validTarget(d: { view_type: string; object_id?: string }) { return objectViews.has(d.view_type) === (d.object_id !== undefined); }
function normalizeView(v: Record<string, unknown>) {
  const result = { ...v };
  for (const field of ["view_type", "grouped_by", "sorted_by", "sort_order", "view_mode"]) if (typeof result[field] === "string") result[field] = (result[field] as string).toLowerCase();
  return result;
}
async function resources(client: ManagementClient, resource: "filters" | "view_options") {
  const data = await client.sync({ sync_token: "*", resource_types: JSON.stringify([resource]) });
  if (!Array.isArray(data[resource])) throw new Error("Unexpected Todoist resource response");
  return (data[resource] as Record<string, unknown>[]).filter(v => !v.is_deleted);
}
async function filter(client: ManagementClient, id: unknown) {
  const found = (await resources(client, "filters")).find(f => f.id === id);
  if (!found) throw new Error("Todoist filter not found");
  return found;
}
// Sync's deployed contract requires uppercase enum values despite lowercase
// examples in the API guide. Keep the public tool schema lowercase consistently.
function syncView(v: Record<string, unknown>) {
  const result = { ...v };
  for (const field of ["view_type", "grouped_by", "sorted_by", "sort_order", "view_mode"]) if (typeof result[field] === "string") result[field] = (result[field] as string).toUpperCase();
  return result;
}
function matchesView(v: Record<string, unknown>, d: Record<string, unknown>) { return String(v.view_type).toLowerCase() === d.view_type && (v.object_id ?? null) === (d.object_id ?? null); }
async function command(client: ManagementClient, type: string, args: Record<string, unknown>, creating = false) {
  const uuid = randomUUID(); const temp_id = creating ? randomUUID() : undefined;
  const result = await client.sync({ commands: JSON.stringify([{ type, uuid, ...(temp_id ? { temp_id } : {}), args }]) });
  if ((result.sync_status as Record<string, unknown> | undefined)?.[uuid] !== "ok") throw new Error("Todoist command failed or was not acknowledged; verify state before retrying");
  if (!temp_id) return undefined;
  const id = (result.temp_id_mapping as Record<string, unknown> | undefined)?.[temp_id];
  if (typeof id !== "string" || !id) throw new Error("Todoist creation result missing ID; verify state before retrying");
  return id;
}
export const filterOperations: Record<string, ManagementOperation> = {
  list_filters: {
    schema: z.object({ operation: z.literal("list_filters") }).strict(), readOnly: true,
    execute: async (_, c) => ({ results: await resources(c, "filters"), next_cursor: null }),
  },
  get_filter: {
    schema: z.object({ operation: z.literal("get_filter"), filter_id: text }).strict(), readOnly: true,
    execute: (d, c) => filter(c, d.filter_id),
  },
  create_filter: {
    schema: z.object({ operation: z.literal("create_filter"), ...filterFields, name: text, query: text }).strict(), readOnly: false,
    execute: async ({ operation: _, ...args }, c) => filter(c, await command(c, "filter_add", args, true)),
  },
  update_filter: {
    schema: z.object({ operation: z.literal("update_filter"), filter_id: text, ...filterFields }).strict().refine(d => Object.keys(d).length > 2, "Supply changed fields"), readOnly: false,
    execute: async ({ operation: _, filter_id, ...args }, c) => { await filter(c, filter_id); await command(c, "filter_update", { id: filter_id, ...args }); return filter(c, filter_id); },
  },
  delete_filter: {
    schema: z.object({ operation: z.literal("delete_filter"), filter_id: text }).strict(), readOnly: false,
    execute: async ({ filter_id }, c) => { await filter(c, filter_id); await command(c, "filter_delete", { id: filter_id }); if ((await resources(c, "filters")).some(f => f.id === filter_id)) throw new Error("Filter deletion not verified"); return { success: true, filter_id }; },
  },
  list_view_options: {
    schema: z.object({ operation: z.literal("list_view_options"), view_type: viewType.optional(), object_id: text.optional() }).strict().refine(d => !d.object_id || (!!d.view_type && objectViews.has(d.view_type)), "object_id requires an object view type"), readOnly: true,
    execute: async (d, c) => ({ results: (await resources(c, "view_options")).map(normalizeView).filter(v => (!d.view_type || v.view_type === d.view_type) && (!d.object_id || v.object_id === d.object_id)), next_cursor: null }),
  },
  set_view_options: {
    schema: z.object({ operation: z.literal("set_view_options"), ...target, ...viewFields }).strict().refine(validTarget, "object_id required only for project, label or filter views").refine(d => Object.keys(viewFields).some(k => k in d), "Supply changed settings"), readOnly: false,
    execute: async ({ operation: _, ...d }, c) => {
      const existing = (await resources(c, "view_options")).find(v => matchesView(v, d));
      const previous = existing ? normalizeView(existing) : {};
      const kept = Object.fromEntries(Object.keys(viewFields).filter(k => previous[k] !== undefined).map(k => [k, previous[k]]));
      await command(c, "view_options_set", syncView({ ...kept, ...d }));
      const saved = (await resources(c, "view_options")).find(v => matchesView(v, d));
      if (!saved) throw new Error("View update not verified");
      const normalized = normalizeView(saved);
      for (const k of Object.keys(viewFields)) if (k in d && JSON.stringify(normalized[k] ?? null) !== JSON.stringify(d[k])) throw new Error("View update readback differs; verify before retrying");
      return normalized;
    },
  },
  reset_view_options: {
    schema: z.object({ operation: z.literal("reset_view_options"), ...target }).strict().refine(validTarget, "Invalid view target"), readOnly: false,
    execute: async ({ operation: _, ...d }, c) => { await command(c, "view_options_delete", syncView(d)); if ((await resources(c, "view_options")).some(v => matchesView(v, d))) throw new Error("View reset not verified"); return { success: true, ...d }; },
  },
};
