import { expect, it } from 'vitest';
import { conversationInputUrl } from '../server/desk/conversation-input.js';
import { parseConversationKey } from '../server/desk/discord-loom-links.js';
it('keeps shadow/default writes unchanged; switches start/reply only in tango mode', () => {
  const base = 'http://fixture/screen/input';
  for (const mode of [undefined, 'shadow']) for (const type of ['start', 'reply', 'choice']) expect(conversationInputUrl(base, type, mode)).toBe(base);
  expect(conversationInputUrl(base, 'start', 'tango')).toBe('http://fixture/conversations/start');
  expect(conversationInputUrl(base, 'reply', 'tango')).toBe('http://fixture/conversations/turn');
});
it('links native provider sessions without rewriting existing Discord sessions', () => {
  for (const conversation of ['conv:00000000000000000000000001', 'thread:123', 'channel:456']) expect(parseConversationKey(JSON.stringify(['fixture', conversation]))).toEqual({ agentId: 'fixture', conversation });
  expect(parseConversationKey('["fixture","conv:../x"]')).toBeNull();
});
