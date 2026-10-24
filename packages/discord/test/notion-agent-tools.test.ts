import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSecret = vi.hoisted(() => vi.fn(async (_v: string, _i: string, _f?: string) => null as string | null));
vi.mock("../src/op-secret.js", () => ({
  getSecret,
  isOpAvailable: () => true,
  getOneTimePassword: async () => null,
}));

import {
  createNotionTools,
  listNotionWorkspaces,
  markdownToBlocks,
  parseInlineMarkdown,
  normalizeNotionId,
  notionCredentialRef,
  notionOperationLooksReadOnly,
  notionWorkspacesForAgent,
  resetNotionTokenCache,
  resolveNotionToken,
  selectNotionWorkspace,
  NOTION_TOKEN_ENV,
  NOTION_VAULT_ENV,
  NOTION_ITEM_ENV,
  NOTION_FIELD_ENV,
  NOTION_DEFAULT_WORKSPACE_ENV,
} from "../src/notion-agent-tools.js";

const CREDENTIAL_ENVS = [
  NOTION_TOKEN_ENV, NOTION_VAULT_ENV, NOTION_ITEM_ENV, NOTION_FIELD_ENV,
  NOTION_DEFAULT_WORKSPACE_ENV,
];
const saved: Record<string, string | undefined> = {};

function tool() {
  const found = createNotionTools().find((t) => t.name === "notion");
  if (!found) throw new Error("notion tool missing");
  return found;
}

/** Route stubbed responses by "METHOD /path" prefix. */
type Route = { status?: number; body: unknown };
function stubFetch(routes: Record<string, Route | ((body: unknown) => Route)>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace("https://api.notion.com/v1", "");
    const parsed = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body: parsed });

    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ");
      return m === method && path.startsWith(p!);
    });
    const entry = key ? routes[key]! : undefined;
    const route = typeof entry === "function" ? entry(parsed) : entry;
    const status = route?.status ?? (route ? 200 : 404);
    const payload = route?.body ?? { message: "Could not find block", code: "object_not_found" };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

beforeEach(() => {
  for (const key of CREDENTIAL_ENVS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetNotionTokenCache();
  getSecret.mockReset();
  getSecret.mockResolvedValue(null);
});

afterEach(() => {
  for (const key of CREDENTIAL_ENVS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  resetNotionTokenCache();
  vi.unstubAllGlobals();
});

describe("notion credential resolution", () => {
  it("prefers the direct token env var", async () => {
    process.env[NOTION_TOKEN_ENV] = "ntn_direct";
    process.env[NOTION_VAULT_ENV] = "SomeVault";
    process.env[NOTION_ITEM_ENV] = "Some Item";

    await expect(resolveNotionToken()).resolves.toBe("ntn_direct");
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("falls back to the configured 1Password item", async () => {
    process.env[NOTION_VAULT_ENV] = "SomeVault";
    process.env[NOTION_ITEM_ENV] = "Some Item";
    getSecret.mockResolvedValue("ntn_from_1password");

    await expect(resolveNotionToken()).resolves.toBe("ntn_from_1password");
    expect(getSecret).toHaveBeenCalledWith("SomeVault", "Some Item", "credential");
  });

  it("honors a custom 1Password field", async () => {
    process.env[NOTION_VAULT_ENV] = "SomeVault";
    process.env[NOTION_ITEM_ENV] = "Some Item";
    process.env[NOTION_FIELD_ENV] = "api_key";
    getSecret.mockResolvedValue("ntn_custom_field");

    await resolveNotionToken();
    expect(getSecret).toHaveBeenCalledWith("SomeVault", "Some Item", "api_key");
  });

  it("caches the token across calls until reset", async () => {
    process.env[NOTION_VAULT_ENV] = "SomeVault";
    process.env[NOTION_ITEM_ENV] = "Some Item";
    getSecret.mockResolvedValue("ntn_cached");

    await resolveNotionToken();
    await resolveNotionToken();
    expect(getSecret).toHaveBeenCalledTimes(1);

    resetNotionTokenCache();
    await resolveNotionToken();
    expect(getSecret).toHaveBeenCalledTimes(2);
  });

  it("names the env vars to configure when nothing is set, and no operator's vault", async () => {
    await expect(resolveNotionToken()).rejects.toThrow(/NOTION_API_KEY/);
    await expect(resolveNotionToken()).rejects.toThrow(/NOTION_1PASSWORD_VAULT/);
    // The repo must not leak any particular installation's vault or item name.
    await expect(resolveNotionToken()).rejects.not.toThrow(/Watson/);
  });

  it("reports a configured-but-unreadable 1Password item distinctly", async () => {
    process.env[NOTION_VAULT_ENV] = "SomeVault";
    process.env[NOTION_ITEM_ENV] = "Missing Item";
    getSecret.mockResolvedValue(null);

    await expect(resolveNotionToken()).rejects.toThrow(/1Password/);
  });

  it("exposes the credential reference without reading the secret", () => {
    process.env[NOTION_VAULT_ENV] = "SomeVault";
    process.env[NOTION_ITEM_ENV] = "Some Item";

    expect(notionCredentialRef()).toMatchObject({
      vault: "SomeVault",
      item: "Some Item",
      field: "credential",
      hasDirectToken: false,
      configured: true,
    });
    expect(getSecret).not.toHaveBeenCalled();
  });
});

describe("notion workspace routing", () => {
  // A Notion token is scoped to one workspace, so routing is the boundary that
  // keeps an agent's writes out of a workspace it has no business touching.
  beforeEach(() => {
    process.env.NOTION_DEFAULT_WORKSPACE = "work";
    process.env.NOTION_API_KEY = "ntn_work";
    process.env.NOTION_API_KEY_PERSONAL = "ntn_personal";
    process.env.NOTION_WORKSPACES_VICTOR = "personal";
    process.env.NOTION_WORKSPACES_WATSON = "work,personal";
    resetNotionTokenCache();
  });

  afterEach(() => {
    for (const k of [
      "NOTION_DEFAULT_WORKSPACE", "NOTION_API_KEY_PERSONAL",
      "NOTION_WORKSPACES_VICTOR", "NOTION_WORKSPACES_WATSON",
    ]) delete process.env[k];
  });

  it("discovers every configured workspace", () => {
    expect(listNotionWorkspaces()).toEqual(["personal", "work"]);
  });

  it("gives each agent only its assigned workspaces, most-preferred first", () => {
    expect(notionWorkspacesForAgent("victor")).toEqual(["personal"]);
    expect(notionWorkspacesForAgent("watson")).toEqual(["work", "personal"]);
  });

  // Guessing here would hand an unmapped agent whichever workspace happens to
  // be default — in a work+personal install, the one with the most to lose.
  it("fails closed for an unmapped agent when several workspaces exist", () => {
    expect(notionWorkspacesForAgent("sierra")).toEqual([]);
    expect(notionWorkspacesForAgent(null)).toEqual([]);

    const res = selectNotionWorkspace("sierra", undefined);
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toMatch(/NOTION_WORKSPACES_SIERRA/);
    expect((res as { error: string }).error).toMatch(/Refusing rather than guessing/);
  });

  // An identified-but-unmapped agent must not slip through by naming one.
  it("refuses an unmapped agent even when it names a workspace", () => {
    const res = selectNotionWorkspace("sierra", "work");
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toMatch(/no workspace is assigned/);
  });

  // No identity at all = an in-process/operator caller (scripts, smoke tests).
  // The rule is "never guess", and naming a workspace outright is not a guess.
  it("lets an unidentified caller name a workspace but never picks one for it", () => {
    expect(selectNotionWorkspace(null, "personal")).toEqual({ workspace: "personal" });

    const omitted = selectNotionWorkspace(null, undefined);
    expect(omitted).toHaveProperty("error");
    expect((omitted as { error: string }).error).toMatch(/Pass `workspace` to choose one/);

    const unknown = selectNotionWorkspace(null, "nope");
    expect((unknown as { error: string }).error).toMatch(/Unknown Notion workspace/);
  });

  it("still needs no mapping when only one workspace is configured", () => {
    delete process.env.NOTION_API_KEY_PERSONAL;
    expect(listNotionWorkspaces()).toEqual(["work"]);
    expect(notionWorkspacesForAgent("sierra")).toEqual(["work"]);
    expect(selectNotionWorkspace("sierra", undefined)).toEqual({ workspace: "work" });
  });

  it("lets ollama clones inherit their persona's mapping", () => {
    expect(notionWorkspacesForAgent("victor-ollama")).toEqual(["personal"]);
    expect(notionWorkspacesForAgent("watson-ollama")).toEqual(["work", "personal"]);
  });

  it("prefers a clone's own mapping when one is set explicitly", () => {
    process.env.NOTION_WORKSPACES_VICTOR_OLLAMA = "work";
    try {
      expect(notionWorkspacesForAgent("victor-ollama")).toEqual(["work"]);
    } finally {
      delete process.env.NOTION_WORKSPACES_VICTOR_OLLAMA;
    }
  });

  it("defaults a call to the agent's first workspace", () => {
    expect(selectNotionWorkspace("victor", undefined)).toEqual({ workspace: "personal" });
    expect(selectNotionWorkspace("watson", undefined)).toEqual({ workspace: "work" });
  });

  it("refuses a workspace outside the agent's allowlist rather than redirecting", () => {
    const res = selectNotionWorkspace("victor", "work");
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toMatch(/not permitted/);
    expect((res as { error: string }).error).toMatch(/personal/);
  });

  it("allows an explicit workspace that is on the allowlist", () => {
    expect(selectNotionWorkspace("watson", "personal")).toEqual({ workspace: "personal" });
  });

  it("resolves a different token per workspace", async () => {
    await expect(resolveNotionToken("work")).resolves.toBe("ntn_work");
    await expect(resolveNotionToken("personal")).resolves.toBe("ntn_personal");
  });

  it("reads a named workspace's 1Password ref from suffixed vars", async () => {
    delete process.env.NOTION_API_KEY_PERSONAL;
    process.env.NOTION_1PASSWORD_VAULT_PERSONAL = "PersonalVault";
    process.env.NOTION_1PASSWORD_ITEM_PERSONAL = "Personal Notion Token";
    resetNotionTokenCache();
    getSecret.mockResolvedValue("ntn_personal_op");
    try {
      await expect(resolveNotionToken("personal")).resolves.toBe("ntn_personal_op");
      expect(getSecret).toHaveBeenCalledWith("PersonalVault", "Personal Notion Token", "credential");
    } finally {
      delete process.env.NOTION_1PASSWORD_VAULT_PERSONAL;
      delete process.env.NOTION_1PASSWORD_ITEM_PERSONAL;
    }
  });

  it("names the configured workspaces when asked for an unconfigured one", async () => {
    await expect(resolveNotionToken("nonexistent")).rejects.toThrow(/Configured workspaces: personal, work/);
  });

  it("routes the handler's requests to the agent's workspace token", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers?.Authorization ?? "");
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) } as unknown as Response;
    }));

    process.env.NOTION_WORKSPACES_SIERRA = "work";
    try {
      await tool().handler({ operation: "search", _requester_agent_id: "victor" });
      await tool().handler({ operation: "search", _requester_agent_id: "sierra" });
    } finally {
      delete process.env.NOTION_WORKSPACES_SIERRA;
    }

    expect(seen).toEqual(["Bearer ntn_personal", "Bearer ntn_work"]);
  });

  it("blocks a cross-workspace call from the handler", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await tool().handler({
      operation: "search", workspace: "work", _requester_agent_id: "victor",
    }) as { error: string; allowed_workspaces: string[] };

    expect(res.error).toMatch(/not permitted/);
    expect(res.allowed_workspaces).toEqual(["personal"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the agent's workspaces via list_workspaces", async () => {
    const res = await tool().handler({ operation: "list_workspaces", _requester_agent_id: "watson" }) as {
      workspaces: string[]; default: string; configured: string[];
    };
    expect(res).toMatchObject({
      workspaces: ["work", "personal"],
      default: "work",
      configured: ["personal", "work"],
    });
  });
});

describe("normalizeNotionId", () => {
  it("dashes a bare 32-char id", () => {
    expect(normalizeNotionId("3ae105b8a632805685550000dd71ab77"))
      .toBe("3ae105b8-a632-8056-8555-0000dd71ab77");
  });

  it("extracts the id from a Notion URL", () => {
    expect(normalizeNotionId("https://www.notion.so/Some-Page-3ae105b8a632805685550000dd71ab77"))
      .toBe("3ae105b8-a632-8056-8555-0000dd71ab77");
  });

  it("passes an already-dashed id through unchanged", () => {
    const id = "3ae105b8-a632-8056-8555-0000dd71ab77";
    expect(normalizeNotionId(id)).toBe(id);
  });
});

describe("notionOperationLooksReadOnly", () => {
  it("classifies reads as reads", () => {
    for (const op of ["search", "get_page", "read", "fetch", "query_database", "get_database"]) {
      expect(notionOperationLooksReadOnly(op)).toBe(true);
    }
  });

  it("classifies every mutation as a write", () => {
    for (const op of ["create_page", "update_page", "append", "archive", "trash", "delete", "restore", "unarchive"]) {
      expect(notionOperationLooksReadOnly(op)).toBe(false);
    }
  });

  it("treats unknown or missing operations as writes", () => {
    expect(notionOperationLooksReadOnly("something_new")).toBe(false);
    expect(notionOperationLooksReadOnly(undefined)).toBe(false);
    expect(notionOperationLooksReadOnly(42)).toBe(false);
  });

  it("normalizes spacing and casing", () => {
    expect(notionOperationLooksReadOnly(" Get-Page ")).toBe(true);
  });
});

// Notion does not parse markdown: inline styling must arrive as separate runs
// carrying `annotations`, or `**bold**` renders as literal asterisks.
describe("inline markdown", () => {
  const annotationsOf = (seg: { annotations: Record<string, boolean> }) =>
    Object.keys(seg.annotations).filter((k) => seg.annotations[k]).sort();

  it.each([
    ["**bold**", "bold", ["bold"]],
    ["__bold__", "bold", ["bold"]],
    ["*italic*", "italic", ["italic"]],
    ["`code`", "code", ["code"]],
    ["~~strike~~", "strike", ["strikethrough"]],
  ])("parses %s", (input, content, annotations) => {
    const segs = parseInlineMarkdown(input);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.content).toBe(content);
    expect(annotationsOf(segs[0]!)).toEqual(annotations);
  });

  it("splits a mixed line into styled and plain runs", () => {
    const segs = parseInlineMarkdown("plain **bold** and *italic* mixed");
    expect(segs.map((s) => s.content)).toEqual(["plain ", "bold", " and ", "italic", " mixed"]);
    expect(annotationsOf(segs[1]!)).toEqual(["bold"]);
    expect(annotationsOf(segs[3]!)).toEqual(["italic"]);
    expect(annotationsOf(segs[0]!)).toEqual([]);
  });

  it("nests emphasis", () => {
    const segs = parseInlineMarkdown("**bold with *both* inside**");
    expect(annotationsOf(segs[1]!)).toEqual(["bold", "italic"]);
  });

  it("captures links, including styled ones", () => {
    expect(parseInlineMarkdown("[link](https://example.com)")[0])
      .toMatchObject({ content: "link", link: "https://example.com" });
    const bold = parseInlineMarkdown("**[text](https://x.com)**")[0]!;
    expect(bold.link).toBe("https://x.com");
    expect(annotationsOf(bold)).toEqual(["bold"]);
  });

  it("leaves snake_case alone", () => {
    const segs = parseInlineMarkdown("snake_case_name stays plain");
    expect(segs).toHaveLength(1);
    expect(annotationsOf(segs[0]!)).toEqual([]);
  });

  // A rejected `_` candidate must not swallow the opening delimiter of a real one.
  it("still finds real underscore emphasis after a snake_case token", () => {
    const segs = parseInlineMarkdown("a_b and _real italic_ here");
    expect(segs.map((s) => s.content)).toEqual(["a_b and ", "real italic", " here"]);
    expect(annotationsOf(segs[1]!)).toEqual(["italic"]);
  });

  it("honors backslash escapes and strips them", () => {
    const segs = parseInlineMarkdown("escaped \\*not italic\\*");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.content).toBe("escaped *not italic*");
    expect(annotationsOf(segs[0]!)).toEqual([]);
  });

  it("does not parse markdown inside a code span", () => {
    const segs = parseInlineMarkdown("`**literal**`");
    expect(segs[0]!.content).toBe("**literal**");
    expect(annotationsOf(segs[0]!)).toEqual(["code"]);
  });

  it("emits annotated rich text on blocks", () => {
    const block = markdownToBlocks("- **bold** item")[0] as {
      bulleted_list_item: { rich_text: Array<{ text: { content: string }; annotations?: Record<string, boolean> }> };
    };
    const runs = block.bulleted_list_item.rich_text;
    expect(runs[0]).toMatchObject({ text: { content: "bold" }, annotations: { bold: true } });
    expect(runs[1]!.annotations).toBeUndefined();
    expect(runs[1]!.text.content).toBe(" item");
  });

  it("keeps code-block bodies literal", () => {
    const block = markdownToBlocks("```\nconst a = **b**;\n```")[0] as {
      code: { rich_text: Array<{ text: { content: string }; annotations?: unknown }> };
    };
    expect(block.code.rich_text[0]!.text.content).toBe("const a = **b**;");
    expect(block.code.rich_text[0]!.annotations).toBeUndefined();
  });

  it("still splits a long styled run at Notion's 2000-char limit", () => {
    const runs = (markdownToBlocks(`**${"x".repeat(2500)}**`)[0] as {
      paragraph: { rich_text: Array<{ text: { content: string }; annotations?: Record<string, boolean> }> };
    }).paragraph.rich_text;
    expect(runs).toHaveLength(2);
    expect(runs[0]!.text.content).toHaveLength(2000);
    expect(runs.every((r) => r.annotations?.bold)).toBe(true);
  });
});

describe("markdownToBlocks", () => {
  it("maps each markdown form to its Notion block type", () => {
    const blocks = markdownToBlocks(
      "# Title\n## Sub\n### Deep\n- bullet\n1. numbered\n- [ ] todo\n- [x] done\n> quote\n---\nplain",
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1", "heading_2", "heading_3",
      "bulleted_list_item", "numbered_list_item",
      "to_do", "to_do", "quote", "divider", "paragraph",
    ]);
    expect((blocks[5] as { to_do: { checked: boolean } }).to_do.checked).toBe(false);
    expect((blocks[6] as { to_do: { checked: boolean } }).to_do.checked).toBe(true);
  });

  it("clamps headings deeper than three levels", () => {
    expect(markdownToBlocks("##### deep")[0]!.type).toBe("heading_3");
  });

  it("keeps code fences intact and maps the language", () => {
    const blocks = markdownToBlocks("```ts\nconst a = 1;\nconst b = 2;\n```");
    expect(blocks).toHaveLength(1);
    const code = blocks[0] as { type: string; code: { language: string; rich_text: Array<{ text: { content: string } }> } };
    expect(code.type).toBe("code");
    expect(code.code.language).toBe("typescript");
    expect(code.code.rich_text[0]!.text.content).toBe("const a = 1;\nconst b = 2;");
  });

  it("falls back to plain text for unknown code languages", () => {
    const code = markdownToBlocks("```wat\nx\n```")[0] as { code: { language: string } };
    expect(code.code.language).toBe("plain text");
  });

  it("does not treat blank lines as blocks", () => {
    expect(markdownToBlocks("a\n\n\nb")).toHaveLength(2);
  });

  it("splits content longer than Notion's 2000-char run limit", () => {
    const runs = (markdownToBlocks("x".repeat(4500))[0] as {
      paragraph: { rich_text: Array<{ text: { content: string } }> };
    }).paragraph.rich_text;
    expect(runs).toHaveLength(3);
    expect(runs[0]!.text.content).toHaveLength(2000);
    expect(runs[2]!.text.content).toHaveLength(500);
  });
});

describe("notion tool handler", () => {
  beforeEach(() => {
    process.env[NOTION_TOKEN_ENV] = "ntn_test";
    resetNotionTokenCache();
  });

  it("summarizes search results", async () => {
    stubFetch({
      "POST /search": {
        body: {
          results: [
            {
              id: "page-1", object: "page", url: "https://notion.so/page-1",
              last_edited_time: "2026-08-01T00:00:00.000Z",
              properties: { Name: { type: "title", title: [{ plain_text: "Example" }] } },
            },
          ],
          has_more: false, next_cursor: null,
        },
      },
    });

    const res = await tool().handler({ operation: "search", query: "example" }) as {
      results: Array<{ id: string; title: string }>;
      has_more: boolean;
    };
    expect(res.results).toEqual([
      expect.objectContaining({ id: "page-1", title: "Example", url: "https://notion.so/page-1" }),
    ]);
    expect(res.has_more).toBe(false);
  });

  it("reads a page's properties and flattened content", async () => {
    stubFetch({
      "GET /pages/": {
        body: {
          id: "page-1", url: "https://notion.so/page-1",
          properties: { Name: { type: "title", title: [{ plain_text: "Doc" }] } },
        },
      },
      "GET /blocks/": {
        body: {
          results: [
            { id: "b1", type: "heading_1", has_children: false, heading_1: { rich_text: [{ plain_text: "Title" }] } },
            { id: "b2", type: "to_do", has_children: false, to_do: { rich_text: [{ plain_text: "task" }], checked: true } },
          ],
          has_more: false, next_cursor: null,
        },
      },
    });

    const res = await tool().handler({ operation: "get_page", page_id: "page-1" }) as { title: string; content: string };
    expect(res.title).toBe("Doc");
    expect(res.content).toBe("# Title\n- [x] task");
  });

  it("surfaces a probe failure that is not a wrong-object-type error", async () => {
    stubFetch({
      "GET /databases/": { status: 429, body: { message: "Rate limited", code: "rate_limited" } },
    });

    const res = await tool().handler({
      operation: "create_page", parent_id: "parent-1", title: "Report",
    }) as { error: string };
    expect(res.error).toMatch(/429/);
  });

  // Without this the reader drops styling, so get_page → edit → write silently
  // strips every bold/italic/link the page had.
  it("renders annotations back into markdown on read", async () => {
    stubFetch({
      "GET /pages/": { body: { id: "page-1", properties: { Name: { type: "title", title: [{ plain_text: "Doc" }] } } } },
      "GET /blocks/": {
        body: {
          results: [
            {
              id: "b1", type: "paragraph", has_children: false,
              paragraph: { rich_text: [
                { plain_text: "plain ", annotations: {} },
                { plain_text: "bold", annotations: { bold: true } },
                { plain_text: " and ", annotations: {} },
                { plain_text: "italic", annotations: { italic: true } },
                { plain_text: " and ", annotations: {} },
                { plain_text: "code", annotations: { code: true } },
                { plain_text: " and ", annotations: {} },
                { plain_text: "gone", annotations: { strikethrough: true } },
                { plain_text: " and ", annotations: {} },
                { plain_text: "a link", annotations: {}, href: "https://example.com" },
              ] },
            },
          ],
          has_more: false, next_cursor: null,
        },
      },
    });

    const res = await tool().handler({ operation: "get_page", page_id: "page-1" }) as { content: string };
    expect(res.content).toBe(
      "plain **bold** and *italic* and `code` and ~~gone~~ and [a link](https://example.com)",
    );
  });

  it("survives a write → read round trip with inline styling intact", async () => {
    const source = "## Notes\n- **bold** and *italic*\n- `code` and [link](https://example.com)\n> ~~struck~~";

    // Feed the blocks the writer produced back through the reader's shape.
    const blocks = markdownToBlocks(source) as Array<Record<string, any>>;
    stubFetch({
      "GET /pages/": { body: { id: "p", properties: { N: { type: "title", title: [{ plain_text: "T" }] } } } },
      "GET /blocks/": {
        body: {
          results: blocks.map((b, i) => ({
            id: `b${i}`, type: b.type, has_children: false,
            [b.type]: {
              ...b[b.type],
              rich_text: (b[b.type].rich_text ?? []).map((r: any) => ({
                plain_text: r.text.content,
                annotations: r.annotations ?? {},
                href: r.text.link?.url ?? null,
              })),
            },
          })),
          has_more: false, next_cursor: null,
        },
      },
    });

    const res = await tool().handler({ operation: "get_page", page_id: "p" }) as { content: string };
    expect(res.content).toBe(source);
  });

  // Editing needs addressable blocks; without ids the only option was to
  // rebuild the whole page, which loses the link and any human edits.
  describe("in-place block editing", () => {
    const BLOCKS = {
      results: [
        { id: "b1", type: "heading_2", has_children: false, heading_2: { rich_text: [{ plain_text: "Section" }] } },
        {
          id: "b2", type: "bulleted_list_item", has_children: false,
          bulleted_list_item: { rich_text: [
            { plain_text: "keep ", annotations: {} },
            { plain_text: "this", annotations: { bold: true } },
          ] },
        },
        { id: "b3", type: "to_do", has_children: false, to_do: { rich_text: [{ plain_text: "a task" }], checked: false } },
      ],
      has_more: false, next_cursor: null,
    };

    it("lists blocks with ids, types and markdown text", async () => {
      stubFetch({ "GET /blocks/": { body: BLOCKS } });
      const res = await tool().handler({ operation: "get_blocks", page_id: "p1" }) as {
        count: number; blocks: Array<{ id: string; type: string; text: string }>;
      };
      expect(res.count).toBe(3);
      expect(res.blocks[0]).toMatchObject({ id: "b1", type: "heading_2", text: "Section" });
      // Existing styling is surfaced as markdown so it can be matched and kept.
      expect(res.blocks[1]!.text).toBe("keep **this**");
    });

    it("rewrites a block in place, keeping its type", async () => {
      const calls = stubFetch({
        "GET /blocks/b2": { body: { id: "b2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [] } } },
        "PATCH /blocks/b2": { body: { id: "b2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "new text" }] } } },
      });

      const res = await tool().handler({ operation: "update_block", block_id: "b2", markdown: "new text" }) as {
        id: string; type: string;
      };
      expect(res).toMatchObject({ id: "b2", type: "bulleted_list_item" });

      const patch = calls.find((c) => c.method === "PATCH")!;
      expect(patch.body).toHaveProperty("bulleted_list_item");
    });

    // "- new text" on a bullet must not produce "- - new text".
    it("does not double a list marker when the markdown repeats it", async () => {
      const calls = stubFetch({
        "GET /blocks/b2": { body: { id: "b2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [] } } },
        "PATCH /blocks/b2": { body: { id: "b2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [] } } },
      });

      await tool().handler({ operation: "update_block", block_id: "b2", markdown: "- swapped **bold**" });
      const sent = (calls.find((c) => c.method === "PATCH")!.body as {
        bulleted_list_item: { rich_text: Array<{ text: { content: string }; annotations?: Record<string, boolean> }> };
      }).bulleted_list_item.rich_text;
      expect(sent[0]!.text.content).toBe("swapped ");
      expect(sent[1]).toMatchObject({ text: { content: "bold" }, annotations: { bold: true } });
    });

    it("ticks a to-do without touching its text", async () => {
      const calls = stubFetch({
        "GET /blocks/b3": { body: { id: "b3", type: "to_do", to_do: { rich_text: [{ plain_text: "a task" }], checked: false } } },
        "PATCH /blocks/b3": { body: { id: "b3", type: "to_do", to_do: { rich_text: [{ plain_text: "a task" }], checked: true } } },
      });

      await tool().handler({ operation: "update_block", block_id: "b3", checked: true });
      expect((calls.find((c) => c.method === "PATCH")!.body as { to_do: { checked: boolean } }).to_do.checked).toBe(true);
    });

    it("refuses to rewrite a block with no editable text", async () => {
      stubFetch({ "GET /blocks/b9": { body: { id: "b9", type: "divider", divider: {} } } });
      const res = await tool().handler({ operation: "update_block", block_id: "b9", markdown: "x" }) as { error: string };
      expect(res.error).toMatch(/has no editable text/);
      expect(res.error).toMatch(/delete_block/);
    });

    it("deletes a block", async () => {
      const calls = stubFetch({ "DELETE /blocks/b2": { body: { id: "b2", archived: true } } });
      await expect(tool().handler({ operation: "delete_block", block_id: "b2" }))
        .resolves.toMatchObject({ id: "b2", deleted: true });
      expect(calls[0]!.method).toBe("DELETE");
    });

    it("inserts after a sibling by resolving its parent", async () => {
      const calls = stubFetch({
        "GET /blocks/b2": { body: { id: "b2", parent: { type: "page_id", page_id: "p1" } } },
        "PATCH /blocks/p1": { body: { results: [] } },
      });

      const res = await tool().handler({ operation: "insert_after", block_id: "b2", markdown: "- added" }) as {
        inserted: number; parent_id: string;
      };
      expect(res).toMatchObject({ inserted: 1, parent_id: "p1" });

      const patch = calls.find((c) => c.method === "PATCH")!;
      expect(patch.path).toBe("/blocks/p1/children");
      expect((patch.body as { after: string }).after).toBe("b2");
    });

    it("replaces wording in the one block that holds it, preserving styling", async () => {
      const calls = stubFetch({
        "GET /blocks/p1/children": { body: BLOCKS },
        "GET /blocks/b2": { body: { id: "b2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [] } } },
        "PATCH /blocks/b2": { body: { id: "b2", type: "bulleted_list_item", bulleted_list_item: { rich_text: [] } } },
      });

      const res = await tool().handler({
        operation: "replace_text", page_id: "p1", find: "keep", replace: "swap",
      }) as { replaced: number };
      expect(res.replaced).toBe(1);

      const sent = (calls.find((c) => c.method === "PATCH")!.body as {
        bulleted_list_item: { rich_text: Array<{ text: { content: string }; annotations?: Record<string, boolean> }> };
      }).bulleted_list_item.rich_text;
      expect(sent[0]!.text.content).toBe("swap ");
      // The bold run survived the rewrite rather than being flattened.
      expect(sent[1]).toMatchObject({ text: { content: "this" }, annotations: { bold: true } });
    });

    // Silently editing the wrong paragraph of a real document is expensive.
    it("refuses an ambiguous replace and lists the candidates", async () => {
      stubFetch({
        "GET /blocks/p1/children": {
          body: {
            results: [
              { id: "x1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "the term here" }] } },
              { id: "x2", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "the term again" }] } },
            ],
            has_more: false, next_cursor: null,
          },
        },
      });

      const res = await tool().handler({
        operation: "replace_text", page_id: "p1", find: "term", replace: "word",
      }) as { error: string; matched: number; candidates: Array<{ id: string }> };
      expect(res.matched).toBe(2);
      expect(res.error).toMatch(/all:true/);
      expect(res.candidates.map((c) => c.id)).toEqual(["x1", "x2"]);
    });

    it("reports a replace that matched nothing", async () => {
      stubFetch({ "GET /blocks/": { body: BLOCKS } });
      const res = await tool().handler({
        operation: "replace_text", page_id: "p1", find: "absent", replace: "x",
      }) as { error: string; matched: number };
      expect(res.matched).toBe(0);
      expect(res.error).toMatch(/No block on this page contains/);
    });

    it("classifies the editing operations for governance", () => {
      expect(notionOperationLooksReadOnly("get_blocks")).toBe(true);
      for (const op of ["update_block", "delete_block", "insert_after", "replace_text"]) {
        expect(notionOperationLooksReadOnly(op)).toBe(false);
      }
    });
  });

  it("points at query_database when get_page is handed a database id", async () => {
    stubFetch({
      "GET /pages/": { status: 404, body: { message: "Could not find page", code: "object_not_found" } },
      "GET /databases/": { body: { object: "database", id: "db-1", properties: {} } },
    });

    const res = await tool().handler({ operation: "get_page", page_id: "db-1" }) as { error?: string };
    expect(res.error).toMatch(/is a database, not a page/);
    expect(res.error).toMatch(/query_database/);
  });

  // Notion answers a page id probed against /databases with 400, not 404 —
  // a live-test finding. Both must fall through to a page parent.
  it.each([
    [400, { message: "Provided ID is a page, not a database", code: "validation_error" }],
    [404, { message: "Could not find database", code: "object_not_found" }],
  ])("creates a sub-page under a page parent when the database probe returns %i", async (status, body) => {
    const calls = stubFetch({
      "GET /databases/": { status, body },
      "POST /pages": { body: { id: "new-1", url: "https://notion.so/new-1" } },
    });

    const res = await tool().handler({
      operation: "create_page", parent_id: "parent-1", title: "Report", markdown: "## Section\n- point",
    }) as { parent_kind: string; blocks_written: number };

    expect(res.parent_kind).toBe("page");
    expect(res.blocks_written).toBe(2);

    const create = calls.find((c) => c.method === "POST" && c.path === "/pages")!;
    const sent = create.body as { parent: Record<string, string>; properties: Record<string, unknown>; children: unknown[] };
    expect(sent.parent).toHaveProperty("page_id");
    expect(sent.properties).toHaveProperty("title");
    expect(sent.children).toHaveLength(2);
  });

  it("creates a database row using the database's own title property", async () => {
    const calls = stubFetch({
      "GET /databases/": {
        body: {
          object: "database", id: "db-1",
          properties: { "Task name": { type: "title" }, Status: { type: "select" } },
        },
      },
      "POST /pages": { body: { id: "row-1", url: "https://notion.so/row-1" } },
    });

    const res = await tool().handler({
      operation: "create_page",
      parent_id: "db-1",
      title: "New request",
      properties: { Status: { select: { name: "In progress" } } },
    }) as { parent_kind: string };

    expect(res.parent_kind).toBe("database");

    const body = calls.find((c) => c.path === "/pages")!.body as {
      parent: Record<string, string>;
      properties: Record<string, unknown>;
    };
    expect(body.parent).toEqual({ database_id: "db-1" });
    expect(body.properties).toHaveProperty("Task name");
    expect(body.properties).toHaveProperty("Status");
    expect(body.properties).not.toHaveProperty("title");
  });

  it("batches appends past Notion's 100-block limit", async () => {
    const calls = stubFetch({ "PATCH /blocks/": { body: { results: [] } } });

    const markdown = Array.from({ length: 250 }, (_, i) => `- item ${i}`).join("\n");
    const res = await tool().handler({ operation: "append", page_id: "page-1", markdown }) as {
      appended: number; batches: number;
    };

    expect(res).toMatchObject({ appended: 250, batches: 3 });
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(3);
    expect((patches[0]!.body as { children: unknown[] }).children).toHaveLength(100);
    expect((patches[2]!.body as { children: unknown[] }).children).toHaveLength(50);
  });

  it("rejects an empty append instead of calling the API", async () => {
    const calls = stubFetch({});
    const res = await tool().handler({ operation: "append", page_id: "page-1", markdown: "   " }) as { error: string };
    expect(res.error).toMatch(/non-empty markdown/);
    expect(calls).toHaveLength(0);
  });

  it("archives and restores through the in_trash flag", async () => {
    const calls = stubFetch({ "PATCH /pages/": { body: { id: "page-1" } } });

    await expect(tool().handler({ operation: "archive", page_id: "page-1" }))
      .resolves.toMatchObject({ archived: true });
    await expect(tool().handler({ operation: "restore", page_id: "page-1" }))
      .resolves.toMatchObject({ archived: false });

    expect((calls[0]!.body as { in_trash: boolean }).in_trash).toBe(true);
    expect((calls[1]!.body as { in_trash: boolean }).in_trash).toBe(false);
  });

  it("returns the database schema as property name → type", async () => {
    stubFetch({
      "GET /databases/": {
        body: {
          object: "database", id: "db-1", url: "https://notion.so/db-1",
          title: [{ plain_text: "Offboarding" }],
          properties: { Name: { type: "title" }, Status: { type: "select" }, Due: { type: "date" } },
        },
      },
    });

    const res = await tool().handler({ operation: "get_database", database_id: "db-1" }) as {
      title: string; properties: Record<string, string>;
    };
    expect(res.title).toBe("Offboarding");
    expect(res.properties).toEqual({ Name: "title", Status: "select", Due: "date" });
  });

  it("explains a 404 as an unshared page rather than a missing one", async () => {
    stubFetch({
      "GET /pages/": { status: 404, body: { message: "Could not find page", code: "object_not_found" } },
      "GET /databases/": { status: 404, body: { message: "Could not find database", code: "object_not_found" } },
    });

    const res = await tool().handler({ operation: "get_page", page_id: "page-1" }) as { error: string; code?: string };
    expect(res.error).toMatch(/not be shared with this installation's Notion integration/);
    expect(res.code).toBe("object_not_found");
  });

  it("surfaces a missing-credential setup hint instead of throwing", async () => {
    delete process.env[NOTION_TOKEN_ENV];
    resetNotionTokenCache();
    stubFetch({});

    const res = await tool().handler({ operation: "search", query: "x" }) as { error: string };
    expect(res.error).toMatch(/NOTION_API_KEY/);
  });

  it("lists the valid operations when given an unknown one", async () => {
    const res = await tool().handler({ operation: "frobnicate" }) as { error: string };
    expect(res.error).toMatch(/Unknown notion operation/);
    expect(res.error).toMatch(/query_database/);
  });

  it("requires a parent for create_page", async () => {
    const calls = stubFetch({});
    const res = await tool().handler({ operation: "create_page", title: "x" }) as { error: string };
    expect(res.error).toMatch(/needs a parent_id/);
    expect(calls).toHaveLength(0);
  });
});
