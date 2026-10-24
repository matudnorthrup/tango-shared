import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { conversationWrite } from '../src/conversation-write.js';
async function request(url: string, body: string, token = 'fixture', method = 'POST') {
  const req = Object.assign(Readable.from([Buffer.from(body)]), { url, method, headers: { 'x-tango-collaboration-token': token } }) as unknown as IncomingMessage;
  let status = 0; let response = '';
  const res = { writeHead: (code: number) => { status = code; }, end: (data: string) => { response = data; } } as unknown as ServerResponse;
  const deliver = vi.fn(async () => ({ delivered: true, conversationKey: 'conv:00000000000000000000000001' }));
  const handled = await conversationWrite(req, res, deliver, 'fixture');
  return { status, response, deliver, handled };
}
it('protects both POST endpoints with the bridge token before executing any work', async () => {
  for (const url of ['/conversations/start', '/conversations/turn']) {
    const denied = await request(url, '{}', 'wrong'); expect(denied.status).toBe(401); expect(denied.deliver).not.toHaveBeenCalled();
    const get = await request(url, '{}', 'fixture', 'GET'); expect(get.status).toBe(405); expect(get.deliver).not.toHaveBeenCalled();
    const allowed = await request(url, '{"agentId":"fixture","type":"start"}'); expect(allowed.status).toBe(200);
    expect(allowed.deliver).toHaveBeenCalledWith({ agentId: 'fixture', type: url.endsWith('start') ? 'start' : 'reply' });
  }
});
it('rejects malformed and oversized input, leaving read routes to their handler', async () => {
  for (const body of ['null', '[]', 'oops']) { const r = await request('/conversations/start', body); expect(r.status).toBe(400); expect(r.deliver).not.toHaveBeenCalled(); }
  expect((await request('/conversations/start', 'x'.repeat(16 * 1024 * 1024 + 1))).status).toBe(413);
  expect((await request('/conversations', '{}')).handled).toBe(false);
});
