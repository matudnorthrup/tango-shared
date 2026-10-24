/**
 * Live Notion smoke test — exercises the real `notion` tool against the real
 * Notion API, end to end, through the same handler agents call.
 *
 * Covers: credential resolution → search → create_page → get_page (markdown
 * round-trip) → append → update_page → database schema/query → archive/restore
 * → cleanup.
 *
 * The test writes only inside a scratch page it creates itself, and archives
 * that page when it finishes. Nothing this touches is pre-existing content.
 *
 * Parent page for the scratch page, in order:
 *   --parent <id|url>  →  NOTION_SMOKE_PARENT_ID  →  workspace root
 *
 * On a multi-workspace install, name the workspace with --workspace <name>
 * (or NOTION_SMOKE_WORKSPACE); the tool refuses to guess one.
 *
 * Notion does not allow archiving workspace-level pages through the API, so a
 * run that falls back to the workspace root reports the page it left behind
 * instead of silently littering. Pass a parent to get full cleanup.
 *
 * Usage:
 *   node --import tsx ./scripts/testing/live-notion-smoke.ts
 *   node --import tsx ./scripts/testing/live-notion-smoke.ts --parent <page-url> --json
 *   node --import tsx ./scripts/testing/live-notion-smoke.ts --keep
 */

import dotenv from "dotenv";
import {
  createNotionTools,
  normalizeNotionId,
  notionCredentialRef,
  NOTION_TOKEN_ENV,
  NOTION_VAULT_ENV,
  NOTION_ITEM_ENV,
} from "../../packages/discord/src/notion-agent-tools.js";

dotenv.config({ quiet: true });

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}
const hasFlag = (flag: string) => process.argv.includes(flag);

const JSON_OUT = hasFlag("--json");
/** Multi-workspace installs refuse to guess, so name the workspace explicitly. */
const WORKSPACE = getArg("--workspace") ?? process.env.NOTION_SMOKE_WORKSPACE ?? null;
const KEEP = hasFlag("--keep");

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
let failures = 0;

function record(name: string, ok: boolean, detail: string): boolean {
  checks.push({ name, ok, detail });
  if (!ok) failures++;
  if (!JSON_OUT) console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

const tool = createNotionTools().find((t) => t.name === "notion")!;
type Result = Record<string, unknown>;
const call = (input: Record<string, unknown>) =>
  tool.handler({ ...input, ...(WORKSPACE ? { workspace: WORKSPACE } : {}) }) as Promise<Result>;

/** Fail fast on an operation that was supposed to succeed. */
function expectOk(label: string, res: Result): Result {
  if (typeof res.error === "string") {
    record(label, false, res.error);
    throw new Error(`${label} failed: ${res.error}`);
  }
  return res;
}

/** The body written to the scratch page — every markdown form the tool claims. */
const BODY = [
  "# Heading one",
  "## Heading two",
  "### Heading three",
  "- bullet item",
  "1. numbered item",
  "- [ ] open task",
  "- [x] done task",
  "> quoted line",
  "---",
  "```ts",
  "const smoke = true;",
  "```",
  "plain paragraph",
  // Inline styling must survive as Notion annotations, not literal asterisks.
  "**bold** and *italic* and `code` and ~~struck~~",
  "- **bold** inside a bullet with *italic*",
  "snake_case_name stays plain and `**literal**` stays literal",
].join("\n");

const EXPECTED = [
  "# Heading one",
  "## Heading two",
  "### Heading three",
  "- bullet item",
  "1. numbered item",
  "- [ ] open task",
  "- [x] done task",
  "> quoted line",
  "---",
  "```typescript\nconst smoke = true;\n```",
  "plain paragraph",
  "**bold** and *italic* and `code` and ~~struck~~",
  "- **bold** inside a bullet with *italic*",
  "snake_case_name stays plain and `**literal**` stays literal",
].join("\n");

/**
 * Create a small database inside the scratch page. The `notion` tool does not
 * create databases (agents work with ones that already exist), so this goes
 * straight to the API — it is fixture setup, not the thing under test.
 *
 * The title property is named "Task name" on purpose: creating a row has to
 * discover that name from the schema rather than assume "title"/"Name".
 */
async function createScratchDatabase(parentPageId: string): Promise<string> {
  const { resolveNotionToken } = await import("../../packages/discord/src/notion-agent-tools.js");
  const token = await resolveNotionToken(WORKSPACE ?? undefined);
  const res = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: "Smoke database" } }],
      properties: {
        "Task name": { title: {} },
        Status: { select: { options: [{ name: "Done" }, { name: "Open" }] } },
      },
    }),
  });
  const json = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !json.id) throw new Error(`scratch database create failed: ${json.message ?? res.status}`);
  return json.id;
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const title = `Tango notion smoke ${stamp}`;

  if (!JSON_OUT) console.log(`[notion-smoke] ${title}\n`);

  /* 1 — credentials -------------------------------------------------------- */
  const ref = notionCredentialRef();
  const configured = ref.hasDirectToken || Boolean(ref.vault && ref.item);
  if (!record(
    "credentials configured",
    configured,
    ref.hasDirectToken
      ? `${NOTION_TOKEN_ENV} set`
      : ref.vault && ref.item
        ? `1Password ${ref.vault}/${ref.item} (field ${ref.field})`
        : `set ${NOTION_TOKEN_ENV}, or ${NOTION_VAULT_ENV} + ${NOTION_ITEM_ENV}`,
  )) {
    throw new Error("Notion is not configured for this installation.");
  }

  /* 2 — search (read) ------------------------------------------------------ */
  const search = expectOk("search returns shared objects", await call({ operation: "search", page_size: 5 }));
  const found = (search.results as unknown[]) ?? [];
  record("search returns shared objects", found.length > 0, `${found.length} object(s) reachable`);

  /* 3 — create_page (write) ------------------------------------------------ */
  const parentArg = getArg("--parent") ?? process.env.NOTION_SMOKE_PARENT_ID ?? null;
  const parentId = parentArg ? normalizeNotionId(parentArg) : null;

  let pageId: string;
  let pageUrl: string;
  let archivable: boolean;

  if (parentId) {
    const created = expectOk(
      "create_page under parent",
      await call({ operation: "create_page", parent_id: parentId, title, markdown: BODY }),
    );
    pageId = String(created.id);
    pageUrl = String(created.url ?? "");
    archivable = true;
    record("create_page under parent", true, `${created.blocks_written} blocks → ${pageId}`);
  } else {
    // No parent configured: fall back to a workspace-root page. The tool itself
    // always requires a parent, so this path talks to the API directly and is
    // reported as un-cleanable rather than pretending it tidied up.
    record("create_page under parent", true, "skipped — no --parent/NOTION_SMOKE_PARENT_ID");
    const { resolveNotionToken } = await import("../../packages/discord/src/notion-agent-tools.js");
    const token = await resolveNotionToken(WORKSPACE ?? undefined);
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { type: "workspace", workspace: true },
        properties: { title: { title: [{ type: "text", text: { content: title } }] } },
      }),
    });
    const page = (await res.json()) as { id?: string; url?: string; message?: string };
    if (!res.ok || !page.id) throw new Error(`workspace-root create failed: ${page.message ?? res.status}`);
    pageId = page.id;
    pageUrl = page.url ?? "";
    archivable = false;
    expectOk("append body to workspace page", await call({ operation: "append", page_id: pageId, markdown: BODY }));
  }

  /* 4 — get_page round-trip (read) ----------------------------------------- */
  const read = expectOk("get_page reads the page back", await call({ operation: "get_page", page_id: pageId }));
  record("get_page returns the title", read.title === title, String(read.title));
  const content = String(read.content ?? "");
  record(
    "markdown round-trips through Notion blocks",
    content === EXPECTED,
    content === EXPECTED ? "exact match" : `got:\n${content}`,
  );

  /* 5 — append (write) ----------------------------------------------------- */
  const appended = expectOk(
    "append adds blocks",
    await call({ operation: "append", page_id: pageId, markdown: "## Appended\n- after the fact" }),
  );
  record("append adds blocks", appended.appended === 2, `${appended.appended} block(s), ${appended.batches} batch(es)`);

  const reread = expectOk("appended content is visible", await call({ operation: "get_page", page_id: pageId }));
  const rereadContent = String(reread.content ?? "");
  record(
    "appended content is visible",
    rereadContent.includes("## Appended") && rereadContent.includes("- after the fact"),
    "found appended blocks",
  );

  /* 6 — URL acceptance ------------------------------------------------------ */
  if (pageUrl) {
    const byUrl = await call({ operation: "get_page", page_id: pageUrl });
    record("get_page accepts a full Notion URL", byUrl.id === pageId, String(byUrl.error ?? byUrl.id));
  }

  /* 7 — update_page (write) ------------------------------------------------- */
  const renamed = `${title} (updated)`;
  const updated = await call({
    operation: "update_page",
    page_id: pageId,
    properties: { title: { title: [{ type: "text", text: { content: renamed } }] } },
  });
  record("update_page sets properties", updated.title === renamed, String(updated.error ?? updated.title));

  /* 8 — databases: schema, row creation, query ------------------------------ */
  // Built inside the scratch page so the database-parent write path is covered
  // without creating rows in any of the workspace's real databases.
  const dbId = await createScratchDatabase(pageId);

  const schema = await call({ operation: "get_database", database_id: dbId });
  record(
    "get_database returns property names and types",
    !schema.error && (schema.properties as Record<string, string>)?.Status === "select",
    JSON.stringify(schema.properties ?? schema.error),
  );

  // The title property is deliberately not called "title" — the tool has to
  // read the real name out of the schema.
  const row = await call({
    operation: "create_page",
    parent_id: dbId,
    title: "Smoke row",
    properties: { Status: { select: { name: "Done" } } },
  });
  record(
    "create_page adds a database row",
    !row.error && row.parent_kind === "database",
    String(row.error ?? `${row.id} (parent_kind=${row.parent_kind})`),
  );

  const rows = await call({ operation: "query_database", database_id: dbId, page_size: 5 });
  const rowList = (rows.results as Array<Record<string, unknown>>) ?? [];
  record(
    "query_database returns the new row with its title",
    !rows.error && rowList.some((r) => r.title === "Smoke row"),
    String(rows.error ?? `${rowList.length} row(s): ${rowList.map((r) => r.title).join(", ")}`),
  );

  const filtered = await call({
    operation: "query_database",
    database_id: dbId,
    filter: { property: "Status", select: { equals: "Done" } },
  });
  record(
    "query_database honors a filter",
    !filtered.error && ((filtered.results as unknown[]) ?? []).length === 1,
    String(filtered.error ?? `${((filtered.results as unknown[]) ?? []).length} match(es)`),
  );

  /* 9 — error shape --------------------------------------------------------- */
  const missing = await call({ operation: "get_page", page_id: "00000000000000000000000000000000" });
  record(
    "unreachable page returns a helpful error",
    typeof missing.error === "string" && /shared/.test(missing.error),
    String(missing.error ?? "(no error returned)"),
  );

  /* 10 — archive + restore + cleanup ---------------------------------------- */
  if (archivable && !KEEP) {
    const archived = await call({ operation: "archive", page_id: pageId });
    record("archive trashes the page", archived.archived === true, String(archived.error ?? "in_trash=true"));

    const restored = await call({ operation: "restore", page_id: pageId });
    record("restore brings it back", restored.archived === false, String(restored.error ?? "in_trash=false"));

    const finalArchive = await call({ operation: "archive", page_id: pageId });
    record("cleanup archives the scratch page", finalArchive.archived === true, pageId);
  } else {
    record(
      "cleanup archives the scratch page",
      true,
      KEEP
        ? `kept by --keep: ${pageUrl || pageId}`
        : `LEFT BEHIND (workspace-root pages cannot be archived via API): ${pageUrl || pageId}`,
    );
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failures === 0, page: { id: pageId, url: pageUrl, archivable }, checks }, null, 2));
  } else {
    console.log(`\n[notion-smoke] ${checks.length - failures}/${checks.length} checks passed`);
    if (!archivable && !KEEP) {
      console.log(`[notion-smoke] delete this page manually in Notion: ${pageUrl || pageId}`);
      console.log("[notion-smoke] pass --parent <page> (or set NOTION_SMOKE_PARENT_ID) for automatic cleanup.");
    }
  }

  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[notion-smoke] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
