import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { messageText, snowflakeAt } from '../server/discord.js';
import { t3AttachmentFile } from '../server/desk/attachments.js';
import { itemDetail, latestReply } from '../server/desk/view.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';
import { AGENT, cid, makeHarness, msg, NOW, type Harness } from './desk-harness.js';

// Images on desk replies (out) and on messages (in): Loom and Discord.

let h: Harness;
const HOME = AGENT.homeChannelId;
const thread = (id: string, name = 'Speaker') => ({ id, name, parent_id: HOME, last_message_id: snowflakeAt(NOW + 365 * 86_400_000) });
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const png = (name = 'shot.png', dataUrl = PNG) => ({ name, mimeType: 'image/png', dataUrl });
/** A data URL that decodes to about `mb` megabytes. */
const bigPng = (mb: number) => `data:image/png;base64,${'A'.repeat(Math.ceil((mb * 1024 * 1024 * 4) / 3))}`;
const iso = (minute: number) => new Date(NOW + minute * 60_000).toISOString();

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.close());

describe('a Discord reply with images', () => {
  beforeEach(async () => {
    h.discord.threads = [thread('7001')];
    h.discord.channels.set('7001', [msg(-10, 'owner', 'Find a speaker'), msg(-5, 'agent', 'Pioneer or Sony?')]);
    await h.source.poll();
  });

  it('sends the images to the bot with the words, and a pictures-only reply too', async () => {
    const withWords = await h.core.command({ commandId: 'r-1', type: 'reply', itemId: 'discord:thread:7001', args: { text: 'This one', attachments: [png()] } });
    expect(withWords.status).toBe('applied');
    expect(h.posted[0]).toMatchObject({ type: 'reply', data: { text: 'This one', attachments: [png()] } });
    const only = await h.core.command({ commandId: 'r-2', type: 'reply', itemId: 'discord:thread:7001', args: { text: '', attachments: [png('a.png'), png('b.png')] } });
    expect(only.status).toBe('applied');
    expect(h.posted[1]).toMatchObject({ data: { text: '', attachments: [png('a.png'), png('b.png')] } });
    // Where the owner's last words are shown, a pictures-only reply reads as what it was.
    expect(h.core.item('discord:thread:7001')!.facts.lastOwnerRequest).toMatchObject({ text: '(2 images)', images: 2, words: false });
    // The agent's newest words are kept for the List until a summary covers them.
    expect(h.core.item('discord:thread:7001')!.facts.lastAgentWords).toMatchObject({ text: 'Pioneer or Sony?' });
  });

  it('refuses what the bot could not post, and sends nothing', async () => {
    const svg = await h.core.command({ commandId: cid(), type: 'reply', itemId: 'discord:thread:7001', args: { text: 'x', attachments: [{ name: 'a.svg', mimeType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }] } });
    expect(svg).toMatchObject({ status: 'failed', error: expect.stringMatching(/PNG, JPEG, GIF or WebP/) });
    const heavy = await h.core.command({ commandId: cid(), type: 'reply', itemId: 'discord:thread:7001', args: { text: 'x', attachments: [png('a.png', bigPng(5)), png('b.png', bigPng(5))] } });
    expect(heavy).toMatchObject({ status: 'failed', error: expect.stringMatching(/Discord takes about 9 MB/) });
    const nothing = await h.core.command({ commandId: cid(), type: 'reply', itemId: 'discord:thread:7001', args: { text: '  ', attachments: [] } });
    expect(nothing).toMatchObject({ status: 'failed', error: 'text is required' });
    expect(h.posted).toEqual([]);
  });

  it('a canned reply carries no images, and a failed pictures-only request is not re-sent as words', async () => {
    await h.core.command({ commandId: cid(), type: 'reply', itemId: 'discord:thread:7001', args: { text: '', attachments: [png()] } });
    h.core.setFacts('discord:thread:7001', { failed: { at: NOW, reason: 'error', message: 'boom' } });
    h.core.refresh('discord:thread:7001');
    const retry = await h.core.command({ commandId: cid(), type: 'retry', itemId: 'discord:thread:7001' });
    expect(retry).toMatchObject({ status: 'failed', error: expect.stringMatching(/only images/) });
  });
});

describe('images on Discord messages', () => {
  const image = (filename: string, content_type?: string) => ({ id: filename, filename, url: `https://cdn.example/${filename}`, ...(content_type ? { content_type } : {}) });

  it('are kept on the message (served by the desk), not as [filename] in the words; other files stay in the words', async () => {
    h.discord.threads = [thread('7001')];
    const withImage = msg(-6, 'agent', 'Here is the chart', { channel_id: '7001', attachments: [image('chart.png', 'image/png'), image('notes.pdf', 'application/pdf')] });
    const onlyImage = msg(-5, 'agent', '', { channel_id: '7001', attachments: [image('photo.jpg')] });
    h.discord.channels.set('7001', [msg(-10, 'owner', 'Show me'), withImage, onlyImage]);
    await h.source.poll();
    const messages = h.core.store.messages('discord:thread:7001');
    expect(messages[1]).toMatchObject({ text: 'Here is the chart\n[notes.pdf]', attachments: [{ name: 'chart.png', mimeType: 'image/png', url: `api/desk/attachments/discord/7001/${withImage.id}/0` }] });
    // A message that is only a picture is still the agent speaking.
    expect(messages[2]).toMatchObject({ text: '', attachments: [{ name: 'photo.jpg', url: `api/desk/attachments/discord/7001/${onlyImage.id}/0` }] });
    expect(latestReply(messages)).toMatchObject({ text: 'Here is the chart\n[notes.pdf]', attachments: [{ name: 'chart.png' }, { name: 'photo.jpg' }] });
    // The legacy inbox still sees every file by name.
    expect(messageText(withImage)).toBe('Here is the chart\n[chart.png]\n[notes.pdf]');
  });

  it('the route fetches a fresh link for the image and passes the bytes on', async () => {
    h.discord.threads = [thread('7001')];
    const withImage = msg(-6, 'agent', 'Chart', { channel_id: '7001', attachments: [image('chart.png', 'image/png')] });
    h.discord.channels.set('7001', [withImage]);
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    const app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => [], attachments: { discord: h.discord } }, compat: { core: h.core, hub, rules: null, pollSources: async () => ({}) } } });
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (url: string) => (fetched.push(String(url)), new Response(new Uint8Array([1, 2, 3])))) as typeof fetch;
    try {
      const response = await app.request(`/api/desk/attachments/discord/7001/${withImage.id}/0`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
      expect(fetched).toEqual(['https://cdn.example/chart.png']);
      expect((await app.request(`/api/desk/attachments/discord/7001/${withImage.id}/5`)).status).toBe(404);
      expect((await app.request(`/api/desk/attachments/discord/..%2F/${withImage.id}/0`)).status).toBe(404);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('the route still serves a retained T3 message image by id and nothing else', async () => {
    const dir = path.join(h.dir, 't3-attachments');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a-1111.png'), Buffer.from([9, 8, 7]));
    fs.writeFileSync(path.join(h.dir, 'secret.png'), 'no');
    expect(t3AttachmentFile(dir, 'a-1111')).toEqual({ file: path.join(dir, 'a-1111.png'), mimeType: 'image/png' });
    expect(t3AttachmentFile(dir, '../secret')).toBeNull();
    const scenes = new SceneStore(path.join(h.dir, 'scenes'));
    const hub = new Hub(scenes, async () => 'agent');
    const app = createApp({ store: scenes, hub, publicDir: h.dir, desk: { routes: { core: h.core, scenes: () => [], attachments: { t3Dir: dir } }, compat: { core: h.core, hub, rules: null, pollSources: async () => ({}) } } });
    const response = await app.request('/api/desk/attachments/t3/a-1111');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([9, 8, 7]);
    expect((await app.request('/api/desk/attachments/t3/a-9999')).status).toBe(404);
    expect((await app.request('/api/desk/attachments/t3/..%2Fsecret')).status).toBe(404);
  });
});
