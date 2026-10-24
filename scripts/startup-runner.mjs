#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_REPO_DIR = path.resolve(path.dirname(THIS_FILE), "..");
const DEFAULT_ENV_NAMES_TO_SYNC = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "SECURITYSESSIONID",
  "XPC_FLAGS",
  "XPC_SERVICE_NAME",
  "__CF_USER_TEXT_ENCODING",
  "__CFBundleIdentifier",
  "COMMAND_MODE",
  "LaunchInstanceID",
];

export function parseArgs(argv = []) {
  const options = {
    dryRun: false,
    health: false,
    help: false,
    only: [],
    skip: [],
    profile: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--health") {
      options.health = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--only") {
      const value = argv[++index];
      if (!value) throw new Error("--only requires a service id");
      options.only.push(...splitServiceList(value));
    } else if (arg.startsWith("--only=")) {
      options.only.push(...splitServiceList(arg.slice("--only=".length)));
    } else if (arg === "--skip") {
      const value = argv[++index];
      if (!value) throw new Error("--skip requires a service id");
      options.skip.push(...splitServiceList(value));
    } else if (arg.startsWith("--skip=")) {
      options.skip.push(...splitServiceList(arg.slice("--skip=".length)));
    } else if (arg === "--profile") {
      const value = argv[++index];
      if (!value) throw new Error("--profile requires a profile name");
      options.profile = value;
    } else if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.only = [...new Set(options.only)];
  options.skip = [...new Set(options.skip)];
  return options;
}

function splitServiceList(value) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function helpText() {
  return [
    "Usage: scripts/startup.sh [options]",
    "",
    "Options:",
    "  --dry-run             Print the startup plan without starting services or hooks.",
    "  --health              Check service health instead of starting services.",
    "  --only <service>      Start/check only one service id. May be repeated or comma-separated.",
    "  --skip <service>      Exclude one service id. May be repeated or comma-separated.",
    "  --profile <name>      Use this Tango profile instead of TANGO_PROFILE/default.",
    "  -h, --help            Show this help.",
    "",
    "Config:",
    "  Repo defaults:        config/defaults/startup.yaml",
    "  Profile override:     ~/.tango/profiles/<profile>/config/startup.yaml",
    "  Profile hooks:        ~/.tango/profiles/<profile>/scripts/startup.d/*.sh",
  ].join("\n");
}

export function resolveStartupContext(options = {}) {
  const env = options.env ?? process.env;
  const repoDir = path.resolve(
    expandHome(env.TANGO_REPO_DIR?.trim() || env.TANGO_STARTUP_REPO_DIR?.trim() || DEFAULT_REPO_DIR, env),
  );
  const tangoHome = path.resolve(expandHome(env.TANGO_HOME?.trim() || path.join(os.homedir(), ".tango"), env));
  const profileName = normalizeProfileName(options.profile ?? env.TANGO_PROFILE ?? "default");
  const profileDir = path.join(tangoHome, "profiles", profileName);
  const nodeBin = resolveNodeBin(env);
  const context = {
    env,
    repoDir,
    tangoHome,
    profileName,
    profileDir,
    profileConfigPath:
      env.TANGO_STARTUP_PROFILE_CONFIG?.trim() || path.join(profileDir, "config", "startup.yaml"),
    defaultConfigPath:
      env.TANGO_STARTUP_DEFAULT_CONFIG?.trim() || path.join(repoDir, "config", "defaults", "startup.yaml"),
    hookDir: path.join(profileDir, "scripts", "startup.d"),
    vars: {
      HOME: env.HOME ?? os.homedir(),
      REPO_DIR: repoDir,
      TANGO_HOME: tangoHome,
      PROFILE: profileName,
      TANGO_PROFILE: profileName,
      PROFILE_DIR: profileDir,
      TANGO_PROFILE_DIR: profileDir,
      NODE_BIN: nodeBin,
    },
  };
  return context;
}

function normalizeProfileName(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "default";
  if (normalized.includes("/") || normalized.includes("\\") || normalized === "." || normalized === "..") {
    throw new Error(`Invalid Tango profile name: ${value}`);
  }
  return normalized;
}

function resolveNodeBin(env) {
  const configured = env.TANGO_NODE_BIN?.trim();
  if (configured && fs.existsSync(expandHome(configured, env))) {
    return path.resolve(expandHome(configured, env));
  }
  return process.execPath;
}

export function loadStartupConfig(context) {
  const defaults = readYamlFile(context.defaultConfigPath, true);
  const profile = readYamlFile(context.profileConfigPath, false);
  const merged = mergeStartupConfig(defaults, profile ?? {});
  return resolveConfigValues(merged, context);
}

function readYamlFile(filePath, required) {
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error(`Missing required startup config: ${filePath}`);
    return null;
  }
  const parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
  if (parsed == null) return {};
  if (!isPlainObject(parsed)) throw new Error(`Startup config must be a YAML object: ${filePath}`);
  return parsed;
}

export function mergeStartupConfig(base, overlay) {
  const merged = deepMerge(base ?? {}, overlay ?? {});
  if (Array.isArray(base?.services) || Array.isArray(overlay?.services)) {
    merged.services = mergeServicesById(base?.services ?? [], overlay?.services ?? []);
  }
  return merged;
}

function mergeServicesById(baseServices, overlayServices) {
  const result = [];
  const positions = new Map();
  for (const service of baseServices) {
    validateServiceId(service);
    positions.set(service.id, result.length);
    result.push(clone(service));
  }
  for (const service of overlayServices) {
    validateServiceId(service);
    if (positions.has(service.id)) {
      const index = positions.get(service.id);
      result[index] = deepMerge(result[index], service);
    } else {
      positions.set(service.id, result.length);
      result.push(clone(service));
    }
  }
  return result;
}

function validateServiceId(service) {
  if (!isPlainObject(service) || !service.id || typeof service.id !== "string") {
    throw new Error("Each startup service must be an object with a string id");
  }
}

function deepMerge(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return clone(overlay);
  const result = clone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (Array.isArray(value)) {
      result[key] = clone(value);
    } else if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clone(inner)]));
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveConfigValues(value, context) {
  if (typeof value === "string") return expandTemplate(value, context);
  if (Array.isArray(value)) return value.map((item) => resolveConfigValues(item, context));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolveConfigValues(inner, context)]));
  }
  return value;
}

function expandTemplate(value, context) {
  const withHome = expandHome(value, context.env);
  return withHome.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g, (_match, name, _fallbackMatch, fallback) => {
    const fromVars = context.vars[name];
    if (fromVars != null && fromVars !== "") return String(fromVars);
    const fromEnv = context.env[name];
    if (fromEnv != null && fromEnv !== "") return String(fromEnv);
    return fallback ?? "";
  });
}

function expandHome(value, env) {
  if (!value) return value;
  if (value === "~") return env.HOME ?? os.homedir();
  if (value.startsWith("~/")) return path.join(env.HOME ?? os.homedir(), value.slice(2));
  return value;
}

export function selectServices(config, options) {
  const services = Array.isArray(config.services) ? config.services : [];
  const knownIds = new Set(services.map((service) => service.id));
  for (const id of [...options.only, ...options.skip]) {
    if (!knownIds.has(id)) throw new Error(`Unknown startup service id: ${id}`);
  }

  return services.filter((service) => {
    if (service.enabled === false) return false;
    if (options.only.length > 0 && !options.only.includes(service.id)) return false;
    if (options.skip.includes(service.id)) return false;
    return true;
  });
}

export function discoverProfileHooks(context, hooksConfig = {}) {
  if (hooksConfig.enabled === false) return [];
  if (!fs.existsSync(context.hookDir)) return [];

  const hookRoot = fs.realpathSync(context.hookDir);
  const profileRoot = fs.existsSync(context.profileDir)
    ? fs.realpathSync(context.profileDir)
    : path.resolve(context.profileDir);
  if (!isPathInside(hookRoot, profileRoot)) {
    throw new Error(`Startup hook directory is outside the active profile: ${context.hookDir}`);
  }

  return fs
    .readdirSync(context.hookDir)
    .filter((name) => name.endsWith(".sh"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const hookPath = path.join(context.hookDir, name);
      const stat = fs.lstatSync(hookPath);
      const realPath = fs.realpathSync(hookPath);
      const inside = isPathInside(path.resolve(realPath), hookRoot);
      const executable = stat.isFile() && (stat.mode & 0o111) !== 0;
      return {
        name,
        path: hookPath,
        realPath,
        executable,
        skipped: !inside || !executable,
        reason: !inside ? "outside active profile startup.d" : executable ? "" : "not executable",
      };
    });
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function runStartup(input = {}) {
  const options = input.options ?? parseArgs(input.argv ?? process.argv.slice(2));
  const stdout = input.stdout ?? ((line) => console.log(line));
  const stderr = input.stderr ?? ((line) => console.error(line));
  if (options.help) {
    stdout(helpText());
    return { code: 0 };
  }

  const context = input.context ?? resolveStartupContext({ env: input.env ?? process.env, profile: options.profile });
  const config = input.config ?? loadStartupConfig(context);
  const services = selectServices(config, options);
  const tmux = resolveTmuxSettings(config, context);
  const runner = input.runner ?? makeSystemRunner(tmux, context, stdout, stderr);

  printHeader(stdout, context, config, tmux, options);

  if (options.health) {
    const result = await runHealthMode({ config, services, tmux, context, options, runner, stdout, stderr });
    return { code: result.ok ? 0 : 1 };
  }

  const startResult = await runStartMode({ config, services, tmux, context, options, runner, stdout, stderr });
  return { code: startResult.ok ? 0 : 1 };
}

function printHeader(stdout, context, config, tmux, options) {
  stdout(`=== Tango startup ${options.dryRun ? "(dry run) " : ""}${options.health ? "health" : "start"} ===`);
  stdout(`repo: ${context.repoDir}`);
  stdout(`profile: ${context.profileName} (${context.profileDir})`);
  stdout(`config: ${context.defaultConfigPath}`);
  if (fs.existsSync(context.profileConfigPath)) stdout(`profile_config: ${context.profileConfigPath}`);
  else stdout(`profile_config: ${context.profileConfigPath} (not present)`);
  stdout(`tmux: ${tmux.hint} session=${tmux.session}`);
  if (config.description) stdout(`description: ${config.description}`);
  stdout("");
}

function resolveTmuxSettings(config, context) {
  const configuredSocket = context.env.TANGO_SERVICE_TMUX_SOCKET?.trim();
  const socketName = context.env.TANGO_SERVICE_TMUX_SOCKET_NAME?.trim() || config.tmux?.socketName || "tango-service";
  const session = context.env.TANGO_TMUX_SESSION?.trim() || config.tmux?.session || "tango";
  const bin = context.env.TANGO_TMUX_BIN?.trim() || "tmux";
  const socketArgs = configuredSocket ? ["-S", configuredSocket] : ["-L", socketName];
  const hint = configuredSocket ? `tmux -S ${shellQuote(configuredSocket)}` : `tmux -L ${shellQuote(socketName)}`;
  return {
    bin,
    session,
    socketName,
    socketPath: configuredSocket || defaultTmuxSocketPath(socketName),
    socketArgs,
    hint,
    legacySessions: config.tmux?.legacySessions ?? [],
    cleanup: config.tmux?.cleanup ?? {},
  };
}

function defaultTmuxSocketPath(socketName) {
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  const tmpdir = process.env.TMPDIR || os.tmpdir();
  return path.join(tmpdir, `tmux-${uid}`, socketName);
}

function makeSystemRunner(tmux, context, stdout, stderr) {
  return {
    tmux(args, options = {}) {
      return spawnSync(tmux.bin, [...tmux.socketArgs, ...args], {
        cwd: options.cwd ?? context.repoDir,
        env: { ...process.env, ...context.env },
        encoding: "utf8",
        timeout: options.timeoutMs,
        stdio: options.stdio ?? "pipe",
      });
    },
    spawn(command, args, options = {}) {
      return spawnSync(command, args, {
        cwd: options.cwd ?? context.repoDir,
        env: options.env ?? { ...process.env, ...context.env },
        encoding: "utf8",
        timeout: options.timeoutMs,
        stdio: options.stdio ?? "pipe",
      });
    },
    stdout: stdout ?? ((line) => console.log(line)),
    stderr: stderr ?? ((line) => console.error(line)),
  };
}

async function runStartMode({ config, services, tmux, context, options, runner, stdout, stderr }) {
  const hooks = discoverProfileHooks(context, config.hooks ?? {});
  if (services.length === 0) {
    // Every service can be supervised elsewhere (Tango Server) and leave no tmux windows here.
    // The profile hooks (e.g. the CDP browser) still belong to startup.
    stdout("No enabled services selected.");
    if (options.dryRun) {
      stdout("");
      printHookPlan({ hooks, context, stdout });
      stdout("");
      stdout("Dry run only. No hooks were started.");
      return { ok: true };
    }
    return { ok: runProfileHooks({ hooks, context, runner, stdout, stderr }) };
  }

  if (options.dryRun) {
    printStartPlan({ services, hooks, config, tmux, context, stdout });
    return { ok: true };
  }

  cleanupStaleTmuxSocket({ tmux, config, runner, stdout });
  warnLegacySessions({ tmux, runner, stdout });

  const sessionExists = tmuxHasSession(tmux.session, runner);
  if (sessionExists && options.only.length === 0) {
    stderr(`tmux session '${tmux.session}' already exists.`);
    stderr(`Stop it first with: ${tmux.hint} kill-session -t ${shellQuote(tmux.session)}`);
    return { ok: false };
  }

  let createdSession = sessionExists;
  for (const service of services) {
    const started = startService({ service, tmux, context, runner, stdout, stderr, createdSession });
    if (!started.ok && !service.optional) return { ok: false };
    if (started.createdSession) {
      createdSession = true;
      syncTmuxEnvironment({ tmux, runner, context, stdout });
    }
  }

  const hooksOk = runProfileHooks({ hooks, context, runner, stdout, stderr });
  if (!hooksOk) return { ok: false };

  stdout("");
  stdout(`=== Startup complete for tmux session '${tmux.session}' ===`);
  stdout(`List windows: ${tmux.hint} list-windows -t ${shellQuote(tmux.session)}`);
  stdout(`Attach:       ${tmux.hint} attach -t ${shellQuote(tmux.session)}`);
  return { ok: true };
}

function printStartPlan({ services, hooks, config, tmux, context, stdout }) {
  stdout("Services:");
  services.forEach((service, index) => {
    const cwd = resolvePathValue(service.cwd ?? context.repoDir, context, context.repoDir);
    const window = service.tmux?.window ?? service.id;
    stdout(`  ${index + 1}. ${service.id} (${service.name ?? service.id})`);
    stdout(`     tmux: ${tmux.session}:${window}`);
    stdout(`     cwd: ${cwd}`);
    stdout(`     command: ${buildServiceShellCommand(service, context)}`);
    if (service.optional) stdout("     optional: true");
    const retries = normalizeRetries(service.retries);
    stdout(`     retries: attempts=${retries.attempts} delayMs=${retries.delayMs} timeoutMs=${retries.timeoutMs}`);
  });

  stdout("");
  printHookPlan({ hooks, context, stdout });
  stdout("");
  stdout("Dry run only. No tmux windows or hooks were started.");
}

function printHookPlan({ hooks, context, stdout }) {
  stdout(`Profile hooks: ${context.hookDir}`);
  if (hooks.length === 0) {
    stdout("  none");
    return;
  }
  for (const hook of hooks) {
    if (hook.skipped) stdout(`  skip ${hook.name}: ${hook.reason}`);
    else stdout(`  run ${hook.name}`);
  }
}

function cleanupStaleTmuxSocket({ tmux, config, runner, stdout }) {
  if (config.tmux?.cleanup?.staleSocket === false) return;
  if (!tmux.socketPath || !path.basename(tmux.socketPath).includes("tango")) return;
  const list = runner.tmux(["list-sessions"], { timeoutMs: 2000 });
  if (list.status === 0) return;
  if (fs.existsSync(tmux.socketPath)) {
    try {
      fs.rmSync(tmux.socketPath, { force: true });
      stdout(`Removed stale Tango tmux socket: ${tmux.socketPath}`);
    } catch (error) {
      stdout(`Warning: could not remove stale Tango tmux socket ${tmux.socketPath}: ${error.message}`);
    }
  }
}

function warnLegacySessions({ tmux, runner, stdout }) {
  for (const legacy of tmux.legacySessions ?? []) {
    if (tmuxHasSession(legacy, runner)) {
      stdout(`Warning: legacy tmux session '${legacy}' is still running.`);
      stdout(`  Stop it with: ${tmux.hint} kill-session -t ${shellQuote(legacy)}`);
    }
  }
}

function startService({ service, tmux, context, runner, stdout, stderr, createdSession }) {
  const window = service.tmux?.window ?? service.id;
  const cwd = resolvePathValue(service.cwd ?? context.repoDir, context, context.repoDir);
  const retries = normalizeRetries(service.retries);

  if (!fs.existsSync(cwd)) {
    const message = `Startup service '${service.id}' cwd does not exist: ${cwd}`;
    if (service.optional) {
      stdout(`Skipping optional service '${service.id}': ${message}`);
      return { ok: true, createdSession };
    }
    stderr(message);
    return { ok: false, createdSession };
  }

  if (createdSession && tmuxWindowExists(tmux.session, window, runner)) {
    stdout(`Skipping service '${service.id}': tmux window '${tmux.session}:${window}' already exists.`);
    return { ok: true, createdSession };
  }

  const command = buildServiceShellCommand(service, context);
  const args = createdSession
    ? ["new-window", "-t", tmux.session, "-n", window, "-c", cwd, command]
    : ["new-session", "-d", "-s", tmux.session, "-n", window, "-c", cwd, command];

  for (let attempt = 1; attempt <= retries.attempts; attempt += 1) {
    stdout(`[${service.id}] starting${attempt > 1 ? ` (attempt ${attempt}/${retries.attempts})` : ""}...`);
    const result = runner.tmux(args, { timeoutMs: retries.timeoutMs });
    if (result.status === 0) return { ok: true, createdSession: true };
    if (attempt < retries.attempts) sleep(retries.delayMs);
    else {
      const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      const message = `Service '${service.id}' failed to start${detail ? `: ${detail}` : "."}`;
      if (service.optional) {
        stdout(`Skipping optional service '${service.id}': ${message}`);
        return { ok: true, createdSession };
      }
      stderr(message);
      return { ok: false, createdSession };
    }
  }

  return { ok: false, createdSession };
}

function normalizeRetries(value) {
  return {
    attempts: Math.max(1, Number(value?.attempts ?? 1)),
    delayMs: Math.max(0, Number(value?.delayMs ?? 1000)),
    timeoutMs: Math.max(1000, Number(value?.timeoutMs ?? 15000)),
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function syncTmuxEnvironment({ tmux, runner, context, stdout }) {
  for (const name of DEFAULT_ENV_NAMES_TO_SYNC) {
    if (context.env[name] == null) continue;
    runner.tmux(["set-environment", "-g", name, context.env[name]], { timeoutMs: 2000 });
  }
  stdout(`Synced launch environment into tmux session '${tmux.session}'.`);
}

function runProfileHooks({ hooks, context, runner, stdout, stderr }) {
  if (hooks.length === 0) return true;
  stdout("");
  stdout(`=== Running profile hooks from ${context.hookDir} ===`);
  for (const hook of hooks) {
    if (hook.skipped) {
      stdout(`Skipping hook ${hook.name}: ${hook.reason}`);
      continue;
    }
    stdout(`Running hook ${hook.name}...`);
    const result = runner.spawn(hook.path, [], {
      cwd: context.profileDir,
      env: {
        ...process.env,
        ...context.env,
        TANGO_REPO_DIR: context.repoDir,
        TANGO_HOME: context.tangoHome,
        TANGO_PROFILE: context.profileName,
        TANGO_PROFILE_DIR: context.profileDir,
      },
      stdio: "inherit",
    });
    if (result.status !== 0) {
      stderr(`Startup hook failed: ${hook.name}`);
      return false;
    }
  }
  return true;
}

async function runHealthMode({ config, services, tmux, context, options, runner, stdout }) {
  if (services.length === 0) {
    stdout("No enabled services selected.");
    return { ok: true };
  }

  if (options.dryRun) {
    stdout("Health checks:");
    for (const service of services) {
      stdout(`  ${service.id}:`);
      for (const check of healthChecksFor(service)) {
        stdout(`    ${describeHealthCheck(check, service)}`);
      }
    }
    stdout("");
    stdout("Dry run only. No health checks were executed.");
    return { ok: true };
  }

  let ok = true;
  stdout("Health checks:");
  for (const service of services) {
    const serviceChecks = healthChecksFor(service);
    const serviceResults = [];
    for (const check of serviceChecks) {
      serviceResults.push(await runHealthCheck({ check, service, tmux, context, runner }));
    }
    const serviceOk = serviceResults.every((result) => result.ok);
    const status = serviceOk ? "ok" : service.optional ? "degraded optional" : "failed";
    stdout(`  ${service.id}: ${status}`);
    for (const result of serviceResults) {
      stdout(`    ${result.ok ? "ok" : "fail"} ${result.label}${result.message ? ` - ${result.message}` : ""}`);
    }
    if (!serviceOk && !service.optional) ok = false;
  }
  return { ok };
}

function healthChecksFor(service) {
  const configured = Array.isArray(service.health?.checks) ? service.health.checks : [];
  return configured.length > 0 ? configured : [{ type: "tmux-window" }];
}

async function runHealthCheck({ check, service, tmux, context, runner }) {
  const attempts = Math.max(1, Number(check.attempts ?? service.health?.attempts ?? 1));
  const intervalMs = Math.max(0, Number(check.intervalMs ?? service.health?.intervalMs ?? 500));
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await runSingleHealthCheck({ check, service, tmux, context, runner });
    if (last.ok) return last;
    if (attempt < attempts) await delay(intervalMs);
  }
  return last;
}

async function runSingleHealthCheck({ check, service, tmux, context, runner }) {
  if (check.type === "tmux-window") {
    const window = check.window ?? service.tmux?.window ?? service.id;
    const ok = tmuxWindowExists(tmux.session, window, runner);
    return { ok, label: describeHealthCheck(check, service), message: ok ? "" : `${tmux.session}:${window} not found` };
  }
  if (check.type === "tcp") {
    const host = check.host ?? "127.0.0.1";
    const port = Number(check.port);
    const timeoutMs = Number(check.timeoutMs ?? service.health?.timeoutMs ?? 1500);
    const ok = await tcpCheck(host, port, timeoutMs);
    return { ok, label: describeHealthCheck(check, service), message: ok ? "" : `no TCP response from ${host}:${port}` };
  }
  if (check.type === "http") {
    const timeoutMs = Number(check.timeoutMs ?? service.health?.timeoutMs ?? 2000);
    const result = await httpCheck(expandTemplate(check.url, context), timeoutMs);
    return { ok: result.ok, label: describeHealthCheck(check, service), message: result.message };
  }
  if (check.type === "command") {
    const result = runner.spawn("bash", ["-lc", expandTemplate(check.command, context)], {
      cwd: resolvePathValue(service.cwd ?? context.repoDir, context, context.repoDir),
      timeoutMs: Number(check.timeoutMs ?? service.health?.timeoutMs ?? 5000),
    });
    return {
      ok: result.status === 0,
      label: describeHealthCheck(check, service),
      message: result.status === 0 ? "" : (result.stderr || result.stdout || "").trim(),
    };
  }
  return { ok: false, label: describeHealthCheck(check, service), message: `unknown health check type '${check.type}'` };
}

function describeHealthCheck(check, service) {
  if (check.type === "tmux-window") return `tmux-window ${service.tmux?.window ?? service.id}`;
  if (check.type === "tcp") return `tcp ${check.host ?? "127.0.0.1"}:${check.port}`;
  if (check.type === "http") return `http ${check.url}`;
  if (check.type === "command") return `command ${check.command}`;
  return String(check.type ?? "unknown");
}

function tcpCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    if (!Number.isFinite(port) || port <= 0) {
      resolve(false);
      return;
    }
    const socket = net.createConnection({ host, port });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

async function httpCheck(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      ok: response.status >= 200 && response.status < 500,
      message: `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, message: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmuxHasSession(session, runner) {
  return runner.tmux(["has-session", "-t", session], { timeoutMs: 2000 }).status === 0;
}

function tmuxWindowExists(session, window, runner) {
  const result = runner.tmux(["list-windows", "-t", session, "-F", "#{window_name}"], { timeoutMs: 2000 });
  if (result.status !== 0) return false;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(window);
}

function buildServiceShellCommand(service, context) {
  const script = [];
  const envFiles = [...normalizeEnvFiles(service.envFiles)];
  for (const envFile of envFiles) {
    const filePath = resolvePathValue(envFile.path, context, service.cwd ?? context.repoDir);
    if (envFile.required) {
      script.push(`[ -f ${shellQuote(filePath)} ] || { echo "Missing env file: ${shellQuote(filePath)}" >&2; exit 1; }`);
    }
    script.push(`[ ! -f ${shellQuote(filePath)} ] || { set -a; . ${shellQuote(filePath)}; set +a; }`);
  }
  for (const name of service.unsetEnv ?? []) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) script.push(`unset ${name}`);
  }
  for (const [name, value] of Object.entries(service.env ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) script.push(`export ${name}=${shellQuote(String(value))}`);
  }
  script.push(expandTemplate(service.command, context));
  return `bash -lc ${shellQuote(script.join("\n"))}`;
}

function normalizeEnvFiles(value) {
  if (!value) return [];
  if (!Array.isArray(value)) throw new Error("envFiles must be an array");
  return value.map((entry) => (typeof entry === "string" ? { path: entry, required: false } : entry));
}

function resolvePathValue(value, context, baseDir) {
  const expanded = expandTemplate(String(value), context);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(expandTemplate(String(baseDir), context), expanded);
}

function shellQuote(value) {
  const text = String(value);
  if (text.length === 0) return "''";
  return `'${text.replace(/'/g, "'\\''")}'`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStartup()
    .then(({ code }) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
