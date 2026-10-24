/**
 * Diagnostic: fetch messages from a thread by ID.
 * Usage: npx tsx scripts/testing/inspect-thread.ts <thread-id>
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits } from 'discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const threadId = process.argv[2];
if (!threadId) {
  console.error('Usage: npx tsx inspect-thread.ts <thread-id>');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

async function main() {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Login timeout')), 15_000);
    client.once('clientReady', () => { clearTimeout(timeout); resolve(); });
    client.login(process.env['DISCORD_TOKEN']).catch((err) => { clearTimeout(timeout); reject(err); });
  });

  const channel = await client.channels.fetch(threadId);
  if (!channel || !('messages' in channel)) {
    console.log('Not a text/thread channel');
    await client.destroy();
    process.exit(1);
  }

  const thread = channel as any;
  console.log(`Thread: ${thread.name}`);
  console.log(`Parent: #${thread.parent?.name ?? 'unknown'}`);
  console.log(`Archived: ${thread.archived}`);
  console.log(`---`);

  const msgs = await thread.messages.fetch({ limit: 20 });
  const sorted = [...msgs.values()].reverse();
  for (const m of sorted as any[]) {
    const author = m.author.bot ? `BOT:${m.author.username}` : `user:${m.author.username}`;
    const content = m.content.length > 300 ? m.content.slice(0, 300) + '...' : m.content;
    console.log(`[${author}] ${content}`);
    console.log('');
  }

  await client.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
