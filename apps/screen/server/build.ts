import { execFileSync } from 'node:child_process';

/**
 * The code this service runs (the checkout's commit; the start time when git can't say). The page carries the
 * build it was served with (a meta tag) and the desk stream's hello carries the running one, so a page loaded
 * before a deploy reloads instead of reading new data with old code.
 */
export const DESK_BUILD = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || `start-${Date.now()}`;
  } catch {
    return `start-${Date.now()}`;
  }
})();

/** The shell page with the build it was served with. */
export function withBuild(html: string): string {
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="desk-build" content="${DESK_BUILD}">`);
}
