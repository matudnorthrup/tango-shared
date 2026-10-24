# gog_email

Gmail operations through the `gog` CLI.

## Input

```json
{
  "command": "gmail messages search 'is:unread newer_than:1d' --max 20 --account personal@example.com"
}
```

## Common commands

- `gmail messages search '<query>' [--max N] [--account <email>]`
- `gmail get <messageId> --format full [--account <email>]`
- `gmail attachment <messageId> <attachmentId> --out /tmp --name <filename> [--account <email>]`
- `gmail messages list [--max N] [--account <email>]`
- `gmail thread <thread_id> [--account <email>]`
- `gmail thread modify <thread_id> --remove INBOX [--account <email>]`
- `gmail drafts create --to <email> --subject '<subject>' --body '<body>' [--reply-to-message-id <id>] [--account <email>]`

## Query notes

- Gmail search syntax works here: `from:`, `to:`, `subject:`, `is:unread`, `newer_than:1d`, and so on.
- Accounts are installation-specific. Common patterns are `personal@example.com` and `work@example.com`.
- Use `gmail get` when you need message body text, headers, or attachment metadata for a specific message.
- Use `gmail attachment` with an absolute `--out` path or a stable directory like `/tmp` plus `--name` when another tool needs the actual file.

## Output

Returns CLI output in `result`. The CLI commonly returns JSON for search and thread fetches.

## Background / Scheduled Runs

The `gog` CLI stores OAuth tokens in the macOS keychain by default. Background processes (MCP servers, scheduled tasks) cannot access the locked keychain — they receive `errSecInteractionNotAllowed` (exit 36).

**Fix (one-time, interactive):** Switch to the file-based keyring backend, then re-authenticate each account:

```bash
gog auth keyring file
gog auth add personal@example.com --services gmail,calendar
gog auth add work@example.com --services gmail,calendar
# repeat for any other configured accounts
```

After this, tokens are stored in `~/Library/Application Support/gogcli/keyring/` and accessible from background processes without keychain interaction.
