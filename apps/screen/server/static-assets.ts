import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Making the desk page quick to (re)load: it reloads after every deploy, often on a phone over the tailnet.
// - Every module the page imports is listed up front (modulepreload), so the browser fetches them side by side
//   instead of one import level per round trip.
// - Static files carry an ETag: a reload revalidates them and an unchanged one comes back empty (304).

const IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g;

/**
 * The page's static import graph from `entry` (relative to `publicDir`), entry first: every module reached by
 * `import … from './x.js'`, `import './x.js'` and `export … from`. Dynamic `import()` stays out (fixtures).
 */
export function moduleGraph(publicDir: string, entry: string): string[] {
  const seen = new Set<string>();
  const visit = (rel: string) => {
    if (seen.has(rel)) return;
    let source: string;
    try {
      source = fs.readFileSync(path.join(publicDir, rel), 'utf8');
    } catch {
      return;
    }
    seen.add(rel);
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1]!;
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!next.startsWith('..')) visit(next);
    }
  };
  visit(entry);
  return [...seen];
}

/** `<link rel="modulepreload">` for each module, placed before the page's module script. */
export function withModulePreloads(html: string, modules: string[]): string {
  if (!modules.length) return html;
  const links = modules.map((m) => `<link rel="modulepreload" href="${m}">`).join('\n');
  return html.replace('</head>', `${links}\n</head>`);
}

/** A file's ETag, recomputed only when its size or modification time changes. */
export function createEtags(): (file: string, data: Uint8Array) => string {
  const known = new Map<string, { mtimeMs: number; size: number; etag: string }>();
  return (file, data) => {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(file);
    } catch {
      /* hashed below */
    }
    const hit = stat ? known.get(file) : undefined;
    if (stat && hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.etag;
    const etag = `"${createHash('sha1').update(data).digest('base64url')}"`;
    if (stat) known.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, etag });
    return etag;
  };
}
