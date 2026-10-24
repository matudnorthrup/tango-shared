import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTodoistManagementSyncForTests, syncTodoistManagement } from "../src/todoist-management-sync.js";

const full = (token = "sync1", extra: Record<string, unknown> = {}) => ({ full_sync: true, sync_token: token, filters: [], view_options: [], ...extra });
const incremental = (token = "sync2", extra: Record<string, unknown> = {}) => ({ full_sync: false, sync_token: token, ...extra });
const sync = (send: (args: Record<string, string>) => Promise<Record<string, unknown>>, args: Record<string, string> = {}, credential = "credentialA") => syncTodoistManagement(credential, args, send);

beforeEach(resetTodoistManagementSyncForTests);

describe("Todoist management incremental sync", () => {
  it("fetches both resources initially and uses the returned token on subsequent reads", async () => {
    const send = vi.fn().mockResolvedValueOnce(full("sync1", { filters: [{ id: "f1", name: "Original", query: "today" }], view_options: [{ id: "v1", view_type: "FILTER", object_id: "f1", grouped_by: "PROJECT" }] }))
      .mockResolvedValueOnce(incremental("sync2", { filters: [{ id: "f1", name: "Changed" }] }));
    await sync(send, { sync_token: "*", resource_types: '["filters"]' });
    const result = await sync(send, { sync_token: "*", resource_types: '["view_options"]' });
    expect(send.mock.calls.map(([args]) => args)).toEqual([
      { sync_token: "*", resource_types: '["filters","view_options"]' },
      { sync_token: "sync1", resource_types: '["filters","view_options"]' },
    ]);
    expect(result.filters).toEqual([{ id: "f1", name: "Changed", query: "today" }]);
    expect(result.view_options).toEqual([{ id: "v1", view_type: "FILTER", object_id: "f1", grouped_by: "PROJECT" }]);
  });

  it("includes first-call commands without changing or replaying them and returns acknowledgements", async () => {
    const commands = '[{"type":"filter_add","uuid":"command1","args":{"name":"Example","query":"today"}}]';
    const metadata = { sync_status: { command1: "ok" }, temp_id_mapping: { temp1: "f1" } };
    const send = vi.fn().mockResolvedValue(full("sync1", { ...metadata, filters: [{ id: "f1" }] }));
    const result = await sync(send, { commands });
    expect(send).toHaveBeenCalledExactlyOnceWith({ commands, sync_token: "*", resource_types: '["filters","view_options"]' });
    expect(result).toMatchObject({ ...metadata, filters: [{ id: "f1" }] });
  });

  it("merges deleted filters and view tombstones into a full current snapshot", async () => {
    const send = vi.fn().mockResolvedValueOnce(full("sync1", { filters: [{ id: "f1" }, { id: "f2" }], view_options: [{ id: "v1", view_type: "FILTER", object_id: "f1" }, { view_type: "TODAY", grouped_by: "PROJECT" }] }))
      .mockResolvedValueOnce(incremental("sync2", { filters: [{ id: "f1", is_deleted: true }], view_options: [{ id: "v1", is_deleted: 1 }, { view_type: "today", is_deleted: true }] }));
    await sync(send);
    expect(await sync(send)).toMatchObject({ filters: [{ id: "f2" }], view_options: [] });
  });

  it("matches view options without IDs by normalized view type and object ID", async () => {
    const send = vi.fn().mockResolvedValueOnce(full("sync1", { view_options: [{ id: "v1", view_type: "FILTER", object_id: "f1", grouped_by: "PROJECT" }, { view_type: "FILTER", object_id: "f2", grouped_by: "PRIORITY" }] }))
      .mockResolvedValueOnce(incremental("sync2", { view_options: [{ view_type: "filter", object_id: "f1", grouped_by: null }] }));
    await sync(send);
    const result = await sync(send);
    expect(result.view_options).toEqual(expect.arrayContaining([{ id: "v1", view_type: "filter", object_id: "f1", grouped_by: null }, { view_type: "FILTER", object_id: "f2", grouped_by: "PRIORITY" }]));
    expect(result.view_options).toHaveLength(2);
  });

  it("replaces cached resources when the server returns another full sync", async () => {
    const send = vi.fn().mockResolvedValueOnce(full("sync1", { filters: [{ id: "old1" }] }))
      .mockResolvedValueOnce(full("sync2", { filters: [{ id: "new1" }] }));
    await sync(send);
    expect((await sync(send)).filters).toEqual([{ id: "new1" }]);
  });

  it("does not share credentials or resource data between accounts", async () => {
    const sendA = vi.fn().mockResolvedValueOnce(full("accountA1", { filters: [{ id: "A1" }] })).mockResolvedValueOnce(incremental("accountA2"));
    const sendB = vi.fn().mockResolvedValue(full("accountB1", { filters: [{ id: "B1" }] }));
    await sync(sendA);
    expect((await sync(sendB, {}, "credentialB")).filters).toEqual([{ id: "B1" }]);
    expect((await sync(sendA)).filters).toEqual([{ id: "A1" }]);
    expect(sendB.mock.calls[0][0].sync_token).toBe("*");
    expect(sendA.mock.calls[1][0].sync_token).toBe("accountA1");
  });

  it("serializes concurrent calls for one credential and carries forward the new token", async () => {
    let release!: (result: Record<string, unknown>) => void;
    const first = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { release = resolve; }));
    const second = vi.fn().mockResolvedValue(incremental("sync2"));
    const p1 = sync(first);
    const p2 = sync(second, { commands: "[]" });
    await Promise.resolve();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    release(full());
    await Promise.all([p1, p2]);
    expect(second).toHaveBeenCalledExactlyOnceWith({ commands: "[]", sync_token: "sync1", resource_types: '["filters","view_options"]' });
  });

  it("does not serialize different credentials behind a slow account", async () => {
    let release!: (result: Record<string, unknown>) => void;
    const pending = sync(() => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    const result = await sync(vi.fn().mockResolvedValue(full("syncB")), {}, "credentialB");
    expect(result.sync_token).toBe("syncB");
    release(full());
    await pending;
  });

  it("returns errors instead of stale data, never retries commands, and retains the prior token", async () => {
    const send = vi.fn().mockResolvedValueOnce(full("sync1", { filters: [{ id: "f1" }] }))
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(incremental("sync2"));
    await sync(send);
    await expect(sync(send, { commands: "unchanged-command" })).rejects.toThrow("rate limited");
    expect(send).toHaveBeenCalledTimes(2);
    expect((await sync(send)).filters).toEqual([{ id: "f1" }]);
    expect(send.mock.calls[2][0].sync_token).toBe("sync1");
    expect(send.mock.calls[2][0].commands).toBeUndefined();
  });

  it("preserves failed-command metadata while applying unrelated valid deltas", async () => {
    const failure = { command1: { error_code: 22, error: "Command failed" } };
    const send = vi.fn().mockResolvedValueOnce(full("sync1", { filters: [{ id: "f1", name: "Old" }] }))
      .mockResolvedValueOnce(incremental("sync2", { sync_status: failure, filters: [{ id: "f1", name: "External change" }] }))
      .mockResolvedValueOnce(incremental("sync3"));
    await sync(send);
    const result = await sync(send, { commands: "[]" });
    expect(result.sync_status).toEqual(failure);
    expect(result.filters).toEqual([{ id: "f1", name: "External change" }]);
    await sync(send);
    expect(send.mock.calls[2][0].sync_token).toBe("sync2");
  });

  it.each([
    { full_sync: true, sync_token: "syncBad", filters: [] },
    { full_sync: true, sync_token: "syncBad", filters: [], view_options: null },
    { full_sync: false, sync_token: "syncBad", filters: [], view_options: [] },
    { full_sync: "true", sync_token: "syncBad", filters: [], view_options: [] },
    { full_sync: true, sync_token: "", filters: [], view_options: [] },
    { full_sync: true, sync_token: "*", filters: [], view_options: [] },
    full("syncBad", { filters: [{}] }),
    full("syncBad", { filters: [{ id: "f1", is_deleted: "false" }] }),
    full("syncBad", { filters: [{ id: "f1" }, { id: "f1" }] }),
    full("syncBad", { view_options: [{ view_type: "filter" }] }),
    full("syncBad", { view_options: [{ view_type: "invented" }] }),
    full("syncBad", { view_options: [{ view_type: "today", object_id: "invalid" }] }),
  ])("rejects malformed initial responses without advancing state: %j", async badResponse => {
    const send = vi.fn().mockResolvedValueOnce(badResponse).mockResolvedValueOnce(full());
    await expect(sync(send)).rejects.toThrow("Unexpected Todoist sync response");
    await sync(send);
    expect(send.mock.calls[1][0].sync_token).toBe("*");
  });

  it("validates both incremental resources before committing either resource or token", async () => {
    const send = vi.fn().mockResolvedValueOnce(full("sync1", { filters: [{ id: "f1", name: "Original" }] }))
      .mockResolvedValueOnce(incremental("invalidToken", { filters: [{ id: "f1", name: "Uncommitted" }], view_options: [{}] }))
      .mockResolvedValueOnce(incremental("sync2"));
    await sync(send);
    await expect(sync(send)).rejects.toThrow("Unexpected Todoist sync response");
    expect((await sync(send)).filters).toEqual([{ id: "f1", name: "Original" }]);
    expect(send.mock.calls[2][0].sync_token).toBe("sync1");
  });

  it("isolates cached objects from mutation by send functions and callers", async () => {
    const response = full("sync1", { filters: [{ id: "f1", nested: { value: "Original" } }] });
    const send = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce(incremental("sync2"));
    const result = await sync(send);
    (result.filters as Array<Record<string, unknown>>)[0].nested = { value: "Caller changed" };
    (response.filters as Array<{ nested: { value: string } }>)[0].nested.value = "Sender changed";
    expect((await sync(send)).filters).toEqual([{ id: "f1", nested: { value: "Original" } }]);
  });

  it("evicts the least recently used account after four cached accounts", async () => {
    const send = vi.fn().mockImplementation(async (args: Record<string, string>) => args.sync_token === "*" ? full("sync1") : incremental("sync2"));
    for (const credential of ["A", "B", "C", "D", "A", "E", "A", "B"]) await sync(send, {}, credential);
    expect(send.mock.calls.map(([args]) => args.sync_token)).toEqual(["*", "*", "*", "*", "sync1", "*", "sync2", "*"]);
  });

  it.each(["not JSON", '["all"]', '["items"]', "[]", '{}'])("rejects unmanaged resource requests: %s", async resource_types => {
    const send = vi.fn();
    await expect(sync(send, { resource_types })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
