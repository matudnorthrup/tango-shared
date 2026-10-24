# Adding a New MCP Tool

Every MCP tool must be wired through the V2 runtime and governance. Missing any step causes silent failures: the tool may exist in code but not be exposed to the agent, not be permitted, or not be documented where the agent can reason about it.

For the broader agent-system structure and file-placement rules, see
[`agents-structure.md`](./agents-structure.md).

## Checklist

### 1. Tool implementation

**File:** `packages/discord/src/{domain}-agent-tools.ts`

Add the tool definition and handler inside the appropriate `create*Tools()` factory.

```ts
{
  name: "my_tool",
  description: "What it does, parameters, and key constraints",
  inputSchema: {
    type: "object",
    properties: { /* ... */ },
    required: ["param1"],
  },
  handler: async (input) => {
    return { result: "..." };
  },
}
```

### 2. MCP server registration

**File:** `packages/discord/src/mcp-wellness-server.ts`

If you added a brand-new factory, import it and include it in `allTools`. If you added the tool to an existing factory, this step is already covered.

### 3. Governance registration and permission grants

**File:** `packages/core/src/governance-schema.ts`

Add:
- the tool row in `governance_tools`
- permission rows in `permissions` for every agent or system principal that should use it

Then apply the new rows to `data/tango.sqlite` if the database already exists.

### 4. V2 agent MCP access

**File:** `config/v2/agents/{agent-name}.yaml`

Expose the MCP server/tool to each agent that should be able to call it. Prefer the narrowest server allowlist that supports the workflow.

```yaml
mcp_servers:
  - name: my-domain
    command: node
    args: ["packages/core/dist/mcp-proxy.js", "my-domain"]
    env:
      ALLOWED_TOOL_IDS: "my_tool"
```

If the agent needs reusable operating guidance, add it to the agent's `soul.md` or `knowledge.md`, or create/update an `agents/skills/*.md` doc and reference it from the agent prompt deliberately.

### 5. Tool doc

**File:** `agents/tools/{doc-name}.md`

Add or update the standalone tool doc that describes:
- what the tool does
- input shape
- important schema or parameter details
- output shape
- a few examples

If the tool belongs to an existing shared doc such as `exa.md` or `printing.md`, extend that doc instead of creating a new file.

Keep tool docs focused on callable surface area. Reusable workflow guidance belongs in `agents/skills/*.md`.

**Keep personal data out of the repo doc.** `agents/tools/*.md` and
`agents/skills/*.md` are generic, shareable defaults. Real account names, ids,
amounts, vendors, biometrics, machine paths, or anything true for one operator go
in the profile overlay (`~/.tango/profiles/<profile>/prompts/{tools,skills}/<doc>.md`),
which `agent_docs` appends to the repo base at read time. Use placeholders/config
keys in the repo doc. See [`profile-model.md`](./profile-model.md); the CI gate is
`scripts/privacy-scan.sh`.

## Common mistakes

| Symptom | Missed step |
| --- | --- |
| Tool never shows up in MCP `tools/list` | Step 2 |
| Agent can see the tool but gets permission denied | Step 3 |
| Agent has permission but the tool is absent in runtime | Step 4 |
| Agent sees the tool but lacks operating context | Step 5 |

## If the tool belongs to a new domain

You also need:

1. the MCP proxy/server registration for that domain
2. agent or system principal entries in `governance-schema.ts`
3. a narrow V2 agent MCP server entry
4. focused prompt guidance in the owning assistant's prompt files

## Verification

After adding a tool:

```sh
npm run build
npm test
npm run cli -- doctor
sqlite3 "${TANGO_DB_PATH:-$HOME/.tango/profiles/default/data/tango.sqlite}" "SELECT * FROM governance_tools WHERE id = 'my_tool';"
sqlite3 "${TANGO_DB_PATH:-$HOME/.tango/profiles/default/data/tango.sqlite}" "SELECT * FROM permissions WHERE tool_id = 'my_tool';"
```
