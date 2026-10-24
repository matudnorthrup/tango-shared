import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const getSecret = vi.hoisted(() => vi.fn<(...args: string[]) => Promise<string | null>>());
vi.mock("../src/op-secret.js", () => ({ getSecret }));

import { createTodoistTools, todoistOperationLooksReadOnly } from "../src/todoist-agent-tools.js";

const TOKEN = "synthetic-todoist-test-token";
const envNames = ["TODOIST_API_TOKEN", "TODOIST_1PASSWORD_VAULT", "TODOIST_1PASSWORD_ITEM", "TODOIST_1PASSWORD_FIELD", "TANGO_HOME", "TANGO_PROFILE"];
const savedEnv: Record<string, string | undefined> = {};
const fetchMock = vi.fn<typeof fetch>();
let fixtureHome: string;

function profileFile(name: string, value: string) {
  const directory = join(fixtureHome, "profiles", "todoist-test", "config", "todoist");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), value);
}

function invoke(input: Record<string, unknown>) {
  return createTodoistTools()[0]!.handler(input);
}

function respond(body: unknown, status = 200, headers?: HeadersInit) {
  fetchMock.mockResolvedValueOnce(new Response(status === 204 ? null : JSON.stringify(body), { status, headers }));
}

function request(index = 0) {
  const [url, init] = fetchMock.mock.calls[index]!;
  return {
    url: new URL(String(url)),
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

beforeEach(() => {
  for (const key of envNames) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  fixtureHome = mkdtempSync(join(tmpdir(), "tango-todoist-test-"));
  process.env.TANGO_HOME = fixtureHome;
  process.env.TANGO_PROFILE = "todoist-test";
  process.env.TODOIST_API_TOKEN = TOKEN;
  getSecret.mockReset().mockResolvedValue(null);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const key of envNames) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(fixtureHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("Todoist validation and governance", () => {
  it("classifies only known read operations as read-only", () => {
    for (const operation of ["list_projects", "list_sections", "list_labels", "list_tasks", "get_task"]) {
      expect(todoistOperationLooksReadOnly(operation)).toBe(true);
    }
    for (const operation of ["create_task", "update_task", "complete_task", "reopen_task", "delete_task", "get_unknown", "", undefined, null]) {
      expect(todoistOperationLooksReadOnly(operation)).toBe(false);
    }
  });

  it.each([
    {},
    { operation: "delete_task", task_id: "task-1" },
    { operation: "get_task" },
    { operation: "complete_task", task_id: " " },
    { operation: "reopen_task" },
    { operation: "create_task", content: " " },
    { operation: "create_task", content: "Task", priority: 0 },
    { operation: "create_task", content: "Task", priority: 5 },
    { operation: "create_task", content: "Task", priority: 1.5 },
    { operation: "create_task", content: "Task", labels: "label" },
    { operation: "create_task", content: "Task", labels: [42] },
    { operation: "create_task", content: "Task", due_date: "2026-10-01", due_string: "tomorrow" },
    { operation: "create_task", content: "Task", due_date: "2026-02-30" },
    { operation: "create_task", content: "Task", due_datetime: "2026-10-01T10:00:00" },
    { operation: "create_task", content: "Task", due_lang: "en" },
    { operation: "update_task", task_id: "task-1" },
    { operation: "update_task", task_id: "task-1", project_id: "project-alpha", content: "Example" },
    { operation: "list_tasks", filter: "today", project_id: "project-alpha" },
    { operation: "list_tasks", filter: "today", label: "example" },
    { operation: "list_tasks", api_token: "input-credential-must-not-override-runtime" },
    { operation: "list_tasks", limit: 0 },
    { operation: "list_tasks", limit: 201 },
    { operation: "list_tasks", limit: 1.5 },
  ])("rejects invalid input before auth or network: %j", async (input) => {
    delete process.env.TODOIST_API_TOKEN;
    process.env.TODOIST_1PASSWORD_VAULT = "Example Vault";
    process.env.TODOIST_1PASSWORD_ITEM = "Example Token";
    expect(await invoke(input)).toMatchObject({ error: expect.any(String) });
    expect(getSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Todoist reads", () => {
  it.each([
    ["list_projects", "/api/v1/projects"],
    ["list_sections", "/api/v1/sections"],
    ["list_labels", "/api/v1/labels"],
    ["list_tasks", "/api/v1/tasks"],
  ])("preserves a %s page and opaque continuation cursor", async (operation, pathname) => {
    const page = { results: [{ id: "opaque-id", name: "Example" }], next_cursor: "next+/=" };
    respond(page);
    expect(await invoke({ operation, cursor: "previous+/=", limit: 200 })).toMatchObject(page);
    const sent = request();
    expect(sent.url.origin).toBe("https://api.todoist.com");
    expect(sent.url.pathname).toBe(pathname);
    expect(sent.url.searchParams.get("cursor")).toBe("previous+/=");
    expect(sent.url.searchParams.get("limit")).toBe("200");
    expect(sent.method).toBe("GET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an empty final page", async () => {
    respond({ results: [], next_cursor: null });
    expect(await invoke({ operation: "list_tasks", limit: 1 })).toMatchObject({ results: [], next_cursor: null });
  });

  it("passes task and section project filters without converting opaque IDs", async () => {
    respond({ results: [], next_cursor: null });
    respond({ results: [], next_cursor: null });
    await invoke({ operation: "list_tasks", project_id: "project-alpha", label: "next & later" });
    await invoke({ operation: "list_sections", project_id: "project-alpha" });
    expect(request().url.searchParams.get("project_id")).toBe("project-alpha");
    expect(request().url.searchParams.get("label")).toBe("next & later");
    expect(request(1).url.searchParams.get("project_id")).toBe("project-alpha");
  });

  it("uses the v1 filter endpoint with a query and pagination", async () => {
    respond({ results: [], next_cursor: "next" });
    await invoke({ operation: "list_tasks", filter: "today | overdue & @follow-up", cursor: "cursor", limit: 10 });
    const sent = request();
    expect(sent.url.pathname).toBe("/api/v1/tasks/filter");
    expect(sent.url.searchParams.get("query")).toBe("today | overdue & @follow-up");
    expect(sent.url.searchParams.get("cursor")).toBe("cursor");
    expect(sent.url.searchParams.get("limit")).toBe("10");
  });

  it("retrieves the requested task and preserves due details", async () => {
    const task = { id: "task-alpha", content: "Example task", due: { date: "2026-10-01", is_recurring: false } };
    respond(task);
    expect(await invoke({ operation: "get_task", task_id: "task-alpha" })).toMatchObject(task);
    expect(request().url.pathname).toBe("/api/v1/tasks/task-alpha");
  });

  it("encodes the task ID so it cannot inject a different endpoint or query", async () => {
    respond({ id: "opaque/../id?query=value" });
    await invoke({ operation: "get_task", task_id: "opaque/../id?query=value" });
    expect(request().url.pathname).toBe("/api/v1/tasks/opaque%2F..%2Fid%3Fquery%3Dvalue");
    expect(request().url.search).toBe("");
  });
});

describe("Todoist writes", () => {
  it("creates a fully specified task in one authenticated request", async () => {
    const fields = {
      content: "Example task", description: "Example description", project_id: "project-alpha",
      section_id: "section-alpha", parent_id: "parent-alpha", labels: ["next", "example"],
      priority: 4, due_string: "tomorrow", due_lang: "en",
    };
    respond({ id: "created-task", ...fields });
    expect(await invoke({ operation: "create_task", ...fields })).toMatchObject({ id: "created-task" });
    const sent = request();
    expect(sent.url.pathname).toBe("/api/v1/tasks");
    expect(sent.method).toBe("POST");
    expect(sent.body).toEqual(fields);
    expect(sent.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent.headers.get("Content-Type")).toContain("application/json");
    expect(sent.headers.get("X-Request-Id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("updates only supplied fields, including empty labels and description", async () => {
    respond({ id: "task-alpha", description: "", labels: [], priority: 1 });
    await invoke({ operation: "update_task", task_id: "task-alpha", description: "", labels: [], priority: 1 });
    expect(request().method).toBe("POST");
    expect(request().url.pathname).toBe("/api/v1/tasks/task-alpha");
    expect(request().body).toEqual({ description: "", labels: [], priority: 1 });
  });

  it.each(["due_date", "due_datetime"])("preserves an explicit %s", async (field) => {
    const value = field === "due_date" ? "2026-10-01" : "2026-10-01T10:00:00Z";
    respond({ id: "task-alpha" });
    await invoke({ operation: "update_task", task_id: "task-alpha", [field]: value });
    expect(request().body).toEqual({ [field]: value });
  });

  it("completes and reopens with separate idempotency keys and handles 204", async () => {
    respond(null, 204);
    respond(null, 204);
    expect(await invoke({ operation: "complete_task", task_id: "task-alpha" })).not.toHaveProperty("error");
    expect(await invoke({ operation: "reopen_task", task_id: "task-alpha" })).not.toHaveProperty("error");
    expect(request().url.pathname).toBe("/api/v1/tasks/task-alpha/close");
    expect(request(1).url.pathname).toBe("/api/v1/tasks/task-alpha/reopen");
    expect(request().method).toBe("POST");
    expect(request(1).method).toBe("POST");
    expect(request().headers.get("X-Request-Id")).toBeTruthy();
    expect(request(1).headers.get("X-Request-Id")).not.toBe(request().headers.get("X-Request-Id"));
  });
});

describe("Todoist credential resolution and safe errors", () => {
  it.each([undefined, "custom-token-field"])("resolves nonsecret profile references with field %s", async (field) => {
    delete process.env.TODOIST_API_TOKEN;
    profileFile("onepassword-vault.txt", "Example Profile Vault\n");
    profileFile("onepassword-item.txt", "Example Profile Item\n");
    if (field) profileFile("onepassword-field.txt", `${field}\n`);
    getSecret.mockResolvedValue("synthetic-profile-token");
    respond({ results: [], next_cursor: null });

    await invoke({ operation: "list_projects" });

    expect(getSecret).toHaveBeenCalledWith("Example Profile Vault", "Example Profile Item", field ?? "credential");
    expect(request().headers.get("Authorization")).toBe("Bearer synthetic-profile-token");
  });

  it("lets explicit environment references override conflicting profile references", async () => {
    delete process.env.TODOIST_API_TOKEN;
    profileFile("onepassword-vault.txt", "Example Profile Vault");
    profileFile("onepassword-item.txt", "Example Profile Item");
    profileFile("onepassword-field.txt", "profile-field");
    process.env.TODOIST_1PASSWORD_VAULT = "Example Env Vault";
    process.env.TODOIST_1PASSWORD_ITEM = "Example Env Item";
    process.env.TODOIST_1PASSWORD_FIELD = "env-field";
    getSecret.mockResolvedValue("synthetic-env-reference-token");
    respond({ results: [], next_cursor: null });

    await invoke({ operation: "list_projects" });

    expect(getSecret).toHaveBeenCalledExactlyOnceWith("Example Env Vault", "Example Env Item", "env-field");
    expect(request().headers.get("Authorization")).toBe("Bearer synthetic-env-reference-token");
  });

  it("overrides the field independently while keeping profile vault and item references", async () => {
    delete process.env.TODOIST_API_TOKEN;
    profileFile("onepassword-vault.txt", "Example Profile Vault");
    profileFile("onepassword-item.txt", "Example Profile Item");
    profileFile("onepassword-field.txt", "profile-field");
    process.env.TODOIST_1PASSWORD_FIELD = "env-field";
    getSecret.mockResolvedValue("synthetic-profile-token");
    respond({ results: [], next_cursor: null });

    await invoke({ operation: "list_projects" });

    expect(getSecret).toHaveBeenCalledWith("Example Profile Vault", "Example Profile Item", "env-field");
  });

  it("prefers the direct API token over profile secret references", async () => {
    profileFile("onepassword-vault.txt", "Example Profile Vault");
    profileFile("onepassword-item.txt", "Example Profile Item");
    respond({ results: [], next_cursor: null });

    await invoke({ operation: "list_projects" });

    expect(getSecret).not.toHaveBeenCalled();
    expect(request().headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("does not load a direct API token from profile config files", async () => {
    delete process.env.TODOIST_API_TOKEN;
    profileFile("api-token.txt", "synthetic-disallowed-file-token");

    expect(await invoke({ operation: "list_projects" })).toMatchObject({ error: expect.stringContaining("TODOIST_API_TOKEN") });
    expect(getSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers the direct token over a configured secret reference", async () => {
    process.env.TODOIST_1PASSWORD_VAULT = "Example Vault";
    process.env.TODOIST_1PASSWORD_ITEM = "Example Token";
    respond({ results: [], next_cursor: null });
    await invoke({ operation: "list_projects" });
    expect(request().headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it.each([undefined, "api_token"])("loads the configured 1Password field %s", async (field) => {
    delete process.env.TODOIST_API_TOKEN;
    process.env.TODOIST_1PASSWORD_VAULT = "Example Vault";
    process.env.TODOIST_1PASSWORD_ITEM = "Example Token";
    if (field) process.env.TODOIST_1PASSWORD_FIELD = field;
    getSecret.mockResolvedValue("synthetic-vault-token");
    respond({ results: [], next_cursor: null });
    await invoke({ operation: "list_projects" });
    expect(getSecret).toHaveBeenCalledWith("Example Vault", "Example Token", field ?? "credential");
    expect(request().headers.get("Authorization")).toBe("Bearer synthetic-vault-token");
  });

  it("gives a setup hint with no network call when credentials are missing", async () => {
    delete process.env.TODOIST_API_TOKEN;
    expect(await invoke({ operation: "list_projects" })).toMatchObject({ error: expect.stringContaining("TODOIST_API_TOKEN") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose credential-provider exception text", async () => {
    delete process.env.TODOIST_API_TOKEN;
    process.env.TODOIST_1PASSWORD_VAULT = "Example Vault";
    process.env.TODOIST_1PASSWORD_ITEM = "Example Failed Token";
    getSecret.mockRejectedValue(new Error(`private provider details ${TOKEN}`));
    const result = await invoke({ operation: "list_projects" });
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("private provider details");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500])("sanitizes HTTP %i without retrying writes", async (status) => {
    respond({ error: `private task content ${TOKEN}` }, status);
    const result = await invoke({ operation: "create_task", content: "Example task" });
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("private task content");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns rate-limit retry guidance without replaying the mutation", async () => {
    respond({ error: "private response" }, 429, { "Retry-After": "30" });
    const result = await invoke({ operation: "complete_task", task_id: "task-alpha" }) as { error: string; retry_after: string | number };
    expect(result.error).toEqual(expect.any(String));
    expect(String(result.retry_after)).toBe("30");
    expect(JSON.stringify(result)).not.toContain("private response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transport errors and leaves uncertain writes unretried", async () => {
    fetchMock.mockRejectedValueOnce(new Error(`network details ${TOKEN}`));
    const result = await invoke({ operation: "create_task", content: "Example task" });
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("network details");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails safely on malformed success JSON without leaking its contents", async () => {
    fetchMock.mockResolvedValueOnce(new Response(`malformed private response ${TOKEN}`, { status: 200 }));
    const result = await invoke({ operation: "create_task", content: "Example task" });
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("malformed private response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects list responses that would silently lose pagination", async () => {
    respond({ results: [{ id: "task-alpha" }] });
    expect(await invoke({ operation: "list_tasks" })).toMatchObject({ error: expect.any(String) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
