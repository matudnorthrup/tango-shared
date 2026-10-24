import { describe, expect, it } from 'vitest';
import { parseSearchFields, searchQuery, searchMatches } from '../server/desk/search-query.js';
import { DeskSearch } from '../server/desk/search.js';
import { makeHarness, NOW } from './desk-harness.js';

describe('server search narrowing', () => {
  it('parses fields and dates, preserves unknown tokens and resolves quoted spaces and agents', () => {
    const parsed = parseSearchFields('router is:needs kind:thread in:"Desk folder" agent:"Named Agent" type:bug stage:review repo:"main repo" before:7d after:2026-01-01 unknown:value is:nope before:2026-02-31', [{ id: 'project:folder', name: 'Desk folder' }], [{ id: 'named', name: 'Named Agent' }], NOW);
    expect(parsed.text.replace(/\s+/g, ' ')).toBe('router unknown:value is:nope before:2026-02-31');
    expect(parsed.tokens).toHaveLength(9);
    expect(parsed.queries[2].scope).toMatchObject({ id: 'project:folder' });
    expect(parsed.queries[3].where).toEqual({ agent: { in: ['named'] } });
    expect(parsed.before).toBe(NOW - 7 * 86_400_000);
    expect(parsed.after).toBe(Date.parse('2026-01-01'));
    for (const value of ['ready', 'todo', 'working', 'watching', 'failed', 'unread', 'pinned']) expect(parseSearchFields(`is:${value}`).tokens).toHaveLength(1);
  });
  it('rejects invalid facets and scope instead of broadening a search', () => {
    for (const where of ['null', '[]', '{"nope":{}}', '{"agent":{"in":"x"}}', '{"type":{"unset":1}}']) expect(() => searchQuery(where)).toThrow();
    expect(() => searchQuery('{}', 'space:wrong')).toThrow();
    expect(() => searchQuery('{}', 'global', 'nobody')).toThrow();
  });
  it('uses snapshot metadata but excludes archives only for selected unavailable facets', () => {
    const row = { archived: true, lastActivityAt: NOW, source: 'loom', kind: 'thread', agentId: 'loom', area: 'repo', facts: { projectId: 'folder', type: 'bug', pinned: true } };
    const fields = parseSearchFields('repo:repo type:bug is:pinned');
    expect(searchMatches(row, [searchQuery('{}', 'space:project:folder')], fields, { projects: [{ id: 'folder' }] })).toBe(true);
    for (const facet of ['live', 'unread', 'busy', 'disposition']) expect(searchMatches(row, [searchQuery(JSON.stringify({ [facet]: { unset: true } }))], fields, {})).toBe(false);
    expect(searchMatches(row, [searchQuery('{"unread":{}}')], fields, {})).toBe(true);
    expect(searchMatches(row, [], parseSearchFields('before:1d', [], [], NOW), {})).toBe(false);
    expect(searchMatches(row, [], parseSearchFields('after:1d', [], [], NOW), {})).toBe(true);
  });
  it('finds a match below the old cap and counts before limiting within the 300-candidate budget', async () => {
    const h = makeHarness();
    try {
      const search = new DeskSearch({ db: h.db });
      const insert = h.db.prepare("INSERT INTO search_docs (item_id, source, kind, agent_id, agent_name, title) VALUES (?, 'loom', 'thread', 'loom', 'Loom', ?)");
      for (let i = 0; i < 305; i++) insert.run(`higher-${i}`, 'Router');
      insert.run('wanted', 'Router with many extra words to rank below short titles');
      const start = performance.now();
      const result = await search.search('router', { limit: 1, semantic: false, eligible: (id) => id === 'wanted', narrowed: true });
      expect(performance.now() - start).toBeLessThan(5000);
      expect(result).toMatchObject({ total: 1, more: false, hits: [{ itemId: 'wanted' }] });
      // A plain search keeps the old 300-title pool, and says its count is a lower bound when that pool is full.
      expect(await search.search('router', { limit: 1, semantic: false })).toMatchObject({ total: 300, more: true });
      expect(await search.search('router', { limit: 1, semantic: false, narrowed: true })).toMatchObject({ total: 306, more: false });
      expect(await search.search('', { limit: 1, semantic: false, eligible: (id) => id === 'wanted', narrowed: true })).toMatchObject({ total: 1, hits: [{ itemId: 'wanted' }] });
    } finally { h.close(); }
  });
  it('flags a lower bound when the candidate pool reaches its cap', async () => {
    const h = makeHarness();
    try {
      const search = new DeskSearch({ db: h.db });
      const insert = h.db.prepare("INSERT INTO search_docs (item_id, source, kind, agent_id, agent_name, title) VALUES (?, 'loom', 'thread', 'loom', 'Loom', 'Router')");
      h.db.exec('BEGIN');
      for (let i = 0; i < 10001; i++) insert.run(`archive-${i}`);
      h.db.exec('COMMIT');
      const result = await search.search('router', { limit: 1, semantic: false, narrowed: true });
      expect(result).toMatchObject({ total: 10000, more: true });
      expect(result.hits).toHaveLength(1);
    } finally { h.close(); }
  });
});

describe('search review fixes (Codex review on #799)', () => {
  it('counts strict matches within the filters before skipping the any-word fallback', async () => {
    const h = makeHarness();
    try {
      const search = new DeskSearch({ db: h.db });
      const doc = h.db.prepare("INSERT INTO search_docs (item_id, source, kind, agent_id, agent_name, title) VALUES (?, 'loom', 'thread', 'loom', 'Loom', ?)");
      const msg = h.db.prepare("INSERT INTO search_messages (message_id, item_id, author, at, text) VALUES (?, ?, 'agent', 1, ?)");
      for (let i = 0; i < 6; i++) { doc.run(`out-${i}`, `Thread ${i}`); msg.run(`m-out-${i}`, `out-${i}`, 'the router firmware is flaky'); }
      doc.run('mine', 'Mine');
      msg.run('m-mine', 'mine', 'the router reboots at night');
      // Six out-of-scope conversations say both words; the in-scope one says only "router".
      const result = await search.search('router firmware', { limit: 10, semantic: false, eligible: (id) => id === 'mine', narrowed: true });
      expect(result.hits.map((hit) => hit.itemId)).toEqual(['mine']);
    } finally { h.close(); }
  });
});
