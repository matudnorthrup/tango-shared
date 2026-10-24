import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser: Browser | null;
const base = 'http://desk-fixture.test';
const root = resolve(import.meta.dirname, '../public');
beforeAll(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => null);
}, 60_000);
afterAll(async () => { await browser?.close(); });
async function fixture(): Promise<Page> {
  const page = await browser!.newPage();
  // Browser suites share the machine with the rest of the run: give each step room before it counts as stuck.
  page.setDefaultTimeout(20_000);
  // Fulfill fixture files directly: no server socket or network requests are needed.
  await page.route('**/*', async (route) => {
    if (!route.request().url().startsWith(base + '/')) return route.abort();
    try {
      const path = new URL(route.request().url()).pathname;
      const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
      if (!file.startsWith(root + '/')) return route.abort();
      await route.fulfill({ body: await readFile(file), contentType: ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(file)] || 'application/octet-stream' });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`${base}/?fixtures=1`);
  await page.waitForFunction(() => (window as any).__desk?.store.state.projectsLoaded);
  return page;
}
describe('space views in the fixture desk', () => {
  it('edits, adds, renames and resets through the shared editor', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await page.evaluate(() => (window as any).__desk.store.openSettings('spaceviews'));
      await page.getByRole('button', { name: '+ New view', exact: true }).click();
      await page.getByRole('textbox').last().fill('Needs you here');
      await page.getByRole('textbox').last().press('Enter');
      await page.waitForFunction(() => (window as any).__desk.store.state.spaceViews?.at(-1)?.name === 'Needs you here', undefined, { timeout: 8000 });
      await page.getByRole('group', { name: 'Live state', exact: true }).getByRole('checkbox', { name: 'Needs you', exact: true }).click();
      // Each change re-renders the editor from the saved view: the next click waits for it, as a person's would.
      await page.waitForFunction(() => (window as any).__desk.store.state.spaceViews?.at(-1)?.where?.live?.in?.includes('needs'), undefined, { timeout: 8000 });
      await page.getByRole('group', { name: 'Live state', exact: true }).getByRole('checkbox', { name: 'Failed', exact: true }).click();
      // The editor saves on each change: wait for the last one rather than read mid-save under a loaded run.
      await page.waitForFunction(() => JSON.stringify((window as any).__desk.store.state.spaceViews?.at(-1)?.where?.live?.in) === '["needs","failed"]');
      const saved = await page.evaluate(() => (window as any).__desk.store.state.spaceViews);
      expect(saved.at(-1)).toMatchObject({ name: 'Needs you here', where: { live: { in: ['needs', 'failed'] } } });
      await page.getByRole('button', { name: '‹ Space views', exact: true }).click();
      await page.getByRole('button', { name: 'Restore the built-in views', exact: true }).click();
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.waitForFunction(() => (window as any).__desk.store.state.spaceViews === null, undefined, { timeout: 8000 });
    } finally { await page.close(); }
  }, { timeout: 60_000, retry: 2 });
  it('renders a custom pill on every project and agent page, edits the one shared set, and remembers the pick on reload', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      const projectId = await page.evaluate(async () => {
        const { store } = (window as any).__desk;
        const id = store.state.projects[0].id;
        await store.saveSpaceViews([{ id: 'custom', name: 'Needs you here', where: { live: { in: ['needs', 'failed'] } } }]);
        store.nextGo({ page: 'project', id });
        return id;
      });
      const pill = page.getByRole('tab', { name: 'Needs you here' });
      await pill.click();
      await pill.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Edit view', exact: true }).click();
      // One set for every space (owner, 10/19): the editor opens the shared views, not this project's.
      expect(await page.evaluate(() => (window as any).__desk.store.state.settingsSub)).toEqual({ tab: 'custom' });
      await page.getByRole('textbox').last().fill('Here too');
      await page.getByRole('textbox').last().press('Enter');
      await page.waitForFunction(() => (window as any).__desk.store.state.spaceViews?.[0]?.name === 'Here too', undefined, { timeout: 8000 });
      expect(await page.evaluate((id) => (window as any).__desk.store.state.spaces?.[`project:${id}`]?.views, projectId)).toBeUndefined();
      await page.reload();
      await page.waitForFunction(() => (window as any).__desk?.store.state.projectsLoaded);
      expect(await page.evaluate((id) => (window as any).__desk.store.state.nextPageViews[`project:${id}`], projectId)).toBe('custom');
    } finally { await page.close(); }
  }, { timeout: 60_000, retry: 2 });
});
