import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { Hub, type Sink } from '../server/hub.js';
import { LinearContent, linearKeysFromEnv, parseLinearUrl, type Fetcher } from '../server/linear.js';
import { SceneStore } from '../server/store.js';

// A fake Linear API: synthetic workspaces and items only (the repo is public).
const HOME_KEY = 'lin_api_home_secret';
const WORK_KEY = 'lin_api_work_secret';
const ORGS: Record<string, string> = { [HOME_KEY]: 'acme-home', [WORK_KEY]: 'acme-work' };
const UPLOAD = 'https://uploads.linear.app/aaaa-bbbb/cccc-dddd';

const state = (name: string, type: string, color = '#5e6ad2') => ({ name, type, color });
let issueTitle: string;
let calls: Array<{ url: string; key: string; query?: string }>;
let linearDown: boolean;

const issue = () => ({
  identifier: 'ACM-12',
  title: issueTitle,
  url: 'https://linear.app/acme-home/issue/ACM-12/fix-the-gate',
  description: `Gate sticks <b>open</b>.\n\n![photo](${UPLOAD})\n\n![outside](https://example.com/x.png)`,
  priority: 2,
  priorityLabel: 'High',
  updatedAt: '2026-10-08T18:00:00.000Z',
  dueDate: '2026-10-20',
  state: state('In Progress', 'started', '#f2c94c'),
  assignee: { name: 'Robin' },
  labels: { nodes: [{ name: 'Bug', color: 'red;background:url(x)' }] },
  project: { name: 'Yard', url: 'https://linear.app/acme-home/project/yard-0a1b2c3d4e5f' },
  projectMilestone: { name: 'Fence' },
  cycle: null,
  parent: null,
  children: { nodes: [{ identifier: 'ACM-13', title: 'Order a hinge', url: 'https://linear.app/acme-home/issue/ACM-13', state: state('Todo', 'unstarted'), assignee: null }] },
  comments: {
    nodes: [
      { body: 'Second', createdAt: '2026-10-08T17:00:00.000Z', user: null, botActor: { name: 'Bot' } },
      { body: 'First', createdAt: '2026-10-08T16:00:00.000Z', user: { name: 'Riley' }, botActor: null },
    ],
  },
  attachments: { nodes: [{ title: 'PR #9', subtitle: 'merged', url: 'https://github.com/example/repo/pull/9' }] },
});

const project = () => ({
  name: 'Yard',
  url: 'https://linear.app/acme-home/project/yard-0a1b2c3d4e5f',
  description: 'Make the yard usable',
  content: '## Goals\n\n+++ Details\nHidden part\n+++',
  color: '#f2994a',
  progress: 0.5,
  startDate: '2026-10-01',
  targetDate: null,
  updatedAt: '2026-10-08T18:00:00.000Z',
  health: 'atRisk',
  status: state('In Progress', 'started'),
  lead: { name: 'Robin' },
  projectUpdates: { nodes: [{ body: 'Fence is late', health: 'atRisk', createdAt: '2026-10-08T12:00:00.000Z', user: { name: 'Robin' } }] },
  projectMilestones: { nodes: [{ name: 'Lawn', progress: 100, sortOrder: 2, targetDate: null }, { name: 'Fence', progress: 25, sortOrder: 1, targetDate: '2026-10-30' }] },
  issues: {
    nodes: [
      { identifier: 'ACM-12', title: 'Fix the gate', url: 'https://linear.app/acme-home/issue/ACM-12', priority: 2, state: state('In Progress', 'started'), assignee: { name: 'Robin' } },
      { identifier: 'ACM-10', title: 'Mow', url: 'https://linear.app/acme-home/issue/ACM-10', priority: 0, state: state('Done', 'completed'), assignee: null },
      { identifier: 'ACM-11', title: 'Old idea', url: 'https://linear.app/acme-home/issue/ACM-11', priority: 0, state: state('Canceled', 'canceled'), assignee: null },
    ],
    pageInfo: { hasNextPage: false },
  },
  documents: { nodes: [{ title: 'Fence spec', url: 'https://linear.app/acme-home/document/fence-spec-abcdef123456' }] },
});

const fakeFetch: Fetcher = async (url, init) => {
  const key = init.headers.authorization ?? '';
  const respond = (body: unknown, extra: { status?: number; type?: string; bytes?: Uint8Array } = {}) => ({
    ok: (extra.status ?? 200) < 400,
    status: extra.status ?? 200,
    headers: { get: (name: string) => (name === 'content-type' ? (extra.type ?? 'application/json') : null) },
    json: async () => body,
    arrayBuffer: async () => (extra.bytes ?? new Uint8Array()).buffer as ArrayBuffer,
  });
  if (url !== 'https://api.linear.app/graphql') {
    calls.push({ url, key });
    if (url === UPLOAD && key === HOME_KEY) return respond(null, { type: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) });
    return respond(null, { status: 401, type: 'text/plain' });
  }
  const { query, variables } = JSON.parse(init.body!) as { query: string; variables: { id?: string } };
  calls.push({ url, key, query });
  if (linearDown) throw new Error(`connect ECONNREFUSED with ${key}`);
  if (!ORGS[key]) return respond({ errors: [{ message: 'Authentication required, not authenticated' }] }, { status: 400 });
  if (query.includes('organization')) return respond({ data: { organization: { urlKey: ORGS[key] } } });
  if (ORGS[key] !== 'acme-home') return respond({ data: { issue: null, project: null, document: null } });
  if (query.includes('issue(id')) return respond(variables.id === 'ACM-12' ? { data: { issue: issue() } } : { errors: [{ message: 'Entity not found: Issue' }] });
  if (query.includes('project(id')) return respond({ data: { project: variables.id === '0a1b2c3d4e5f' ? project() : null } });
  if (query.includes('document(id'))
    return respond({
      data: {
        document: {
          title: 'Fence spec',
          url: 'https://linear.app/acme-home/document/fence-spec-abcdef123456',
          content: '# Spec\n\nSix feet, cedar.',
          updatedAt: '2026-10-07T10:00:00.000Z',
          creator: { name: 'Riley' },
          updatedBy: { name: 'Robin' },
          project: { name: 'Yard', url: 'https://linear.app/acme-home/project/yard-0a1b2c3d4e5f' },
        },
      },
    });
  return respond({ errors: [{ message: 'unexpected query' }] });
};

let dir: string;
let now: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-linear-'));
  calls = [];
  linearDown = false;
  issueTitle = 'Fix the gate';
  now = Date.parse('2026-10-09T12:00:00Z');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup(keys = [WORK_KEY, HOME_KEY]) {
  const store = new SceneStore(path.join(dir, 'screen'), Date.now, []);
  const hub = new Hub(store, async () => {});
  const linear = new LinearContent({ keys, fetch: fakeFetch, now: () => now });
  const app = createApp({ store, hub, publicDir: path.join(dir, 'public'), linear });
  const stage = async (body: Record<string, unknown>) =>
    (await (await app.request('/api/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()) as any;
  const frame = async (id: string) => (await app.request(`/frame/${id}`)).text();
  return { app, stage, frame, store, hub };
}

const ISSUE_URL = 'https://linear.app/acme-home/issue/ACM-12/fix-the-gate';
const PROJECT_URL = 'https://linear.app/acme-home/project/yard-0a1b2c3d4e5f/overview';
const DOC_URL = 'https://linear.app/acme-home/document/fence-spec-abcdef123456';

/** The markdown sources the frame hands to marked. */
function markdownSources(html: string): string[] {
  return JSON.parse(/var sources = (\[.*?\]);\n/s.exec(html)![1]!) as string[];
}

describe('Linear items on screens', () => {
  it('parses issue, project, and document links', () => {
    expect(parseLinearUrl(ISSUE_URL)).toEqual({ workspace: 'acme-home', kind: 'issue', id: 'ACM-12' });
    expect(parseLinearUrl('https://linear.app/acme-home/issue/acm-12')).toEqual({ workspace: 'acme-home', kind: 'issue', id: 'ACM-12' });
    expect(parseLinearUrl(PROJECT_URL)).toEqual({ workspace: 'acme-home', kind: 'project', id: '0a1b2c3d4e5f' });
    expect(parseLinearUrl(DOC_URL)).toEqual({ workspace: 'acme-home', kind: 'document', id: 'abcdef123456' });
    expect(parseLinearUrl('https://linear.app/acme-home/view/my-view-123456789abc')).toBeUndefined();
    expect(parseLinearUrl('https://linear.app/acme-home/team/ACM/active')).toBeUndefined();
    expect(parseLinearUrl('http://linear.app/acme-home/issue/ACM-12')).toBeUndefined();
    expect(parseLinearUrl('https://linear.app.evil.example/acme-home/issue/ACM-12')).toBeUndefined();
  });

  it('shows an issue in the screen layout, read with the key for its workspace', async () => {
    const { stage, frame } = setup();
    const staged = await stage({ agentId: 'watson', kind: 'url', body: ISSUE_URL, summary: 'The gate issue', choices: [{ id: 'ok', label: 'Looks good' }] });
    expect(staged.linear).toEqual({ name: 'ACM-12 Fix the gate', kind: 'issue' });
    const html = await frame(staged.sceneId);
    expect(html).toContain('<h1 class="lin-title">Fix the gate</h1>');
    expect(html).toContain('In Progress');
    expect(html).toContain('High');
    expect(html).toContain('Robin');
    expect(html).toContain('Yard</a> › Fence');
    expect(html).toContain('ACM-13');
    expect(html).toContain('PR #9');
    expect(html).toContain('data-choice="ok"');
    // An unsafe label color is dropped, not written into a style attribute.
    expect(html).not.toContain('url(x)');
    const sources = markdownSources(html);
    // Comments oldest first, by the bot when there's no user.
    expect(sources.slice(1)).toEqual(['First', 'Second']);
    expect(html.indexOf('Riley · ')).toBeLessThan(html.indexOf('Bot · '));
    // Upload images go through the proxy; other images stay as they are.
    expect(sources[0]).toContain(`![photo](../linear/upload/${staged.sceneId}/`);
    expect(sources[0]).toMatch(/upload\/[\w-]+\/[0-9a-f]{32}\)/);
    expect(sources[0]).toContain('https://example.com/x.png');
    // The work key was tried for its organization only, never for the item.
    expect(calls.filter((c) => c.key === WORK_KEY).every((c) => c.query?.includes('organization'))).toBe(true);
    expect(html).not.toContain(HOME_KEY);
  });

  it('serves only upload images a live scene referenced, with the key that read it', async () => {
    const { app, stage, frame } = setup();
    const staged = await stage({ agentId: 'watson', kind: 'url', body: ISSUE_URL, summary: 's' });
    const src = /\.\.\/(linear\/upload\/[^)]+)\)/.exec(markdownSources(await frame(staged.sceneId))[0]!)![1]!;
    const token = src.split('/').pop()!;
    const image = await app.request(`/${src}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(calls.at(-1)).toEqual({ url: UPLOAD, key: HOME_KEY });
    expect((await app.request(`/linear/upload/${staged.sceneId}/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await app.request('/linear/upload/..%2F..%2Fetc')).status).toBe(404);
    // Another scene (here, a project) that never referenced the image can't fetch it.
    const other = await stage({ agentId: 'watson', kind: 'url', body: PROJECT_URL, summary: 's', slot: 'b' });
    expect((await app.request(`/linear/upload/${other.sceneId}/${token}`)).status).toBe(404);
    // Once the scene is cleared, its image links stop working.
    await app.request(`/api/scenes/${staged.sceneId}`, { method: 'DELETE' });
    calls = [];
    expect((await app.request(`/${src}`)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('refuses upload images over the size cap without buffering them whole', async () => {
    let pulled = 0;
    const big: Fetcher = async (url, init) => {
      if (url !== UPLOAD) return fakeFetch(url, init);
      const chunk = new Uint8Array(1024 * 1024);
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-type' ? 'image/png' : null) },
        json: async () => null,
        arrayBuffer: async () => { throw new Error('should stream'); },
        body: new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(chunk); } }),
      };
    };
    const store = new SceneStore(path.join(dir, 'screen'), Date.now, []);
    const linear = new LinearContent({ keys: [HOME_KEY], fetch: big, now: () => now });
    const app = createApp({ store, hub: new Hub(store, async () => {}), publicDir: path.join(dir, 'public'), linear });
    const staged = (await (await app.request('/api/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'watson', kind: 'url', body: ISSUE_URL, summary: 's' }) })).json()) as any;
    const src = /\.\.\/(linear\/upload\/[^)]+)\)/.exec(markdownSources(await (await app.request(`/frame/${staged.sceneId}`)).text())[0]!)![1]!;
    expect((await app.request(`/${src}`)).status).toBe(404);
    expect(pulled).toBeLessThan(40);
  });

  it('shows a project with status, progress, its latest update, milestones, and issues by state', async () => {
    const { stage, frame } = setup();
    const staged = await stage({ agentId: 'watson', kind: 'url', body: PROJECT_URL, summary: 's' });
    expect(staged.linear).toEqual({ name: 'Yard', kind: 'project' });
    const html = await frame(staged.sceneId);
    expect(html).toContain('Make the yard usable');
    expect(html).toContain('At risk');
    expect(html).toContain('width:50%');
    // Canceled issues don't count toward the total.
    expect(html).toContain('1 of 2 issues done');
    expect(html.indexOf('Fence')).toBeLessThan(html.indexOf('Lawn'));
    expect(html.indexOf('In progress')).toBeLessThan(html.indexOf('Done'));
    expect(html).toContain('<details class="lin-group"><summary><h3>');
    expect(html).toContain('Fence spec');
    expect(markdownSources(html)).toEqual(['Make the yard usable', 'Fence is late', '## Goals\n\n+++ Details\nHidden part\n+++']);
  });

  it('sanitizes rendered markdown in the page instead of trusting raw HTML', async () => {
    const { stage, frame } = setup();
    const html = await frame((await stage({ agentId: 'watson', kind: 'url', body: DOC_URL, summary: 's' })).sceneId);
    // marked output goes through an inert DOMParser document and an allowlist before it reaches the page.
    expect(html).toContain('new DOMParser().parseFromString');
    expect(html).toContain('clean(parsed)');
    expect(html).not.toMatch(/el\.innerHTML\s*=/);
    expect(html).toContain('/^(https:|\\.\\.\\/linear\\/upload\\/)/i');
  });

  it('shows a document as a reading page', async () => {
    const { stage, frame } = setup();
    const staged = await stage({ agentId: 'watson', kind: 'url', body: DOC_URL, summary: 's' });
    expect(staged.linear).toEqual({ name: 'Fence spec', kind: 'document' });
    const html = await frame(staged.sceneId);
    expect(html).toContain('<main class="lin-doc">');
    expect(html).toContain('updated by Robin');
    expect(markdownSources(html)).toEqual(['# Spec\n\nSix feet, cedar.']);
  });

  it('re-reads after a short while, so edits show on the next load', async () => {
    const { stage, frame } = setup();
    const staged = await stage({ agentId: 'watson', kind: 'url', body: ISSUE_URL, summary: 's' });
    issueTitle = 'Fix the gate today';
    expect(await frame(staged.sceneId)).toContain('>Fix the gate<');
    now += 31_000;
    expect(await frame(staged.sceneId)).toContain('>Fix the gate today<');
  });

  it('falls back to the open-in-Linear card with the reason, and never shows a key', async () => {
    const { stage, frame } = setup();
    const missing = await stage({ agentId: 'watson', kind: 'url', body: 'https://linear.app/acme-home/issue/ACM-99', summary: 's' });
    expect(missing.linear.error).toContain('Entity not found');
    expect(await frame(missing.sceneId)).toContain('Open in Linear');

    const other = await stage({ agentId: 'watson', kind: 'url', body: 'https://linear.app/someone-else/issue/ACM-1', summary: 's', slot: 'b' });
    expect(other.linear.error).toBe('none of the 2 Linear API keys belongs to the someone-else workspace');

    linearDown = true;
    now += 11 * 60 * 1000;
    const down = await stage({ agentId: 'watson', kind: 'url', body: DOC_URL, summary: 's', slot: 'c' });
    expect(JSON.stringify(down)).not.toContain('secret');
  });

  it('shows the card when no key is configured', async () => {
    const { stage, frame } = setup([]);
    const staged = await stage({ agentId: 'watson', kind: 'url', body: ISSUE_URL, summary: 's' });
    expect(staged.linear.error).toBe('no Linear API key is configured');
    expect(await frame(staged.sceneId)).toContain('Open in Linear');
  });

  it('reads Linear items only for agents on this machine', async () => {
    const { app } = setup();
    const response = await app.request('/api/scenes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Tailscale-User-Login': 'someone@example.com' },
      body: JSON.stringify({ agentId: 'watson', kind: 'url', body: ISSUE_URL, summary: 's' }),
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('never reads a scene a local agent did not stage, or one that was cleared', async () => {
    const { app, store, stage, frame } = setup();
    const { scene } = store.stage({ agentId: 'x', kind: 'url', body: ISSUE_URL, summary: 's', choices: [], state: {}, urgent: false, origin: {} } as any);
    expect(await frame(scene.id)).toContain('Open in Linear');
    expect(calls).toEqual([]);

    const staged = await stage({ agentId: 'watson', kind: 'url', body: ISSUE_URL, summary: 's', slot: 'b' });
    await app.request(`/api/scenes/${staged.sceneId}`, { method: 'DELETE' });
    calls = [];
    now += 60_000;
    expect(await frame(staged.sceneId)).toContain('Open in Linear');
    expect(calls).toEqual([]);
  });

  it('scrolls by voice, since the frame is its own page', async () => {
    const { app, stage, hub } = setup();
    const screen: Sink = { send() {} };
    hub.addScreen('', screen);
    const staged = await stage({ agentId: 'watson', kind: 'url', body: ISSUE_URL, summary: 's' });
    hub.show(staged.sceneId, 'director');
    const sent = await app.request('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'scroll_down' }) });
    expect(await sent.json()).toMatchObject({ sent: true });
  });

  it('collects every LINEAR_API_KEY variant from the environment, the plain one first', () => {
    expect(linearKeysFromEnv({ LINEAR_API_KEY_WORK: 'b', LINEAR_API_KEY: 'a', LINEAR_API_KEY_DUP: 'a', LINEAR_TEAM: 'x', LINEAR_API_KEY_EMPTY: ' ' })).toEqual(['a', 'b']);
  });
});
