import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDayOneCliCall, createDayOneTools } from "../src/dayone-agent-tools.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tool(name: string, call = vi.fn(async () => [] as unknown)) {
  const found = createDayOneTools({ call }).find((t) => t.name === name);
  if (!found) throw new Error(name);
  return { handler: found.handler, call };
}

// A stand-in for `dayone mcp`: logs noise, answers initialize and one tools/call.
function fakeCli(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tango-dayone-test-"));
  dirs.push(dir);
  const file = join(dir, "dayone");
  writeFileSync(file, `#!/usr/bin/env node\n${script}`);
  chmodSync(file, 0o755);
  return file;
}

describe("dayone_read", () => {
  it("explains an empty journal list instead of implying there are no journals", async () => {
    const { handler, call } = tool("dayone_read");
    const result = await handler({ operation: "list_journals" });
    expect(call).toHaveBeenCalledWith("list_journals", {});
    expect(result).toMatchObject({ journals: [], note: expect.stringContaining("MCP Access Control") });
  });

  it("forwards search filters without the operation key", async () => {
    const { handler, call } = tool("dayone_read", vi.fn(async () => [{ id: "e1" }]));
    const result = await handler({ operation: "get_entries", query: "hike", start_date: "2026-10-01", limit: 5 });
    expect(call).toHaveBeenCalledWith("get_entries", { query: "hike", start_date: "2026-10-01", limit: 5 });
    expect(result).toEqual({ entries: [{ id: "e1" }] });
  });

  it("rejects writes and bad dates", async () => {
    const { handler } = tool("dayone_read");
    await expect(handler({ operation: "create_entry", text: "x" })).rejects.toThrow();
    await expect(handler({ operation: "get_entries", start_date: "10/01/2026" })).rejects.toThrow();
  });
});

describe("dayone_write", () => {
  it("joins tag and attachment arrays into Day One's comma-separated form", async () => {
    const { handler, call } = tool("dayone_write", vi.fn(async () => ({ id: "e2" })));
    await handler({ operation: "create_entry", text: "# Hike", journal_name: "Journal", tags: ["outdoors", "family"] });
    expect(call).toHaveBeenCalledWith("create_entry", { text: "# Hike", journal_name: "Journal", tags: "outdoors,family" });
  });

  it("requires text to create and entry_id to update", async () => {
    const { handler } = tool("dayone_write");
    await expect(handler({ operation: "create_entry" })).rejects.toThrow(/text/);
    await expect(handler({ operation: "update_entry", text: "x" })).rejects.toThrow(/entry_id/);
  });
});

describe("createDayOneCliCall", () => {
  it("speaks MCP over stdio and parses the JSON tool result", async () => {
    const cli = fakeCli(`
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (const line of buf.split("\\n").slice(0, -1)) {
    const m = JSON.parse(line);
    if (m.id === 1) console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
    if (m.id === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ echo: m.params }) }] } }));
  }
  buf = buf.split("\\n").pop();
});`);
    await expect(createDayOneCliCall(cli, 5000)("get_entries", { query: "x" }))
      .resolves.toEqual({ echo: { name: "get_entries", arguments: { query: "x" } } });
  });

  it("surfaces tool errors and early exits", async () => {
    const failing = fakeCli(`process.stdin.once("data", () => { console.log(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { isError: true, content: [{ type: "text", text: "Journal not found" }] } })); });`);
    await expect(createDayOneCliCall(failing, 5000)("create_entry", {})).rejects.toThrow("Journal not found");
    const exiting = fakeCli("process.exit(1);");
    await expect(createDayOneCliCall(exiting, 5000)("list_journals", {})).rejects.toThrow(/Labs/);
  });
});
