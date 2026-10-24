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
  const page = await browser!.newPage({ viewport: { width: 1200, height: 420 } });
  page.setDefaultTimeout(20_000);
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

describe('returning from a thread', () => {
  for (const place of [{ page: 'catchup' }, { page: 'inbox', view: 'needs' }, { page: 'inbox', view: null }]) {
    it(`lands at the top of ${place.page}${place.view ? `/${place.view}` : ''}, not where the thread was scrolled`, async (ctx) => {
      if (!browser) return ctx.skip();
      const page = await fixture();
      try {
        await page.locator('[data-id]').first().waitFor();
        const id = await page.locator('[data-id]').first().getAttribute('data-id');
        await page.evaluate((route) => (window as any).__desk.store.nextGo(route), place);
        await page.evaluate((itemId) => (window as any).__desk.store.nextOpen(itemId), id);
        await page.waitForFunction(() => (window as any).__desk.store.state.presentation.view === 'conversation');
        // The thread reads from its latest reply: scroll it to the bottom, as a long one is.
        await page.evaluate(() => { document.body.style.minHeight = '4000px'; window.scrollTo(0, document.documentElement.scrollHeight); });
        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
        // Done, Snooze or Park closes the thread through the store, not through Back.
        await page.evaluate(() => (window as any).__desk.store.goBoard());
        await page.waitForFunction(() => (window as any).__desk.store.state.presentation.view === 'active');
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
      } finally { await page.close(); }
    }, 30_000);
  }
});
