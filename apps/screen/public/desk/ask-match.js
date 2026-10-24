// Shared record matching for the desk and its read-only metrics.
/**
 * The key two rows share when they carry the same ask: the words, normalized. Short asks ("say go") are common
 * across unrelated threads, so under six words the key stays inside the conversation.
 */
export function askKey(text, conversationKey) {
  const norm = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_>#[\]()]/g, ' ')
    .replace(/[^a-z0-9$%@ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = norm.split(' ').filter(Boolean);
  return words.length >= 6 ? `t:${norm}` : `c:${conversationKey}|${norm}`;
}

/** The words name this decision id (D-6, not D-60 or XD-6). */
export const namesDecision = (words, decisionId) => new RegExp(`(?<![\\w-])${decisionId.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![\\w-])`).test(words);
