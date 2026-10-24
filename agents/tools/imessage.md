# imessage

Read and send iMessages through the `imsg` CLI.

## Input

```json
{
  "command": "chats --limit 10 --json"
}
```

## Common commands

- `chats [--limit N] [--json]` — list recent conversations with chat IDs, participants, last message
- `history --chat-id <id> [--limit N] [--start <ISO8601>] [--end <ISO8601>] [--attachments] [--json]` — read messages for a conversation
- `send --to <handle> --text '<message>'` — send to a phone number (E.164: +15551234567) or email
- `send --chat-id <id> --text '<message>'` — send to an existing conversation by ID

## Workflow

1. Use `chats --json` to find the chat_id for a person or group
2. Use `history --chat-id <id> --json` to read recent messages
3. Use `send --chat-id <id> --text '...'` to reply

## Output

- `chats --json` returns an array of chat objects with `chat_id`, `display_name`, `participants`, `last_message_date`
- `history --json` returns an array of message objects with `sender`, `text`, `date`, `is_from_me`
- `send` returns confirmation of the sent message

## Important notes

- Always use `--json` for `chats` and `history` commands to get structured output.
- Prefer `--chat-id` over `--to` for sending when the conversation already exists.
- Sending is a real action — the recipient sees the message immediately.
- Date ranges: `--end` is exclusive (same as most ISO range conventions).
