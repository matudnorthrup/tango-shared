# discord_manage

Discord server management through the Discord REST API.

## Input

```json
{
  "operation": "create_channel",
  "name": "new-channel",
  "type": "text",
  "parent_id": "1234567890"
}
```

## Operations

- `list_channels`
- `create_channel`
- `edit_channel`
- `delete_channel`
- `create_thread`
- `send_message`
- `api`

## Channel types

- `text`
- `voice`
- `category`
- `announce`
- `forum`

## Notes

- `create_thread` can persist a `session_id` and optional `agent_id` for reply continuity.
- `api` supports raw Discord API calls with `method`, `endpoint`, and optional `body`.
- `{guild_id}` placeholders in raw endpoints are substituted automatically.
