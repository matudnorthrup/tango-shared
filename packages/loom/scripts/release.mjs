#!/usr/bin/env node
import * as fs from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export function atomicJSON(file, value, beforeRename = () => {}) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    beforeRename(temp);
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
function permissions(path, writable) {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (writable) fs.chmodSync(path, stat.mode | 0o200 | (stat.isDirectory() ? 0o700 : 0));
  if (stat.isDirectory()) for (const name of fs.readdirSync(path)) permissions(join(path, name), writable);
  if (!writable) fs.chmodSync(path, stat.mode & ~0o222);
}
function remove(path) { permissions(path, true); fs.rmSync(path, { recursive: true }); }
function size(path) {
  const stat = fs.lstatSync(path);
  return stat.isDirectory() ? fs.readdirSync(path).reduce((n, name) => n + size(join(path, name)), 0) : stat.size;
}
export function run(args, options = {}) {
  const root = resolve(options.root ?? process.env.LOOM_RELEASES_DIR ?? join(homedir(), '.tango/releases/loom'));
  const pkg = options.packageDir ?? packageDir;
  fs.mkdirSync(root, { recursive: true });
  const lock = join(root, '.lock');
  fs.mkdirSync(lock); // Fail closed if another invocation (or an interrupted one) owns the root.
  try {
    const stateFile = join(root, 'state.json');
    const state = fs.existsSync(stateFile) ? readJSON(stateFile) : { current: null, previous: null, candidates: [], history: [], pins: {} };
    state.pins ??= {};
    const pointer = () => {
      if (!state.current) return;
      const temp = join(root, `.current-${randomUUID()}`);
      try { fs.symlinkSync(state.current, temp); fs.renameSync(temp, join(root, 'current')); }
      finally { fs.rmSync(temp, { force: true }); }
    };
    // State is authoritative: repair an interruption between state and pointer renames.
    pointer();
    const save = () => atomicJSON(stateFile, state);
    const releases = () => fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(join(root, e.name, 'release.json'))).map(e => e.name).sort().reverse();
    // Never delete what a live session host or the coordinator still runs from: each stays on its release until it restarts.
    const prune = (keep) => {
      const home = options.loomHome ?? process.env.LOOM_HOME ?? join(homedir(), '.tango/loom');
      const live = [...liveHostLedgers(home, options.processStart), ...liveCoordinator(home, options.processStart)].map(host => host.release).filter(Boolean);
      const protectedIds = new Set([state.current, state.previous, ...state.candidates, ...Object.values(state.pins), ...live]);
      for (const id of releases().filter(id => !protectedIds.has(id)).slice(keep)) {
        remove(join(root, id)); record('prune', id, null); save(); console.log(`Pruned ${id}`);
      }
    };
    const validate = (id) => {
      if (!id || !/^[a-zA-Z0-9-]+$/.test(id) || !releases().includes(id)) throw new Error(`Unknown release: ${id}`);
      return id;
    };
    const record = (action, from, to) => state.history.push({ at: new Date().toISOString(), action, from, to });
    const [command, ...rest] = args;
    if (command === 'build') {
      if (rest.some(a => a !== '--allow-dirty')) throw new Error('Usage: build [--allow-dirty]');
      const git = (...a) => execFileSync('git', a, { cwd: pkg, encoding: 'utf8' }).trim();
      const sha = git('rev-parse', 'HEAD');
      // The build also reads the root tsconfig and the lockfile that pins the shipped dependencies.
      const dirty = !!git('status', '--porcelain', '--untracked-files=all', '--', '.', ':(top)tsconfig.base.json', ':(top)package.json', ':(top)package-lock.json', ':(top)config/decisions/board.yaml', ':(top)AGENTS.md');
      if (dirty && !rest.includes('--allow-dirty')) throw new Error('Uncommitted changes in packages/loom or its root build inputs; use --allow-dirty');
      (options.build ?? (() => execFileSync('npm', ['run', 'build'], { cwd: pkg, stdio: 'inherit' })))();
      // IDs have second precision. Wait for an unused second rather than rewriting a release.
      let id;
      do {
        id = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + '-' + sha.slice(0, 7) + (dirty ? '-dirty' : '');
        if (fs.existsSync(join(root, id))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      } while (fs.existsSync(join(root, id)));
      const stage = join(root, `.building-${randomUUID()}`);
      fs.mkdirSync(stage);
      try {
        const sourceRoot = resolve(pkg, '../..');
        // Runtime prompts are versioned with the release, never read from a thread's cwd.
        fs.copyFileSync(join(sourceRoot, 'AGENTS.md'), join(stage, 'AGENTS.md'));
        const releasePkg = join(stage, 'packages/loom');
        fs.mkdirSync(releasePkg, { recursive: true });
        fs.cpSync(join(pkg, 'dist'), join(releasePkg, 'dist'), { recursive: true, dereference: true });
        fs.copyFileSync(join(pkg, 'package.json'), join(releasePkg, 'package.json'));
        // The delegation board the decision tools read (src/decisions.ts loadBoard: beside dist in a release).
        const board = join(sourceRoot, 'config/decisions/board.yaml');
        if (fs.existsSync(board)) fs.copyFileSync(board, join(releasePkg, 'board.yaml'));
        const closure = (options.productionPaths ?? (() => execFileSync('npm',
          ['ls', '-w', '@tango/loom', '--omit=dev', '--all', '--parseable'],
          { cwd: sourceRoot, encoding: 'utf8' })))().trim().split(/\r?\n/);
        const paths = [...new Set(closure.map(p => resolve(p)))].filter(p =>
          p !== sourceRoot && p !== join(sourceRoot, 'node_modules/@tango/loom'));
        const dependencies = {};
        const dependencyLocations = {};
        // Record every location, including nested packages and multiple versions of a name.
        for (const path of paths.sort((a, b) => b.length - a.length || a.localeCompare(b))) {
          const location = relative(sourceRoot, path);
          if (isAbsolute(location) || location === '..' || location.startsWith('../') ||
              !(location.startsWith('node_modules/') || location.startsWith('packages/loom/node_modules/'))) {
            throw new Error(`Dependency outside release layout: ${path}`);
          }
          const { name, version } = readJSON(join(path, 'package.json'));
          dependencies[name] ??= version;
          dependencyLocations[location] = { name, version };
        }
        // Copy parents first; their nested node_modules already contain their closure.
        const copied = [];
        for (const path of paths.sort((a, b) => a.length - b.length || a.localeCompare(b))) {
          if (copied.some(parent => path.startsWith(parent + '/'))) continue;
          const dest = join(stage, relative(sourceRoot, path));
          fs.mkdirSync(dirname(dest), { recursive: true });
          fs.cpSync(path, dest, { recursive: true, dereference: true });
          copied.push(path);
        }
        const require = createRequire(join(pkg, 'package.json'));
        const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
        const info = { id, gitSha: sha, dirty, buildTime: new Date().toISOString(), nodeVersion: process.version,
          sdkVersion: readJSON(join(sdkDir, 'package.json')).version, dependencies, dependencyLocations };
        if (fs.existsSync(join(pkg, 'src/host-protocol.ts')) && /export\s+const\s+HOST_PROTOCOL\b/.test(fs.readFileSync(join(pkg, 'src/host-protocol.ts'), 'utf8'))) {
          const protocol = readProtocol(join(releasePkg, 'dist/host-protocol.js'));
          if (protocol !== undefined) info.hostProtocol = protocol;
          // The protocol this release's own session hosts speak: a running coordinator only routes
          // threads to a release whose hosts it can talk to (Codex review on #651).
          const speaks = fs.readFileSync(join(releasePkg, 'dist/host-protocol.js'), 'utf8').match(/export\s+const\s+HOST_PROTOCOL\s*=\s*(\d+)\s*;/);
          if (speaks) info.hostSpeaks = Number(speaks[1]);
        }
        atomicJSON(join(stage, 'release.json'), info);
        permissions(stage, false);
        fs.renameSync(stage, join(root, id));
      } catch (error) { if (fs.existsSync(stage)) remove(stage); throw error; }
      state.candidates.push(id); record('build', null, id); save();
      console.log(`Built ${id} (candidate)`);
      return id;
    }
    if (command === 'promote' || command === 'rollback') {
      const from = state.current;
      const oldPrevious = state.previous;
      const to = validate(command === 'rollback' ? state.previous : rest[0]);
      if (command === 'promote' && !state.candidates.includes(to)) throw new Error('Only candidates can be promoted');
      if (to === from) throw new Error('Release is already current');
      assertHostProtocols(join(root, to, 'release.json'), options.loomHome ?? process.env.LOOM_HOME ?? join(homedir(), '.tango/loom'), options.processStart);
      state.current = to; state.previous = from;
      state.candidates = state.candidates.filter(id => id !== to);
      record(command, from, to); save(); pointer();
      console.log(`${command}: current ${from ?? 'none'} -> ${to}; previous ${oldPrevious ?? 'none'} -> ${state.previous ?? 'none'}. Coordinator needs a restart to pick it up.`);
      // Every move would otherwise leave one more release (~0.3 GB) behind forever.
      try { prune(PRUNE_KEEP); }
      catch (error) { console.error(`Prune after ${command} skipped: ${error.message}`); }
    } else if (command === 'pin') {
      const [thread, id] = rest;
      if (!thread || !id) throw new Error('Usage: pin <threadId> <id|none>');
      if (id === 'none') delete state.pins[thread];
      else Object.defineProperty(state.pins, thread, { value: validate(id), enumerable: true, configurable: true, writable: true });
      record('pin', thread, id); save(); console.log(`Pin ${thread}: ${id}`);
    } else if (command === 'list') {
      console.log('RELEASE\tSTATUS\tBYTES');
      for (const id of releases()) console.log(`${id}\t${[state.current === id && 'current', state.previous === id && 'previous', state.candidates.includes(id) && 'candidate', Object.values(state.pins).includes(id) && 'pinned'].filter(Boolean).join(',')}\t${size(join(root, id))}`);
    } else if (command === 'prune') {
      if (rest.length && (rest[0] !== '--keep' || rest.length !== 2)) throw new Error('Usage: prune [--keep N]');
      const keep = rest.length ? Number(rest[1]) : PRUNE_KEEP;
      if (!Number.isInteger(keep) || keep < 0) throw new Error('--keep must be a nonnegative integer');
      prune(keep);
    } else throw new Error('Usage: release.mjs build|list|promote <id>|rollback|pin <threadId> <id|none>|prune [--keep N]');
  } finally { fs.rmdirSync(lock); }
}
/** Unprotected releases kept as extra rollback targets by `prune` and after every promote or rollback. */
export const PRUNE_KEEP = 5;
/** Ledger identity must still match: stale files never block a release. */
export function processStart(pid) {
  try { return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; }
    throw new Error(`Cannot verify start time of live process ${pid}`);
  }
}
export function liveHostLedgers(home, startTime = processStart) {
  const dir = join(home, 'hosts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).flatMap(name => {
    let host;
    try { host = readJSON(join(dir, name)); } catch { return []; }
    if (!Number.isInteger(host.pid) || host.pid <= 1 || !host.started) return [];
    const started = startTime(host.pid);
    return started === host.started ? [host] : [];
  });
}
/** The running coordinator's own release (it may predate several promotes until it restarts). */
export function liveCoordinator(home, startTime = processStart) {
  let coordinator;
  try { coordinator = readJSON(join(home, 'coordinator.json')); } catch { return []; }
  if (!Number.isInteger(coordinator.pid) || coordinator.pid <= 1 || !coordinator.started) return [];
  return startTime(coordinator.pid) === coordinator.started ? [coordinator] : [];
}
export function assertHostProtocols(manifest, home, startTime) {
  const declared = readJSON(manifest).hostProtocol;
  // Scalar manifests from the first release builder remain readable.
  const supported = new Set(Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]);
  for (const host of liveHostLedgers(home, startTime)) {
    if (!supported.has(host.protocol)) throw new Error(`Release drops live host protocol ${host.protocol} (thread ${host.threadId}); drain that host before promoting`);
  }
}
// Read the exported literal without loading host code or starting any services.
function readProtocol(file) {
  const source = fs.readFileSync(file, 'utf8');
  const supported = source.match(/export\s+const\s+SUPPORTED_HOST_PROTOCOLS\s*=\s*new Set\(\s*(\[[\d,\s]*\])\s*\)/);
  if (supported) return JSON.parse(supported[1]);
  const match = source.match(/export\s+const\s+HOST_PROTOCOL\s*=\s*(\d+|"[^"\n]*"|'[^'\n]*')\s*;/);
  if (!match) throw new Error('HOST_PROTOCOL must be a number or string literal');
  return [match[1].startsWith("'") ? match[1].slice(1, -1) : JSON.parse(match[1])];
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
