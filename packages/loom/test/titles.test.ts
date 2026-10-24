import { describe, expect, it } from "vitest";
import { cleanTitle, createClaudeTitler, TITLE_MODEL } from "../src/claude/titler.js";
import { LoomHost } from "../src/host.js";
import { LoomStore } from "../src/store.js";
import { FakeRuntime } from "./fake-runtime.js";

const flush = () => new Promise((r) => setTimeout(r, 5));

describe("cleanTitle", () => {
  it("keeps one plain line and drops quotes, markdown and labels", () => {
    expect(cleanTitle('"Harbor Hub Map"\n')).toBe("Harbor Hub Map");
    expect(cleanTitle("# Title: Fix Flaky Export Test.")).toBe("Fix Flaky Export Test");
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("a ".repeat(30))).toBeNull();
  });
});

describe("createClaudeTitler", () => {
  it("asks the small model with no tools and no saved transcript, on the thread's account", async () => {
    let seen: any;
    const titler = createClaudeTitler({
      account: (name) => ({ name: name ?? "a", configDir: `/cfg/${name}` }),
      query: ((params: any) => {
        seen = params;
        return (async function* () {
          yield { type: "result", subtype: "success", is_error: false, result: "Harbor Hub" };
        })();
      }) as any,
    });
    expect(await titler("# Handoff: build the Harbor hub (map and track)", "team")).toBe("Harbor Hub");
    expect(seen.options).toMatchObject({ model: TITLE_MODEL, tools: [], maxTurns: 1, persistSession: false, settingSources: [] });
    expect(seen.options.env.CLAUDE_CONFIG_DIR).toBe("/cfg/team");
    expect(seen.prompt).toContain("Harbor hub");
  });

  it("gives up quietly when the model fails", async () => {
    const titler = createClaudeTitler({
      account: () => ({ name: "a" }),
      query: (() => (async function* () { yield { type: "result", subtype: "success", is_error: true, result: "Not logged in" }; })()) as any,
    });
    expect(await titler("x", null)).toBeNull();
  });
});

describe("thread titles and repos", () => {
  function setup(titler: (text: string, account: string | null) => Promise<string | null>) {
    const store = new LoomStore(":memory:");
    const host = new LoomHost(store, { fake: new FakeRuntime() }, {
      titler,
      createWorktree: async (repoPath, threadId) => ({ path: `/wts/${threadId.slice(0, 8)}`, repo: `${repoPath}-root` }),
    });
    return { store, host };
  }

  it("replaces a draft title with a generated one", async () => {
    const { store, host } = setup(async () => "Harbor Hub");
    const r = await host.execute({ type: "submit", commandId: "c1", text: "# Handoff: build it", cwd: "/r", provider: "fake", title: "# Handoff: build it", autoTitle: true });
    await flush();
    expect(store.thread(r.threadId!)).toMatchObject({ title: "Harbor Hub", title_source: "generated" });
  });

  it("keeps a title the owner gave", async () => {
    const { store, host } = setup(async () => "Something Else");
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/r", provider: "fake", title: "My name for it" });
    await flush();
    expect(store.thread(r.threadId!)).toMatchObject({ title: "My name for it", title_source: "given" });
  });

  it("never overwrites a rename that landed while the name was being made", async () => {
    let finish!: (title: string) => void;
    const { store, host } = setup(() => new Promise((resolve) => (finish = resolve)));
    const r = await host.execute({ type: "submit", commandId: "c1", text: "go", cwd: "/r", provider: "fake" });
    await host.execute({ type: "rename", commandId: "c2", threadId: r.threadId!, title: "Owner's Name" });
    finish("Generated Name");
    await flush();
    expect(store.thread(r.threadId!)).toMatchObject({ title: "Owner's Name", title_source: "owner" });
  });

  it("names only a new thread, not later replies", async () => {
    let calls = 0;
    const { host } = setup(async () => (calls++, "Name"));
    const r = await host.execute({ type: "submit", commandId: "c1", text: "one", cwd: "/r", provider: "fake" });
    await host.execute({ type: "submit", commandId: "c2", threadId: r.threadId, text: "two" });
    await flush();
    expect(calls).toBe(1);
  });

  it("records the checkout a thread works on: the worktree's repo, or its cwd", async () => {
    const { store, host } = setup(async () => null);
    const a = await host.execute({ type: "submit", commandId: "c1", text: "go", provider: "fake", worktree: { repoPath: "/repos/acme" } });
    expect(store.thread(a.threadId!)).toMatchObject({ repo: "/repos/acme-root", cwd: `/wts/${a.threadId!.slice(0, 8)}` });
    const b = await host.execute({ type: "submit", commandId: "c2", text: "go", cwd: "/repos/sideproject", provider: "fake" });
    expect(store.thread(b.threadId!)!.repo).toBe("/repos/sideproject");
  });
});
