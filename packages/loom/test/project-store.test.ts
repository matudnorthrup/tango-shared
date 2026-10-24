import { describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { linkProject, linkSession, linkTranscript, projectSlug } from "../src/claude/project-store.js";
import { ClaudeRuntime } from "../src/claude/claude-runtime.js";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loom-links-")));
  const a = join(root, "a"), b = join(root, "b"), shared = join(root, "shared");
  const cwd = "/work/test", slug = projectSlug(cwd);
  const dir = (account: string) => join(account, "projects", slug);
  const file = (account: string) => join(dir(account), "session.jsonl");
  return { root, a, b, shared, cwd, slug, dir, file };
}

describe("real Claude project directories", () => {
  it("leaves non-Loom project trees unchanged during startup and opening another slug", async () => {
    const f = fixture();
    const personal = join(f.a, "projects", "personal");
    mkdirSync(join(personal, "memory"), { recursive: true });
    writeFileSync(join(personal, "memory", "notes"), "private fixture");
    writeFileSync(join(personal, "other.jsonl"), "unrelated history");
    const tree = (path: string): unknown => readdirSync(path).sort().map(name => {
      const child = join(path, name), stat = lstatSync(child);
      return [name, stat.ino, stat.mtimeMs, stat.isDirectory() ? tree(child) : readFileSync(child, "utf8")];
    });
    symlinkSync(personal, join(f.a, "projects", "personal-link"));
    const before = tree(personal);
    const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: f.a }], defaultAccount: "a", sharedProjectsDir: f.shared,
      query: (() => { throw new Error("test stopped before harness"); }) as never });
    expect(tree(personal)).toEqual(before);
    await expect(runtime.open({ threadId: "t", cwd: f.cwd, account: "a", nativeSessionId: null }, () => {})).rejects.toThrow("test stopped");
    expect(tree(personal)).toEqual(before);
    expect(existsSync(join(f.shared, "personal"))).toBe(false);
    expect(readlinkSync(join(f.a, "projects", "personal-link"))).toBe(personal);
    rmSync(f.root, { recursive: true });
  });

  it.each(["config", "projects"])("warns without copying a symlinked %s parent", kind => {
    const f = fixture();
    const actual = join(f.root, "actual");
    mkdirSync(join(actual, "personal"), { recursive: true });
    writeFileSync(join(actual, "personal", "notes"), "keep");
    if (kind === "projects") mkdirSync(f.a);
    const path = kind === "config" ? f.a : join(f.a, "projects");
    symlinkSync(actual, path);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      new ClaudeRuntime({ accounts: [{ name: "a", configDir: f.a }], defaultAccount: "a", sharedProjectsDir: f.shared });
      expect(readlinkSync(path)).toBe(actual);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(path));
      expect(readdirSync(f.root).some(name => name.includes("loom-backup"))).toBe(false);
    } finally { warn.mockRestore(); rmSync(f.root, { recursive: true }); }
  });

  it("reconciles only session X into the target and only reads other accounts", async () => {
    const f = fixture();
    const shared = join(f.shared, f.slug);
    for (const dir of [f.dir(f.a), f.dir(f.b), shared]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(shared, "X.jsonl"), "old");
    utimesSync(join(shared, "X.jsonl"), 1, 1);
    writeFileSync(join(f.dir(f.b), "X.jsonl"), "new");
    for (const id of ["X", "Y"]) {
      mkdirSync(join(f.dir(f.b), id));
      writeFileSync(join(f.dir(f.b), id, "output"), id);
    }
    writeFileSync(join(f.dir(f.b), "Y.jsonl"), "other session");
    const linkedCompanion = join(f.root, "companion");
    mkdirSync(linkedCompanion);
    writeFileSync(join(linkedCompanion, "existing"), "keep");
    symlinkSync(linkedCompanion, join(f.dir(f.a), "X"));
    const before = readdirSync(f.dir(f.b));
    const ino = statSync(join(f.dir(f.b), "X.jsonl")).ino;
    const runtime = new ClaudeRuntime({ accounts: [{ name: "a", configDir: f.a }, { name: "b", configDir: f.b }], defaultAccount: "a", sharedProjectsDir: f.shared,
      query: (() => { throw new Error("test stopped before harness"); }) as never });
    await expect(runtime.open({ threadId: "t", cwd: f.cwd, account: "a", nativeSessionId: "X" }, () => {})).rejects.toThrow("test stopped");
    expect(readFileSync(join(f.dir(f.a), "X", "output"), "utf8")).toBe("X");
    expect(statSync(join(f.dir(f.a), "X", "output")).ino).toBe(statSync(join(f.dir(f.b), "X", "output")).ino);
    expect(lstatSync(join(f.dir(f.a), "X")).isDirectory()).toBe(true);
    expect(readFileSync(join(f.dir(f.a), "X", "existing"), "utf8")).toBe("keep");
    expect(existsSync(join(f.dir(f.a), "Y.jsonl"))).toBe(false);
    expect(existsSync(join(f.dir(f.a), "Y"))).toBe(false);
    expect(existsSync(join(shared, "Y"))).toBe(false);
    expect(readdirSync(f.dir(f.b))).toEqual(before);
    expect(statSync(join(f.dir(f.b), "X.jsonl")).ino).toBe(ino);
    expect(statSync(join(f.dir(f.a), "X.jsonl")).ino).toBe(ino);
    rmSync(f.root, { recursive: true });
  });

  it("shares appends across accounts and hard-links companion files without overwriting", () => {
    const f = fixture();
    linkProject(f.a, f.shared, f.cwd);
    writeFileSync(f.file(f.a), "history\n");
    mkdirSync(join(f.dir(f.a), "session", "tool-results"), { recursive: true });
    writeFileSync(join(f.dir(f.a), "session", "tool-results", "large"), "output");
    linkProject(f.a, f.shared, f.cwd);
    linkProject(f.b, f.shared, f.cwd);
    appendFileSync(f.file(f.a), "next\n");
    for (const file of [f.file(f.b), join(f.shared, f.slug, "session.jsonl")]) {
      expect(statSync(file).ino).toBe(statSync(f.file(f.a)).ino);
      expect(readFileSync(file, "utf8")).toBe("history\nnext\n");
    }
    const folder = join(f.dir(f.b), "session", "tool-results");
    let path = f.b;
    for (const part of relative(f.b, folder).split(sep)) {
      path = join(path, part);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
    }
    expect(statSync(join(folder, "large")).ino).toBe(statSync(join(f.dir(f.a), "session", "tool-results", "large")).ino);
    rmSync(join(folder, "large"));
    writeFileSync(join(folder, "large"), "keep target");
    linkProject(f.b, f.shared, f.cwd);
    expect(readFileSync(join(folder, "large"), "utf8")).toBe("keep target");
    rmSync(f.root, { recursive: true });
  });

  it("migrates at runtime startup and is idempotent on open", () => {
    const f = fixture();
    const source = join(f.shared, f.slug);
    mkdirSync(join(source, "session", "tool-results"), { recursive: true });
    writeFileSync(join(source, "session.jsonl"), "history");
    writeFileSync(join(source, "session", "tool-results", "large"), "output");
    mkdirSync(join(f.a, "projects"), { recursive: true });
    symlinkSync(source, f.dir(f.a));
    new ClaudeRuntime({ accounts: [{ name: "a", configDir: f.a }], defaultAccount: "a", sharedProjectsDir: f.shared });
    expect(lstatSync(f.dir(f.a)).isDirectory()).toBe(true);
    expect(statSync(join(f.dir(f.a), "session", "tool-results", "large")).ino).toBe(statSync(join(source, "session", "tool-results", "large")).ino);
    const ino = statSync(f.file(f.a)).ino;
    linkProject(f.a, f.shared, f.cwd);
    expect(statSync(f.file(f.a)).ino).toBe(ino);
    expect(statSync(join(source, "session.jsonl")).ino).toBe(ino);
    expect(readFileSync(join(f.dir(f.a), "session", "tool-results", "large"), "utf8")).toBe("output");
    rmSync(f.root, { recursive: true });
  });

  it.each([true, false])("preserves the newer inode and backs up the loser (local newer: %s)", localNewer => {
    const f = fixture();
    linkProject(f.a, f.shared, f.cwd);
    const shared = join(f.shared, f.slug, "session.jsonl");
    writeFileSync(f.file(f.a), localNewer ? "new" : "old");
    writeFileSync(shared, localNewer ? "old" : "new");
    utimesSync(localNewer ? shared : f.file(f.a), 1, 1);
    linkProject(f.a, f.shared, f.cwd, 42);
    expect(readFileSync(shared, "utf8")).toBe("new");
    expect(statSync(shared).ino).toBe(statSync(f.file(f.a)).ino);
    expect(readFileSync(`${localNewer ? shared : f.file(f.a)}.loom-backup-42`, "utf8")).toBe("old");
    rmSync(f.root, { recursive: true });
  });

  it("dereferences companion symlinks into real directories and hard-linked files", () => {
    const f = fixture();
    try {
      const source = join(f.root, "source");
      mkdirSync(source);
      writeFileSync(join(source, "output"), "output");
      mkdirSync(join(f.dir(f.a), "session"), { recursive: true });
      symlinkSync(source, join(f.dir(f.a), "session", "tool-results"));
      symlinkSync(join(source, "output"), join(f.dir(f.a), "session", "file"));
      linkSession(f.b, f.shared, f.cwd, "session", [f.a]);
      const target = join(f.dir(f.b), "session");
      expect(lstatSync(join(target, "tool-results")).isDirectory()).toBe(true);
      for (const file of [join(target, "file"), join(target, "tool-results", "output")]) {
        expect(lstatSync(file).isFile()).toBe(true);
        expect(statSync(file).ino).toBe(statSync(join(source, "output")).ino);
      }
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it.each(["EXDEV", "EPERM"])("copies companion files on %s for migration and session linking", code => {
    const f = fixture();
    try {
      const source = join(f.dir(f.a), "session", "tool-results", "output");
      mkdirSync(join(f.dir(f.a), "session", "tool-results"), { recursive: true });
      writeFileSync(source, "output");
      const link = vi.fn(() => { throw Object.assign(new Error(code), { code }); });
      linkProject(f.a, f.shared, f.cwd, 42, { link });
      const shared = join(f.shared, f.slug, "session", "tool-results", "output");
      expect(readFileSync(shared, "utf8")).toBe("output");
      expect(statSync(shared).ino).not.toBe(statSync(source).ino);
      linkSession(f.b, f.shared, f.cwd, "session", [f.a], { link });
      const target = join(f.dir(f.b), "session", "tool-results", "output");
      expect(readFileSync(target, "utf8")).toBe("output");
      expect(statSync(target).ino).not.toBe(statSync(source).ino);
      expect(statSync(target).ino).not.toBe(statSync(shared).ino);
      expect(link).toHaveBeenCalled();
    } finally { rmSync(f.root, { recursive: true }); }
  });

  it("copies on EXDEV and refreshes the shared name after appends", () => {
    const f = fixture();
    mkdirSync(f.dir(f.a), { recursive: true });
    writeFileSync(f.file(f.a), "history");
    const shared = join(f.shared, f.slug, "session.jsonl");
    const warn = vi.fn();
    const link = vi.fn(() => { throw Object.assign(new Error("cross volume"), { code: "EXDEV" }); });
    linkTranscript(f.file(f.a), shared, 42, { link, warn });
    expect(readFileSync(shared, "utf8")).toBe("history");
    appendFileSync(f.file(f.a), " appended");
    utimesSync(f.file(f.a), new Date(), new Date(Date.now() + 1000));
    linkTranscript(f.file(f.a), shared, 43, { link, warn });
    expect(readFileSync(shared, "utf8")).toBe("history appended");
    linkTranscript(f.file(f.b), shared, 44, { link, warn });
    expect(readFileSync(f.file(f.b), "utf8")).toBe("history appended");
    expect(statSync(f.file(f.b)).ino).not.toBe(statSync(shared).ino);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(existsSync(`${shared}.loom-backup-43`)).toBe(true);
    rmSync(f.root, { recursive: true });
  });

  it("falls back to a copy when transcript hard links are refused with EPERM", () => {
    const f = fixture();
    mkdirSync(f.dir(f.a), { recursive: true });
    writeFileSync(f.file(f.a), "history");
    const shared = join(f.shared, f.slug, "session.jsonl");
    const link = vi.fn(() => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); });
    linkTranscript(f.file(f.a), shared, 50, { link, warn: vi.fn() });
    expect(readFileSync(shared, "utf8")).toBe("history");
    rmSync(f.root, { recursive: true });
  });

  it("keeps the longer local transcript when modification times tie", () => {
    const f = fixture();
    mkdirSync(f.dir(f.a), { recursive: true });
    const shared = join(f.shared, f.slug, "session.jsonl");
    mkdirSync(join(f.shared, f.slug), { recursive: true });
    writeFileSync(shared, "history");
    writeFileSync(f.file(f.a), "history appended");
    const when = new Date(1_700_000_000_000);
    utimesSync(shared, when, when);
    utimesSync(f.file(f.a), when, when);
    linkTranscript(f.file(f.a), shared, 51);
    expect(readFileSync(f.file(f.a), "utf8")).toBe("history appended");
    expect(readFileSync(shared, "utf8")).toBe("history appended");
    rmSync(f.root, { recursive: true });
  });

  it("resumes a session stored behind a non-Loom link at the slug", () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(join(outside, "s1"), { recursive: true });
    writeFileSync(join(outside, "s1.jsonl"), "history");
    writeFileSync(join(outside, "s1", "note"), "x");
    mkdirSync(join(f.a, "projects"), { recursive: true });
    symlinkSync(outside, f.dir(f.a), "dir");
    linkSession(f.a, f.shared, "/work/test", "s1", [f.a, f.b]);
    expect(lstatSync(f.dir(f.a)).isDirectory()).toBe(true);
    expect(readFileSync(join(f.dir(f.a), "s1.jsonl"), "utf8")).toBe("history");
    expect(readFileSync(join(f.dir(f.a), "s1", "note"), "utf8")).toBe("x");
    rmSync(f.root, { recursive: true });
  });
});
