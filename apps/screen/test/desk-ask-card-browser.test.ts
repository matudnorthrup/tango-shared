import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser: Browser | null;
const base = 'http://desk-fixture.test';
const root = resolve(import.meta.dirname, '../public');
beforeAll(async () => { browser = await chromium.launch({ headless: true }).catch(() => null); }, 60_000);
afterAll(async () => { await browser?.close(); });
async function fixture(): Promise<Page> {
  const page = await browser!.newPage({ viewport: { width: 1300, height: 1000 } });
  await page.route('**/*', async (route) => {
    if (!route.request().url().startsWith(base + '/')) return route.abort();
    try {
      const file = resolve(root, `.${new URL(route.request().url()).pathname}`);
      if (!file.startsWith(root + '/')) return route.abort();
      await route.fulfill({ body: await readFile(file), contentType: ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' } as Record<string, string>)[extname(file)] || 'application/octet-stream' });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto(`${base}/ask-fixture.html`);
  await page.locator('[data-shape="do"] .ac').waitFor();
  return page;
}

describe('recorded hand-off ask cards', () => {
  it('shows the three declared shapes and recorded metadata, with no completion for answer or legacy', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      const todo = page.locator('[data-shape="do"]');
      expect(await todo.innerText()).toContain('To do');
      expect(await todo.innerText()).toContain('Needs your sign-in');
      expect(await todo.locator('time').getAttribute('datetime')).toBe('2030-01-02T12:00:00Z');
      expect(await todo.locator('input[type=checkbox]').count()).toBe(2);
      for (const [kind, label] of [['answer', 'Answer'], ['unclear', 'Reply']]) {
        const card = page.locator(`[data-shape="${kind}"] .ac`);
        expect(await card.innerText()).toContain(label);
        expect(await card.getByRole('button', { name: 'Did it', exact: true }).count()).toBe(0);
        expect(await card.getByRole('textbox').count()).toBe(1);
        expect(await card.getByRole('button', { name: kind === 'answer' ? 'Snooze' : 'Defer', exact: true }).count()).toBe(1);
        expect(await card.getByRole('button', { name: 'Open thread', exact: true }).count()).toBe(1);
      }
    } finally { await page.close(); }
  });
  it('ticks recorded steps, completing only the last, with no owner words', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      const card = page.locator('[data-shape="do"] .ac');
      await card.locator('input').nth(0).check();
      expect(await card.locator('.ac-status').count()).toBe(0);
      expect(await card.locator('input').nth(0).isChecked()).toBe(true);
      expect(await card.innerText()).toContain('Did it');
      await card.locator('input').nth(1).check();
      expect(await card.locator('.ac-status').innerText()).toBe('Done');
      const calls = await page.evaluate(() => (window as any).askFixture.calls);
      expect(calls.map((c: any) => [c.type, c.askId, c.step])).toEqual([['resolve', 'A-901', '1'], ['resolve', 'A-901', '2']]);
      expect(calls.every((c: any) => typeof c.commandId === 'string' && !('text' in c))).toBe(true);
    } finally { await page.close(); }
  });
  it('keeps an uncertain network completion open and unchecked, retaining the command id for retry', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await page.evaluate(() => { (window as any).askFixture.fail = true; });
      const card = page.locator('[data-shape="do"] .ac');
      await card.locator('input').first().click();
      expect(await card.getByRole('alert').innerText()).toBe('Could not reach Loom');
      expect(await card.locator('.ac-status').count()).toBe(0);
      expect(await card.locator('input').first().isChecked()).toBe(false);
      await page.evaluate(() => { (window as any).askFixture.fail = false; });
      await card.locator('input').first().check();
      const calls = await page.evaluate(() => (window as any).askFixture.calls);
      expect(calls[0].commandId).toBe(calls[1].commandId);
    } finally { await page.close(); }
  });
  it('sends only typed words through reply and keeps Snooze and Open thread separate', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      const card = page.locator('[data-shape="answer"] .ac');
      await card.getByRole('button', { name: 'Snooze', exact: true }).click();
      await card.getByRole('button', { name: 'Open thread', exact: true }).click();
      await card.getByRole('textbox').fill('The blue drive');
      await card.getByRole('button', { name: 'Send reply', exact: true }).click();
      expect(await card.locator('.ac-status').innerText()).toBe('Answered');
      const calls = await page.evaluate(() => (window as any).askFixture.calls);
      expect(calls.map((c: any) => c.type)).toEqual(['defer', 'open', 'reply']);
      expect(calls[2].text).toBe('The blue drive');
    } finally { await page.close(); }
  });
  it('offers Did it only for an open declared do, never for a legacy or expired record', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      const card = page.locator('[data-shape="do"] .ac');
      await page.evaluate(() => { const f = (window as any).askFixture; f.records[0].steps = []; f.redraw(); });
      expect(await card.getByRole('button', { name: 'Did it', exact: true }).count()).toBe(1);
      await page.evaluate(() => { const f = (window as any).askFixture; f.records[0].legacy = true; f.redraw(); });
      expect(await card.getByRole('button', { name: 'Did it', exact: true }).count()).toBe(0);
      // Re-recording with a declared kind clears legacy in Loom and restores completion on the card.
      await page.evaluate(() => { const f = (window as any).askFixture; Object.assign(f.records[0], { kind: 'do', legacy: 0, revision: 2 }); f.redraw(); });
      expect(await card.getByRole('button', { name: 'Did it', exact: true }).count()).toBe(1);
      await page.evaluate(() => { const f = (window as any).askFixture; f.records[0].status = 'expired'; f.redraw(); });
      expect(await card.locator('.ac-status').innerText()).toBe('Expired');
      expect(await card.getByRole('textbox').count()).toBe(0);
      expect(await card.getByRole('button', { name: 'Did it', exact: true }).count()).toBe(0);
    } finally { await page.close(); }
  });

  it('keeps a legacy chapter line replyable without inventing a recorded status or completion', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await page.evaluate(() => { const f = (window as any).askFixture; f.store.state.chapters.sample.data.asks = []; f.redraw(); });
      const card = page.locator('[data-shape="answer"] .ac');
      expect(await card.locator('.bc-pill').allTextContents()).toEqual(['Reply']);
      expect(await card.locator('.ac-status').count()).toBe(0);
      expect(await card.getByRole('button', { name: 'Did it', exact: true }).count()).toBe(0);
      expect(await card.getByRole('textbox').count()).toBe(1);
      expect(await card.getByRole('button', { name: 'Snooze', exact: true }).count()).toBe(1);
      expect(await card.getByRole('button', { name: 'Open thread', exact: true }).count()).toBe(1);
      await card.getByRole('textbox').fill('The blue drive');
      await card.getByRole('button', { name: 'Send reply', exact: true }).click();
      expect(await page.evaluate(() => (window as any).askFixture.calls.at(-1))).toMatchObject({ type: 'reply', text: 'The blue drive' });
    } finally { await page.close(); }
  });

  it('retries a definitive failed command with a new id after recovery', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await fixture();
    try {
      await page.evaluate(() => { (window as any).askFixture.failDefinitive = true; });
      const card = page.locator('[data-shape="do"] .ac');
      await card.locator('input').first().click();
      expect(await card.getByRole('alert').innerText()).toBe('Service unavailable');
      expect(await card.locator('.ac-status').count()).toBe(0);
      expect(await card.locator('input').first().isChecked()).toBe(false);
      await page.evaluate(() => { (window as any).askFixture.failDefinitive = false; });
      await card.locator('input').first().check();
      const calls = await page.evaluate(() => (window as any).askFixture.calls);
      expect(calls).toHaveLength(2);
      expect(calls[0].commandId).not.toBe(calls[1].commandId);
      expect(await card.locator('input').first().isChecked()).toBe(true);
    } finally { await page.close(); }
  });

});
