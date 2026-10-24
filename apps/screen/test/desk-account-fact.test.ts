import { describe, expect, it, vi } from 'vitest';
import { DeskLoomSource } from '../server/desk/source-loom.js';
import { makeHarness } from './desk-harness.js';

describe('read-time Loom account fact', () => {
  it('overlays cached accounts on all read paths without storing them', () => {
    const accounts = new Map<string, string | null>([['loom:a', 'seat-a']]);
    const readAccounts = vi.fn(() => accounts);
    const h = makeHarness({ adapters: [{ owns: () => true, done: async () => ({ ok: true }), reply: async () => ({ ok: true }), accounts: readAccounts }] });
    try {
      for (const id of ['loom:a', 'loom:unknown', 't3:a']) h.core.ensureItem({ id, source: id.startsWith('loom:') ? 'loom' : 't3', kind: 'thread', conversationKey: id, agentId: 'test', agentName: 'Test', place: 'test', createdAt: 1 }, 'agent');
      readAccounts.mockClear();
      expect(h.core.item('loom:a')!.facts.account).toBe('seat-a');
      expect(h.core.itemsByIds(['loom:a'])[0].facts.account).toBe('seat-a');
      expect(h.core.items().find((item) => item.id === 'loom:unknown')!.facts.account).toBeNull();
      expect(h.core.item('t3:a')!.facts.account).toBeUndefined();
      expect(readAccounts).toHaveBeenCalledTimes(1);
      expect(h.core.store.item('loom:a')!.facts.account).toBeUndefined();
      accounts.set('loom:a', 'seat-b');
      h.clock.now += 5000;
      expect(h.core.item('loom:a')!.facts.account).toBe('seat-b');
      accounts.set('loom:a', null);
      h.clock.now += 5000;
      expect(h.core.item('loom:a')!.facts.account).toBeNull();
    } finally { h.close(); }
  });

  it('caches accounts from existing ingestion, including an unknown account before the first turn', () => {
    const h = makeHarness();
    try {
      const source = new DeskLoomSource({ core: h.core, url: 'http://unused.invalid', tokenFile: 'unused' });
      const ingest = (account?: string | null) => (source as unknown as { ingest(detail: unknown): void }).ingest({
        thread: { id: 'a', kind: 'tango-agent', account }, runs: [], messages: [], requests: [],
      });
      ingest('seat-a');
      expect(source.accounts().get('loom:a')).toBe('seat-a');
      ingest('seat-b');
      expect(source.accounts().get('loom:a')).toBe('seat-b');
      ingest();
      expect(source.accounts().get('loom:a')).toBeNull();
    } finally { h.close(); }
  });
});
