#!/usr/bin/env node
// Exercise the released SDK's in-process MCP path without starting services.
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const release = resolve(process.argv[2]);
const require = createRequire(join(release, 'packages/loom/package.json'));
const { tool, createSdkMcpServer } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')));
const { z } = await import(pathToFileURL(require.resolve('zod')));
const server = createSdkMcpServer({
  name: 'release-smoke',
  version: '1.0.0',
  tools: [tool('echo', 'Echo text', { text: z.string() }, async ({ text }) => ({
    content: [{ type: 'text', text }],
  }))],
});
console.log(`MCP smoke: ${server.name}; one tool constructed with released zod`);
await server.instance.close();
