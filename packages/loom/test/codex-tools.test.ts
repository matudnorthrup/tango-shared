import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLoomTools } from "../src/claude/loom-tools.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("the SDK and stdio servers expose identical tool names, descriptions and schemas", async () => {
  // The handoff tool names the desk's person from the profile: both servers read the same one.
  const profile = mkdtempSync(join(tmpdir(), "loom-profile-"));
  mkdirSync(join(profile, "config"));
  writeFileSync(join(profile, "config", "owner.yaml"), "display_name: Avery\n");
  const was = process.env.TANGO_PROFILE_DIR;
  process.env.TANGO_PROFILE_DIR = profile;
  const sdk = createLoomTools("test").instance;
  const stdio = new Client({ name: "test", version: "1" });
  async function list(server: { connect(transport: InMemoryTransport): Promise<void> }) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(a); await client.connect(b);
    try { return (await client.listTools()).tools; }
    finally { await client.close(); }
  }
  try {
    const expected = await list(sdk);
    await stdio.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", fileURLToPath(new URL("../src/codex/loom-mcp.ts", import.meta.url))], env: { PATH: process.env.PATH ?? "", LOOM_THREAD_ID: "test", TANGO_PROFILE_DIR: profile } }));
    const actual = (await stdio.listTools()).tools;
    expect(actual.map(t => t.name)).toEqual(expected.map(t => t.name));
    const comparable = (tools: typeof actual) => tools.map(({ name, description, inputSchema }) => {
      const { $schema, ...schema } = inputSchema; return { name, description, schema };
    });
    expect(comparable(actual)).toEqual(comparable(expected));
    expect(expected.find(t => t.name === "handoff")!.description).toContain("The desk's person is Avery (id avery). This thread is loom:test");
  } finally {
    await sdk.close(); await stdio.close();
    if (was === undefined) delete process.env.TANGO_PROFILE_DIR; else process.env.TANGO_PROFILE_DIR = was;
    rmSync(profile, { recursive: true, force: true });
  }
});
