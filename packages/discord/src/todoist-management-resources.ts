import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ManagementClient, ManagementOperation } from "./todoist-management-types.js";

// Routes and fields: https://developer.todoist.com/api/v1/ (REST resources;
// section_move is a bounded Sync command because it has no REST equivalent).
const id = z.string().trim().regex(/^[a-zA-Z0-9]+$/, "Use a confirmed Todoist resource ID.");
const text = z.string().trim().min(1);
const color = z.union([
  z.enum(["berry_red", "red", "orange", "yellow", "olive_green", "lime_green", "green", "mint_green", "teal", "sky_blue", "light_blue", "blue", "grape", "violet", "lavender", "magenta", "salmon", "charcoal", "grey", "taupe"]),
  z.number().int().min(30).max(49),
]);
const order = z.number().int().nonnegative();
const projectFields = {
  name: text.optional(), description: z.string().optional(), color: color.optional(),
  is_favorite: z.boolean().optional(), view_style: z.enum(["list", "board", "calendar"]).optional(),
};
const labelFields = { name: text.max(128).optional(), color: color.optional(), order: order.optional(), is_favorite: z.boolean().optional() };
const scope = { task_id: id.optional(), project_id: id.optional() };
const oneScope = (data: Record<string, unknown>) => [data.task_id, data.project_id].filter(value => value !== undefined).length === 1;
const nonemptyUpdate = (data: Record<string, unknown>) => Object.entries(data).some(([key, value]) => !["operation", "project_id", "section_id", "label_id"].includes(key) && value !== undefined);
const objectResponse = z.object({ id: text }).passthrough();
const listResponse = z.object({ results: z.array(objectResponse), next_cursor: text.nullable() }).passthrough();

function checkObject(response: unknown, expectedId?: unknown): Record<string, unknown> {
  const parsed = objectResponse.safeParse(response);
  if (!parsed.success || (expectedId !== undefined && parsed.data.id !== expectedId)) {
    throw new Error("Unexpected Todoist resource response. Verify current state before retrying a write.");
  }
  return parsed.data;
}

function rest(
  schema: z.ZodTypeAny, method: "GET" | "POST" | "DELETE", collection: string,
  idField?: string, suffix = "",
): ManagementOperation {
  return {
    schema, readOnly: method === "GET",
    async execute(data, client) {
      const { operation, ...fields } = data;
      const resourceId = idField ? fields[idField] : undefined;
      if (idField) delete fields[idField];
      const path = `/${collection}${resourceId === undefined ? "" : `/${encodeURIComponent(String(resourceId))}`}${suffix}`;
      const response = await client.request(method, path, method === "POST" ? fields : undefined);
      if (method === "DELETE") {
        if (response !== null && response !== undefined) throw new Error("Unexpected Todoist delete response. Verify current state before retrying a write.");
        return { success: true, operation, [idField!]: resourceId };
      }
      return checkObject(response, resourceId);
    },
  };
}

function actionSchema(operation: string, idField: string) {
  return z.object({ operation: z.literal(operation), [idField]: id }).strict();
}

export const resourceOperations: Record<string, ManagementOperation> = {
  get_project: rest(actionSchema("get_project", "project_id"), "GET", "projects", "project_id"),
  create_project: rest(z.object({ operation: z.literal("create_project"), ...projectFields, name: text, parent_id: id.optional(), workspace_id: z.number().int().positive().optional() }).strict()
    .refine(data => !(data.parent_id && data.workspace_id), "Choose a personal parent project or a workspace, not both."), "POST", "projects"),
  update_project: rest(z.object({ operation: z.literal("update_project"), project_id: id, ...projectFields, child_order: order.optional(), is_collapsed: z.boolean().optional(), folder_id: z.number().int().positive().nullable().optional() }).strict()
    .refine(nonemptyUpdate, "Provide at least one changed field."), "POST", "projects", "project_id"),
  archive_project: rest(actionSchema("archive_project", "project_id"), "POST", "projects", "project_id", "/archive"),
  unarchive_project: rest(actionSchema("unarchive_project", "project_id"), "POST", "projects", "project_id", "/unarchive"),
  delete_project: rest(actionSchema("delete_project", "project_id"), "DELETE", "projects", "project_id"),

  get_section: rest(actionSchema("get_section", "section_id"), "GET", "sections", "section_id"),
  create_section: rest(z.object({ operation: z.literal("create_section"), name: text, project_id: id, order: order.optional(), description: z.string().optional() }).strict(), "POST", "sections"),
  update_section: rest(z.object({ operation: z.literal("update_section"), section_id: id, name: text.optional(), section_order: order.optional(), is_collapsed: z.boolean().optional(), description: z.string().nullable().optional() }).strict()
    .refine(nonemptyUpdate, "Provide at least one changed field."), "POST", "sections", "section_id"),
  move_section: {
    schema: z.object({ operation: z.literal("move_section"), section_id: id, project_id: id }).strict(),
    readOnly: false,
    async execute(data, client: ManagementClient) {
      const uuid = randomUUID();
      const result = await client.sync({ commands: JSON.stringify([{ type: "section_move", uuid, args: { id: data.section_id, project_id: data.project_id } }]) });
      const statuses = result.sync_status;
      if (!statuses || typeof statuses !== "object" || Array.isArray(statuses) || (statuses as Record<string, unknown>)[uuid] !== "ok") {
        throw new Error("Todoist section move was not confirmed. Verify current state before retrying a write.");
      }
      const section = checkObject(await client.request("GET", `/sections/${encodeURIComponent(String(data.section_id))}`), data.section_id);
      if (section.project_id !== data.project_id) throw new Error("Todoist section move readback did not match the requested project. Verify current state before retrying a write.");
      return section;
    },
  },
  delete_section: rest(actionSchema("delete_section", "section_id"), "DELETE", "sections", "section_id"),

  get_label: rest(actionSchema("get_label", "label_id"), "GET", "labels", "label_id"),
  create_label: rest(z.object({ operation: z.literal("create_label"), ...labelFields, name: text.max(128) }).strict(), "POST", "labels"),
  update_label: rest(z.object({ operation: z.literal("update_label"), label_id: id, ...labelFields }).strict()
    .refine(nonemptyUpdate, "Provide at least one changed field."), "POST", "labels", "label_id"),
  delete_label: rest(actionSchema("delete_label", "label_id"), "DELETE", "labels", "label_id"),

  move_task: rest(z.object({ operation: z.literal("move_task"), task_id: id, project_id: id.optional(), section_id: id.optional(), parent_id: id.optional() }).strict()
    .refine(data => [data.project_id, data.section_id, data.parent_id].filter(value => value !== undefined).length === 1, "Provide exactly one destination: project_id, section_id, or parent_id.")
    .refine(data => data.task_id !== data.parent_id, "A task cannot be its own parent."), "POST", "tasks", "task_id", "/move"),
  delete_task: rest(actionSchema("delete_task", "task_id"), "DELETE", "tasks", "task_id"),

  list_comments: {
    schema: z.object({ operation: z.literal("list_comments"), ...scope, cursor: text.optional(), limit: z.number().int().min(1).max(200).optional() }).strict()
      .refine(oneScope, "Provide exactly one task_id or project_id."),
    readOnly: true,
    async execute(data, client) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(data)) if (key !== "operation" && value !== undefined) params.set(key, String(value));
      const parsed = listResponse.safeParse(await client.request("GET", `/comments?${params}`));
      if (!parsed.success) throw new Error("Unexpected Todoist comments list response.");
      return parsed.data;
    },
  },
  get_comment: rest(actionSchema("get_comment", "comment_id"), "GET", "comments", "comment_id"),
  create_comment: rest(z.object({ operation: z.literal("create_comment"), ...scope, content: text.max(15000) }).strict()
    .refine(oneScope, "Provide exactly one task_id or project_id."), "POST", "comments"),
  update_comment: rest(z.object({ operation: z.literal("update_comment"), comment_id: id, content: text.max(15000) }).strict(), "POST", "comments", "comment_id"),
  delete_comment: rest(actionSchema("delete_comment", "comment_id"), "DELETE", "comments", "comment_id"),
};
