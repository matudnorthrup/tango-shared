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
async function fixture(phone = false): Promise<Page> {
  const page = await browser!.newPage(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
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
describe('pull request surfaces', () => {
  for (const width of [1500, 900, 390]) {
    it(`keeps crowded PR chips on one line without overlap at ${width}px`, async (ctx) => {
      if (!browser) return ctx.skip();
      const page = await fixture(width === 390);
      try {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => (window as any).__desk.store.nextGo({ page: 'project', id: 'desk-reliability' }));
        for (const count of [1, 3]) {
          const row = page.locator(`[data-id="loom:fx-pr-crowded-${count}"]`);
          const chip = row.locator('.nx-pr-chip');
          await chip.waitFor();
          expect(await chip.textContent()).toBe(count === 1 ? 'open' : '3 open');
          expect(await row.locator('.nx-meta').textContent()).toContain('CI failing');
          const geometry = await chip.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const text = document.createRange();
            text.selectNodeContents(el.lastChild!);
            const lines = [...text.getClientRects()];
            const next = el.parentElement!.nextElementSibling!.getBoundingClientRect();
            return { right: box.right, nextLeft: next.left, lines: lines.length, textRight: Math.max(...lines.map(r => r.right)), height: box.height };
          });
          expect(geometry.lines).toBe(1);
          expect(geometry.textRight).toBeLessThanOrEqual(geometry.right);
          expect(geometry.right).toBeLessThanOrEqual(geometry.nextLeft);
          expect(geometry.height).toBeLessThan(32);
        }
      } finally { await page.close(); }
    }, 30_000);
  }
  it('opens a summary without opening the row, dismisses it, and routes to grouped PRs', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await page.evaluate(() => (window as any).__desk.store.nextGo({ page: 'project', id: 'desk-reliability' }));
      const chip = page.locator('[data-id="loom:fx-pr-2"] .nx-pr-chip');
      await chip.hover();
      await page.getByRole('region', { name: 'Pull request summary' }).waitFor();
      expect(await page.locator('.nx-pr-pop a').count()).toBe(3);
      expect(await page.locator('.nx-pr-pop a').first().getAttribute('target')).toBe('_blank');
      await page.keyboard.press('Escape');
      expect(await page.locator('.nx-pr-pop').count()).toBe(0);
      await chip.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'All pull requests', exact: true }).click();
      await page.getByRole('tab', { name: 'Pull requests' }).waitFor();
      expect(await page.locator('.nx-pr-list h3').allTextContents()).toEqual(['Open', 'Merged']);
      expect(await page.locator('.nx-pr-list').textContent()).toContain('by worker CSV export fix');
      expect(await page.getByRole('tab', { name: 'Links', exact: true }).count()).toBe(0);
      await page.getByRole('button', { name: 'Hide the panel', exact: true }).click();
      await page.getByRole('button', { name: '↗ 3 links', exact: true }).click();
      expect(await page.getByRole('tab', { name: 'Pull requests' }).getAttribute('aria-selected')).toBe('true');
      await page.evaluate(() => (window as any).__desk.store.nextOpen('loom:fx-pr-6'));
      await page.locator('.nx-pr-list summary').waitFor();
      expect(await page.locator('.nx-pr-list details').getAttribute('open')).toBeNull();
      expect(await page.locator('.nx-thead .nx-pr-chip').count()).toBe(0);
    } finally { await page.close(); }
  }, 30_000);
  it('keeps a touch summary inside the phone viewport and supports outside dismissal', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture(true);
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => (window as any).__desk.store.nextOpen('loom:fx-pr-9'));
      const chip = page.locator('.nx-thead .nx-pr-chip');
      await chip.tap();
      const pop = page.locator('.nx-pr-pop');
      await pop.waitFor();
      await page.waitForTimeout(250);
      expect(await pop.isVisible()).toBe(true);
      const r = await pop.boundingBox();
      expect(r!.x).toBeGreaterThanOrEqual(0);
      expect(r!.x + r!.width).toBeLessThanOrEqual(390);
      await page.locator('.nx-h1').click();
      expect(await pop.count()).toBe(0);
    } finally { await page.close(); }
  }, 30_000);
});
