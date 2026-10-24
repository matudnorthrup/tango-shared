import { describe, expect, it } from "vitest";
import { canonicalVoiceConversation } from "../src/conversation-identity.js";

describe("canonicalVoiceConversation", () => {
  it("uses thread:<id> when the voice turn posts into a thread", () => {
    expect(canonicalVoiceConversation({
      postedChannelId: "thread-7",
      postedChannel: { isThread: true, parentId: "home-1" },
      routerChannelId: "home-1",
      routerThreadId: "thread-7",
    })).toEqual({ conversationKey: "thread:thread-7", channelId: "home-1", threadId: "thread-7" });
  });

  it("uses channel:<id> for an agent's home channel, matching typed turns", () => {
    expect(canonicalVoiceConversation({
      postedChannelId: "home-1",
      postedChannel: { isThread: false },
      routerChannelId: "home-1",
    })).toEqual({ conversationKey: "channel:home-1", channelId: "home-1" });
  });

  it("treats a non-thread channel other than the home channel as its own channel", () => {
    expect(canonicalVoiceConversation({
      postedChannelId: "other-2",
      postedChannel: { isThread: false },
      routerChannelId: "home-1",
      routerThreadId: "other-2",
    })).toEqual({ conversationKey: "channel:other-2", channelId: "other-2" });
  });

  it("falls back to the router's channel/thread when the posted channel is unknown", () => {
    expect(canonicalVoiceConversation({
      postedChannelId: "thread-7",
      routerChannelId: "home-1",
      routerThreadId: "thread-7",
    })).toEqual({ conversationKey: "thread:thread-7", channelId: "home-1", threadId: "thread-7" });
    expect(canonicalVoiceConversation({ postedChannelId: null, routerChannelId: "home-1" }))
      .toEqual({ conversationKey: "channel:home-1", channelId: "home-1" });
  });
});
