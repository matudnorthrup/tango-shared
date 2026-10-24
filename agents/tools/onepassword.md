# 1Password Tool

Retrieve credentials and secrets from 1Password via service account.

## Actions

### `get` — Retrieve a field from an item

| Param   | Required | Default    | Description |
|---------|----------|------------|-------------|
| vault   | yes      | —          | Vault name (for example an installation-specific automation vault) |
| item    | yes      | —          | Item title (for example "Finance API", "Amazon", or "Slack Bot") |
| field   | no       | "password" | Field name: password, username, credential, url, notesPlain |
| section | no       | —          | Section name if the field is nested |

Returns: `{ value: "..." }`

### `list` — List items in a vault

| Param | Required | Description |
|-------|----------|-------------|
| vault | yes      | Vault name |

Returns: `{ items: [{ id, title, category }] }`

### `whoami` — Check service account identity

No params. Returns account info.

### `vault-list` — List accessible vaults

No params. Returns vault names and IDs.

## Examples

```json
{ "action": "get", "vault": "Automation", "item": "Finance API", "field": "credential" }
{ "action": "get", "vault": "Automation", "item": "Amazon", "field": "password" }
{ "action": "get", "vault": "Automation", "item": "Amazon", "field": "username" }
{ "action": "list", "vault": "Automation" }
```

## Field naming conventions

- **Login items**: `username`, `password`
- **API keys**: usually `credential` or `password`
- **All items**: `notesPlain` for notes

## Hard limits

NEVER retrieve credentials for banking, healthcare, government, investment, or primary email accounts. If the task requires those, stop and ask the user.
