import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { BundleStore } from '../server/bundles.js';
import { glanceWarnings, SceneChecker } from '../server/check.js';
import { Hub } from '../server/hub.js';
import { SceneStore } from '../server/store.js';

// Real headless Chromium against real frames: the phone-width check.
let dir: string;
let port: number;
let close: () => void;
let checker: SceneChecker;
let app: ReturnType<typeof createApp>;
let bundles: BundleStore;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-test-'));
  const store = new SceneStore(path.join(dir, 'data'));
  checker = new SceneChecker(path.join(dir, 'checks'));
  bundles = new BundleStore(path.join(dir, 'bundles'));
  app = createApp({
    store,
    bundles,
    hub: new Hub(store, async () => 'agent'),
    publicDir: dir,
    check: (sceneId, version) => checker.check(`http://127.0.0.1:${port}/frame/${sceneId}?v=${version}`, `${sceneId}-v${version}`),
  });
  await new Promise<void>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      port = info.port;
      resolve();
    });
    close = () => server.close();
  });
});

afterAll(async () => {
  await checker.close();
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function stage(body: string, kind = 'html') {
  const response = await app.request('/api/scenes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'sierra', kind, summary: 's', slot: String(Math.random()), body }),
  });
  return ((await response.json()) as { check: { ok: boolean; errors: string[]; warnings?: string[]; phoneScreenshot?: string; skipped?: string } }).check;
}

describe('phone check', () => {
  it('errors on a fixed-width layout and names what overflows', async () => {
    const check = await stage('<div class="board" style="width:900px"><h1>Wide board</h1><p>Fixed at 900px.</p></div>');
    if (check.skipped) return; // no browser on this machine
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toMatch(/not phone-friendly: content is \d+px wide on a 390px phone.*<div\.board>/);
    expect(fs.existsSync(check.phoneScreenshot!)).toBe(true);
  }, 60_000);

  it('a wide table scrolls inside itself (safety net): a warning, not an error', async () => {
    const cells = Array.from({ length: 8 }, (_, i) => `<td>Column number ${i} with long text</td>`).join('');
    const check = await stage(`<table><tr>${cells}</tr></table>`);
    if (check.skipped) return;
    expect(check.ok).toBe(true);
    expect(check.warnings?.join(' ')).toMatch(/<table> scrolls sideways/);
  }, 60_000);

  it('passes a fluid grid', async () => {
    const check = await stage('<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,14em),1fr));gap:1em"><div class="card">A</div><div class="card">B</div><div class="card">C</div></div>');
    if (check.skipped) return;
    expect(check).toMatchObject({ ok: true, errors: [] });
    expect(check.warnings).toBeUndefined();
  }, 60_000);
});

const prose = (words: number) => `<p>${Array.from({ length: words }, (_, i) => `word${i}`).join(' ')}</p>`;

describe('glance check', () => {
  it('flags text, height, and hidden variations; passes a glanceable board', () => {
    expect(glanceWarnings({ words: 90, hiddenWords: 0, screens: 1.1, tabs: 0 })).toEqual([]);
    const [words, height, hidden] = glanceWarnings({ words: 969, hiddenWords: 0, screens: 3.5, tabs: 8 });
    expect(words).toMatch(/reads like a document \(969 words/);
    expect(height).toMatch(/3\.5 screens tall/);
    expect(hidden).toMatch(/8 tab\/toggle controls.*side by side/);
    expect(glanceWarnings({ words: 50, hiddenWords: 120, screens: 1, tabs: 0 })[0]).toMatch(/120 words of collapsed or hidden text/);
  });

  it('warns (never errors) on a wall of text with tabbed variations', async () => {
    const tabs = '<div role="tablist"><button role="tab" aria-selected="true">A</button><button role="tab" aria-selected="false">B</button></div>';
    const check = await stage(`<h1>Research</h1>${prose(400)}${tabs}<div hidden>${prose(60)}</div>`);
    if (check.skipped) return;
    expect(check.ok).toBe(true);
    const warnings = check.warnings!.join(' ');
    expect(warnings).toMatch(/reads like a document \(40\d words/);
    expect(warnings).toMatch(/2 tab\/toggle controls/);
  }, 60_000);

  it('checks an uploaded page (a url scene from a bundle) inside its frame', async () => {
    const html = `<!doctype html><html><body><h1>Kickoff</h1>${prose(300)}</body></html>`;
    const saved = bundles.save([{ path: 'index.html', data: Buffer.from(html).toString('base64') }]);
    const check = await stage(`bundles/${saved.id}/index.html`, 'url');
    if (check.skipped) return;
    expect(check.warnings?.join(' ')).toMatch(/reads like a document \(30\d words/);
  }, 60_000);

  it('counts the height of a panel that scrolls inside a 100vh page', async () => {
    const check = await stage('<div style="height:100vh;overflow-y:auto"><div style="height:400vh">Tall panel</div></div>');
    if (check.skipped) return;
    expect(check.warnings?.join(' ')).toMatch(/[45]\.\d screens tall/);
  }, 60_000);

  it('an empty uploaded page is blank, not hidden behind its frame', async () => {
    const saved = bundles.save([{ path: 'index.html', data: Buffer.from('<!doctype html><html><body></body></html>').toString('base64') }]);
    const check = await stage(`bundles/${saved.id}/index.html`, 'url');
    if (check.skipped) return;
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toMatch(/rendered empty/);
  }, 60_000);

  it('phone-checks an uploaded page inside its frame', async () => {
    const html = '<!doctype html><html><body><div class="board" style="width:900px"><h1>Wide</h1></div></body></html>';
    const saved = bundles.save([{ path: 'index.html', data: Buffer.from(html).toString('base64') }]);
    const check = await stage(`bundles/${saved.id}/index.html`, 'url');
    if (check.skipped) return;
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toMatch(/not phone-friendly.*<div\.board>/);
  }, 60_000);
});
