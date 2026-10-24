import { createHash } from 'node:crypto';

// Linear pages can't load inside a scene: linear.app forbids framing
// (frame-ancestors 'self') and needs a signed-in session. Instead the server
// reads the issue, project, or document through the Linear API with the owner's
// keys each time the frame loads, and frame.ts lays it out in the screen's own
// design. Uploaded images in the markdown need the key too, so the frame loads
// them through /linear/upload/:sceneId/:token, only while that scene is live.

export type LinearKind = 'issue' | 'project' | 'document';

/** A Linear item a url scene points at. */
export interface LinearRef {
  /** The workspace's URL key (`linear.app/<workspace>/…`). */
  workspace: string;
  kind: LinearKind;
  /** An issue identifier (TGO-123), or a project's or document's slug id. */
  id: string;
}

/** The app label a card or bar shows. */
export const LINEAR_APP = 'Linear';

export function parseLinearUrl(body: string): LinearRef | undefined {
  let url: URL;
  try {
    url = new URL(body.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'linear.app') return undefined;
  const [workspace, type, slug] = url.pathname.split('/').filter(Boolean);
  if (!workspace || !slug || !/^[\w-]+$/.test(workspace)) return undefined;
  if (type === 'issue') return /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(slug) ? { workspace, kind: 'issue', id: slug.toUpperCase() } : undefined;
  if (type !== 'project' && type !== 'document') return undefined;
  // `<title-slug>-<slugId>`, or the bare slug id.
  const id = /(?:^|-)([0-9a-f]{8,})$/i.exec(slug)?.[1];
  return id ? { workspace, kind: type, id: id.toLowerCase() } : undefined;
}

export interface LinearState {
  name: string;
  /** backlog | unstarted | started | completed | canceled | triage */
  type: string;
  color: string;
}

export interface LinearIssueRow {
  identifier: string;
  title: string;
  url: string;
  priority?: number;
  state?: LinearState;
  assignee?: string;
  milestone?: string;
}

export interface LinearComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface LinearIssue {
  kind: 'issue';
  identifier: string;
  title: string;
  url: string;
  updatedAt: string;
  description: string;
  state?: LinearState;
  priority: number;
  priorityLabel: string;
  assignee?: string;
  labels: Array<{ name: string; color: string }>;
  project?: { name: string; url: string };
  milestone?: string;
  cycle?: string;
  dueDate?: string;
  parent?: LinearIssueRow;
  children: LinearIssueRow[];
  /** Oldest first; the most recent MAX_COMMENTS. */
  comments: LinearComment[];
  /** Linked PRs, docs and the like. */
  links: Array<{ title: string; subtitle?: string; url: string }>;
}

export interface LinearProject {
  kind: 'project';
  name: string;
  url: string;
  updatedAt: string;
  summary: string;
  content: string;
  color?: string;
  status?: { name: string; type: string; color: string };
  /** 0–1 */
  progress: number;
  health?: string;
  lead?: string;
  startDate?: string;
  targetDate?: string;
  latestUpdate?: { body: string; health?: string; createdAt: string; author: string };
  milestones: Array<{ name: string; progress: number; targetDate?: string }>;
  issues: LinearIssueRow[];
  /** More issues than were read. */
  moreIssues: boolean;
  documents: Array<{ title: string; url: string }>;
}

export interface LinearDocument {
  kind: 'document';
  title: string;
  url: string;
  updatedAt: string;
  content: string;
  author?: string;
  project?: { name: string; url: string };
}

export type LinearSnapshot = (LinearIssue | LinearProject | LinearDocument) & {
  /** Display name, for staging results and titles. */
  name: string;
};

export class LinearUnavailable extends Error {}

export type Fetcher = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
}>;

export interface LinearContentOptions {
  /** API keys to try; each is matched to its workspace by `organization.urlKey`. */
  keys: string[];
  fetch?: Fetcher;
  now?: () => number;
}

const API = 'https://api.linear.app/graphql';
const UPLOAD_HOST = 'uploads.linear.app';
const MAX_ISSUES = 150;
const MAX_COMMENTS = 30;
/** A frame reload within this window reuses the last read. */
const FRESH_MS = 30_000;
const ORG_TTL_MS = 10 * 60 * 1000;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOKENS = 2000;
const TIMEOUT_MS = 20_000;

const STATE = 'name type color';
const ISSUE_ROW = `identifier title url priority state { ${STATE} } assignee { name } projectMilestone { name }`;
const QUERIES: Record<LinearKind, string> = {
  issue: `query($id: String!) { issue(id: $id) {
    identifier title url description priority priorityLabel updatedAt dueDate
    state { ${STATE} } assignee { name } labels { nodes { name color } }
    project { name url } projectMilestone { name } cycle { number name }
    parent { identifier title url state { ${STATE} } }
    children(first: 50) { nodes { identifier title url state { ${STATE} } assignee { name } } }
    comments(first: 100) { nodes { body createdAt user { name } botActor { name } } }
    attachments(first: 20) { nodes { title subtitle url } }
  } }`,
  project: `query($id: String!) { project(id: $id) {
    name url description content color progress startDate targetDate updatedAt health
    status { ${STATE} } lead { name }
    projectUpdates(first: 1) { nodes { body health createdAt user { name } } }
    projectMilestones { nodes { name targetDate progress sortOrder } }
    issues(first: ${MAX_ISSUES}) { nodes { ${ISSUE_ROW} } pageInfo { hasNextPage } }
    documents { nodes { title url } }
  } }`,
  document: `query($id: String!) { document(id: $id) {
    title url content updatedAt creator { name } updatedBy { name } project { name url }
  } }`,
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const defaultFetch: Fetcher = (url, init) => fetch(url, init);

export class LinearContent {
  private readonly fetch: Fetcher;
  private readonly now: () => number;
  private orgs: { byWorkspace: Map<string, string>; at: number } | undefined;
  private readonly snapshots = new Map<string, { snapshot: LinearSnapshot; at: number }>();
  private readonly inFlight = new Map<string, Promise<LinearSnapshot>>();
  /** Upload images the frames reference, by token: the URL and the key that may read it. */
  private readonly uploads = new Map<string, { url: string; key: string; refs: Set<string> }>();

  constructor(private readonly options: LinearContentOptions) {
    this.fetch = options.fetch ?? defaultFetch;
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return this.options.keys.length > 0;
  }

  /** The item's current content, re-read at most every FRESH_MS. */
  render(ref: LinearRef): Promise<LinearSnapshot> {
    const flight = flightKey(ref);
    const cached = this.snapshots.get(flight);
    if (cached && this.now() - cached.at < FRESH_MS) return Promise.resolve(cached.snapshot);
    const running = this.inFlight.get(flight);
    if (running) return running;
    const task = this.load(ref)
      .then((snapshot) => {
        this.snapshots.set(flight, { snapshot, at: this.now() });
        return snapshot;
      })
      .finally(() => this.inFlight.delete(flight));
    this.inFlight.set(flight, task);
    return task;
  }

  /**
   * An upload image that the item `ref` points at referenced, or null for anything else.
   * The caller checks that a live scene still shows `ref`.
   */
  async upload(ref: LinearRef, token: string): Promise<{ data: Uint8Array<ArrayBuffer>; type: string } | null> {
    const entry = /^[0-9a-f]{32}$/.test(token) ? this.uploads.get(token) : undefined;
    if (!entry?.refs.has(flightKey(ref))) return null;
    const res = await this.fetch(entry.url, { headers: { authorization: entry.key }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
    const type = res?.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    // Images only: the frame shows them inline, and nothing else is served from here.
    if (!res?.ok || !/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) return null;
    if (Number(res.headers.get('content-length') ?? 0) > UPLOAD_MAX_BYTES) return null;
    return readCapped(res).then((data) => (data ? { data, type } : null)).catch(() => null);
  }

  private async load(ref: LinearRef): Promise<LinearSnapshot> {
    const key = await this.keyFor(ref.workspace);
    const data = await this.query(key, QUERIES[ref.kind], { id: ref.id });
    const node = data[ref.kind] as Json | null;
    if (!node) throw new LinearUnavailable(`no ${ref.kind} ${ref.id} in ${ref.workspace}`);
    const md = (text: unknown) => this.withUploads(typeof text === 'string' ? text : '', key, flightKey(ref));
    if (ref.kind === 'issue') {
      const comments = ((node.comments?.nodes ?? []) as Json[])
        .map((c) => ({ author: c.user?.name ?? c.botActor?.name ?? 'Someone', createdAt: String(c.createdAt ?? ''), body: md(c.body) }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-MAX_COMMENTS);
      return {
        kind: 'issue',
        name: `${node.identifier} ${node.title}`,
        identifier: node.identifier,
        title: node.title,
        url: node.url,
        updatedAt: node.updatedAt,
        description: md(node.description),
        state: state(node.state),
        priority: Number(node.priority ?? 0),
        priorityLabel: String(node.priorityLabel ?? ''),
        assignee: node.assignee?.name,
        labels: ((node.labels?.nodes ?? []) as Json[]).map((l) => ({ name: String(l.name), color: String(l.color ?? '') })),
        project: node.project ? { name: node.project.name, url: node.project.url } : undefined,
        milestone: node.projectMilestone?.name,
        cycle: node.cycle ? node.cycle.name || `Cycle ${node.cycle.number}` : undefined,
        dueDate: node.dueDate ?? undefined,
        parent: node.parent ? issueRow(node.parent) : undefined,
        children: ((node.children?.nodes ?? []) as Json[]).map(issueRow),
        comments,
        links: ((node.attachments?.nodes ?? []) as Json[]).map((a) => ({ title: String(a.title ?? a.url), subtitle: a.subtitle ?? undefined, url: String(a.url) })),
      };
    }
    if (ref.kind === 'project') {
      const update = (node.projectUpdates?.nodes ?? [])[0] as Json | undefined;
      return {
        kind: 'project',
        name: node.name,
        url: node.url,
        updatedAt: node.updatedAt,
        summary: String(node.description ?? ''),
        content: md(node.content),
        color: node.color ?? undefined,
        status: node.status ? state(node.status) : undefined,
        progress: Number(node.progress ?? 0),
        health: node.health ?? undefined,
        lead: node.lead?.name,
        startDate: node.startDate ?? undefined,
        targetDate: node.targetDate ?? undefined,
        latestUpdate: update
          ? { body: md(update.body), health: update.health ?? undefined, createdAt: String(update.createdAt ?? ''), author: update.user?.name ?? 'Someone' }
          : undefined,
        milestones: ((node.projectMilestones?.nodes ?? []) as Json[])
          .sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0))
          .map((m) => ({ name: String(m.name), progress: Number(m.progress ?? 0), targetDate: m.targetDate ?? undefined })),
        issues: ((node.issues?.nodes ?? []) as Json[]).map(issueRow),
        moreIssues: node.issues?.pageInfo?.hasNextPage === true,
        documents: ((node.documents?.nodes ?? []) as Json[]).map((d) => ({ title: String(d.title), url: String(d.url) })),
      };
    }
    return {
      kind: 'document',
      name: node.title,
      title: node.title,
      url: node.url,
      updatedAt: node.updatedAt,
      content: md(node.content),
      author: node.updatedBy?.name ?? node.creator?.name,
      project: node.project ? { name: node.project.name, url: node.project.url } : undefined,
    };
  }

  /** Points upload images at the frame's proxy, so they load without a Linear sign-in. */
  private withUploads(markdown: string, key: string, ref: string): string {
    return markdown.replace(/(!\[[^\]]*\]\()\s*<?(https:\/\/[^\s)>]+)>?/g, (whole, lead: string, src: string) => {
      let url: URL;
      try {
        url = new URL(src);
      } catch {
        return whole;
      }
      if (url.hostname !== UPLOAD_HOST) return whole;
      const token = createHash('sha256').update(`${key}\n${url.href}`).digest('hex').slice(0, 32);
      if (!this.uploads.has(token) && this.uploads.size >= MAX_UPLOAD_TOKENS) this.uploads.delete(this.uploads.keys().next().value!);
      const entry = this.uploads.get(token) ?? { url: url.href, key, refs: new Set<string>() };
      entry.refs.add(ref);
      this.uploads.set(token, entry);
      return `${lead}../linear/upload/${token}`;
    });
  }

  /** The key whose organization is this workspace. Errors never include a key. */
  private async keyFor(workspace: string): Promise<string> {
    if (this.options.keys.length === 0) throw new LinearUnavailable('no Linear API key is configured');
    const want = workspace.toLowerCase();
    let found = (await this.workspaces()).get(want);
    if (!found) found = (await this.workspaces(true)).get(want);
    if (!found) throw new LinearUnavailable(`none of the ${this.options.keys.length} Linear API keys belongs to the ${workspace} workspace`);
    return found;
  }

  private async workspaces(refresh = false): Promise<Map<string, string>> {
    if (!refresh && this.orgs && this.now() - this.orgs.at < ORG_TTL_MS) return this.orgs.byWorkspace;
    const byWorkspace = new Map<string, string>();
    for (const key of this.options.keys) {
      try {
        const data = await this.query(key, '{ organization { urlKey } }', {});
        const urlKey = String(data.organization?.urlKey ?? '').toLowerCase();
        if (urlKey && !byWorkspace.has(urlKey)) byWorkspace.set(urlKey, key);
      } catch {
        // revoked or offline; the others may still work
      }
    }
    this.orgs = { byWorkspace, at: this.now() };
    return byWorkspace;
  }

  private async query(key: string, query: string, variables: Record<string, unknown>): Promise<Json> {
    let res: Awaited<ReturnType<Fetcher>>;
    try {
      res = await this.fetch(API, {
        method: 'POST',
        headers: { authorization: key, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new LinearUnavailable((err as Error).name === 'TimeoutError' ? 'Linear timed out' : "couldn't reach Linear");
    }
    const out = (await res.json().catch(() => ({}))) as { data?: Json; errors?: Array<{ message?: string; extensions?: { userPresentableMessage?: string } }> };
    if (out.errors?.length) {
      const first = out.errors[0]!;
      throw new LinearUnavailable(first.extensions?.userPresentableMessage ?? first.message ?? 'Linear returned an error');
    }
    if (!res.ok || !out.data) throw new LinearUnavailable(`Linear answered ${res.status}`);
    return out.data;
  }
}

function flightKey(ref: LinearRef): string {
  return `${ref.workspace}/${ref.kind}/${ref.id}`;
}

/** The body, or null once it passes UPLOAD_MAX_BYTES (stops reading there). */
async function readCapped(res: Awaited<ReturnType<Fetcher>>): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const data = new Uint8Array(await res.arrayBuffer());
    return data.byteLength > UPLOAD_MAX_BYTES ? null : data;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > UPLOAD_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function state(raw: Json | null | undefined): LinearState | undefined {
  return raw ? { name: String(raw.name ?? ''), type: String(raw.type ?? ''), color: String(raw.color ?? '') } : undefined;
}

function issueRow(raw: Json): LinearIssueRow {
  return {
    identifier: String(raw.identifier),
    title: String(raw.title ?? ''),
    url: String(raw.url ?? ''),
    priority: raw.priority ?? undefined,
    state: state(raw.state),
    assignee: raw.assignee?.name,
    milestone: raw.projectMilestone?.name,
  };
}

/** Every LINEAR_API_KEY and LINEAR_API_KEY_<NAME> in the environment, deduplicated. */
export function linearKeysFromEnv(env: NodeJS.ProcessEnv): string[] {
  const keys = Object.entries(env)
    .filter(([name, value]) => /^LINEAR_API_KEY(_\w+)?$/.test(name) && value?.trim())
    .sort(([a], [b]) => (a === 'LINEAR_API_KEY' ? -1 : b === 'LINEAR_API_KEY' ? 1 : a.localeCompare(b)))
    .map(([, value]) => value!.trim());
  return [...new Set(keys)];
}
