import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_SESSION_PREFIX,
  assessClaudeSessionPane,
  buildClaudeLaunchCommand,
  createClaudeSessionTools,
  pickClaudeSessionName,
  resolveClaudeSessionWorkingDir,
  sanitizeClaudeDisplayName,
  slugifyClaudeSessionTitle,
  summarizeClaudeSessionPane,
  type TmuxResult,
} from "../src/claude-session-tools.js";

const READY_PANE = [
  "❯ Fix the voice gate flake in pac",
  "  ⎿  UserPromptSubmit hook ran",
  "",
  "⏺ Acknowledged — starting on the voice gate flake now.",
  "",
  "────────────────────────────────",
  "❯",
  "────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)   Remote Control active",
].join("\n");

const UI_NO_RESPONSE_PANE = [
  "❯ Fix the voice gate flake in pac",
  "",
  "· Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)",
  "",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

const UI_PROMPT_NOT_SUBMITTED_PANE = [
  "────────────────────────────────",
  "❯",
  "────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)   Remote Control active",
].join("\n");

const SHELL_ONLY_PANE = "user@host tango % ";

const NOT_FOUND_PANE = "zsh: command not found: claude";

const AUTH_PANE = [
  "❯ Fix the voice gate flake in pac",
  "Invalid API key. Please run /login to authenticate.",
].join("\n");

describe("slugifyClaudeSessionTitle", () => {
  it("slugs mixed input", () => {
    expect(slugifyClaudeSessionTitle("Fix Voice Bug!")).toBe("fix-voice-bug");
    expect(slugifyClaudeSessionTitle("  weird___chars 42 ")).toBe("weird-chars-42");
  });

  it("falls back for empty input", () => {
    expect(slugifyClaudeSessionTitle(undefined)).toBe("session");
    expect(slugifyClaudeSessionTitle("!!!")).toBe("session");
  });

  it("caps length without trailing dash", () => {
    const slug = slugifyClaudeSessionTitle("a".repeat(39) + " trailing words here");
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("sanitizeClaudeDisplayName", () => {
  it("strips shell-significant characters", () => {
    expect(sanitizeClaudeDisplayName("fix 'voice' \"bug\" `now` $HOME\\x")).toBe("fix voice bug now HOME x");
  });

  it("collapses whitespace including newlines", () => {
    expect(sanitizeClaudeDisplayName("fix\nvoice\tbug")).toBe("fix voice bug");
  });

  it("falls back when empty", () => {
    expect(sanitizeClaudeDisplayName("'\"`")).toBe("Remote session");
  });
});

describe("pickClaudeSessionName", () => {
  it("uses the base name when free", () => {
    expect(pickClaudeSessionName(["main", "TANGO-PM"], "fix")).toBe("CC-fix");
  });

  it("increments on collision", () => {
    expect(pickClaudeSessionName(["CC-fix", "CC-fix-2"], "fix")).toBe("CC-fix-3");
  });

  it("throws when exhausted", () => {
    const taken = ["CC-fix", ...Array.from({ length: 19 }, (_, i) => `CC-fix-${i + 2}`)];
    expect(() => pickClaudeSessionName(taken, "fix")).toThrow(/No free tmux session name/);
  });
});

describe("resolveClaudeSessionWorkingDir", () => {
  function makeRoot(): { root: string; repo: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-root-"));
    const repo = path.join(root, "tango");
    fs.mkdirSync(repo);
    return { root, repo };
  }

  it("resolves a repo name under the root", () => {
    const { root, repo } = makeRoot();
    expect(resolveClaudeSessionWorkingDir("tango", root)).toBe(fs.realpathSync(repo));
  });

  it("accepts an absolute path inside the root", () => {
    const { root, repo } = makeRoot();
    expect(resolveClaudeSessionWorkingDir(repo, root)).toBe(fs.realpathSync(repo));
  });

  it("rejects paths outside the root", () => {
    const { root } = makeRoot();
    expect(() => resolveClaudeSessionWorkingDir(os.tmpdir(), root)).toThrow(/outside the allowed/);
    expect(() => resolveClaudeSessionWorkingDir("../escape", root)).toThrow(/outside the allowed|does not exist/);
  });

  it("rejects symlink escapes", () => {
    const { root } = makeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-outside-"));
    fs.symlinkSync(outside, path.join(root, "sneaky"));
    expect(() => resolveClaudeSessionWorkingDir("sneaky", root)).toThrow(/outside the allowed/);
  });

  it("rejects missing dirs and empty input", () => {
    const { root } = makeRoot();
    expect(() => resolveClaudeSessionWorkingDir("nope", root)).toThrow(/does not exist/);
    expect(() => resolveClaudeSessionWorkingDir("  ", root)).toThrow(/repo is required/);
  });
});

describe("buildClaudeLaunchCommand", () => {
  it("builds the seeded interactive launch line", () => {
    const cmd = buildClaudeLaunchCommand({
      claudeCommand: "claude",
      displayName: "fix voice bug",
      promptFile: "/tmp/tango-test/.tango/claude-sessions/CC-fix.prompt.txt",
    });
    expect(cmd).toBe(
      "claude --dangerously-skip-permissions -n 'fix voice bug' \"$(cat '/tmp/tango-test/.tango/claude-sessions/CC-fix.prompt.txt')\"",
    );
  });
});

describe("assessClaudeSessionPane", () => {
  const head = "Fix the voice gate flake in pac";

  it("detects the ready state with remote control", () => {
    const a = assessClaudeSessionPane(READY_PANE, head);
    expect(a.state).toBe("ready");
    expect(a.remoteControl).toBe(true);
    expect(a.responsePreview).toContain("Acknowledged");
  });

  it("reports pending while the first response streams", () => {
    const a = assessClaudeSessionPane(UI_NO_RESPONSE_PANE, head);
    expect(a.state).toBe("pending");
    expect(a.claudeUiSeen).toBe(true);
    expect(a.promptSubmitted).toBe(true);
  });

  it("flags an unsubmitted prompt", () => {
    const a = assessClaudeSessionPane(UI_PROMPT_NOT_SUBMITTED_PANE, head);
    expect(a.state).toBe("pending");
    expect(a.claudeUiSeen).toBe(true);
    expect(a.promptSubmitted).toBe(false);
  });

  it("stays pending on a bare shell", () => {
    const a = assessClaudeSessionPane(SHELL_ONLY_PANE, head);
    expect(a.state).toBe("pending");
    expect(a.claudeUiSeen).toBe(false);
  });

  it("fails on command-not-found and auth errors", () => {
    expect(assessClaudeSessionPane(NOT_FOUND_PANE, head).state).toBe("failed");
    expect(assessClaudeSessionPane(AUTH_PANE, head).state).toBe("failed");
  });
});

describe("summarizeClaudeSessionPane", () => {
  it("classifies working vs idle", () => {
    expect(summarizeClaudeSessionPane(UI_NO_RESPONSE_PANE).activity).toBe("working");
    expect(summarizeClaudeSessionPane(READY_PANE).activity).toBe("idle");
    expect(summarizeClaudeSessionPane(SHELL_ONLY_PANE).activity).toBe("unknown");
  });
});

describe("createClaudeSessionTools", () => {
  function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-root-"));
    fs.mkdirSync(path.join(root, "tango"));
    const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-prompts-"));
    return { root, promptDir };
  }

  it("exposes both tools with schemas", () => {
    const tools = createClaudeSessionTools({ runTmux: async () => ({ stdout: "", stderr: "", code: 0 }) });
    expect(tools.map((t) => t.name)).toEqual(["spawn_claude_session", "list_claude_sessions"]);
    const spawn = tools[0]!;
    expect((spawn.inputSchema as { required: string[] }).required).toEqual(["repo", "prompt"]);
    expect(spawn.description).toContain("read back the repo");
  });

  it("spawns end-to-end against a scripted tmux", async () => {
    const { root, promptDir } = makeFixture();
    const calls: string[][] = [];
    let captures = 0;
    const runTmux = async (args: string[]): Promise<TmuxResult> => {
      calls.push(args);
      switch (args[0]) {
        case "list-sessions":
          return { stdout: "main\nTANGO-PM\n", stderr: "", code: 0 };
        case "new-session":
        case "send-keys":
          return { stdout: "", stderr: "", code: 0 };
        case "capture-pane":
          captures += 1;
          return {
            stdout: captures === 1 ? UI_NO_RESPONSE_PANE : READY_PANE,
            stderr: "",
            code: 0,
          };
        default:
          return { stdout: "", stderr: "", code: 1 };
      }
    };

    const tools = createClaudeSessionTools({
      allowedRoot: root,
      promptDir,
      claudeCommand: "claude",
      runTmux,
      sleep: async () => undefined,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });
    const prompt = "Fix the voice gate flake in packages/voice.\nIt's flaky on \"gate grace\" — investigate.";
    const result = (await tools[0]!.handler({
      repo: "tango",
      prompt,
      title: "Voice Gate Flake",
    })) as Record<string, unknown>;

    expect(result.status).toBe("ready");
    expect(result.session).toBe("CC-voice-gate-flake");
    expect(result.remote_control).toBe(true);
    expect(result.response_preview).toContain("Acknowledged");

    const promptFile = path.join(promptDir, "CC-voice-gate-flake.prompt.txt");
    expect(fs.readFileSync(promptFile, "utf8")).toBe(prompt);

    const newSession = calls.find((c) => c[0] === "new-session")!;
    expect(newSession).toContain("CC-voice-gate-flake");
    expect(newSession).toContain(fs.realpathSync(path.join(root, "tango")));

    const sendKeys = calls.find((c) => c[0] === "send-keys")!;
    expect(sendKeys[sendKeys.length - 1]).toBe("Enter");
    expect(sendKeys.join(" ")).toContain("--dangerously-skip-permissions");
    expect(sendKeys.join(" ")).toContain(`$(cat '${promptFile}')`);
    // Prompt content itself must never be on the command line.
    expect(sendKeys.join(" ")).not.toContain("gate grace");
  });

  it("kills only its own session on fatal startup errors", async () => {
    const { root, promptDir } = makeFixture();
    const calls: string[][] = [];
    const runTmux = async (args: string[]): Promise<TmuxResult> => {
      calls.push(args);
      if (args[0] === "list-sessions") return { stdout: "", stderr: "", code: 1 };
      if (args[0] === "capture-pane") return { stdout: NOT_FOUND_PANE, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };

    const tools = createClaudeSessionTools({
      allowedRoot: root,
      promptDir,
      runTmux,
      sleep: async () => undefined,
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
    });

    await expect(
      tools[0]!.handler({ repo: "tango", prompt: "hello", title: "x" }),
    ).rejects.toThrow(/not found on PATH/);

    const kill = calls.find((c) => c[0] === "kill-session");
    expect(kill).toBeDefined();
    expect(kill![2]).toBe("CC-x");
  });

  it("hands over a slow session instead of killing it", async () => {
    const { root, promptDir } = makeFixture();
    const calls: string[][] = [];
    const runTmux = async (args: string[]): Promise<TmuxResult> => {
      calls.push(args);
      if (args[0] === "list-sessions") return { stdout: "", stderr: "", code: 1 };
      if (args[0] === "capture-pane") return { stdout: UI_NO_RESPONSE_PANE, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };

    const tools = createClaudeSessionTools({
      allowedRoot: root,
      promptDir,
      runTmux,
      sleep: async () => undefined,
      pollIntervalMs: 1,
      pollTimeoutMs: 10,
    });

    const result = (await tools[0]!.handler({
      repo: "tango",
      prompt: "Fix the voice gate flake in packages/voice, deeply.",
    })) as Record<string, unknown>;

    expect(result.status).toBe("started");
    expect(calls.some((c) => c[0] === "kill-session")).toBe(false);
  });

  it("rejects empty and oversized prompts", async () => {
    const { root, promptDir } = makeFixture();
    const tools = createClaudeSessionTools({
      allowedRoot: root,
      promptDir,
      runTmux: async () => ({ stdout: "", stderr: "", code: 0 }),
      sleep: async () => undefined,
    });
    await expect(tools[0]!.handler({ repo: "tango", prompt: "  " })).rejects.toThrow(/prompt is required/);
    await expect(
      tools[0]!.handler({ repo: "tango", prompt: "x".repeat(16_001) }),
    ).rejects.toThrow(/too long/);
  });

  it("lists only CC- sessions with activity", async () => {
    const runTmux = async (args: string[]): Promise<TmuxResult> => {
      if (args[0] === "list-sessions") {
        return {
          stdout: "main|1765400000|1\nCC-fix|1765401000|0\nTANGO-PM|1765402000|1\n",
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "capture-pane") {
        return { stdout: READY_PANE, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const tools = createClaudeSessionTools({ runTmux, sleep: async () => undefined });
    const result = (await tools[1]!.handler({})) as { sessions: Array<Record<string, unknown>> };
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.session).toBe("CC-fix");
    expect(result.sessions[0]!.activity).toBe("idle");
    expect(result.sessions[0]!.remote_control).toBe(true);
    expect(result.sessions[0]!.created_at).toBe(new Date(1765401000 * 1000).toISOString());
  });

  it("returns empty when no tmux server is running", async () => {
    const tools = createClaudeSessionTools({
      runTmux: async () => ({ stdout: "", stderr: "no server running", code: 1 }),
      sleep: async () => undefined,
    });
    const result = (await tools[1]!.handler({})) as { sessions: unknown[] };
    expect(result.sessions).toEqual([]);
  });

  it(`uses the ${CLAUDE_SESSION_PREFIX} prefix for all spawned sessions`, () => {
    expect(pickClaudeSessionName([], "anything").startsWith(CLAUDE_SESSION_PREFIX)).toBe(true);
  });
});
