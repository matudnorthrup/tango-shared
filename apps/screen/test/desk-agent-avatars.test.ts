import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentAvatars, realAvatarUrl } from '../server/desk/agents.js';

// Agents' pictures for the next layout: read from the config, kept on disk. Invented URLs only.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function setup(over: { fetch?: typeof fetch; now?: () => number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatars-'));
  const calls: string[] = [];
  const ok: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
  };
  const file = path.join(dir, 'papa.png');
  fs.writeFileSync(file, PNG);
  const avatars = new AgentAvatars({
    dir: path.join(dir, 'kept'),
    agents: () => [
      { id: 'sierra', name: 'Sierra', avatar: { url: 'https://cdn.example.org/a/sierra.webp' } },
      { id: 'papa', name: 'Papa', avatar: { file } },
      { id: 'kilo', name: 'Kilo', avatar: null },
      { id: 'foxtrot', name: 'Foxtrot', avatar: { url: 'https://cdn.example.org/attachments/expired.png', file } },
    ],
    fetch: over.fetch ?? ok,
    now: over.now,
  });
  return { avatars, calls };
}

describe('agent avatars', () => {
  it('lists every agent, with a picture URL only when one is configured', () => {
    const { avatars } = setup();
    expect(avatars.list()).toEqual([
      { id: 'sierra', name: 'Sierra', avatar: 'api/desk/agents/sierra/avatar' },
      { id: 'papa', name: 'Papa', avatar: 'api/desk/agents/papa/avatar' },
      { id: 'kilo', name: 'Kilo', avatar: null },
      { id: 'foxtrot', name: 'Foxtrot', avatar: 'api/desk/agents/foxtrot/avatar' },
    ]);
  });

  it('reads a URL once and keeps it; a file is served as is', async () => {
    const { avatars, calls } = setup();
    expect((await avatars.image('sierra'))?.type).toBe('image/png');
    expect((await avatars.image('sierra'))?.body.equals(PNG)).toBe(true);
    expect(calls).toHaveLength(1);
    expect((await avatars.image('papa'))?.body.equals(PNG)).toBe(true);
    expect(await avatars.image('kilo')).toBeNull();
    expect(await avatars.image('nobody')).toBeNull();
  });

  it('shows the last picture when the source fails after it went stale (an expired CDN link)', async () => {
    let now = 1_000;
    let up = true;
    const flaky: typeof fetch = async () => (up ? new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } }) : new Response('gone', { status: 404 }));
    const { avatars } = setup({ fetch: flaky, now: () => now });
    await avatars.image('sierra');
    up = false;
    now += 2 * 24 * 60 * 60_000;
    expect((await avatars.image('sierra'))?.body.equals(PNG)).toBe(true);
  });

  it('falls back to the agent’s file when its link never worked (an expired attachment)', async () => {
    const gone: typeof fetch = async () => new Response('This content is no longer available.', { status: 404 });
    const { avatars } = setup({ fetch: gone });
    expect((await avatars.image('foxtrot'))?.body.equals(PNG)).toBe(true);
    expect(await avatars.image('sierra')).toBeNull();
  });

  it('stops reading a picture past 2 MB', async () => {
    const huge: typeof fetch = async () => new Response(new Uint8Array(2_100_000), { status: 200, headers: { 'Content-Type': 'image/png' } });
    const { avatars } = setup({ fetch: huge });
    expect(await avatars.image('sierra')).toBeNull();
  });

  it('never keeps a non-image', async () => {
    const html: typeof fetch = async () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    const { avatars } = setup({ fetch: html });
    expect(await avatars.image('sierra')).toBeNull();
  });

  it('drops the public repo’s placeholder URLs', () => {
    expect(realAvatarUrl('https://example.com/tango/avatars/juliet.png')).toBeNull();
    expect(realAvatarUrl('http://cdn.discordapp.com/x.png')).toBeNull();
    expect(realAvatarUrl('https://cdn.discordapp.com/avatars/1/abc.webp')).toBe('https://cdn.discordapp.com/avatars/1/abc.webp');
    expect(realAvatarUrl(undefined)).toBeNull();
  });
});
