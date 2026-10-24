import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { load } from 'js-yaml';
import { parse, stringify } from 'smol-toml';

// TOML parser objects have a null prototype; compare values, not prototypes.
const normalize = (v: any): any => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, normalize(value)])) : v;
const equal = (a: unknown, b: unknown) => isDeepStrictEqual(normalize(a), normalize(b));
const marker = 'TANGO_TOOLKIT_OWNER';
type Server = { command: string; args: string[]; env: Record<string, string>; type?: string };
type Tool = { toolId: string; workerId: string; readOnly: boolean; workspaces?: string[] };
type Client = { kind: 'claude' | 'codex'; configPath: string; include?: string[]; exclude?: string[] };
export type Manifest = { version: 1; id: string; port?: number; tools: Record<string, Tool>; clients: Client[] };
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const name = /^[a-zA-Z0-9_-]+$/;
export function readManifest(raw: string): Manifest {
  const m = load(raw);
  if (!object(m) || m.version !== 1 || typeof m.id !== 'string' || !name.test(m.id) || !object(m.tools) || !Array.isArray(m.clients)) throw new Error('Invalid toolkit manifest');
  if (m.port !== undefined && (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535)) throw new Error('Invalid port');
  for (const [key, t] of Object.entries(m.tools)) {
    if (!name.test(key) || !object(t) || typeof t.toolId !== 'string' || !name.test(t.toolId) || typeof t.workerId !== 'string' || !name.test(t.workerId) || typeof t.readOnly !== 'boolean') throw new Error(`Invalid tool: ${key}`);
    if (t.workspaces !== undefined && (!Array.isArray(t.workspaces) || t.workspaces.some((w: unknown) => typeof w !== 'string'))) throw new Error(`Invalid workspace notes: ${key}`);
  }
  for (const c of m.clients) {
    if (!object(c) || !['claude', 'codex'].includes(c.kind) || typeof c.configPath !== 'string' || !(path.isAbsolute(c.configPath) || c.configPath.startsWith('~/'))) throw new Error('Client needs kind and absolute configPath (or ~/...)');
    for (const key of ['include', 'exclude']) if (c[key] !== undefined && (!Array.isArray(c[key]) || c[key].some((n: unknown) => typeof n !== 'string' || !Object.hasOwn(m.tools, n)))) throw new Error(`Unknown tool in ${key}`);
  }
  return m as Manifest;
}
export function desiredServers(m: Manifest, client: Client, proxy: string): Record<string, Server> {
  return Object.fromEntries(Object.entries(m.tools).filter(([n]) => (!client.include || client.include.includes(n)) && !client.exclude?.includes(n)).map(([n, t]) => [n, {
    ...(client.kind === 'claude' ? { type: 'stdio' } : {}), command: 'node', args: [proxy], env: {
      ALLOWED_TOOL_IDS: t.toolId, MCP_SERVER_PORT: String(m.port ?? 9100), WORKER_ID: t.workerId,
      ...(t.readOnly ? { READ_ONLY_STEP: '1' } : {}), [marker]: m.id,
    },
  }]));
}
function merged(current: Record<string, any>, desired: Record<string, Server>, owner: string, adopt: boolean) {
  const result = { ...current };
  for (const [n, s] of Object.entries(current)) if (s?.env?.[marker] === owner) delete result[n];
  for (const [n, s] of Object.entries(desired)) {
    const old = Object.hasOwn(current, n) ? current[n] : undefined;
    if (Object.hasOwn(current, n) && old?.env?.[marker] !== owner) {
      const unmarked = structuredClone(s); delete unmarked.env[marker];
      if (!adopt || !equal(old, unmarked)) throw new Error(`Refusing to overwrite unowned server ${n}; --adopt-existing only accepts exact matches`);
    }
    Object.defineProperty(result, n, { value: s, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
export function mergeJson(raw: string, desired: Record<string, Server>, owner: string, adopt = false): string {
  const data = raw ? JSON.parse(raw) : {};
  if (!object(data) || (data.mcpServers !== undefined && !object(data.mcpServers))) throw new Error('Invalid Claude config');
  const next = { ...data, mcpServers: merged(data.mcpServers ?? {}, desired, owner, adopt) };
  if (equal(data, next)) return raw;
  return JSON.stringify(next, null, 2) + '\n';
}
export function mergeToml(raw: string, desired: Record<string, Server>, owner: string, adopt = false): string {
  const data = parse(raw);
  if (data.mcp_servers !== undefined && !object(data.mcp_servers)) throw new Error('Invalid mcp_servers');
  const current = (data.mcp_servers ?? {}) as Record<string, any>;
  const servers = merged(current, desired, owner, adopt);
  if (equal(current, servers)) return raw;
  const changed = new Set([...Object.keys(current), ...Object.keys(servers)].filter(n => !equal(current[n], servers[n])));
  // Edit only complete server tables; validate the resulting document against the
  // semantic merge below. Unusual TOML layouts fail closed instead of reformatting.
  const headers = [...raw.matchAll(/^[ \t]*\[[^\r\n]+\][^\r\n]*(?:\r?\n|$)/gm)].filter(h => {
    // A header inside a multiline string/array has an incomplete prefix.
    try { parse(raw.slice(0, h.index)); return true; } catch { return false; }
  });
  let out = raw.slice(0, headers[0]?.index ?? raw.length);
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const section = raw.slice(h.index, headers[i + 1]?.index ?? raw.length);
    let keys: string[] = [];
    try { const parsed = parse(h[0]); keys = Object.keys((parsed.mcp_servers ?? {}) as object); } catch { /* verified below */ }
    if (!keys.some(k => changed.has(k))) out += section;
    else {
      // Keep trailing comments/spacing that introduce the next untouched table.
      const lines = section.split('\n');
      let trailing = lines.length;
      while (trailing > 0 && /^[ \t\r]*(?:#.*)?$/.test(lines[trailing - 1]!)) trailing--;
      out += lines.slice(trailing).join('\n');
    }
  }
  const additions = Object.fromEntries([...changed].filter(n => Object.hasOwn(servers, n)).map(n => [n, servers[n]]));
  if (Object.keys(additions).length) out += (out.endsWith('\n') ? '\n' : '\n\n') + stringify({ mcp_servers: additions });
  if (!Object.keys(servers).length && !parse(out).mcp_servers) out += '\n[mcp_servers]\n';
  if (!equal(parse(out), { ...data, mcp_servers: servers })) throw new Error('Unsupported TOML layout: no files written');
  return out;
}
export function resolveProxy(): string {
  return fileURLToPath(new URL('../../core/dist/mcp-proxy.js', import.meta.url));
}
export function syncToolkit(m: Manifest, options: { dryRun?: boolean; adoptExisting?: boolean; proxy?: string; log?: (s: string) => void } = {}) {
  const proxy = options.proxy ?? resolveProxy();
  if (!fs.existsSync(proxy)) throw new Error(`Build Tango core first: ${proxy}`);
  const log = options.log ?? console.log;
  const paths = new Set<string>();
  const plans = m.clients.map(c => {
    const target = path.resolve(c.configPath.startsWith('~/') ? path.join(os.homedir(), c.configPath.slice(2)) : c.configPath);
    if (paths.has(target)) throw new Error(`Duplicate client path: ${target}`);
    paths.add(target);
    if (fs.lstatSync(target, { throwIfNoEntry: false }) && !fs.lstatSync(target).isFile()) throw new Error(`Config must be a regular file: ${target}`);
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const desired = desiredServers(m, c, proxy);
    const after = (c.kind === 'claude' ? mergeJson : mergeToml)(before, desired, m.id, options.adoptExisting);
    return { target, before, after, exists: fs.existsSync(target) };
  });
  for (const p of plans) {
    if (p.before === p.after) { log(`unchanged ${p.target}`); continue; }
    // Diff only toolkit entries, never unrelated credentials in the client config.
    const c = m.clients[plans.indexOf(p)]!;
    const entries = (s: string) => c.kind === 'claude' ? JSON.parse(s || '{}').mcpServers ?? {} : parse(s).mcp_servers ?? {};
    const before = entries(p.before), after = entries(p.after);
    log(`--- ${p.target}\n+++ ${p.target}`);
    for (const n of new Set([...Object.keys(before), ...Object.keys(after)])) if (!equal(before[n], after[n])) {
      if (before[n]) log(`- ${n}: ${JSON.stringify(before[n])}`);
      if (after[n]) log(`+ ${n}: ${JSON.stringify(after[n])}`);
    }
  }
  if (options.dryRun) return plans;
  for (const p of plans.filter(p => p.before !== p.after)) {
    if (fs.existsSync(p.target) !== p.exists || (p.exists && fs.readFileSync(p.target, 'utf8') !== p.before)) throw new Error(`Config changed during sync: ${p.target}`);
    fs.mkdirSync(path.dirname(p.target), { recursive: true });
    const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    if (p.exists) { const backup = `${p.target}.bak-toolkit-${suffix}`; fs.copyFileSync(p.target, backup, fs.constants.COPYFILE_EXCL); fs.chmodSync(backup, 0o600); log(`backup ${backup}`); }
    const temp = `${p.target}.tmp-${suffix}`;
    try { fs.writeFileSync(temp, p.after, { flag: 'wx', mode: p.exists ? fs.statSync(p.target).mode & 0o777 : 0o600 }); fs.renameSync(temp, p.target); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return plans;
}
