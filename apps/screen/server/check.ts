import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Browser, Frame, Page } from 'playwright-core';

// Renders a freshly staged scene once in headless Chromium so the agent finds
// out about broken HTML (script errors, failed loads, a blank page) before
// anyone looks at a screen. Agents that can read images also get a screenshot.

export interface CheckResult {
  ok: boolean;
  errors: string[];
  /** Worth fixing but not broken (e.g. a table that scrolls sideways on a phone). */
  warnings?: string[];
  /** How it looks on a monitor or TV (1280×800). */
  screenshot?: string;
  /** How it looks on a phone (390×844). */
  phoneScreenshot?: string;
  skipped?: string;
}

/** Screens run from phones to TVs: a scene must fit a phone without sideways scrolling. */
export const PHONE = { width: 390, height: 844 };

/**
 * Screens are glanced at from across the room or while scrolling past, not
 * read. Past these limits a scene reads like a document. Good screens measured
 * on 10/07 stayed under ~140 words and about one screen tall; the ones that
 * missed ran 350-5,000 words over 2.4-20 screens or hid variations behind tabs.
 */
export const GLANCE = { maxWords: 150, maxScreens: 2, maxHiddenWords: 40 };

export interface GlanceMeasure {
  words: number;
  hiddenWords: number;
  screens: number;
  tabs: number;
}

/** Warnings for a scene that asks to be read, scrolled, or clicked through instead of glanced at. */
export function glanceWarnings(m: GlanceMeasure): string[] {
  const warnings: string[] = [];
  if (m.words > GLANCE.maxWords)
    warnings.push(
      `reads like a document (${m.words} words; a glance is under ${GLANCE.maxWords}). Lead with the answer as a headline, cut text to labels ` +
        `and a line or two, and link the full write-up (<a href="…" target="_blank">Full report</a>) instead of putting it on the screen`,
    );
  if (m.screens > GLANCE.maxScreens)
    warnings.push(`${m.screens.toFixed(1)} screens tall: the first screen is all a glance sees. Fit the point on one screen; put the rest behind a link`);
  if (m.tabs > 0 || m.hiddenWords > GLANCE.maxHiddenWords)
    warnings.push(
      `content hidden behind ${m.tabs > 0 ? `${m.tabs} tab/toggle control${m.tabs === 1 ? '' : 's'}` : `${m.hiddenWords} words of collapsed or hidden text`}: ` +
        `show variations side by side so all of them are visible without a tap`,
    );
  return warnings;
}

const IDLE_CLOSE_MS = 5 * 60_000;

/**
 * Measures a scene in the page. Plain JS in a string on purpose: the service
 * runs under tsx, whose keepNames transform wraps named functions in a
 * `__name()` helper that doesn't exist inside the page.
 */
const MEASURE_GLANCE = `(() => {
  const body = document.body;
  if (!body) return { words: 0, hiddenWords: 0, screens: 0, tabs: 0 };
  const wordRe = /[\\p{L}\\p{N}][\\p{L}\\p{N}'’.-]*/gu;
  // Every text node outside scripts and styles, minus what renders, is what's collapsed or hidden.
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let all = '';
  while (walker.nextNode()) {
    if (!/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(walker.currentNode.parentElement?.tagName ?? '')) all += ' ' + (walker.currentNode.nodeValue ?? '');
  }
  const words = ((body.innerText || '').match(wordRe) ?? []).length;
  // The scene's own tap bar is chrome, not content.
  const tabs = Array.from(document.querySelectorAll('[role="tab"], [aria-selected], [aria-pressed]')).filter((el) => !el.closest('.tango-choices')).length;
  // App-style pages keep the document at 100vh and scroll a panel: count the tallest panel's hidden part too.
  let nested = 0;
  for (const el of Array.from(body.querySelectorAll('*'))) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') nested = Math.max(nested, el.scrollHeight - el.clientHeight);
  }
  const screens = (document.documentElement.scrollHeight + nested) / window.innerHeight;
  return { words, hiddenWords: Math.max(0, (all.match(wordRe) ?? []).length - words), screens, tabs };
})()`;

/** The scene's own document: an uploaded page (a url scene) renders in an iframe inside the frame shell. */
async function sceneFrame(page: Page): Promise<Frame> {
  const inner = (await page.$('iframe.tango-full')) ? page.frames().find((frame) => frame !== page.mainFrame()) : undefined;
  if (!inner) return page.mainFrame();
  await inner.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
  return inner;
}

export class SceneChecker {
  private browser: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly outDir: string) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  /** `glance: false` for a prototype: a page to use, not a poster, so length and tabs are fine. */
  async check(frameUrl: string, name: string, options: { glance?: boolean } = {}): Promise<CheckResult> {
    let browser: Browser;
    try {
      browser = await this.launch();
    } catch (err) {
      return { ok: true, errors: [], skipped: `headless check unavailable: ${(err as Error).message.split('\n')[0]}` };
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text().slice(0, 300)}`);
    });
    page.on('pageerror', (error) => errors.push(`script: ${error.message.slice(0, 300)}`));
    page.on('requestfailed', (request) => errors.push(`failed to load ${request.url().slice(0, 200)}: ${request.failure()?.errorText ?? 'error'}`));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`HTTP ${response.status()} for ${response.url().slice(0, 200)}`);
    });
    try {
      await page.goto(frameUrl, { waitUntil: 'load', timeout: 15_000 });
      await page.waitForTimeout(1200);
      const scene = await sceneFrame(page);
      const blank = await scene.evaluate(() => {
        const body = document.body;
        if (!body) return true;
        const text = (body.innerText || '').trim();
        return text.length === 0 && !body.querySelector('img, video, canvas, svg, iframe');
      });
      if (blank) errors.push('the page rendered empty (no text, images, or canvas)');
      const glance = options.glance === false ? [] : glanceWarnings(await this.measureGlance(scene));
      const screenshot = path.join(this.outDir, `${name}.png`);
      await page.screenshot({ path: screenshot });
      const phone = await this.checkPhone(browser, frameUrl, name);
      if (phone.error) errors.push(phone.error);
      const warnings = [...glance, ...(phone.warning ? [phone.warning] : [])];
      return {
        ok: errors.length === 0,
        errors: [...new Set(errors)].slice(0, 12),
        ...(warnings.length ? { warnings } : {}),
        screenshot,
        ...(phone.screenshot ? { phoneScreenshot: phone.screenshot } : {}),
      };
    } catch (err) {
      errors.push(`render failed: ${(err as Error).message.split('\n')[0]}`);
      return { ok: false, errors };
    } finally {
      await context.close().catch(() => undefined);
      this.armIdleClose();
    }
  }

  /** Words, height and hidden content of the scene itself (inside the frame of an uploaded page). */
  private async measureGlance(scene: Frame): Promise<GlanceMeasure> {
    return (await scene.evaluate(MEASURE_GLANCE)) as GlanceMeasure;
  }


  /** Renders at phone width and reports anything wider than the screen, naming what overflows. */
  private async checkPhone(browser: Browser, frameUrl: string, name: string): Promise<{ error?: string; warning?: string; screenshot?: string }> {
    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    try {
      const page = await context.newPage();
      await page.goto(frameUrl, { waitUntil: 'load', timeout: 15_000 });
      await page.waitForTimeout(800);
      const target = await sceneFrame(page);
      const sideways = await target.evaluate(() =>
        Array.from(document.body.querySelectorAll('*'))
          .filter((el) => {
            const style = getComputedStyle(el);
            return (style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 2 && el.tagName !== 'PRE';
          })
          .map((el) => `<${el.tagName.toLowerCase()}>`)
          .slice(0, 3),
      );
      const overflow = await target.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const width = document.documentElement.scrollWidth;
        if (width <= viewport + 2) return null;
        // The outermost elements that stick out: that's what to fix.
        const culprits: string[] = [];
        for (const el of Array.from(document.body.querySelectorAll('*'))) {
          if (el.getBoundingClientRect().right <= viewport + 2) continue;
          if (el.parentElement && el.parentElement !== document.body && el.parentElement.getBoundingClientRect().right > viewport + 2) continue;
          const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
          culprits.push(`<${el.tagName.toLowerCase()}${cls}>`);
          if (culprits.length >= 4) break;
        }
        return { width, viewport, culprits };
      });
      const screenshot = path.join(this.outDir, `${name}-phone.png`);
      await page.screenshot({ path: screenshot });
      const warning = sideways.length
        ? `on a phone, ${sideways.join(', ')} scrolls sideways; readable, but stacked cards (@media (max-width: 640px)) read better at a glance`
        : undefined;
      if (!overflow) return { screenshot, ...(warning ? { warning } : {}) };
      return {
        screenshot,
        error:
          `not phone-friendly: content is ${overflow.width}px wide on a ${overflow.viewport}px phone (sideways scrolling), ` +
          `caused by ${overflow.culprits.join(', ') || 'a fixed-width element'}. Use fluid widths (%, minmax(min(100%, Npx), 1fr) grids, flex-wrap), ` +
          `and turn wide tables into stacked cards on narrow screens (@media (max-width: 640px)).`,
      };
    } catch (err) {
      return { error: `phone render failed: ${(err as Error).message.split('\n')[0]}` };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = import('playwright-core').then(({ chromium }) => chromium.launch({ headless: true }));
      this.browser.catch(() => {
        this.browser = null;
      });
    }
    return this.browser;
  }

  private armIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  async close(): Promise<void> {
    const pending = this.browser;
    this.browser = null;
    if (pending) await (await pending.catch(() => null))?.close().catch(() => undefined);
  }
}
