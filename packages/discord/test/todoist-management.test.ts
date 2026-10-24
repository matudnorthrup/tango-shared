import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTodoistManagementTools, todoistManagementOperationLooksReadOnly } from "../src/todoist-management-tools.js";
import { getMcpToolAnnotations } from "../src/mcp-tool-metadata.js";
import { resetTodoistManagementSyncForTests } from "../src/todoist-management-sync.js";
const fetchMock = vi.fn<typeof fetch>();
let old: string | undefined;
const invoke = (args: Record<string, unknown>) => createTodoistManagementTools()[0]!.handler(args);
let syncIndex = 0;
function envelope(body: unknown) { return { full_sync: syncIndex++ === 0, sync_token: `cursor-${syncIndex}`, filters: [], view_options: [], ...(body as object) }; }
function respond(body: unknown) { fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify(envelope(body)))); }
function sent(i = 0) { const [url, init] = fetchMock.mock.calls[i]!; return { url, init, args: Object.fromEntries(new URLSearchParams(String(init?.body))) }; }
function commandReply(extra: Record<string, unknown> = {}) {
  fetchMock.mockImplementationOnce(async (_, init) => {
    const c = JSON.parse(new URLSearchParams(String(init?.body)).get("commands")!)[0];
    return new Response(JSON.stringify(envelope({ sync_status: { [c.uuid]: "ok" }, ...(c.temp_id ? { temp_id_mapping: { [c.temp_id]: "filter-new" } } : {}), ...extra })));
  });
}
beforeEach(() => { resetTodoistManagementSyncForTests(); syncIndex = 0; old = process.env.TODOIST_API_TOKEN; process.env.TODOIST_API_TOKEN = "synthetic-secret"; fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { if (old === undefined) delete process.env.TODOIST_API_TOKEN; else process.env.TODOIST_API_TOKEN = old; vi.unstubAllGlobals(); });
describe("Todoist management filters and views", () => {
  it.each([
    { operation: "raw_request", url: "https://example.test" },
    { operation: "__proto__" },
    { operation: "create_filter", name: "Example" },
    { operation: "update_filter", filter_id: "f" },
    { operation: "delete_filter", filter_id: "" },
    { operation: "list_filters", commands: [] },
    { operation: "list_filters", api_token: "override" },
    { operation: "list_filters", cursor: "unsupported" },
    { operation: "set_view_options", view_type: "filter", grouped_by: null },
    { operation: "set_view_options", view_type: "today", object_id: "f", grouped_by: null },
    { operation: "set_view_options", view_type: "filter", object_id: "f" },
    { operation: "set_view_options", view_type: "filter", object_id: "f", grouped_by: "invalid" },
    { operation: "reset_view_options", view_type: "project" },
    { operation: "list_view_options", object_id: "f" },
  ])("rejects invalid or unscoped input before any request: %j", async args => {
    expect(await invoke(args)).toHaveProperty("error"); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("lists only active filters and initializes both management resources", async () => {
    respond({ filters: [{ id: "a", name: "Example" }, { id: "b", is_deleted: true }], sync_token: "not-returned" });
    expect(await invoke({ operation: "list_filters" })).toEqual({ results: [{ id: "a", name: "Example" }], next_cursor: null });
    expect(sent().args).toEqual({ sync_token: "*", resource_types: '["filters","view_options"]' });
  });
  it("creates via UUID command, maps the temporary ID and reads back", async () => {
    commandReply(); respond({ filters: [{ id: "filter-new", name: "Example", query: "today" }] });
    expect(await invoke({ operation: "create_filter", name: "Example", query: "today" })).toHaveProperty("id", "filter-new");
    const c = JSON.parse(sent().args.commands!)[0]; expect(c).toMatchObject({ type: "filter_add", args: { name: "Example", query: "today" } });
    expect(sent(1).args.sync_token).toBe("cursor-1"); expect(c.uuid).not.toBe(c.temp_id); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("updates only requested fields and confirms filter state", async () => {
    respond({ filters: [{ id: "f", name: "Keep", query: "today" }] }); commandReply(); respond({ filters: [{ id: "f", name: "Keep", query: "overdue" }] });
    expect(await invoke({ operation: "update_filter", filter_id: "f", query: "overdue" })).toHaveProperty("name", "Keep");
    expect(JSON.parse(sent(1).args.commands!)[0].args).toEqual({ id: "f", query: "overdue" });
  });
  it("rejects HTTP-success command failures without returning private error details", async () => {
    respond({ sync_status: { fake: { error: "private synthetic-secret" } } });
    const result = await invoke({ operation: "create_filter", name: "Example", query: "today" });
    expect(result).toHaveProperty("error"); expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("preserves other view preferences while clearing grouping with null", async () => {
    respond({ view_options: [{ view_type: "FILTER", object_id: "f", grouped_by: "DUE_DATE", sorted_by: "PRIORITY", sort_order: "DESC", view_mode: "LIST" }] });
    commandReply(); respond({ view_options: [{ view_type: "FILTER", object_id: "f", grouped_by: null, sorted_by: "PRIORITY", sort_order: "DESC", view_mode: "LIST" }] });
    const result = await invoke({ operation: "set_view_options", view_type: "filter", object_id: "f", grouped_by: null });
    expect(result).toMatchObject({ grouped_by: null, sorted_by: "priority", sort_order: "desc" });
    expect(JSON.parse(sent(1).args.commands!)[0].args).toEqual({ view_type: "FILTER", object_id: "f", grouped_by: null, sorted_by: "PRIORITY", sort_order: "DESC", view_mode: "LIST" });
  });
  it("detects an unacknowledged view setting instead of falsely claiming success", async () => {
    respond({ view_options: [] }); commandReply(); respond({ view_options: [{ view_type: "FILTER", object_id: "f", grouped_by: "DUE_DATE" }] });
    expect(await invoke({ operation: "set_view_options", view_type: "filter", object_id: "f", grouped_by: null })).toHaveProperty("error");
  });
  it("reset deletes only the specified view and verifies absence", async () => {
    commandReply(); respond({ view_options: [{ view_type: "FILTER", object_id: "other" }] });
    expect(await invoke({ operation: "reset_view_options", view_type: "filter", object_id: "f" })).toHaveProperty("success", true);
    expect(JSON.parse(sent().args.commands!)[0]).toMatchObject({ type: "view_options_delete", args: { view_type: "FILTER", object_id: "f" } });
  });
  it("sanitizes transport failures and never retries a potentially accepted write", async () => {
    fetchMock.mockRejectedValue(new Error("private synthetic-secret"));
    const result = await invoke({ operation: "create_filter", name: "Example", query: "today" });
    expect(result).toHaveProperty("error"); expect(JSON.stringify(result)).not.toContain("synthetic-secret"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("returns structured status for verified HTTP failures", async () => {
    fetchMock.mockResolvedValue(new Response('private synthetic-secret', { status: 404 }));
    expect(await invoke({ operation: "get_project", project_id: "absent" })).toMatchObject({ status: 404 });
  });
  it("honors Retry-After across calls without replaying blocked writes", async () => {
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
    const tool = createTodoistManagementTools()[0]!;
    fetchMock.mockResolvedValueOnce(new Response("private synthetic-secret", { status: 429, headers: { "Retry-After": "120" } }));
    const args = { operation: "delete_task", task_id: "scratch" };
    expect(await tool.handler(args)).toMatchObject({ status: 429, retry_after: 120, retry_at: new Date(now + 120_000).toISOString() });
    expect(await tool.handler(args)).toMatchObject({ status: 429, retry_after: 120 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await tool.handler(args)).toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2); vi.restoreAllMocks();
  });
  it.each([undefined, "invalid", "Wed, 01 Jan 2031 00:00:00 GMT"])("supplies safe retry timing for a missing, malformed or dated header: %s", async retry => {
    const now = Date.parse("2030-01-01T00:00:00Z"); vi.spyOn(Date, "now").mockReturnValue(now);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429, ...(retry ? { headers: { "Retry-After": retry } } : {}) }));
    const result = await invoke({ operation: "get_project", project_id: "scratch" });
    expect(result).toMatchObject({ status: 429, retry_after: retry?.startsWith("Wed") ? 31536000 : 60 });
    vi.restoreAllMocks();
  });
  it("marks read Sync requests as reads, mutations as writes, and destructive tool correctly", () => {
    for (const op of ["list_filters", "get_filter", "list_view_options", "get_project", "list_comments"]) expect(todoistManagementOperationLooksReadOnly(op)).toBe(true);
    for (const op of ["create_filter", "delete_project", "set_view_options", "reset_view_options", "unknown", "__proto__"]) expect(todoistManagementOperationLooksReadOnly(op)).toBe(false);
    expect(getMcpToolAnnotations("todoist_manage", "write")).toMatchObject({ openWorldHint: true, destructiveHint: true, readOnlyHint: false });
  });
  it("exposes typed public fields without allowing raw endpoint/command escape hatches", () => {
    const s = createTodoistManagementTools()[0]!.inputSchema as { properties: Record<string, any> };
    expect(s.properties.operation.enum).toContain("update_filter"); expect(s.properties.filter_id.type).toBe("string");
    expect(s.properties.grouped_by).toBeTruthy(); expect(s.properties.commands).toBeUndefined(); expect(s.properties.url).toBeUndefined();
  });
});
