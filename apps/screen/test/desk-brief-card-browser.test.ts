import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The decision brief card (TGO-1080, R-12) in the fixture desk: plain-word pills, where it came from, one summary
// line over a folded receipt, options as full-width rows with their whole consequence, the rule, assets, background.

let browser: Browser | null;
const base = 'http://desk-fixture.test';
const root = resolve(import.meta.dirname, '../public');
beforeAll(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => null);
}, 60_000);
afterAll(async () => { await browser?.close(); });
async function fixture(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1300, height: 1400 } });
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
const open = async (page: Page, id: string) => {
  await page.evaluate((id) => (window as any).__desk.store.openItem(id), id);
  const card = page.locator('section.bc').first();
  await card.waitFor();
  return card;
};

describe('the decision brief card in the fixture desk', () => {
  it('level 1 behind a tripwire: plain pills, a short due pill, no level numbers or codes, rows with whole consequences', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const card = await open(page, 'loom:fx-brief-l1');
      const top = await card.locator('.bc-top').innerText();
      expect(top).toContain('Your call');
      expect(top).toContain('Within about 1 h');
      expect(top).toContain('Needs your sign-in');
      const text = await card.innerText();
      expect(text).not.toMatch(/\bL[1-4]\b|identity|credentials-identity|two-way/);
      expect(await card.locator('.bc-sum summary').innerText()).toMatch(/^Reversible · only affects you · raised \d+m ago · Details/);
      // The receipt is folded until tapped.
      expect(await card.locator('.bc-rcpt').isVisible()).toBe(false);
      await card.locator('.bc-sum summary').click();
      const receipt = await card.locator('.bc-rcpt').innerText();
      expect(receipt).toContain('Sign-ins and credentials');
      expect(receipt).toContain("Within about 1 h, when the automatic backup restarts.");
      const rows = card.locator('.bc-opt');
      expect(await rows.count()).toBe(3);
      expect(await rows.first().innerText()).toContain('Other disk work may feel slower while it runs. Resets on reboot.');
      expect(await rows.first().locator('.bc-rec').innerText()).toBe('★ Recommended');
      // Full width: every row as wide as the options column.
      const widths = await rows.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
      expect(new Set(widths).size).toBe(1);
      // A tripwire is never a rule: no rule chips.
      expect(await card.locator('.rd-brief-rule').count()).toBe(0);
      expect(await card.locator('.bc-tile').innerText()).toContain('Pull request');
      expect(await card.locator('.bc-bg summary').innerText()).toContain('Background');
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('level 3: the countdown pill and the default named on its row; the rule as "Proposes a rule" after a similar call', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      const card = await open(page, 'loom:fx-brief');
      expect(await card.locator('.bc-pill.timer').innerText()).toBe('Goes ahead in 2h 10m unless you say otherwise');
      expect(await card.locator('.bc-opt').first().locator('.bc-rec').innerText()).toBe("★ Recommended · goes ahead if you don't answer");
      expect(await card.locator('.rd-brief-rule p').innerText()).toMatch(/^Proposes a rule \(you approved a similar call, D-\d+\): Next time, for desk timer copy/);
      expect(await card.locator('.rd-rule-seg button').count()).toBe(3);
    } finally {
      await page.close();
    }
  });

  it('the brief page is the same card: pills, rows, rule, and its D-n as links that open their own page', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.evaluate(() => (window as any).__desk.store.openDecision('D-42'));
      const card = page.locator('.rd-dsheet section.bc');
      await card.waitFor();
      expect(await card.locator('.bc-pill.timer').innerText()).toBe('Goes ahead in 2h 10m unless you say otherwise');
      expect(await card.locator('.bc-from').innerText()).toMatch(/^From .*Veto countdown copy →/);
      expect(await card.locator('.bc-opt').count()).toBe(2);
      expect(await card.locator('.rd-brief-rule p').innerText()).toMatch(/^Proposes a rule \(you approved a similar call, D-\d+\):/);
      // D-n in the card's text links to its page; the row's own id is a pill, not a link.
      const link = card.locator('.bc-standing a.dlink');
      expect(await link.innerText()).toBe('D-6');
      await link.click();
      await page.waitForFunction(() => (window as any).__desk.store.state.decisionPage?.id === 'D-6');
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('carried and revised: "From <thread> →" on the lead, "Carried by <lead> →" on the worker, and the update line', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      const lead = await open(page, 'loom:fx-desk-lead');
      expect(await lead.locator('.bc-from').innerText()).toContain('From Filter System Audit and Upgrade →');
      expect(await lead.locator('.bc-pill.rev').innerText()).toBe('Revised · 2nd version');
      expect(await lead.locator('.bc-updated').innerText()).toBe('Updated: Step 6 turned out to need step 4 first');
      expect(await lead.locator('.bc-sum summary').innerText()).toContain('updated 10m ago');
      await lead.locator('.bc-from button').click();
      await page.waitForFunction(() => (window as any).__desk.store.state.presentation.itemId === 'loom:fx-filter' || (window as any).__desk.store.state.detail?.id === 'loom:fx-filter');
      const worker = page.locator('section.bc').first();
      await worker.locator('.bc-from').waitFor();
      expect(await worker.locator('.bc-from').innerText()).toContain('Carried by Tango Desk →');
    } finally {
      await page.close();
    }
  });
});
