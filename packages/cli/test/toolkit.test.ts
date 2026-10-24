import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { desiredServers, mergeJson, mergeToml, readManifest, syncToolkit, type Manifest } from '../src/toolkit.js';
const manifest: Manifest = { version: 1, id: 'personal', tools: { 'tango-example': { toolId: 'example', workerId: 'assistant', readOnly: true } }, clients: [] };
const client = { kind: 'claude' as const, configPath: '/example/config.json' };
const jsonServers = desiredServers(manifest, client, '/install/proxy.js');
const tomlServers = desiredServers(manifest, { ...client, kind: 'codex' }, '/install/proxy.js');
describe('toolkit merge', () => {
  it('preserves JSON settings and unrelated servers, and is idempotent', () => {
    const raw = JSON.stringify({ other: 4, mcpServers: { acme: { command: 'other' } } });
    const next = mergeJson(raw, jsonServers, manifest.id);
    expect(JSON.parse(next).mcpServers.acme).toEqual({ command: 'other' });
    expect(JSON.parse(next).other).toBe(4);
    expect(mergeJson(next, jsonServers, manifest.id)).toBe(next);
    expect(JSON.parse(mergeJson(next, {}, manifest.id)).mcpServers).toEqual({ acme: { command: 'other' } });
  });
  it('refuses foreign ownership and only explicitly adopts exact matches', () => {
    const old = structuredClone(jsonServers); delete old['tango-example']!.env.TANGO_TOOLKIT_OWNER;
    const raw = JSON.stringify({ mcpServers: old });
    expect(() => mergeJson(raw, jsonServers, manifest.id)).toThrow('unowned');
    expect(mergeJson(raw, jsonServers, manifest.id, true)).toContain('TANGO_TOOLKIT_OWNER');
    old['tango-example']!.env.EXTRA = 'keep';
    expect(() => mergeJson(JSON.stringify({ mcpServers: old }), jsonServers, manifest.id, true)).toThrow('unowned');
    expect(() => mergeJson(mergeJson(raw, jsonServers, manifest.id, true), jsonServers, 'different', true)).toThrow('unowned');
  });
  it('preserves unrelated TOML text, comments, nested tables and quoted names', () => {
    const untouched = '# keep me\nmodel = "example"\n\n[mcp_servers."other-server"] # comment\ncommand = "other"\n[mcp_servers."other-server".env]\nEXAMPLE = "value"\n';
    const next = mergeToml(untouched, tomlServers, manifest.id);
    expect(next.startsWith(untouched)).toBe(true);
    expect(mergeToml(next, tomlServers, manifest.id)).toBe(next);
    const removed = mergeToml(next, {}, manifest.id);
    expect(parse(removed)).toEqual(parse(untouched));
    expect(removed.startsWith(untouched)).toBe(true);
  });
  it('keeps comments introducing an untouched table after a removed server', () => {
    const raw = stringify({ mcp_servers: tomlServers }) + '\n# Next server stays here\n[mcp_servers.other]\ncommand = "other"\n';
    expect(mergeToml(raw, {}, manifest.id)).toContain('# Next server stays here\n[mcp_servers.other]\ncommand = "other"');
  });
  it('adopts TOML and updates permissions without leaving stale env', () => {
    const old = structuredClone(tomlServers); delete old['tango-example']!.env.TANGO_TOOLKIT_OWNER;
    const raw = stringify({ mcp_servers: old });
    expect(() => mergeToml(raw, tomlServers, manifest.id)).toThrow('unowned');
    const next = mergeToml(raw, tomlServers, manifest.id, true);
    const writable = structuredClone(tomlServers); delete writable['tango-example']!.env.READ_ONLY_STEP;
    expect(mergeToml(next, writable, manifest.id)).not.toContain('READ_ONLY_STEP');
    expect(parse(mergeToml(next, {}, manifest.id)).mcp_servers ?? {}).toEqual({});
  });
  it('rejects unsupported inline TOML without losing data', () => {
    const raw = 'mcp_servers = ' + '{ "tango-example" = { command = "node", env = { TANGO_TOOLKIT_OWNER = "personal" } } }\n';
    expect(() => mergeToml(raw, tomlServers, manifest.id)).toThrow();
  });
  it('refuses malformed unowned entries and preserves foreign markers on removal', () => {
    expect(() => mergeJson('{"mcpServers":{"tango-example":null}}', jsonServers, manifest.id)).toThrow('unowned');
    const foreign = JSON.stringify({ mcpServers: { other: { env: { TANGO_TOOLKIT_OWNER: 'other' } } } });
    expect(mergeJson(foreign, {}, manifest.id)).toBe(foreign);
  });
  it('does not mistake multiline TOML content for editable server tables', () => {
    const raw = 'note = """\n[mcp_servers.tango-example]\nthis is text\n"""\n';
    const next = mergeToml(raw, tomlServers, manifest.id);
    expect(parse(next).note).toEqual(parse(raw).note);
  });
  it('validates manifests and applies include/exclude', () => {
    expect(() => readManifest('version: 1\nid: x\ntools: {}\nclients: [{kind: codex, configPath: relative}]')).toThrow();
    expect(desiredServers(manifest, { ...client, exclude: ['tango-example'] }, 'proxy')).toEqual({});
  });
  it('dry runs without files, backs up exact bytes, and refuses conflicts before writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolkit-test-'));
    try {
      const target = path.join(dir, 'config.json'), proxy = path.join(dir, 'proxy.js');
      fs.writeFileSync(proxy, ''); fs.writeFileSync(target, '{"other":true}');
      const m = { ...manifest, clients: [{ ...client, configPath: target }] };
      syncToolkit(m, { proxy, dryRun: true, log: () => {} });
      expect(fs.readFileSync(target, 'utf8')).toBe('{"other":true}');
      syncToolkit(m, { proxy, log: () => {} });
      const backups = fs.readdirSync(dir).filter(n => n.includes('.bak-toolkit-'));
      expect(backups).toHaveLength(1); expect(fs.readFileSync(path.join(dir, backups[0]!), 'utf8')).toBe('{"other":true}');
      syncToolkit(m, { proxy, log: () => {} });
      expect(fs.readdirSync(dir).filter(n => n.includes('.bak-toolkit-'))).toHaveLength(1);
      const fresh = path.join(dir, 'fresh.json');
      fs.writeFileSync(target, '{"mcpServers":{"tango-example":{"command":"foreign"}}}');
      expect(() => syncToolkit({ ...m, clients: [{ ...client, configPath: fresh }, ...m.clients] }, { proxy, log: () => {} })).toThrow('unowned');
      expect(fs.existsSync(fresh)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true }); }
  });
});
