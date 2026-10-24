import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, utimesSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";

/**
 * Claude Code keeps a session's transcript under
 * `<CLAUDE_CONFIG_DIR>/projects/<slug of cwd>/`. Loom keeps one shared copy of
 * each transcript and hard-links it into real account project directories,
 * so a session started on one account resumes natively on another.
 */

/** Longer slugs are hashed by Claude Code, so Loom can't predict them. */
export const MAX_SLUG_LENGTH = 200;

/** Claude Code's project folder name: every non-alphanumeric character becomes "-". */
export function projectSlug(cwd: string): string {
  // Claude keys a project by its real path (/tmp is /private/tmp on macOS): so must Loom, or a thread in a
  // symlinked folder links the wrong project folder and never finds its transcript.
  let path = resolve(cwd);
  try {
    path = realpathSync(path);
  } catch {
    // Not there (yet): the path as given.
  }
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

export type LinkResult = "linked" | "already-linked" | "adopted" | "merged" | "unsupported";

export interface LinkOptions {
  link?: typeof linkSync;
  warn?: (message: string) => void;
}
let warned = false;
function warnCopy(options: LinkOptions): void {
  if (warned) return;
  warned = true;
  (options.warn ?? console.warn)("Claude transcript hard links unavailable across volumes; using copies.");
}

function backup(path: string, now: number): void {
  let target = `${path}.loom-backup-${now}`;
  for (let n = 1; lstatOrNull(target); n++) target = `${path}.loom-backup-${now}-${n}`;
  renameSync(path, target);
}

/** Materialize directories and hard-link dereferenced files without replacing names. */
function copyMissing(source: string, target: string, options: LinkOptions = {}): void {
  const stat = statSync(source);
  if (stat.isDirectory()) {
    if (!lstatOrNull(target)) mkdirSync(target, { recursive: true });
    if (!lstatSync(target).isDirectory()) return;
    for (const name of readdirSync(source)) copyMissing(join(source, name), join(target, name), options);
    return;
  }
  if (!stat.isFile() || lstatOrNull(target)) return;
  // linkSync links a symlink itself, so resolve it before linking its file.
  const file = realpathSync(source);
  try {
    (options.link ?? linkSync)(file, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    if (code !== "EXDEV" && code !== "EPERM") throw error;
    try {
      copyFileSync(file, target, constants.COPYFILE_EXCL);
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code === "EEXIST") return;
      throw copyError;
    }
    utimesSync(target, stat.atime, stat.mtime);
  }
}

/** Reconcile two transcript names. Preserve conflicts before replacing either name. */
export function linkTranscript(local: string, shared: string, now = Date.now(), options: LinkOptions = {}): void {
  const a = lstatOrNull(local);
  const b = lstatOrNull(shared);
  if (!a && !b) return; // init can precede the harness's first transcript write.
  if (a && b && a.dev === b.dev && a.ino === b.ino) return;
  if ((a && !a.isFile()) || (b && !b.isFile())) throw new Error("Transcript must be a regular file");
  // Newer wins; on a tie (coarse mtimes under the copy fallback) the longer file, then the local one,
  // since transcripts only grow and the local name is the one a writer may hold open.
  const source = a && (!b || a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.size >= b.size)) ? local : shared;
  const target = source === local ? shared : local;
  mkdirSync(dirname(target), { recursive: true });
  const previous = lstatOrNull(target);
  // A fallback copy with identical contents needs no backup or rewrite.
  if (previous && readFileSync(source).equals(readFileSync(target))) {
    const temporary = `${target}.loom-link-${randomUUID()}`;
    try { (options.link ?? linkSync)(source, temporary); }
    catch (error) {
      if (!["EXDEV", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      warnCopy(options);
      return;
    }
    backup(target, now);
    renameSync(temporary, target);
    return;
  }
  if (previous) backup(target, now);
  try {
    (options.link ?? linkSync)(source, target);
  } catch (error) {
    if (!["EXDEV", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    copyFileSync(source, target);
    const stat = statSync(source);
    utimesSync(target, stat.atime, stat.mtime);
    warnCopy(options);
  }
}

/** Migrate a known slug, also used at startup when its cwd is not available. */
export function linkProjectSlug(configDir: string, sharedDir: string, slug: string, now = Date.now(), options: LinkOptions = {}): LinkResult {
  if (slug.length > MAX_SLUG_LENGTH) return "unsupported";
  const projects = join(configDir, "projects");
  const shared = join(sharedDir, slug);
  const local = join(projects, slug);
  ensureProjects(configDir, options);
  mkdirSync(shared, { recursive: true });
  const stat = lstatOrNull(local);
  let result: LinkResult = stat?.isDirectory() ? "already-linked" : "linked";
  if (stat?.isSymbolicLink()) {
    const target = resolve(projects, readlinkSync(local));
    backup(local, now);
    mkdirSync(local);
    if (target !== resolve(shared) && existsSync(target)) copyMissing(target, local, options);
    result = "merged";
  } else {
    mkdirSync(local, { recursive: true });
    if (stat?.isDirectory()) result = readdirSync(shared).length ? "merged" : "adopted";
  }
  for (const name of new Set([...readdirSync(local), ...readdirSync(shared)])) {
    if (name.includes(".loom-backup-")) continue;
    const a = join(local, name), b = join(shared, name);
    if (name.endsWith(".jsonl")) linkTranscript(a, b, now, options);
    else {
      if (existsSync(a)) copyMissing(a, b, options);
      if (existsSync(b)) copyMissing(b, a, options);
    }
  }
  return result;
}

export function linkProject(configDir: string, sharedDir: string, cwd: string, now = Date.now(), options: LinkOptions = {}): LinkResult {
  return linkProjectSlug(configDir, sharedDir, projectSlug(cwd), now, options);
}

const warnedParents = new Set<string>();

/** Warn about parent links without copying or replacing account-owned trees. */
export function ensureProjects(configDir: string, options: LinkOptions = {}): void {
  const projects = join(configDir, "projects");
  for (const path of [configDir, projects]) {
    if (lstatOrNull(path)?.isSymbolicLink() && !warnedParents.has(path)) {
      warnedParents.add(path);
      (options.warn ?? console.warn)(`Claude account directory is a symlink: ${path}`);
    }
  }
  if (!lstatOrNull(projects)) mkdirSync(projects, { recursive: true });
}

/** Only symlinks into Loom's shared store belong to the legacy layout. */
export function isLegacyProject(path: string, sharedDir: string): boolean {
  if (!lstatOrNull(path)?.isSymbolicLink()) return false;
  try {
    const rel = relative(realpathSync(sharedDir), realpathSync(path));
    return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  } catch { return false; }
}

/** Reconcile one native session, reading other accounts without changing them. */
export function linkSession(configDir: string, sharedDir: string, cwd: string, id: string | null, sources: string[], options: LinkOptions = {}): LinkResult {
  const slug = projectSlug(cwd);
  if (slug.length > MAX_SLUG_LENGTH) return "unsupported";
  const now = Date.now();
  ensureProjects(configDir);
  const local = join(configDir, "projects", slug);
  const extra: string[] = [];
  if (lstatOrNull(local)?.isSymbolicLink()) {
    // Opening a thread owns this slug, but only its session may be copied: read it from the link's target first.
    try { extra.push(realpathSync(local)); } catch { /* a dangling link holds no history */ }
    backup(local, now);
  }
  mkdirSync(local, { recursive: true });
  if (!id) return "linked";
  const shared = join(sharedDir, slug);
  const dirs = [shared, ...extra, ...sources.map(source => join(source, "projects", slug))];
  const transcripts = [...dirs, local].map(dir => join(dir, `${id}.jsonl`))
    .filter(path => lstatOrNull(path)?.isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const newest = transcripts[0];
  if (newest) {
    // The winner is read-only: reconcile its inode into shared, then the target.
    linkTranscript(join(shared, `${id}.jsonl`), newest, now);
    linkTranscript(join(local, `${id}.jsonl`), join(shared, `${id}.jsonl`), now);
  }
  const companion = join(local, id);
  if (lstatOrNull(companion)?.isSymbolicLink()) realDirectory(companion, now, options);
  const companions = dirs.map(dir => join(dir, id)).filter(path => existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const source of companions) if (source !== companion) copyMissing(source, companion, options);
  return "linked";
}

function realDirectory(path: string, now: number, options: LinkOptions): void {
  const stat = lstatOrNull(path);
  if (stat?.isSymbolicLink()) {
    const target = realpathSync(path);
    backup(path, now);
    mkdirSync(path, { recursive: true });
    copyMissing(target, path, options);
  } else mkdirSync(path, { recursive: true });
}

function lstatOrNull(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
