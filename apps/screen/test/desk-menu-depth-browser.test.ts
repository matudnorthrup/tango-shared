import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Render the real Preact menu in an isolated DOM; all modules are local fixtures.
// Skipped where no Chromium is installed (the CI runner), as the desk's other browser tests are.
let browser: Browser | null;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => null);
  if (!browser) return;
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(20_000);
  const publicDir = path.resolve(import.meta.dirname, '../public');
  await page.route('http://menu.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/desk-next.css"><style>#root { position: absolute; top: 40px; right: 30px; }</style><div id="root"></div>' });
    const body = await fs.readFile(path.join(publicDir, url.pathname));
    await route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body });
  });
  await page.goto('http://menu.test/');
}, 60_000);
afterAll(async () => { await browser?.close(); });

async function draw(phone: boolean, duplicate = false) {
  await page.evaluate(`(async () => {
    const phone = ${JSON.stringify(phone)};
    // Browser imports use the intercepted local module routes.
    const load = (url) => import(url);
    const { html, render } = await load('/vendor/preact-htm.js');
    const { Menu } = await load('/desk/next/menu.js');
    const root = document.getElementById('root');
    render(null, root);
    render(html\`<\${Menu} phone=\${phone} onClose=\${() => {}} items=\${[
      { label: 'Reports to', sub: [
        { heading: 'Projects' },
        { key: 'p1', label: 'One', sub: [{ label: 'Lead one', onSelect: () => {} }] },
        { key: 'p2', label: ${JSON.stringify(duplicate ? 'One' : 'Two')}, sub: [{ label: 'Lead two', onSelect: () => {} }] },
      ] },
      { label: 'Stage', sub: [{ label: 'Active', onSelect: () => {} }] },
    ]} />\`, root);
  })()`);
}

describe('two-level menu', () => {
  it('opens nested desk flyouts by hover and keyboard, returning to the parent', async (ctx) => {
    if (!browser) return ctx.skip();
    await draw(false);
    await page.getByRole('menuitem', { name: 'Reports to', exact: true }).click();
    expect(await page.locator('.nx-mhead').textContent()).toBe('Projects');
    expect(await page.getByRole('menuitem', { name: 'Projects', exact: true }).count()).toBe(0);
    await page.getByRole('menuitem', { name: 'One', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Lead one', exact: true }).waitFor();
    expect(await page.locator('.nx-fly .nx-fly').count()).toBe(1);
    expect(await page.locator('.nx-fly .nx-fly').evaluate((el) => {
      const parent = el.parentElement!.closest('.nx-fly')!;
      return el.getBoundingClientRect().right <= parent.getBoundingClientRect().left + 1;
    })).toBe(true);
    await page.getByRole('menuitem', { name: 'Two', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('menuitem', { name: 'Lead two', exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement === document.querySelector('.nx-fly .nx-fly [role="menuitem"]'));
    expect(await page.getByRole('menuitem', { name: 'Lead one', exact: true }).count()).toBe(0);
    await page.keyboard.press('ArrowLeft');
    await page.locator('.nx-fly .nx-fly').waitFor({ state: 'detached' });
    expect(await page.evaluate(() => document.activeElement?.textContent)).toContain('Two');
    await page.keyboard.press('ArrowLeft');
    await page.locator('.nx-fly').waitFor({ state: 'detached' });
  });

  it('drills two phone levels and pops just one level at each back tap', async (ctx) => {
    if (!browser) return ctx.skip();
    await draw(true);
    await page.getByRole('menuitem', { name: 'Reports to', exact: true }).click();
    expect(await page.locator('.nx-mhead').textContent()).toBe('Projects');
    expect(await page.getByRole('menuitem', { name: 'Projects', exact: true }).count()).toBe(0);
    await page.getByRole('menuitem', { name: 'One', exact: true }).click();
    expect(await page.locator('.nx-mback').textContent()).toBe('One');
    expect(await page.getByRole('menuitem', { name: 'Lead one', exact: true }).count()).toBe(1);
    await page.locator('.nx-mback').click();
    expect(await page.locator('.nx-mback').textContent()).toBe('Reports to');
    expect(await page.getByRole('menuitem', { name: 'Two', exact: true }).count()).toBe(1);
    await page.locator('.nx-mback').click();
    expect(await page.locator('.nx-mback').count()).toBe(0);
    expect(await page.getByRole('menuitem', { name: 'Stage', exact: true }).count()).toBe(1);
  });

  for (const phone of [false, true]) it(`opens only the selected same-name project (phone: ${phone})`, async (ctx) => {
    if (!browser) return ctx.skip();
    await draw(phone, true);
    await page.getByRole('menuitem', { name: 'Reports to', exact: true }).click();
    await page.getByRole('menuitem', { name: 'One', exact: true }).nth(1).click();
    await page.getByRole('menuitem', { name: 'Lead two', exact: true }).waitFor();
    expect(await page.getByRole('menuitem', { name: 'Lead one', exact: true }).count()).toBe(0);
    if (!phone) expect(await page.locator('.nx-fly .nx-fly').count()).toBe(1);
  });

  it('groups reporting options by space under Options on the Start work sheet', async (ctx) => {
    if (!browser) return ctx.skip();
    await page.evaluate(`(async () => {
      const load = (url) => import(url);
      const { html, render } = await load('/vendor/preact-htm.js');
      const { StartWorkSheet } = await load('/desk/start-work.js');
      const { createStore } = await load('/desk/store.js');
      const items = [
        { id: 'lead1', source: 't3', place: 'Lead one', disposition: 'active', facts: { projectId: 'p1', role: 'default' } },
        { id: 'lead2', source: 't3', place: 'Lead two', disposition: 'active', facts: { projectId: 'p2', role: 'default' } },
      ];
      const store = createStore({ mode: 'fixtures', items: async () => ({ items: [] }), startWorkOptions: async () => ({ repos: [{ id: 'repo', name: 'Code', account: 'a' }], accounts: [{ id: 'a', name: 'A' }] }) });
      store.set({ projects: [{ id: 'p1', name: 'One', createdAt: 1 }, { id: 'p2', name: 'Two', createdAt: 2 }], lists: { active: { items, loaded: true }, snoozed: { items: [], loaded: true }, everything: { items: [], loaded: true }, history: { items: [], loaded: true } } });
      await store.openStartWork({ projectId: 'p1', prompt: 'Fix it' });
      store.setStartField('role', 'worker');
      store.setStartField('optsOpen', true);
      store.setStartField('openOpt', 'owner');
      const root = document.getElementById('root');
      render(null, root);
      render(html\`<\${StartWorkSheet} store=\${store} />\`, root);
    })()`);
    const list = page.getByRole('radiogroup', { name: 'Reports to' });
    expect(await list.locator('.swc-listhead').allTextContents()).toEqual(['One', 'Two']);
    expect(await list.getByRole('radio').allTextContents()).toEqual([expect.stringContaining('Lead one · lead'), expect.stringContaining('Lead two · lead')]);
  });

});
