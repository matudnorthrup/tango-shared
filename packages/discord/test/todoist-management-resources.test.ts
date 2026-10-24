import { describe, expect, it, vi } from "vitest";
import { resourceOperations } from "../src/todoist-management-resources.js";
import type { ManagementClient } from "../src/todoist-management-types.js";

function mockClient(response: unknown = { id: "resource1" }) {
  return { request: vi.fn().mockResolvedValue(response), sync: vi.fn() } satisfies ManagementClient;
}

async function execute(input: Record<string, unknown>, client = mockClient()) {
  const definition = resourceOperations[String(input.operation)];
  return definition.execute(definition.schema.parse(input), client);
}

describe("Todoist management resources", () => {
  it.each(["project", "section", "label", "comment"])("reads the named %s through its route", async resource => {
    const client = mockClient();
    await expect(execute({ operation: `get_${resource}`, [`${resource}_id`]: "resource1" }, client)).resolves.toEqual({ id: "resource1" });
    expect(client.request).toHaveBeenCalledWith("GET", `/${resource}s/resource1`, undefined);
    expect(resourceOperations[`get_${resource}`].readOnly).toBe(true);
  });

  it.each(["project", "section", "label", "task", "comment"])("acknowledges an empty %s deletion with its exact ID", async resource => {
    const client = mockClient(null);
    const input = { operation: `delete_${resource}`, [`${resource}_id`]: "resource1" };
    await expect(execute(input, client)).resolves.toEqual({ success: true, ...input });
    expect(client.request).toHaveBeenCalledWith("DELETE", `/${resource}s/resource1`, undefined);
    expect(resourceOperations[`delete_${resource}`].readOnly).toBe(false);
  });

  it.each([
    [{ operation: "create_project", name: "Example", color: "teal", view_style: "board" }, "/projects", { name: "Example", color: "teal", view_style: "board" }],
    [{ operation: "update_project", project_id: "resource1", folder_id: null, is_favorite: false }, "/projects/resource1", { folder_id: null, is_favorite: false }],
    [{ operation: "create_section", project_id: "project1", name: "Example", order: 0 }, "/sections", { project_id: "project1", name: "Example", order: 0 }],
    [{ operation: "update_section", section_id: "resource1", description: null, section_order: 2 }, "/sections/resource1", { description: null, section_order: 2 }],
    [{ operation: "create_label", name: "example", color: 40 }, "/labels", { name: "example", color: 40 }],
    [{ operation: "update_label", label_id: "resource1", order: 0 }, "/labels/resource1", { order: 0 }],
    [{ operation: "create_comment", task_id: "task1", content: "Example" }, "/comments", { task_id: "task1", content: "Example" }],
    [{ operation: "create_comment", project_id: "project1", content: "Example" }, "/comments", { project_id: "project1", content: "Example" }],
    [{ operation: "update_comment", comment_id: "resource1", content: "Changed" }, "/comments/resource1", { content: "Changed" }],
    [{ operation: "archive_project", project_id: "resource1" }, "/projects/resource1/archive", {}],
    [{ operation: "unarchive_project", project_id: "resource1" }, "/projects/resource1/unarchive", {}],
  ])("sends only documented body fields for %j", async (input, path, body) => {
    const client = mockClient();
    await execute(input as Record<string, unknown>, client);
    expect(client.request).toHaveBeenCalledWith("POST", path, body);
    expect(resourceOperations[String((input as Record<string, unknown>).operation)].readOnly).toBe(false);
  });

  it.each(["project_id", "section_id", "parent_id"])("moves a task to one %s", async destination => {
    const client = mockClient();
    await execute({ operation: "move_task", task_id: "resource1", [destination]: "target1" }, client);
    expect(client.request).toHaveBeenCalledWith("POST", "/tasks/resource1/move", { [destination]: "target1" });
  });

  it("moves a section with one fixed Sync command and verifies its destination", async () => {
    const client = mockClient({ id: "section1", project_id: "project2" });
    client.sync.mockImplementation(async ({ commands }) => {
      const command = JSON.parse(commands)[0];
      expect(command).toEqual({ type: "section_move", uuid: expect.any(String), args: { id: "section1", project_id: "project2" } });
      return { sync_status: { [command.uuid]: "ok" } };
    });
    await expect(execute({ operation: "move_section", section_id: "section1", project_id: "project2" }, client)).resolves.toEqual({ id: "section1", project_id: "project2" });
    expect(client.sync).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith("GET", "/sections/section1");
  });

  it("rejects failed Sync commands without leaking server content or doing readback", async () => {
    const client = mockClient();
    client.sync.mockImplementation(async ({ commands }) => ({ sync_status: { [JSON.parse(commands)[0].uuid]: { error: "private server details" } } }));
    await expect(execute({ operation: "move_section", section_id: "section1", project_id: "project2" }, client)).rejects.toThrow("section move was not confirmed");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("rejects a successful section move whose readback has the wrong project", async () => {
    const client = mockClient({ id: "section1", project_id: "oldproject" });
    client.sync.mockImplementation(async ({ commands }) => ({ sync_status: { [JSON.parse(commands)[0].uuid]: "ok" } }));
    await expect(execute({ operation: "move_section", section_id: "section1", project_id: "project2" }, client)).rejects.toThrow("readback did not match");
  });

  it("preserves comment pagination and URL-encodes the cursor", async () => {
    const response = { results: [{ id: "comment1", content: "Example" }], next_cursor: "next-page" };
    const client = mockClient(response);
    await expect(execute({ operation: "list_comments", task_id: "task1", cursor: "cursor&other=value", limit: 15 }, client)).resolves.toEqual(response);
    const path = String(client.request.mock.calls[0][1]);
    const url = new URL(path, "https://example.test");
    expect(url.pathname).toBe("/comments");
    expect([...url.searchParams.entries()]).toEqual([["task_id", "task1"], ["cursor", "cursor&other=value"], ["limit", "15"]]);
  });

  it.each([
    { operation: "update_project", project_id: "project1" },
    { operation: "update_section", section_id: "section1" },
    { operation: "update_label", label_id: "label1" },
    { operation: "update_comment", comment_id: "comment1", content: " " },
    { operation: "create_project", name: "Example", parent_id: "project1", workspace_id: 5 },
    { operation: "update_project", project_id: "project1", color: "invented" },
    { operation: "move_task", task_id: "task1" },
    { operation: "move_task", task_id: "task1", project_id: "project1", section_id: "section1" },
    { operation: "move_task", task_id: "task1", parent_id: "task1" },
    { operation: "list_comments" },
    { operation: "list_comments", task_id: "task1", project_id: "project1" },
    { operation: "list_comments", task_id: "task1", limit: 201 },
    { operation: "create_comment", content: "Example" },
    { operation: "create_comment", content: "Example", task_id: "task1", project_id: "project1" },
    { operation: "create_comment", content: "Example", task_id: "task1", attachment: {} },
    { operation: "create_comment", content: "Example", task_id: "task1", uids_to_notify: [123] },
    { operation: "get_project", project_id: "tmp-unconfirmed" },
    { operation: "get_project", project_id: "../projects" },
    { operation: "delete_task", task_id: "task1", arbitrary: true },
  ])("rejects invalid parameters before making any requests: %j", async input => {
    const client = mockClient();
    await expect(execute(input, client)).rejects.toThrow();
    expect(client.request).not.toHaveBeenCalled();
    expect(client.sync).not.toHaveBeenCalled();
  });

  it.each([null, {}, [], { id: "other1" }, { id: "" }])("rejects malformed or mismatched resource results: %j", async response => {
    await expect(execute({ operation: "get_project", project_id: "resource1" }, mockClient(response))).rejects.toThrow("Unexpected Todoist resource response");
  });

  it.each([{ results: [] }, { results: [{}], next_cursor: null }, { results: [], next_cursor: 5 }])("rejects malformed list responses: %j", async response => {
    await expect(execute({ operation: "list_comments", task_id: "task1" }, mockClient(response))).rejects.toThrow("Unexpected Todoist comments list response");
  });

  it("does not mistake an unexpected delete body for confirmed success", async () => {
    await expect(execute({ operation: "delete_project", project_id: "resource1" }, mockClient({ error: "private detail" }))).rejects.toThrow("Unexpected Todoist delete response");
  });
});
