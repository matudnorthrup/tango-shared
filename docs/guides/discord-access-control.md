# Discord Access Control

How Tango decides whether an agent may respond in a Discord channel or thread.

## Two independent layers

Tango applies **two** allowlist checks on inbound Discord messages. Both must pass
for normal agent handling to proceed. They use different channel ID semantics.

| Layer | Where | ID checked | Config |
| --- | --- | --- | --- |
| **1 — Event gate** | `packages/discord/src/allowed-channels.ts` | `message.channelId` (thread ID inside a forum post) | `DISCORD_ALLOWED_CHANNELS` env var |
| **2 — Agent routing** | `packages/discord/src/access-control.ts` | Parent channel ID **and** optional thread ID (see below) | `TANGO_ACCESS_MODE`, `TANGO_ALLOWLIST_*`, per-agent `access` in v2 yaml |

**Layer 1** runs first in the `messageCreate` handler. If `DISCORD_ALLOWED_CHANNELS`
is unset or empty, layer 1 allows all channels.

**Layer 2** runs after routing resolves which agent owns the message. An agent can
be blocked here even when layer 1 passed — this is the failure mode that blocked
Cod-E on the upstream migration baseline (June 2026).

Slot-mode dev testing uses a third mechanism: after creating smoke-test threads,
the bot mutates `defaultAccessPolicy.allowlistChannelIds` to include smoke-test
**parent** channels. See [`parallel-dev.md`](./parallel-dev.md).

## Why forum threads need special handling

Routing and session keys normalize forum threads to their **parent** channel:

```typescript
// packages/discord/src/main.ts — resolveRoutingChannelId()
if (channel.isThread()) {
  return channel.parentId ?? message.channelId;
}
```

That is correct for routing (one agent config per forum, isolated thread sessions).
It is wrong for allowlist checks if you only allowlist a **single thread** without
opening the whole forum.

Example:

| Concept | ID |
| --- | --- |
| #infrastructure forum (parent) | `100000000000000100` |
| Cod-E canary thread | `100000000000000101` |

Desired policy: Cod-E may respond **only** in the canary thread, not every post in
#infrastructure.

If layer 2 only checks `routingChannelId` (parent), an allowlist containing the
thread ID always fails:

```
blocked mode=allowlist agent=cod-e reason=channel-not-allowlisted channel=100000000000000101
```

The bot routes correctly (`routed=cod-e`) but access control denies before any
reply is sent.

## Thread-level allowlist fix (2026-05-28)

Allowlist evaluation accepts **either** the routed parent channel ID **or** the
original thread ID when they differ.

### 1. `access-control.ts`

Add optional `threadChannelId` to the evaluation input. In `evaluateAllowlist`,
channel is allowed when:

- `allowlistChannelIds` is empty (allow all), **or**
- `channelId` is in the set, **or**
- `threadChannelId` is in the set

### 2. `main.ts`

When calling `evaluateAccess` in `handleMessage`, pass the thread ID alongside
the resolved parent:

```typescript
const routingChannelId = resolveRoutingChannelId(message);
const threadChannelId =
  message.channelId !== routingChannelId ? message.channelId : undefined;

const access = evaluateAccess(
  {
    channelId: routingChannelId,
    threadChannelId,
    userId: message.author.id,
    mentioned: hasMentionForBot(message),
  },
  accessPolicy,
);
```

**Both files are required.** Patching only `access-control.ts` compiles and passes
unit tests in isolation but does **not** fix live Discord — `main.ts` must pass
`threadChannelId` or the check never sees the thread ID.

Regression test: `packages/discord/test/access-control.test.ts` — *allows forum
thread ID when parent channel is routed for allowlist*.

This fix benefits any deployment with forum-thread allowlists.

## Configuration

### Default access policy (env)

```bash
TANGO_ACCESS_MODE=allowlist   # off | allowlist | mention | both
TANGO_ALLOWLIST_CHANNEL_IDS=    # comma-separated; empty = no default channels
TANGO_ALLOWLIST_USER_IDS=
```

Per-agent yaml can override mode and allowlists via `access:`.

### Per-agent allowlist (v2 yaml)

```yaml
access:
  mode: allowlist
  allowlist_channel_ids:
    - "100000000000000101"   # forum thread ID; OK with thread-level fix
```

You do **not** need to add the parent forum ID when you only want one thread —
that would open the entire forum to the agent.

### Layer 1 (optional extra gate)

```bash
DISCORD_ALLOWED_CHANNELS=100000000000000101
```

Use when you want the bot process to ignore all traffic outside specific channels
before routing. Some deployments leave this unset and rely on layer 2 +
per-agent yaml instead.

## Access modes

| Mode | Behavior |
| --- | --- |
| `off` | No access gating |
| `allowlist` | Channel/user must be allowlisted |
| `mention` | Bot must be @mentioned |
| `both` | Allowlist **and** mention required |

## Debugging a silent non-response

1. **Check bot logs** for `blocked mode=allowlist`:
   ```bash
   tmux -L tango-service capture-pane -t tango:discord -p -S -30
   ```
2. **Confirm both halves of the thread fix** are in compiled output:
   ```bash
   rg 'threadChannelId' packages/discord/dist/access-control.js packages/discord/dist/main.js
   ```
   `main.js` must show `threadChannelId` in the `evaluateAccess({ ... })` call inside
   `handleMessage`, not only in `getConversationKey`.
3. **Rebuild and restart** after changing either file:
   ```bash
   npm run build -w @tango/discord && npm run bot:restart
   ```
4. **Verify agent yaml** loads the intended allowlist (`agent-access agent=cod-e … channels=1` at boot).

## Related docs

- [`parallel-dev.md`](./parallel-dev.md) — slot mode, two-layer allowlist, smoke-test parent injection
- [`agent-operating-model.md`](./agent-operating-model.md) — operator conventions
- [`agents-structure.md`](./agents-structure.md) — v2 yaml `access` fields

## History

| Date | Event |
| --- | --- |
| 2026-05-28 | Thread-level allowlist implemented after a cross-agent routing leak when `TANGO_ACCESS_MODE=off` |
| 2026-06-03 | Re-forward-ported during upstream memory migration; partial port (access-control only) caused recurrence; fixed with `main.ts` pass-through |
