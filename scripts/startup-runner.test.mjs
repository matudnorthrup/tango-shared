import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  discoverProfileHooks,
  mergeStartupConfig,
  parseArgs,
  resolveStartupContext,
  runStartup,
  selectServices,
} from "./startup-runner.mjs";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tango-${name}-`));
}

function write(filePath, contents, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  if (mode != null) fs.chmodSync(filePath, mode);
}

test("mergeStartupConfig deep-merges objects and services by id", () => {
  const merged = mergeStartupConfig(
    {
      tmux: { session: "tango", cleanup: { staleSocket: true } },
      services: [
        { id: "discord", command: "node bot.js", retries: { attempts: 1 }, tmux: { window: "discord" } },
        { id: "voice", command: "node voice.js" },
      ],
    },
    {
      tmux: { cleanup: { staleSocket: false } },
      services: [
        { id: "discord", command: "node dist/main.js", retries: { delayMs: 250 } },
        { id: "custom", command: "echo custom" },
      ],
    },
  );

  assert.equal(merged.tmux.session, "tango");
  assert.equal(merged.tmux.cleanup.staleSocket, false);
  assert.deepEqual(
    merged.services.map((service) => service.id),
    ["discord", "voice", "custom"],
  );
  assert.equal(merged.services[0].command, "node dist/main.js");
  assert.deepEqual(merged.services[0].retries, { attempts: 1, delayMs: 250 });
  assert.deepEqual(merged.services[0].tmux, { window: "discord" });
});

test("selectServices honors --only and --skip filters", () => {
  const config = {
    services: [
      { id: "kokoro", command: "true" },
      { id: "discord", command: "true" },
      { id: "voice", command: "true", enabled: false },
    ],
  };

  assert.deepEqual(
    selectServices(config, parseArgs(["--only", "kokoro,discord", "--skip", "discord"])).map((service) => service.id),
    ["kokoro"],
  );
  assert.throws(() => selectServices(config, parseArgs(["--only", "missing"])), /Unknown startup service id/);
});

test("discoverProfileHooks uses only executable .sh files inside active profile startup.d", () => {
  const tangoHome = tempDir("hooks-home");
  const context = resolveStartupContext({
    env: { ...process.env, TANGO_HOME: tangoHome, TANGO_PROFILE: "test" },
  });
  const hookDir = path.join(context.profileDir, "scripts", "startup.d");
  write(path.join(hookDir, "10-first.sh"), "#!/usr/bin/env bash\necho first\n", 0o755);
  write(path.join(hookDir, "20-skip.sh"), "#!/usr/bin/env bash\necho skip\n", 0o644);
  write(path.join(hookDir, "ignore.txt"), "nope\n", 0o755);
  const outside = path.join(tempDir("outside-hook"), "30-outside.sh");
  write(outside, "#!/usr/bin/env bash\necho outside\n", 0o755);
  fs.symlinkSync(outside, path.join(hookDir, "30-outside.sh"));

  const hooks = discoverProfileHooks(context, { enabled: true });

  assert.deepEqual(
    hooks.map((hook) => [hook.name, hook.skipped, hook.reason]),
    [
      ["10-first.sh", false, ""],
      ["20-skip.sh", true, "not executable"],
      ["30-outside.sh", true, "outside active profile startup.d"],
    ],
  );
});

test("runStartup prints health dry-run checks without executing them", async () => {
  const lines = [];
  const result = await runStartup({
    options: parseArgs(["--health", "--dry-run", "--only", "web"]),
    context: resolveStartupContext({ env: process.env }),
    config: {
      tmux: { session: "tango-test", socketName: "tango-test" },
      services: [
        {
          id: "web",
          command: "node server.js",
          health: { checks: [{ type: "tcp", host: "127.0.0.1", port: 4321 }] },
        },
      ],
    },
    stdout: (line) => lines.push(line),
  });

  assert.equal(result.code, 0);
  assert.match(lines.join("\n"), /Health checks:/);
  assert.match(lines.join("\n"), /tcp 127\.0\.0\.1:4321/);
  assert.match(lines.join("\n"), /Dry run only/);
});

test("CLI dry-run loads temp defaults and reports executable and skipped profile hooks", () => {
  const tangoHome = tempDir("cli-home");
  const defaultConfig = path.join(tempDir("config"), "startup.yaml");
  write(
    defaultConfig,
    [
      "version: 1",
      "tmux:",
      "  session: tango-test",
      "  socketName: tango-test",
      "services:",
      "  - id: alpha",
      "    name: Alpha",
      "    cwd: \"${REPO_DIR}\"",
      "    command: echo alpha",
      "    tmux:",
      "      window: alpha",
      "",
    ].join("\n"),
  );
  const hookDir = path.join(tangoHome, "profiles", "test", "scripts", "startup.d");
  write(path.join(hookDir, "10-ok.sh"), "#!/usr/bin/env bash\necho ok\n", 0o755);
  write(path.join(hookDir, "20-skip.sh"), "#!/usr/bin/env bash\necho skip\n", 0o644);

  const result = spawnSync(process.execPath, ["scripts/startup-runner.mjs", "--dry-run", "--only", "alpha"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      TANGO_HOME: tangoHome,
      TANGO_PROFILE: "test",
      TANGO_STARTUP_DEFAULT_CONFIG: defaultConfig,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /alpha \(Alpha\)/);
  assert.match(result.stdout, /run 10-ok\.sh/);
  assert.match(result.stdout, /skip 20-skip\.sh: not executable/);
  assert.match(result.stdout, /Dry run only\. No tmux windows or hooks were started\./);
});

test("CLI with every service disabled still runs the profile hooks and needs no tmux", () => {
  const tangoHome = tempDir("cli-home");
  const defaultConfig = path.join(tempDir("config"), "startup.yaml");
  write(
    defaultConfig,
    [
      "version: 1",
      "tmux:",
      "  session: tango-test",
      "  socketName: tango-test-none",
      "services:",
      "  - id: alpha",
      "    enabled: false",
      "    command: echo alpha",
      "",
    ].join("\n"),
  );
  const marker = path.join(tangoHome, "hook-ran");
  const hookDir = path.join(tangoHome, "profiles", "test", "scripts", "startup.d");
  write(path.join(hookDir, "10-mark.sh"), `#!/usr/bin/env bash\ntouch "${marker}"\n`, 0o755);
  const run = (...args) => spawnSync(process.execPath, ["scripts/startup-runner.mjs", ...args], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: { ...process.env, TANGO_HOME: tangoHome, TANGO_PROFILE: "test", TANGO_STARTUP_DEFAULT_CONFIG: defaultConfig },
    encoding: "utf8",
  });

  const plan = run("--dry-run");
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /No enabled services selected\.[\s\S]*run 10-mark\.sh/);
  assert.equal(fs.existsSync(marker), false, "a dry run starts nothing");

  const start = run();
  assert.equal(start.status, 0, start.stderr);
  assert.equal(fs.existsSync(marker), true, "the hook ran");
});

test("CLI dry-run overlays profile startup config by service id", () => {
  const tangoHome = tempDir("overlay-home");
  const defaultConfig = path.join(tempDir("overlay-config"), "startup.yaml");
  write(
    defaultConfig,
    [
      "version: 1",
      "tmux:",
      "  session: tango-test",
      "  socketName: tango-test",
      "services:",
      "  - id: alpha",
      "    name: Alpha",
      "    cwd: \"${REPO_DIR}\"",
      "    command: echo default",
      "    tmux:",
      "      window: alpha",
      "",
    ].join("\n"),
  );
  write(
    path.join(tangoHome, "profiles", "test", "config", "startup.yaml"),
    [
      "services:",
      "  - id: alpha",
      "    command: echo profile",
      "  - id: beta",
      "    name: Beta",
      "    cwd: \"${REPO_DIR}\"",
      "    command: echo beta",
      "",
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, ["scripts/startup-runner.mjs", "--dry-run"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: {
      ...process.env,
      TANGO_HOME: tangoHome,
      TANGO_PROFILE: "test",
      TANGO_STARTUP_DEFAULT_CONFIG: defaultConfig,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /alpha \(Alpha\)/);
  assert.match(result.stdout, /command: bash -lc 'echo profile'/);
  assert.match(result.stdout, /beta \(Beta\)/);
});

test("CLI help prints usage before loading config", () => {
  const result = spawnSync(process.execPath, ["scripts/startup-runner.mjs", "--help"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: { ...process.env, TANGO_STARTUP_DEFAULT_CONFIG: path.join(tempDir("missing-config"), "missing.yaml") },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: scripts\/startup\.sh/);
  assert.match(result.stdout, /--dry-run/);
});
