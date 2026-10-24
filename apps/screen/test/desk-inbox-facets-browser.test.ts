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
describe('Inbox filtering in the fixture desk', () => {
  async function setup(page: Page) {
    await page.evaluate(async () => {
      const { store } = (window as any).__desk;
      await store.saveListViews([{ id: 'all', name: 'All', status: ['active'], group: 'none', sort: 'recent', fold: false }]);
      store.nextGo({ page: 'inbox', view: 'all' });
      store.nextSetFilter({});
    });
  }
  it('keeps Source and Account out of the menu and folded in both editors', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await setup(page);
      await page.getByRole('button', { name: 'Filter', exact: true }).click();
      for (const facet of ['Where', 'Unread', 'Pinned', 'Working now', 'Overdue', 'Waiting on', 'Last active', 'Edit tabs…']) expect(await page.getByRole('menuitem', { name: facet, exact: true }).count()).toBe(1);
      // Where took Project, Agent, Space and Repo; Kind, Source and Account live in the tab editor.
      for (const facet of ['Project', 'Agent', 'Space', 'Repo', 'Busy', 'Kind', 'Advanced', 'Source', 'Account']) expect(await page.getByRole('menuitem', { name: facet, exact: true }).count()).toBe(0);
      await page.keyboard.press('Escape');
      for (const settings of ['tabs', 'spaceviews']) {
        await page.evaluate((settings) => {
          const store = (window as any).__desk.store;
          store.openSettings(settings, { tab: settings === 'tabs' ? 'all' : 'jobs' });
        }, settings);
        const advanced = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Advanced' }) });
        expect(await advanced.getAttribute('open')).toBeNull();
        expect(await page.getByRole('group', { name: 'Source', exact: true }).isVisible()).toBe(false);
        await advanced.locator('summary').click();
        expect(await page.getByRole('group', { name: 'Source', exact: true }).isVisible()).toBe(true);
        expect(await page.getByRole('group', { name: 'Account', exact: true }).isVisible()).toBe(true);
        await advanced.locator('summary').click();
      }
    } finally { await page.close(); }
  }, 60_000);
  it('offers new facets, chips, a name-only save and exact membership under the new name', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await setup(page);
      await page.getByRole('button', { name: 'Filter', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Where', exact: true }).click();
      const choice = page.locator('.nx-fly [role=menuitem]').first();
      await choice.click();
      await page.keyboard.press('Escape');
      expect(await page.getByLabel('Filters on this device').count()).toBe(1);
      const expected = await page.evaluate(`(async () => {
        const { nextListReport } = await import('/desk/next/model.js');
        return nextListReport(window.__desk.store.state).rows.map((r) => r.id);
      })()`);
      await page.getByRole('button', { name: /^Filter/ }).click();
      await page.getByRole('menuitem', { name: 'Save as tab…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Save as tab', exact: true });
      expect(await dialog.getByRole('textbox').count()).toBe(1);
      await dialog.getByRole('textbox').fill('My filtered tab');
      await dialog.getByRole('button', { name: 'Save tab', exact: true }).click();
      await page.waitForFunction(() => (window as any).__desk.store.state.listViews?.at(-1)?.name === 'My filtered tab' && Object.keys((window as any).__desk.store.state.nextFilter).length === 0);
      const after = await page.evaluate(`(async () => {
        const { nextListReport } = await import('/desk/next/model.js');
        const report = nextListReport(window.__desk.store.state);
        return { ids: report.rows.map((r) => r.id), name: report.tabs.find((t) => t.id === window.__desk.store.state.nextRoute.view)?.name };
      })()`);
      expect(after).toEqual({ ids: expected, name: 'My filtered tab' });
      await page.evaluate(() => (window as any).__desk.store.nextSetFilter({ pinned: ['true'] }));
      await page.getByRole('button', { name: 'Remove Pinned', exact: true }).click();
      expect(await page.getByLabel('Filters on this device').count()).toBe(0);
    } finally { await page.close(); }
  }, 60_000);
  it('edits an Inbox tab in the Filter menu\'s words: Show only, Waiting on with No wait, Exclude instead, Advanced', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await setup(page);
      const where = () => page.evaluate(() => (window as any).__desk.store.state.listViews.find((v: { id: string }) => v.id === 'all').where || {});
      const until = (test: string) => page.waitForFunction(new Function(`const w = window.__desk.store.state.listViews.find((v) => v.id === 'all').where || {}; return ${test};`) as () => boolean);
      await page.evaluate(() => (window as any).__desk.store.openSettings('tabs', { tab: 'all' }));
      const showOnly = page.getByRole('group', { name: 'Show only', exact: true });
      for (const [name, test] of [['Unread', "w.unread?.in?.[0] === 'true'"], ['Pinned', "w.pinned?.in?.[0] === 'true'"], ['Working now', "w.busy?.in?.[0] === 'working'"]]) {
        await showOnly.getByRole('button', { name, exact: true }).click();
        await until(test);
      }
      // Unset is a value: No wait.
      const wait = page.getByRole('group', { name: 'Waiting on', exact: true });
      await wait.getByRole('checkbox', { name: 'No wait', exact: true }).click();
      await until('w.wait?.unset === true');
      await wait.getByRole('checkbox', { name: 'Person', exact: true }).click();
      await until("w.wait?.in?.includes('person')");
      // One switch turns "any of these" into "none of these".
      await page.locator('.stg-facet', { has: wait }).getByRole('checkbox', { name: 'Exclude instead' }).click();
      await until("w.wait?.not?.includes('person') && w.wait?.unset === false && !w.wait?.in");
      // Kind sits under Advanced, with the Inbox's two kinds only.
      await page.getByText('Advanced', { exact: true }).click();
      const kinds = page.getByRole('group', { name: 'Kind', exact: true });
      expect(await kinds.getByRole('checkbox', { name: 'Job', exact: true }).count()).toBe(0);
      await kinds.getByRole('checkbox', { name: 'Default', exact: true }).click();
      await until("w.kind?.in?.includes('default')");
      expect(await where()).toMatchObject({ unread: { in: ['true'] }, pinned: { in: ['true'] }, busy: { in: ['working'] }, wait: { not: ['person'], unset: false }, kind: { in: ['default'] } });
      // The old duplicate controls are gone.
      for (const name of ['Workspace / repo', 'Repo', 'Space', 'Project', 'Agent', 'Busy']) expect(await page.getByRole('group', { name, exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  }, 60_000);
  it('keeps an older tab\'s Project and Busy filters editable, and removes one in a tap', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await setup(page);
      await page.evaluate(async () => {
        const { store } = (window as any).__desk;
        await store.saveListViews([{ id: 'all', name: 'All', status: ['active'], group: 'workspace', sort: 'recent', fold: false, where: { busy: { in: ['background'] }, repo: { in: ['tango'] } } }]);
        store.openSettings('tabs', { tab: 'all' });
      });
      await page.getByRole('group', { name: 'Busy', exact: true }).waitFor();
      expect(await page.getByRole('group', { name: 'Show only', exact: true }).getByRole('button', { name: 'Working now', exact: true }).count()).toBe(0);
      await page.locator('.stg-facet', { has: page.getByRole('group', { name: 'Repo', exact: true }) }).getByRole('button', { name: 'Remove' }).click();
      await page.waitForFunction(() => !(window as any).__desk.store.state.listViews.find((v: { id: string }) => v.id === 'all').where.repo);
      // Grouped by Workspace still shows that choice, so it reads true until it's changed.
      expect(await page.getByRole('group', { name: 'Group by', exact: true }).getByRole('button', { name: 'Workspace' }).count()).toBe(1);
      expect(await page.getByRole('group', { name: 'Sort', exact: true }).getByRole('button').allTextContents()).toEqual(['Requests first', 'Newest first', 'Oldest first', 'Wakes soonest']);
    } finally { await page.close(); }
  }, 60_000);
  it('disables saving with a reason at twenty tabs', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await setup(page);
      await page.evaluate(async () => {
        const { store } = (window as any).__desk;
        await store.saveListViews(Array.from({ length: 20 }, (_, i) => ({ id: i ? `tab-${i}` : 'all', name: `Tab ${i}`, group: 'none', sort: 'recent', fold: false })));
      });
      await page.getByRole('button', { name: 'Filter', exact: true }).click();
      const save = page.getByRole('menuitem', { name: /Save as tab/ });
      expect(await save.isDisabled()).toBe(true);
      expect(await save.textContent()).toContain('20-tab limit reached');
    } finally { await page.close(); }
  }, 60_000);
});
