import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';

it('reconnects when the persistent MCP server comes back', async () => {
  const server = createServer((_req, res) => res.end('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const child = spawn(process.execPath, ['dist/mcp-proxy.js'], { env: { ...process.env, MCP_SERVER_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const refused = new Promise<void>(resolve => child.stderr.on('data', chunk => { if (String(chunk).includes('ECONNREFUSED')) resolve(); }));
    const response = new Promise<string>(resolve => child.stdout.once('data', chunk => resolve(String(chunk))));
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}\n');
    await refused;
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    expect(JSON.parse(await response)).toMatchObject({ id: 1, result: { ok: true } });
  } finally {
    child.kill();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);
