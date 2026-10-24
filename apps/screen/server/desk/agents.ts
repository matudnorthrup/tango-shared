// The desk's agents for the next layout (docs/specs/agent-desk-next.md): who they are, and each one's
// picture, the same one Discord shows. A picture comes from the agent's config (the profile's
// `avatar_url`, else the repo's `avatar_path` file) and is kept on disk, so a Discord CDN link that
// expires, or a moment offline, still shows the last picture the desk read.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AgentAvatarSource {
  /** An image URL (Discord's CDN, usually). */
  url?: string | null;
  /** An image file on this machine. */
  file?: string | null;
}

export interface DeskAgentInfo {
  id: string;
  name: string;
  avatar?: AgentAvatarSource | null;
}

export interface AgentAvatarsOptions {
  agents: () => DeskAgentInfo[];
  /** Where pictures are kept (`<data>/agent-avatars`). */
  dir: string;
  fetch?: typeof fetch;
  /** How long a fetched picture is used before it's read again (default a day). */
  maxAgeMs?: number;
  now?: () => number;
}

export interface AvatarImage {
  body: Buffer;
  type: string;
}

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_BYTES = 2_000_000;

/** A placeholder in a public config ("https://example.com/…") isn't a picture. */
export function realAvatarUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (!/^https:\/\//.test(value)) return null;
  try {
    const host = new URL(value).hostname;
    return host === 'example.com' || host.endsWith('.example.com') ? null : value;
  } catch {
    return null;
  }
}

/** A response body, stopped at `max` bytes: null past it, so a bad source can't fill memory. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export class AgentAvatars {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<AvatarImage | null>>();

  constructor(private readonly options: AgentAvatarsOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** The agents, each with its picture's URL on the desk (null: no picture configured). */
  list(): Array<{ id: string; name: string; avatar: string | null }> {
    return this.options.agents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      avatar: agent.avatar?.url || agent.avatar?.file ? `api/desk/agents/${encodeURIComponent(agent.id)}/avatar` : null,
    }));
  }

  /** The agent's picture: fresh from disk, else read from its source (and kept), else the last one kept. */
  async image(id: string): Promise<AvatarImage | null> {
    const agent = this.options.agents().find((a) => a.id === id);
    if (!agent?.avatar) return null;
    const { url, file } = agent.avatar;
    const fromFile = () => (file ? this.readFile(file) : null);
    if (!url) return fromFile();
    const cached = this.cached(id, url);
    if (cached && this.now() - cached.at < this.maxAgeMs) return cached.image;
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.download(id, url).finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    // A link that stopped working (Discord's attachment links expire): the last picture kept, else the file.
    return (await pending) ?? cached?.image ?? fromFile();
  }

  private readFile(file: string): AvatarImage | null {
    try {
      return { body: fs.readFileSync(file), type: TYPES[path.extname(file).toLowerCase()] ?? 'image/png' };
    } catch {
      return null;
    }
  }

  private paths(id: string) {
    const safe = id.replace(/[^a-z0-9_-]/gi, '_');
    return { image: path.join(this.options.dir, `${safe}.img`), meta: path.join(this.options.dir, `${safe}.json`) };
  }

  /** The kept picture, when it came from this same URL. */
  private cached(id: string, url: string): { image: AvatarImage; at: number } | null {
    const p = this.paths(id);
    try {
      const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as { url: string; type: string; at: number };
      if (meta.url !== url) return null;
      return { image: { body: fs.readFileSync(p.image), type: meta.type }, at: meta.at };
    } catch {
      return null;
    }
  }

  private async download(id: string, url: string): Promise<AvatarImage | null> {
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!type.startsWith('image/')) return null;
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BYTES) return null;
      const body = await readCapped(res, MAX_BYTES);
      if (!body?.length) return null;
      const p = this.paths(id);
      fs.mkdirSync(this.options.dir, { recursive: true });
      fs.writeFileSync(p.image, body);
      fs.writeFileSync(p.meta, JSON.stringify({ url, type, at: this.now() }));
      return { body, type };
    } catch {
      return null;
    }
  }
}
