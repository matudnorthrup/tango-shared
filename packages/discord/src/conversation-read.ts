import type { TangoStorage, ConversationAttachment } from '@tango/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

export function parseConversationKey(key: string): { kind: 'thread' | 'channel' | 'conv'; id: string } | null {
  const match = /^(?:(thread|channel):([0-9]+)|(conv):([0-7][0-9A-HJKMNP-TV-Z]{25}))$/.exec(key);
  return match ? { kind: (match[1] ?? match[3]) as 'thread' | 'channel' | 'conv', id: (match[2] ?? match[4])! } : null;
}
function integer(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid cursor or limit');
  return Number(value);
}

/** Read-only bridge. All queries are public posts, with bounded pages and opaque local cursors. */
export async function conversationRead(req: IncomingMessage, res: ServerResponse, storage: TangoStorage, dataDir: string,
  token = process.env.TANGO_COLLABORATION_BRIDGE_TOKEN?.trim()): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://bot');
  if (url.pathname !== '/conversations' && !url.pathname.startsWith('/conversations/')) return false;
  const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (token && req.headers['x-tango-collaboration-token'] !== token) { json(403, { error: 'forbidden' }); return true; }
  if (req.method !== 'GET') { json(405, { error: 'read only' }); return true; }
  const db = storage.getDatabase();
  try {
    if (url.pathname === '/conversations') {
      const after = integer(url.searchParams.get('updatedAfter'), 0);
      // Take the high watermark and rows synchronously, before yielding to another writer.
      const cursor = (db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM conversation_changes').get() as { n: number }).n;
      const conversations = db.prepare(`SELECT c.*, MAX(r.revision) AS revision,
        json_group_array(r.message_id) AS changed_message_ids FROM conversation_changes r
        JOIN conversations c USING(conversation_key) JOIN messages m ON m.id=r.message_id
        WHERE r.revision > ? AND r.revision <= ? AND m.visibility='public'
        GROUP BY c.conversation_key ORDER BY revision`).all(after, cursor);
      json(200, { conversations, cursor }); return true;
    }
    const attachment = /^\/conversations\/attachments\/(\d+)\/(\d+)$/.exec(url.pathname);
    if (attachment) {
      const row = db.prepare("SELECT attachments FROM messages WHERE id=? AND visibility='public' AND conversation_key IS NOT NULL").get(integer(attachment[1]!, 0)) as { attachments: string } | undefined;
      const file = row ? (JSON.parse(row.attachments) as ConversationAttachment[])[integer(attachment[2]!, 0)] : null;
      if (!file?.localPath) { json(404, { error: 'attachment unavailable' }); return true; }
      const root = await fs.realpath(dataDir);
      const target = await fs.realpath(path.resolve(root, file.localPath));
      if (!target.startsWith(root + path.sep)) { json(403, { error: 'invalid attachment path' }); return true; }
      const bytes = await fs.readFile(target);
      res.writeHead(200, { 'Content-Type': file.contentType || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, '_')}"` });
      res.end(bytes); return true;
    }
    const match = /^\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    const key = match ? decodeURIComponent(match[1]!) : '';
    if (!parseConversationKey(key)) { json(400, { error: 'invalid conversation key' }); return true; }
    const after = integer(url.searchParams.get('after'), 0);
    const limit = Math.max(1, Math.min(500, integer(url.searchParams.get('limit'), 100)));
    const messages = db.prepare(`SELECT id,conversation_key,author_kind,content,created_at,discord_message_ids,reply_to_message_id,attachments,
      json_extract(metadata_json,'$.discordMessageType') AS discord_message_type,
      json_extract(metadata_json,'$.inputSource') AS input_source
      FROM messages WHERE conversation_key=? AND visibility='public' AND id>? ORDER BY id LIMIT ?`).all(key, after, limit);
    json(200, { messages });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    json(missing ? 404 : 400, { error: missing ? 'attachment unavailable' : 'invalid conversation request' });
  }
  return true;
}
