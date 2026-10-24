# Tango Conversations Off Discord

Status: proposed (2026-10-22)

Tango agents (the ones with a home channel: Watson, Malibu, Sierra, and the
rest) keep their conversations in Discord. The runtime writes a copy to
`tango.sqlite`, but the Agent Desk reads Discord, not that copy, and a new desk
thread is always a new Discord thread. This spec makes the runtime's store the
record, makes the desk read it, and turns Discord into an optional mirror.

It is step 1 of reducing Tango's dependency on Discord. Later steps, out of
scope here:

- split `packages/discord` into the agent runtime and a thin Discord adapter;
- move intake channels and alerts off Discord;
- voice transport (the voice operator keeps its Discord voice channel).

## Why

- **Lag.** The desk polls Discord every 45 s (`apps/screen/server/desk/setup.ts`,
  `discordPollMs`) and a `turn.finished` event does not trigger a read, so a
  reply reaches Discord up to 45 s before the desk.
- **Two sources of truth.** The `messages` table misses posts made outside a
  turn (check-in replies, context-rotation and error notices), stores only the
  last chunk id of a reply, has no conversation key, and keeps attachments as
  Discord CDN URLs that expire.
- **Identity.** A conversation key is a Discord snowflake (`thread:<id>`,
  `channel:<id>`), so starting a conversation means creating a Discord thread.

## Current shape

| Concern | Today |
|---|---|
| Desk reply / start | `/screen/input` → `deliverScreenInput` posts to Discord (owner webhook), then calls `handleMessage(discordMessage)` directly (`packages/discord/src/main.ts`) |
| Turn entry | `handleMessage(message: Message)` reads channel, id, timestamps, attachments and reply-to from a discord.js `Message`, then `routeV2MessageIfEnabled` → `TangoRouter.routeMessage` |
| Turn core | `routeMessage({ message, channelId, threadId?, messageId?, occurredAt?, agentId, conversationKey? })` already runs without Discord for the scheduler and check-ins |
| Reply | `presentRuntimeReply` → `replyPresenter.sendChunked` posts to Discord, then the outbound row is written |
| Desk read | `source-discord.ts` reads home channels and active threads over REST; chapters, seen/done/park reactions, intake requests and read cursors all derive from Discord ids |
| Identity | `provider_sessions.conversation_key`, `discord_thread_sessions(thread_id → session_id)`, `parseConversationKey` requires `^(thread|channel):\d+$` |
| Provenance | memory and state MCP servers get `TANGO_DISCORD_*` and a Discord `TANGO_MESSAGE_ID`; post-turn extraction prefers Discord message ids |

## Target shape

```
 desk reply/start ──▶ bot /conversations/turn ──▶ runConversationTurn ──▶ routeMessage
 Discord message  ──▶ handleMessage (adapter) ──┘          │
                                                          ▼
                                     conversation store (tango.sqlite)
                                       │                  │
                         message.created event      Discord mirror (optional)
                                       ▼
                         desk source-tango (cursor read)
```

- The **conversation store** is the record. Every owner and agent post lands
  there first, with the full text, attachments copied locally, and a
  conversation key.
- The **desk** reads the store, told by a push event and backed by a slow poll.
- **Discord** is an adapter: inbound Discord messages become turns through the
  same entry point; outbound posts are mirrored after the store write. A mirror
  failure never fails a turn.

## Design

### Store

Extend `tango.sqlite` (`packages/core/src/storage.ts`) with a migration:

- `conversations`: `conversation_key` (PK), `agent_id`, `kind`
  (`thread` | `home`), `title`, `origin` (`desk` | `discord` | `voice` |
  `schedule` | `check-in`), `created_at`, `archived_at`, `discord_channel_id`,
  `discord_thread_id` (both nullable).
- `messages`: add `conversation_key` (indexed, with `id`), `author_kind`
  (`owner` | `agent` | `system` | `requester`), `reply_to_message_id` (local
  id), `discord_message_ids` (JSON array: every chunk, not just the last),
  and an `attachments` metadata shape pointing at local files. Widen the
  `source` check to include `desk` and `voice`.
- Attachments, inbound and outbound, are copied to
  `<profile>/data/attachments/<conversation>/<message>/` at write time, so
  history never depends on a CDN URL.

One choke point, `recordConversationPost(...)`, writes every post. All current
writers go through it, plus the ones that write nothing today: check-in
replies, context-pressure and rotation notices, error notices.

### Identity

- New conversations started from the desk or voice get `conv:<ulid>` keys.
- Existing `thread:<snowflake>` and `channel:<snowflake>` keys stay valid
  for good. Nothing is rewritten.
- `parseConversationKey` (`apps/screen/server/desk/discord-loom-links.ts`) and
  the other `\d+` checks accept `conv:` keys. The Discord ids move to
  `conversations.discord_*`.
- `discord_thread_sessions` stays as the Discord adapter's lookup; the
  runtime resolves sessions by conversation key.

### Turn entry

`runConversationTurn({ conversationKey, agentId, author, text, attachments,
replyToMessageId?, origin })`:

1. records the inbound post;
2. calls `routeMessage` with `messageId` = the local id;
3. records each agent post, emits `message.created`, then hands it to the
   mirror.

`handleMessage` becomes the Discord adapter: it maps a discord.js `Message` to
this input (dedup on Discord message id) and calls it. `deliverScreenInput`
calls it directly, with no Discord post first.

### Bot HTTP

On the bot's existing server, behind the same bridge token as `/screen/input`:

- `POST /conversations/turn`: reply or choice into an existing conversation.
- `POST /conversations/start`: new conversation for an agent; returns its key.
- `GET /conversations?updatedAfter=<cursor>`: conversations changed since a
  cursor.
- `GET /conversations/:key/messages?after=<id>&limit=`: messages in order.
- `GET /conversations/attachments/:messageId/:index`.

`/screen/input` stays as a compatibility shim over these during the move.

### Desk

- `source-tango.ts` replaces `source-discord.ts` for agent home channels and
  threads. It reads by cursor (the local message id), not by snowflake.
- Push: the bot posts `message.created` and `conversation.updated` to the
  desk's existing agent-events endpoint (`desk-events.ts`, same
  fire-and-forget rules). The desk reads that conversation at once. A 5-minute
  poll is the backstop.
- Chapters keep the 30-minute rule, moved into a source-agnostic helper that
  works on store timestamps.
- Seen, done and park are desk attention state, not reactions. While the
  mirror is on, the desk still writes ✅ and archive to Discord, and reads owner
  reactions from the mirror as input.
- Owner identity comes from `author_kind`, not the 🖥️ prefix or a list of
  Discord accounts.
- `source-discord.ts` keeps intake channels only, until the intake step.

### Discord mirror

Per agent, in the agent config: `discordMirror: both | outbound | off`.

- `both` (default during the move): agent posts mirror to Discord; messages
  typed in Discord become turns. Matches today.
- `outbound`: Discord shows the conversation; typing there is ignored, with a
  one-time notice pointing to the desk.
- `off`: Discord is not touched.

A `conv:` conversation gets its Discord thread lazily, on its first mirrored
post, and the ids are stored on the conversation.

### Provenance and memory

- `TANGO_MESSAGE_ID` becomes the local id. `TANGO_DISCORD_*` are set only when
  the conversation has a mirror.
- Post-turn extraction and dead letters carry local ids, with Discord ids as
  optional extras. Atlas readers that resolve Discord ids keep working for old
  memories.

## Phases

Each phase ships on its own and leaves the system working.

0. **Lag fix.** On `turn.finished` for a `thread:` or `channel:` conversation,
   the desk reads that conversation from Discord at once. No other changes.
1. **Complete store.** Migration, `recordConversationPost`, local
   attachments, every post recorded. Backfill: for conversations active in the
   last 30 days, read Discord and fill `conversation_key`, chunk ids and
   missing posts (idempotent on Discord message id). No user-visible change.
2. **Desk reads the store.** `source-tango.ts` and the push events. Run it in
   shadow first: both sources read, the desk trace records each difference
   (missing post, different text, different order), and the Discord source
   still drives the desk. Cut over after a week with no unexplained
   differences.
3. **Turns without Discord.** `runConversationTurn`, the HTTP endpoints, and
   `handleMessage` as the adapter. The desk replies and starts through the new
   endpoints; new desk conversations get `conv:` keys and lazy mirror threads.
4. **Mirror off.** Turn agents to `outbound`, then `off`, one at a time, at
   the owner's pace. Seen, done and park become desk-only for those agents.

## Success criteria

- A desk reply's agent answer is on the desk within 2 s of `turn.finished`
  (from phase 0, against Discord; from phase 2, against the store).
- After phase 1, every post visible in a mirrored Discord conversation has a
  row with the full text, and attachments open with Discord offline.
- After phase 3, with Discord unreachable, the owner can start a conversation
  from the desk, reply and get an answer, and the turn's memory carries
  provenance.
- After phase 4, an agent with `discordMirror: off` makes no Discord API calls.
- Existing `thread:` and `channel:` conversations keep their sessions, Loom
  links and memory provenance throughout.

## Verification

- Unit: key parsing, the Discord-message-to-turn-input mapping and dedup,
  chapter splitting on store timestamps, mirror modes, migration and backfill
  idempotency.
- Desk harness (`apps/screen/test/desk-harness.ts`): `source-tango` against a
  fake bot API, including push-then-read and the cursor after a restart.
- Shadow-run diff report from phase 2 before cutting over.
- Live check per phase with the test agents (the `-test` clones), never an
  owner agent first.

## Risks

- **Double turns.** A desk reply mirrored to Discord must not come back in as a
  Discord message. The adapter ignores its own webhook and bot posts, and
  dedups on Discord message id.
- **Order.** The store write happens before the Discord post, so the order in
  Discord can differ from the store under a slow Discord API. The store order
  wins.
- **Backfill gaps.** Posts older than the backfill window in a conversation
  that wakes up later are read on demand the first time it is opened.
- **Owner habit.** While the mirror is `both`, a message typed in Discord works
  as before, so nothing breaks before the owner chooses to switch an agent off.
