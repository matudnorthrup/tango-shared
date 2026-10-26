import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';

// The fixture imports the actual thread, chapter and decision-sheet components. No network or live desk actions.
it('one brief card on every surface: rows, tripwires, read-only outcomes and stable screenshots', async (ctx) => {
  const browser = await chromium.launch({ headless: true }).catch(() => null);
  if (!browser) return ctx.skip();
  const root = resolve(import.meta.dirname, '../public');
  const page = await browser.newPage({ viewport: { width: 1600, height: 1500 }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://brief.test') return route.abort();
    const file = resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + '/')) return route.abort();
    try { await route.fulfill({ body: await readFile(file), contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' } as Record<string, string>)[extname(file)] }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
  try {
    await page.goto('http://brief.test/brief-fixture.html');
    await page.waitForFunction(() => (window as any).fixtureReady);
    await page.waitForTimeout(200); // Let the real sheets finish their focus effects before taking focus back.
    await page.locator('h1').click();
    expect(await page.locator('.bc').count()).toBe(8);
    const catchupCards = page.locator('[data-surface="catchup"] .bc');
    expect(await catchupCards.first().getByRole('button', { name: 'Snooze', exact: true }).count()).toBe(1);
    expect(await catchupCards.first().getByRole('button', { name: 'Defer', exact: true }).count()).toBe(0);
    expect(await catchupCards.last().getByRole('button', { name: 'Snooze', exact: true }).count()).toBe(0);

    expect(await page.locator('.rd-needs .bc').count()).toBe(0);
    for (const surface of ['thread', 'catchup', 'decision']) {
      const cards = page.locator(`[data-surface="${surface}"] .bc`);
      expect(await cards.first().locator('.bc-pill.trip').innerText()).toBe('Might surprise you');
      expect(await cards.last().locator('button.bc-opt').count()).toBe(0);
      expect(await cards.last().locator('.bc-opt.on').innerText()).toContain('✓ Chosen');
      expect(await cards.last().locator('.bc-outcome').innerText()).toContain('You answered');
      const rects = await cards.first().locator('.bc-opt').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, bottom: r.bottom }; }));
      expect(rects[0].width).toBe(rects[1].width);
      expect(rects[0].x).toBe(rects[1].x);
      expect(rects[1].y).toBeGreaterThanOrEqual(rects[0].bottom);
    }
    const plain = page.locator('[data-surface="plain"]');
    expect(await plain.locator('.bc-ask').count()).toBe(2);
    // D-468 replaces #957's unlabelled plain ask with its own Reply card.
    // This older source has no recorded status: the label must not invent one.
    expect(await plain.locator('.bc-pill').allTextContents()).toEqual(['Reply']);
    expect(await plain.locator('.nx-pill, .ac-status, .rd-status').count()).toBe(0);
    expect(await plain.locator('[data-case="repeat"] .bc-standing').count()).toBe(0);
    expect(await plain.locator('[data-case="repeat"] .bc-ask').innerText()).toBe('Use the shorter introduction?');
    expect(await plain.locator('.bc-standing').innerText()).toBe('The shorter version fits on one screen and keeps the example.');
    expect(await plain.locator('.pq-foot').count()).toBe(0);
    const gap = await plain.locator('[data-case="context"] .bc').evaluate(el => {
      const heading = el.querySelector('h3')!.getBoundingClientRect();
      return el.querySelector('.bc-standing')!.getBoundingClientRect().top - heading.bottom;
    });
    expect(gap).toBe(10);
    await plain.getByRole('button', { name: 'Use it', exact: true }).click();
    expect(await page.evaluate(() => (window as any).fixtureAnswer.slice(0, 3))).toEqual(['plain-options', 'intro', 'Use it']);
    await plain.getByRole('button', { name: 'Other…', exact: true }).click();
    await plain.locator('input').fill('Keep the example, shorten the opening');
    await plain.getByRole('button', { name: 'Send', exact: true }).click();
    expect(await page.evaluate(() => (window as any).fixtureAnswer[2])).toBe('Keep the example, shorten the opening');
    await plain.locator('input').press('Escape');
    const controls = page.locator('[data-surface="decision"] [aria-label="How your answer counts"]');
    expect(await controls.count()).toBe(1);
    expect(await page.locator('.bc-compact [aria-label="How your answer counts"]').count()).toBe(0);
    expect(await page.locator('[data-surface="thread"] [aria-label="How your answer counts"]').count()).toBe(0);
    await controls.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await page.evaluate(() => (window as any).fixtureRule)).toMatchObject([{ decision: 'D-900', rule: 'R-90', from: 'always' }, 'next-time']);
    for (const [choice, label] of [['once', 'Just this once'], ['always', 'Always do this'], ['next-time', 'Ask me next time']]) {
      await controls.getByRole('button', { name: label, exact: true }).click();
      expect(await page.evaluate(() => (window as any).fixtureRule[1])).toBe(choice);
    }
    await page.evaluate(() => (window as any).fixtureSetRule('always', 'suspended'));
    expect(await controls.innerText()).toContain('is suspended now');
    await controls.getByRole('button', { name: 'Always do this', exact: true }).click();
    expect(await page.evaluate(() => (window as any).fixtureRule[1])).toBe('always');
    await page.evaluate(() => (window as any).fixtureSetRule('always'));
    const statuses = page.locator('[data-surface="status"]');
    expect(await statuses.locator('[aria-label="How your answer counts"]').count()).toBe(0);
    expect(await statuses.locator('[aria-label="Proposed rule"]').count()).toBe(1);
    await statuses.getByRole('button', { name: 'Not now', exact: true }).click();
    expect(await statuses.locator('[aria-label="Proposed rule"]').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).fixtureRule[1])).toBe('once');
    await page.evaluate(() => (window as any).fixtureResetProposal());
    await statuses.getByRole('button', { name: 'Make it a rule', exact: true }).click();
    expect(await page.evaluate(() => (window as any).fixtureRule)).toMatchObject([{ decision: 'D-902', proposal: 'Use the shared card for future asks' }, 'always']);
    expect(await statuses.locator('[aria-label="Proposed rule"]').count()).toBe(0);
    await page.evaluate(() => (window as any).fixtureResetProposal());
    expect(await statuses.innerText()).not.toContain('Summary:');
    for (const card of await statuses.locator('.rd-status-card').all()) {
      const bottom = await card.evaluate(el => el.getBoundingClientRect().bottom - el.lastElementChild!.getBoundingClientRect().bottom);
      expect(bottom).toBe(14); // 13px padding + 1px border, no paragraph margin or empty child.
    }
    const historical = page.locator('[data-surface="decision"] .bc').last().locator('.bc-rcpt');
    expect(await historical.textContent()).toContain('Design direction');
    expect(await historical.textContent()).not.toContain("If you don't answer");
    expect(await historical.textContent()).not.toContain('Who decides');
    expect(await page.locator('.bc-compact .bc-bg, .bc-compact .bc-sum').count()).toBe(0);
    expect(await page.locator('.bc-compact a').filter({ hasText: 'Full brief' }).first().getAttribute('href')).toBe('decision/D-900');
    await page.locator('[data-surface="catchup"] button.bc-opt').nth(1).click();
    expect(await page.evaluate(() => (window as any).fixtureAnswer[3].key)).toBe('B');
    await page.locator('h1').click();
    // Opening the dialog focuses its container. That must not add a second frame, while
    // keyboard users still get the normal focus indicator on the Close button.
    const sheet = page.locator('.rd-dsheet').first();
    await sheet.focus();
    expect(await sheet.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');
    const header = sheet.locator('header');
    expect(await header.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    expect(await page.locator('.fixture-behind').count()).toBe(2);
    await page.keyboard.press('Tab');
    expect(await sheet.locator('.rd-x').evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none')).toBe(true);
    await sheet.focus();
    // Check screenshots against reviewed baselines. Updating requires an explicit environment flag.
    const dir = resolve(import.meta.dirname, 'screenshots/brief-surfaces');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1600, 390]) {
        await page.setViewportSize({ width, height: 1500 });
        const png = await page.screenshot({ fullPage: true, animations: 'disabled' });
        const baseline = resolve(dir, `${width}${theme === 'dark' ? '-dark' : ''}.png`);
        if (process.env.UPDATE_BRIEF_SCREENSHOTS === '1') { await mkdir(dir, { recursive: true }); await writeFile(baseline, png); }
        const diff = await page.evaluate(async ([actual, expected]) => {
          const images = await Promise.all([actual, expected].map(src => new Promise<HTMLImageElement>(resolve => { const image = new Image(); image.onload = () => resolve(image); image.src = src; })));
          if (images[0].width !== images[1].width || images[0].height !== images[1].height) return 1;
          const pixels = images.map(image => {
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
            return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          });
          let changed = 0;
          for (let i = 0; i < pixels[0].length; i += 4) {
            if ([0, 1, 2, 3].some(c => Math.abs(pixels[0][i + c] - pixels[1][i + c]) > 16)) changed++;
          }
          return changed / (pixels[0].length / 4);
        }, [png, await readFile(baseline)].map(bytes => `data:image/png;base64,${bytes.toString('base64')}`));
        // Chromium sometimes rounds a handful of border pixels differently after a resize.
        expect(diff, `Screenshot changed at ${width}px; inspect the fixture before updating its baseline`).toBeLessThanOrEqual(0.0001);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
    expect(errors).toEqual([]);
    for (const why of ['Applied your picks and shortened the introduction.', '']) {
      await page.evaluate(why => (window as any).fixtureUpdated(why), why);
      for (const surface of ['thread', 'catchup', 'decision']) {
        const update = page.locator(`[data-surface="${surface}"] .bc`).first().locator('.bc-updated');
        expect(await update.isVisible()).toBe(true);
        expect(await update.innerText()).toContain(`Updated: ${why || 'options'}`);
      }
    }
    await page.evaluate(() => (window as any).fixtureUnaddressed());
    for (const surface of ['thread', 'catchup', 'decision']) {
      expect(await page.locator(`[data-surface="${surface}"]`).innerText()).toContain("You replied; the agent didn't address it");
    }
    // Missing brief data still offers thread snooze; a brief without a thread retains line-only snooze.
    for (const variant of ['missing-brief', 'no-thread']) {
      await page.evaluate(async (variant) => {
        const vendorPath = '/vendor/preact-htm.js';
        const chapterPath = '/desk/next/chapter.js';
        const browserImport = new Function('path', 'return import(path)');
        const { html, render } = await browserImport(vendorPath);
        const { ChapterBrief } = await browserImport(chapterPath);
        const host = document.createElement('div'); host.id = 'snooze-case'; document.body.append(host);
        const calls: unknown[] = []; (window as any).snoozeCalls = calls;
        const store = { state: {}, openSnooze: (...args: unknown[]) => calls.push(['thread', ...args]), chapterLine: (...args: unknown[]) => calls.push(['line', ...args]) };
        const line = { id: 77, briefId: 'D-77', title: 'Continue?', ...(variant === 'missing-brief' ? { itemId: 'sample' } : {}) };
        const brief = variant === 'no-thread' ? { id: 'D-77', status: 'open', ask: 'Continue?', options: [] } : null;
        render(html`<${ChapterBrief} line=${line} brief=${brief} store=${store} spaceId="unfiled"/>`, host);
      }, variant);
      await page.locator('#snooze-case').getByRole('button', { name: 'Snooze', exact: true }).click();
      const calls = await page.evaluate(() => (window as any).snoozeCalls);
      expect(calls[0][0]).toBe(variant === 'missing-brief' ? 'thread' : 'line');
      if (variant === 'missing-brief') expect(calls[0][1]).toBe('sample');
      else expect(calls[0][3]).toBe('defer');
      await page.locator('#snooze-case').evaluate(el => el.remove());
    }
  } finally { await browser.close(); }
}, 30_000);
