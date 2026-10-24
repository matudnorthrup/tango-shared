# Conversation turns

The bot accepts native conversation turns on its existing loopback HTTP server.
The `X-Tango-Collaboration-Token` header uses the same bridge token as
`/screen/input`. The caller is the trusted owner bridge; clients cannot choose
an author identity or write to an isolated agent's conversation.

- `POST /conversations/start`: `{agentId, data: {text, title?, attachments?}, commandId?, origin?}`.
  Returns `{delivered: true, conversationKey: "conv:<ulid>"}` after enqueueing.
- `POST /conversations/turn`: `{agentId, conversationKey, data: {text, attachments?}, commandId?, replyToMessageId?}`.
  The stored conversation must belong to the supplied agent. Reply references
  accept a local numeric id, a `tango:<id>` desk id, or an existing Discord id.
- Attachments use the existing desk image shape `{name, mimeType, dataUrl}`.
  Arbitrary remote URLs and filesystem paths are not accepted by this API.
- `type: "choice"` and `label` send a scene choice through the turn endpoint.

The shared turn entry writes the inbound post and local attachment copies before
routing with the local message id. It writes the answer before mirror delivery.
Push events and the existing read API expose these posts to the desk. A mirror
failure leaves the answer in the store. Loom recovery also saves native answers
before attempting a mirror.

`TANGO_CONVERSATION_SOURCE=tango` selects these endpoints in the desk and makes
`/screen/input` a compatibility shim. With the switch unset or `shadow`, existing
desk writes still use the Discord path. Do not change the switch until the
shadow observation has been reviewed. The POST endpoints themselves are available
for explicit native callers independently of the desk switch.

Existing `thread:` and `channel:` identities remain unchanged. New native
conversations get `conv:` keys. A conversation acquires a mirror thread on its
first mirrored post; its Discord ids are stored separately and never replace
its key. Replying in that thread resolves back to the native conversation.
Per-agent `discordMirror` defaults to `both`. The mirror-off rollout is separate.

`TANGO_MESSAGE_ID` is a local message id. A native turn with no mirror omits
`TANGO_DISCORD_CHANNEL_ID` and `TANGO_DISCORD_THREAD_ID`; tools must use
`TANGO_CONVERSATION_KEY` for identity. Existing messages and memories retain their
Discord ids, and extraction/dead letters also retain local request/response ids.

Command retries are deduplicated in the running bot, matching the existing desk
bridge contract. Discord ingress additionally deduplicates against persisted
message ids. Mirror requests are serialized per conversation, but aren't a
persistent delivery queue: a process crash or Discord failure can leave a post
unmirrored. The store remains authoritative.
