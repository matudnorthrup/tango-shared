# linear

Universal Linear GraphQL API tool for project management — issues, projects, cycles, documents, comments.

## Input

```json
{
  "query": "{ viewer { id name email } }"
}
```

With variables:

```json
{
  "query": "mutation($id: String!, $title: String!) { issueUpdate(id: $id, input: { title: $title }) { success issue { id title } } }",
  "variables": { "id": "abc-123", "title": "Updated title" }
}
```

## Key Entities

- **Issue**: id, identifier (e.g. "ENG-123"), title, description, state { name, type }, assignee { name, email }, project { name }, labels { nodes { name } }, priority (0=none, 1=urgent, 2=high, 3=medium, 4=low), dueDate, createdAt, updatedAt, estimate
- **Project**: id, name, description, state (planned/started/paused/completed/canceled), startDate, targetDate, progress, members, issues
- **Team**: id, name, key, issues, projects, labels, states
- **Cycle**: id, number, startsAt, endsAt, issues, completedIssuesCount, issueCountHistory
- **Document**: id, title, content (markdown), project, creator, createdAt, updatedAt
- **Comment**: id, body (markdown), issue, user, createdAt
- **WorkflowState**: id, name, type (triage/backlog/unstarted/started/completed/canceled), position

## Pagination

Relay-style: `first`/`after` with `nodes[]` and `pageInfo { hasNextPage endCursor }`. Default 50 results.

```graphql
{
  issues(first: 25, after: "cursor-string") {
    nodes { id title }
    pageInfo { hasNextPage endCursor }
  }
}
```

## Filtering

Comparators: `eq`, `neq`, `contains`, `in`, `nin`, `lt`, `lte`, `gt`, `gte`.
Relative dates: `"P2W"` (next 2 weeks), `"-P2W"` (past 2 weeks).
Logical OR: `filter: { or: [...] }`.

```graphql
{
  issues(filter: {
    assignee: { isMe: { eq: true } },
    state: { type: { nin: ["completed", "canceled"] } }
  }) {
    nodes { id identifier title state { name } priority }
  }
}
```

## Common Queries

- `{ viewer { id name email } }` — current user
- `{ teams { nodes { id name key } } }` — all teams
- `{ issue(id: "ENG-123") { ... } }` — by identifier
- `{ issues(filter: { assignee: { isMe: { eq: true } } }) { nodes { ... } } }` — my issues

## Read-Before-Write (Required)

Before any mutation that modifies existing content (issueUpdate, documentUpdate, etc.), you MUST first query the current state of that resource from Linear. Users edit directly in Linear — if you write from stale or locally-cached data, you will silently overwrite their changes. Always fetch the latest version immediately before writing.

## Common Mutations

- `issueCreate(input: { teamId, title, description, priority, stateId, assigneeId, labelIds })`
- `issueUpdate(id, input: { title, stateId, priority, dueDate })`
- `commentCreate(input: { issueId, body })`
- `documentCreate(input: { projectId, title, content })`

## Output

Returns parsed JSON with `data` key on success. GraphQL errors appear in `errors[]` array (HTTP 200). `_rateLimitRemaining` is appended when available.

## 1Password credential

The MCP server should fetch the API key from the installation's configured
secret manager entry for Linear. If the tool errors with "not found", verify
the configured item name for this installation. As a fallback, retrieve the key
manually and call the GraphQL endpoint via curl with `Authorization: <key>`
against `https://api.linear.app/graphql`.
