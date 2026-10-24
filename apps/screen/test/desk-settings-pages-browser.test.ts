// Settings in six pages (settings.js): each old page's link opens its new home at that section.
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
const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings' }).getByRole('button');
const open = (page: Page, key: string, sub: unknown = null) => page.evaluate(([key, sub]) => (window as any).__desk.store.openSettings(key, sub), [key, sub] as const);
describe('Settings in six pages', () => {
  it('lists six pages and puts each old page in its new home', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await open(page, 'device');
      expect(await nav(page).allTextContents()).toEqual(['This device', 'Inbox tabs', 'Projects & agents', 'Notifications', 'Accounts', 'Labs', 'Activity log']);
      for (const [old, home, heading] of [['display', 'This device', 'Text and previews'], ['windows', 'This device', 'Windows'], ['mutes', 'Inbox tabs', 'Mutes'], ['agents', 'Projects & agents', 'Agents'], ['repos', 'Projects & agents', 'Repos not in a project'], ['feed', 'Notifications', 'Feed'], ['snooze', 'Notifications', 'Snooze times'], ['routing', 'Accounts', 'Routing'], ['flags', 'Labs', 'Flags']]) {
        await open(page, old);
        await page.locator(`#stg-sec-${old}`).getByRole('heading', { name: heading, exact: true }).waitFor();
        expect(await page.locator('.stg-nav button.on').textContent()).toBe(home);
      }
      // Stage order sits in Labs only while stage labels are on.
      await open(page, 'labs');
      expect(await page.locator('#stg-sec-stages').count()).toBe(0);
      await page.evaluate(() => (window as any).__desk.store.saveFlags({ stageLabels: true }));
      await page.locator('#stg-sec-stages').waitFor();
    } finally { await page.close(); }
  }, 60_000);
  it('opens space views straight from a project page, with the way back to Projects & agents', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await open(page, 'spaceviews');
      await page.getByRole('button', { name: '+ New view', exact: true }).waitFor();
      expect(await page.locator('.stg-nav button.on').textContent()).toBe('Projects & agents');
      await page.getByRole('button', { name: '‹ Projects & agents' }).click();
      await page.getByRole('button', { name: 'Edit space views…' }).waitFor();
    } finally { await page.close(); }
  }, 60_000);
  it('sets this device\'s sort order beside text size, the same pick as the Filter menu\'s', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await open(page, 'device');
      await page.getByRole('group', { name: 'Sort order', exact: true }).getByRole('button', { name: 'Oldest first' }).click();
      await page.waitForFunction(() => (window as any).__desk.store.state.nextOrder === 'oldest');
      // Mutes sit at the foot of Inbox tabs.
      await open(page, 'tabs');
      await page.locator('#stg-sec-mutes').waitFor();
      expect(await page.getByRole('button', { name: '+ New tab' }).count()).toBe(1);
    } finally { await page.close(); }
  }, 60_000);
});

it('keeps dictation capture on by default and saves device off across reloads', async ctx => {
  if (!browser) return ctx.skip();
  const page = await fixture();
  try {
    await open(page, 'device');
    const setting = page.getByRole('checkbox', { name: 'Save new desk dictations from this device' });
    expect(await setting.isChecked()).toBe(true);
    await setting.uncheck(); await page.reload();
    await page.waitForFunction(() => (window as any).__desk?.store.state.projectsLoaded);
    await open(page, 'device'); expect(await setting.isChecked()).toBe(false);
    expect(await page.getByText(/Saves text, never audio/).count()).toBe(1);
  } finally { await page.close(); }
}, 60_000);
