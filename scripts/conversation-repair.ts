#!/usr/bin/env tsx
/** Repair a specified store only; defaults to a read-only dry run. No network or service actions. */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { loadLayeredV2AgentConfigs, resolveConfigDir } from '@tango/core';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help')) {
  console.log('conversation-repair.ts --db <copy.sqlite> [--config-dir <config>] [--discord-snapshot <json>] [--apply]\nDefaults to dry-run. Snapshot is an array of verified Discord messages with id, channel_id and type. Repairs chunk ordering, home ownership and system-event metadata; never deletes text or rows.');
  process.exit(0);
}
const file = option('--db');
if (!file) throw new Error('Explicit --db required; no live-profile default');
if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('Choose --apply or --dry-run');
const apply = args.includes('--apply');
const db = new DatabaseSync(path.resolve(file), { readOnly: !apply });
try {
  if (apply) db.exec('BEGIN IMMEDIATE');
  const agents = loadLayeredV2AgentConfigs(resolveConfigDir(option('--config-dir')));
  const owners = new Map<string, string>();
  for (const agent of agents.values()) {
    const home = agent.discord?.defaultChannelId;
    if (!home) continue;
    if (owners.has(home)) throw new Error('Ambiguous home-channel ownership');
    owners.set(home, agent.id);
  }
  type Evidence = { id: string; channel_id: string; type: number };
  const evidence: Evidence[] = option('--discord-snapshot') ? JSON.parse(fs.readFileSync(option('--discord-snapshot')!, 'utf8')) : [];
  if (!Array.isArray(evidence) || evidence.some(p => !/^\d+$/.test(p.id) || !/^\d+$/.test(p.channel_id) || !Number.isInteger(p.type))) throw new Error('Invalid Discord snapshot');
  const byId = new Map(evidence.map(p => [p.id, p]));
  const updates: Array<{ id: number; ids: string; metadata: string }> = [];
  const counts = { chunkOrder: 0, conversationOwner: 0, systemEvent: 0 };
  for (const row of db.prepare('SELECT id,conversation_key,discord_message_ids,metadata_json FROM messages WHERE conversation_key IS NOT NULL').all() as unknown as Array<{ id: number; conversation_key: string; discord_message_ids: string; metadata_json: string | null }>) {
    const ids = JSON.parse(row.discord_message_ids) as string[];
    if (ids.some(id => !/^\d+$/.test(id))) throw new Error(`Invalid mirror id on row ${row.id}`);
    const sorted = [...new Set(ids)].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    const metadata = JSON.parse(row.metadata_json ?? '{}');
    let changed = false;
    if (JSON.stringify(sorted) !== row.discord_message_ids) { counts.chunkOrder++; changed = true; }
    const event = sorted.length === 1 ? byId.get(sorted[0]!) : undefined;
    if (event && event.channel_id === row.conversation_key.split(':')[1] && ![0, 19].includes(event.type) && metadata.discordMessageType !== event.type) {
      metadata.discordMessageType = event.type; counts.systemEvent++; changed = true;
    }
    if (changed) updates.push({ id: row.id, ids: JSON.stringify(sorted), metadata: JSON.stringify(metadata) });
  }
  const conversations = (db.prepare('SELECT conversation_key,agent_id,discord_channel_id FROM conversations').all() as unknown as Array<{ conversation_key: string; agent_id: string; discord_channel_id: string }>)
    .flatMap(row => {
      const owner = owners.get(row.discord_channel_id);
      return owner && owner !== row.agent_id ? [{ key: row.conversation_key, owner }] : [];
    });
  counts.conversationOwner = conversations.length;
  if (apply) {
    try {
      for (const row of updates) db.prepare('UPDATE messages SET discord_message_ids=?,metadata_json=? WHERE id=?').run(row.ids, row.metadata, row.id);
      for (const row of conversations) {
        db.prepare('UPDATE conversations SET agent_id=? WHERE conversation_key=?').run(row.owner, row.key);
        // Publish the metadata repair through the existing message revision stream.
        db.prepare('UPDATE messages SET content=content WHERE id=(SELECT MIN(id) FROM messages WHERE conversation_key=?)').run(row.key);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  console.log(JSON.stringify({ dryRun: !apply, ...counts, updatedMessages: updates.length }));
} finally { db.close(); }
