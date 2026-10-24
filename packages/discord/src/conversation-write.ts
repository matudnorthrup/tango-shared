import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ConversationWriteResult { delivered: boolean; reason?: string; conversationKey?: string; }
/** Same loopback bridge boundary as screen input; never accepts filesystem attachment paths. */
export async function conversationWrite(req: IncomingMessage, res: ServerResponse,
  deliver: (body: Record<string, unknown>) => Promise<ConversationWriteResult>,
  token = process.env.TANGO_COLLABORATION_BRIDGE_TOKEN?.trim()): Promise<boolean> {
  if (!['/conversations/turn', '/conversations/start'].includes(req.url ?? '')) return false;
  const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (token && req.headers['x-tango-collaboration-token'] !== token) { json(401, { error: 'unauthorized' }); return true; }
  if (req.method !== 'POST') { json(405, { error: 'POST required' }); return true; }
  let body = ''; let size = 0;
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 16 * 1024 * 1024) { json(413, { error: 'request too large' }); return true; }
      body += chunk.toString();
    }
    const input: unknown = JSON.parse(body);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid input');
    const result = await deliver({ ...input, type: req.url === '/conversations/start' ? 'start' : (input as Record<string, unknown>).type === 'choice' ? 'choice' : 'reply' });
    json(result.delivered ? 200 : 422, result);
  } catch { json(400, { error: 'invalid conversation request' }); }
  return true;
}
