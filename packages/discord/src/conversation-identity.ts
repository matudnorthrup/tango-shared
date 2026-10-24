import { conversationKeyFor } from "./project-state.js";

/** Where a turn lives in Discord, in the canonical form text turns use. */
export interface CanonicalConversation {
  /** `thread:<threadId>` or `channel:<channelId>` (see TangoRouter.getConversationKey). */
  conversationKey: string;
  /** The channel the conversation belongs to (a thread's parent). */
  channelId: string;
  threadId?: string;
}

/**
 * Canonical identity for a voice turn. Voice sessions key by
 * `session:agent[:channel]` so resumption stays per voice session, but tools,
 * memory, state and the desk must see the same key a typed message in that
 * Discord place would get. The place is where the turn is posted: a thread
 * gives `thread:<id>`, any other channel `channel:<id>`. When the posted
 * channel could not be resolved, fall back to the router's channel/thread.
 */
export function canonicalVoiceConversation(input: {
  postedChannelId: string | null;
  postedChannel?: { isThread: boolean; parentId?: string | null };
  routerChannelId: string;
  routerThreadId?: string;
}): CanonicalConversation {
  const posted = input.postedChannelId?.trim();
  if (posted && input.postedChannel) {
    if (input.postedChannel.isThread) {
      return {
        conversationKey: conversationKeyFor(input.routerChannelId, posted),
        channelId: input.postedChannel.parentId?.trim() || input.routerChannelId,
        threadId: posted,
      };
    }
    return { conversationKey: conversationKeyFor(posted), channelId: posted };
  }

  return {
    conversationKey: conversationKeyFor(input.routerChannelId, input.routerThreadId),
    channelId: input.routerChannelId,
    ...(input.routerThreadId ? { threadId: input.routerThreadId } : {}),
  };
}
