# agent_docs

Read, write, list, and patch markdown files inside `agents/`.

## Input

```json
{
  "operation": "read",
  "path": "assistants/watson/knowledge.md"
}
```

## Operations

- `list` with optional `path` or `agent`
- `read` with `path`
- `write` with `path`, `content`
- `patch` with `path`, `old`, `new`

## Path rules

- Paths must stay inside `agents/`
- Only `.md` files are allowed
- Tool docs under `agents/tools/` are valid targets
- Skill docs under `agents/skills/` are valid targets

## Examples

```json
{
  "operation": "list",
  "path": "assistants/watson"
}
```

```json
{
  "operation": "write",
  "path": "tools/wellnessdb.md",
  "content": "# wellnessdb\n..."
}
```

```json
{
  "operation": "patch",
  "path": "assistants/watson/knowledge.md",
  "old": "old text",
  "new": "new text"
}
```
