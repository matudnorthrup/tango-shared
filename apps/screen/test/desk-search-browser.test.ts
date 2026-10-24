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
describe('search in the fixture desk', () => {
  it('separates Project and Repo and keeps the selected space in search and its breadcrumb', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      // The pickers offer every repo the desk has loaded: wait for the lists, not just the projects.
      await page.waitForFunction(() => (window as any).__desk.store.state.lists?.active?.items?.length > 0 && (window as any).__desk.store.state.lists?.history?.loaded);
      const project = await page.evaluate(() => {
        const { store } = (window as any).__desk;
        const project = store.state.projects[0];
        store.nextGo({ page: 'project', id: project.id });
        store.nextSwitch(true);
        return { id: project.id, name: project.name };
      });
      await page.getByRole('searchbox', { name: 'Go to or search' }).fill('router');
      await page.getByRole('searchbox', { name: 'Go to or search' }).press('Control+Enter');
      await page.getByRole('heading', { name: 'Search', exact: true }).waitFor();
      const projectPicker = page.getByRole('combobox', { name: 'Project', exact: true });
      const repoPicker = page.getByRole('combobox', { name: 'Repo', exact: true });
      await projectPicker.waitFor();
      await repoPicker.waitFor();
      expect(await projectPicker.locator('option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))).toContain(project.id);
      const repoValues = await repoPicker.locator('option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
      expect(repoValues.length).toBeGreaterThan(1);
      const scope = page.getByRole('checkbox', { name: 'In this space', exact: true });
      expect(await scope.isChecked()).toBe(true);
      expect(await page.evaluate(() => (window as any).__desk.store.state.search.scope)).toBe(`space:project:${project.id}`);
      expect(await page.getByRole('navigation', { name: 'Breadcrumb' }).textContent()).toContain(project.name);
      await scope.uncheck();
      expect(await page.evaluate(() => (window as any).__desk.store.state.search.scope)).toBe('global');
      expect(await page.evaluate(() => (window as any).__desk.store.state.nextRoute.scope)).toBe('global');
      await projectPicker.selectOption(project.id);
      await repoPicker.selectOption(repoValues.find((value) => value)!);
      await page.waitForFunction(() => !(window as any).__desk.store.state.search.loading);
      expect(await page.evaluate(() => {
        const s = (window as any).__desk.store.state.search;
        return { project: s.project, repo: s.repo };
      })).toEqual({ project: project.id, repo: repoValues.find((value) => value)! });
      await scope.check();
      expect(await page.evaluate(() => (window as any).__desk.store.state.nextRoute.scope)).toBe(`space:project:${project.id}`);
      await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: project.name, exact: true }).click();
      expect(await page.evaluate(() => (window as any).__desk.store.state.nextRoute)).toEqual({ page: 'project', id: project.id });
      await page.evaluate(() => (window as any).__desk.store.nextGo({ page: 'search', query: 'router' }));
      await page.reload();
      await page.waitForFunction(() => (window as any).__desk?.store.state.projectsLoaded);
      expect(await page.getByRole('checkbox', { name: 'In this space', exact: true }).isChecked()).toBe(true);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, { timeout: 60_000 });
});
