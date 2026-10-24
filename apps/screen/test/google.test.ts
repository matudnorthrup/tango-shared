import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { GoogleContent, parseGoogleUrl, redact, type Runner } from '../server/google.js';
import { Hub, type Sink } from '../server/hub.js';
import { SceneStore } from '../server/store.js';

// A fake `gog` + `pdftoppm`: synthetic files only (the repo is public).
const DOC_ID = '1DocDocDocDocDoc';
const DECK_ID = '1DeckDeckDeckDeck';
const SHEET_ID = '1SheetSheetSheet';
const WORK_SHEET_ID = '1WorkSheetWorkSheet';
const files: Record<string, { name: string; mimeType: string; modifiedTime: string; owner: string }> = {
  [DOC_ID]: { name: 'Team plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-07T21:00:00.000Z', owner: 'work@example.com' },
  [DECK_ID]: { name: 'Pitch', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '2026-10-07T20:00:00.000Z', owner: 'home@example.com' },
  [SHEET_ID]: { name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-07T19:00:00.000Z', owner: 'home@example.com' },
  [WORK_SHEET_ID]: { name: 'Costs', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-07T19:00:00.000Z', owner: 'work@example.com' },
};

let dir: string;
let calls: string[][];
let docBody: string;
let rasterizerDown: boolean;
let authExtra: string;
let workScopes: string;

const runner: Runner = async (command, args) => {
  calls.push([command, ...args]);
  const flag = (name: string) => args[args.indexOf(name) + 1]!;
  if (command === 'pdftoppm') {
    if (rasterizerDown) throw new Error('pdftoppm: timed out');
    const prefix = args[args.length - 1]!;
    fs.writeFileSync(`${prefix}-1.png`, 'png1');
    fs.writeFileSync(`${prefix}-2.png`, 'png2');
    return '';
  }
  if (args[0] === 'auth') return `work@example.com\tdefault\t${workScopes}\t2026\toauth\n` + 'mail@example.com\tdefault\tgmail\t2026\toauth\nhome@example.com\tdefault\tdocs,drive,sheets\t2026\toauth\n' + authExtra;
  const file = files[args[2]!];
  if (!file || file.owner !== flag('-a')) throw new Error('Google API error (404 notFound): File not found');
  if (args[0] === 'drive' && args[1] === 'get') return JSON.stringify({ file });
  const out = args.includes('--out') ? flag('--out') : undefined;
  if (out && fs.existsSync(out)) throw new Error(`${out} exists (use --overwrite)`); // like real gog
  if (args[0] === 'docs' && args[1] === 'export') fs.writeFileSync(flag('--out'), docBody);
  if (args[0] === 'drive' && args[1] === 'download') fs.writeFileSync(flag('--out'), flag('--format') === 'csv' ? 'Vendor,Cost,\r\n"Acme, Inc.","$1,200",\r\n,,\r\n' : '%PDF');
  if (args[0] === 'sheets' && args[1] === 'metadata')
    return JSON.stringify({ sheets: [{ properties: { title: "Q4's plan", sheetId: 0 } }, { properties: { title: 'Chart', sheetType: 'OBJECT' } }, { properties: { title: 'Old', hidden: true, sheetId: 7 } }, { properties: { title: 'Notes', sheetId: 42 } }] });
  if (args[0] === 'sheets' && args[1] === 'get') return JSON.stringify({ values: [['Item', 'Cost'], ['Rent <base>', '$2,000.00'], [], ['Total', '$2,000.00', '']] });
  return '';
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-google-'));
  calls = [];
  rasterizerDown = false;
  authExtra = '';
  workScopes = 'calendar,docs,drive';
  docBody = '<html><head><style>.c1{color:red}</style></head><body class="doc-content" style="max-width:468pt"><p class="c1">Ship Friday</p></body></html>';
  files[DOC_ID]!.modifiedTime = '2026-10-07T21:00:00.000Z';
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function setup() {
  const store = new SceneStore(path.join(dir, 'screen'), Date.now, []);
  const hub = new Hub(store, async () => {});
  const google = new GoogleContent({ dir: path.join(dir, 'google'), run: runner });
  const app = createApp({ store, hub, publicDir: path.join(dir, 'public'), google });
  const stage = async (body: Record<string, unknown>) =>
    (await (await app.request('/api/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()) as any;
  return { app, stage, store, hub };
}

describe('Google files on screens', () => {
  it('shows a Doc as its own content, read through the account that can open it', async () => {
    const { app, stage } = setup();
    const staged = await stage({ agentId: 'loom', kind: 'url', body: `https://docs.google.com/document/d/${DOC_ID}/edit`, summary: 'The plan', title: 'Plan', choices: [{ id: 'a', label: 'Approve $5' }] });
    expect(staged.google).toEqual({ name: 'Team plan' });

    const frame = await (await app.request(`/frame/${staged.sceneId}`)).text();
    expect(frame).toContain('<p class="c1">Ship Friday</p>');
    expect(frame).toContain('.c1{color:red}'); // the export's own styles stay
    expect(frame).toContain('window.tango'); // voice scroll still works
    expect(frame).toContain('Open ↗');
    expect(frame).toContain('Approve $5</button></div></body>');
    expect(frame).not.toContain('<iframe');
    // Drive-scoped accounts only, in order; the gmail-only account is never tried.
    expect(calls.some((call) => call.includes('mail@example.com'))).toBe(false);
  });

  it('re-exports only when the file changed', async () => {
    const { app, stage } = setup();
    const staged = await stage({ agentId: 'loom', kind: 'url', body: `https://docs.google.com/document/d/${DOC_ID}/edit`, summary: 's' });
    await app.request(`/frame/${staged.sceneId}`);
    const exports = () => calls.filter((call) => call[1] === 'docs' && call[2] === 'export').length;
    expect(exports()).toBe(1);

    docBody = docBody.replace('Ship Friday', 'Ship Monday');
    files[DOC_ID]!.modifiedTime = '2026-10-07T22:00:00.000Z';
    const frame = await (await app.request(`/frame/${staged.sceneId}`)).text();
    expect(exports()).toBe(2);
    expect(frame).toContain('Ship Monday');
    // The older export stays until the weekly sweep, for frames still showing it.
    expect(fs.readdirSync(path.join(dir, 'google'))).toHaveLength(2);
  });

  it('shows Slides (and Sheets, PDFs) as page images served from the cache', async () => {
    const { app, stage } = setup();
    const staged = await stage({ agentId: 'loom', kind: 'url', body: `https://docs.google.com/presentation/d/${DECK_ID}/edit`, summary: 's' });
    expect(staged.google).toEqual({ name: 'Pitch', pages: 2 });
    expect(calls.find((call) => call[1] === 'drive' && call[2] === 'download')).toContain('pdf');

    const frame = await (await app.request(`/frame/${staged.sceneId}`)).text();
    const src = /<img src="\.\.\/(google\/[^"]+page-1\.png)"/.exec(frame)?.[1];
    expect(src).toBeTruthy();
    const image = await app.request(`/${src}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(await image.text()).toBe('png1');
    expect((await app.request('/google/..%2F..%2Fetc/passwd')).status).toBe(404);
    expect((await app.request(`/google/${src!.split('/')[1]}/file.pdf`)).status).toBe(404);
  });

  it('shows a Sheet as tables of displayed values, every tab when the account has Sheets access', async () => {
    const { app, stage } = setup();
    const staged = await stage({ agentId: 'loom', kind: 'url', body: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`, summary: 's' });
    expect(staged.google).toEqual({ name: 'Budget' });
    expect(calls.find((call) => call[1] === 'sheets' && call[2] === 'get')).toContain("'Q4''s plan'!A1:AN500"); // bounded read
    expect(calls.filter((call) => call[1] === 'sheets' && call[2] === 'get')).toHaveLength(2); // no chart or hidden tabs

    const frame = await (await app.request(`/frame/${staged.sceneId}`)).text();
    expect(frame).toContain('<th>Item</th><th>Cost</th>');
    expect(frame).toContain('<td>Rent &lt;base&gt;</td><td class="n">$2,000.00</td>');
    expect(frame).not.toContain('<img');
  });

  it('reads every tab once the account gains Sheets access, even if the sheet did not change', async () => {
    let now = Date.parse('2026-10-07T12:00:00Z');
    const google = new GoogleContent({ dir: path.join(dir, 'google'), run: runner, now: () => now });
    const sheet = { id: WORK_SHEET_ID, app: 'Google Sheets' };
    expect((await google.render(sheet)).note).toMatch(/First tab only/);
    workScopes = 'calendar,docs,drive,sheets'; // re-authorized with Sheets
    now += 11 * 60_000; // past the account-list refresh
    expect((await google.render(sheet)).note).toBeUndefined();
  });

  it('puts the tab a Sheets link points at (#gid) first', async () => {
    const google = new GoogleContent({ dir: path.join(dir, 'google'), run: runner });
    const ref = parseGoogleUrl(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=42`)!;
    expect(ref.gid).toBe(42);
    expect((await google.render(ref)).tables!.map((tab) => tab.title)).toEqual(['Notes', "Q4's plan"]);
  });

  it('falls back to the first tab through Drive when the account has no Sheets access', async () => {
    const { app, stage } = setup();
    const staged = await stage({ agentId: 'loom', kind: 'url', body: `https://docs.google.com/spreadsheets/d/${WORK_SHEET_ID}/edit`, summary: 's' });
    const frame = await (await app.request(`/frame/${staged.sceneId}`)).text();
    expect(frame).toContain('<td>Acme, Inc.</td><td class="n">$1,200</td>');
    expect(frame).not.toContain('<tr><td></td>'); // trailing blank row dropped
    expect(frame).toContain('First tab only (this Google account has no Sheets access in gog)');
    expect(frame).not.toContain('@example.com'); // account addresses never reach a screen
  });

  it('stops reading once the scene is cleared', async () => {
    const { app, stage, store } = setup();
    const staged = await stage({ agentId: 'loom', kind: 'url', body: `https://docs.google.com/document/d/${DOC_ID}/edit`, summary: 's' });
    store.clear(staged.sceneId);
    const before = calls.length;
    const frame = await (await app.request(`/frame/${staged.sceneId}`)).text();
    expect(frame).toContain('Open in Google Docs');
    expect(calls.length).toBe(before);
  });

  it('exports the Docs tab the link selects', async () => {
    const google = new GoogleContent({ dir: path.join(dir, 'google'), run: runner });
    await google.render(parseGoogleUrl(`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.abc123`)!);
    expect(calls.find((call) => call[1] === 'docs' && call[2] === 'export')).toEqual(expect.arrayContaining(['--tab', 't.abc123']));
    expect(fs.readdirSync(path.join(dir, 'google'))[0]).toMatch(/-tab-t_abc123$/);
  });

  it('scrolls by voice, since the frame is its own page and not a nested site', async () => {
    const { app, stage, hub } = setup();
    const screen: Sink = { send() {} };
    hub.addScreen('', screen);
    const staged = await stage({ agentId: 'loom', kind: 'url', body: `https://docs.google.com/document/d/${DOC_ID}/edit`, summary: 's' });
    hub.show(staged.sceneId, 'director');
    const sent = await app.request('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'scroll_down' }) });
    expect(await sent.json()).toMatchObject({ sent: true });
  });

  it('reads Google files only for agents on this machine', async () => {
    const { app } = setup();
    const response = await app.request('/api/scenes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Tailscale-User-Login': 'someone@example.com' },
      body: JSON.stringify({ agentId: 'loom', kind: 'url', body: `https://docs.google.com/document/d/${DOC_ID}/edit`, summary: 's' }),
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('never reads a Google scene that a local agent did not stage (rows from before the gate)', async () => {
    const { app, store } = setup();
    const { scene } = store.stage({ agentId: 'x', kind: 'url', body: `https://docs.google.com/document/d/${DOC_ID}/edit`, summary: 's', choices: [], state: {}, urgent: false, origin: {} } as any);
    const frame = await (await app.request(`/frame/${scene.id}`)).text();
    expect(frame).toContain('Open in Google Docs');
    expect(calls).toEqual([]);
  });

  it('re-reads the account list when no known account can open a file', async () => {
    const google = new GoogleContent({ dir: path.join(dir, 'google'), run: runner });
    files['1LaterLaterLater'] = { name: 'Later', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-07T21:00:00.000Z', owner: 'new@example.com' };
    await google.render({ id: DOC_ID, app: 'Google Docs' }); // caches the list
    authExtra = 'new@example.com\tdefault\tdocs,drive\t2026\toauth\n'; // signed in afterwards
    expect((await google.render({ id: '1LaterLaterLater', app: 'Google Docs' })).name).toBe('Later');
  });

  it('tries the next account when one can see a file but not download it', async () => {
    files['1SharedViewOnly'] = { name: 'Shared', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-07T21:00:00.000Z', owner: 'home@example.com' };
    const google = new GoogleContent({
      dir: path.join(dir, 'google'),
      run: async (command, args) => {
        // work@ can read the metadata (a viewer) but the export is refused.
        if (args.includes('1SharedViewOnly') && args.includes('work@example.com')) {
          if (args[1] === 'get') return JSON.stringify({ file: files['1SharedViewOnly'] });
          throw new Error('Google API error (403 cannotDownloadFile)');
        }
        return runner(command, args);
      },
    });
    expect((await google.render({ id: '1SharedViewOnly', app: 'Google Docs' })).html).toContain('Ship Friday');
  });

  it('keeps account addresses and local paths out of error text', () => {
    expect(redact('read token for someone@example.com: open /home/someone/.config/gog/token.json: denied')).toBe(
      'read token for <account>: open …/token.json: denied',
    );
  });

  it('retries cleanly after an export failed partway', async () => {
    const google = new GoogleContent({ dir: path.join(dir, 'google'), run: runner });
    const deck = { id: DECK_ID, app: 'Google Slides' };
    rasterizerDown = true;
    await expect(google.render(deck)).rejects.toThrow(/couldn't render its pages \(pdftoppm/);
    // A local failure isn't retried on every other account.
    expect(calls.filter((call) => call[0] === 'pdftoppm')).toHaveLength(1);
    rasterizerDown = false;
    expect((await google.render(deck)).pages).toHaveLength(2);
  });

  it('keeps a long-lived export when another file sweeps day-old ones', async () => {
    let now = Date.parse('2026-10-07T12:00:00Z');
    const google = new GoogleContent({ dir: path.join(dir, 'google'), run: runner, now: () => now });
    const doc = { id: DOC_ID, app: 'Google Docs' };
    await google.render(doc);
    const docDir = fs.readdirSync(path.join(dir, 'google'))[0]!;
    // Real mtimes are "now"; age it, then render again (a frame reload) a day later.
    const old = new Date(now - 8 * 86_400_000);
    fs.utimesSync(path.join(dir, 'google', docDir), old, old);
    now += 7 * 86_400_000;
    await google.render(doc);
    await google.render({ id: DECK_ID, app: 'Google Slides' });
    expect(fs.readdirSync(path.join(dir, 'google'))).toContain(docDir);
  });

  it('falls back to the open-in-Google card with the reason when no account can read it', async () => {
    const { app, stage } = setup();
    const staged = await stage({ agentId: 'loom', kind: 'url', body: 'https://docs.google.com/document/d/1NobodyHasThisOne/edit', summary: 's', title: 'Secret' });
    expect(staged.google.error).toBe('none of the 2 signed-in Google accounts can open it');
    const frame = await (await app.request(`/frame/${staged.sceneId}`)).text();
    expect(frame).toContain('Open in Google Docs');
    expect(frame).toContain("Couldn't load it here");
  });
});
