import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface LoomConfig {
  home: string;
  port: number;
  dbPath: string;
  ownerPath: string;
  tokenPath: string;
  accountsPath: string;
  claudeProjectsDir: string;
  /** Tango's usage monitor. Empty string turns the feed off. */
  usageUrl: string;
}

export interface AccountsFile {
  codex?: { default: string; accounts: { name: string; home: string; usageName?: string; aliases?: string[] }[] };
  claude?: { default: string; accounts: { name: string; configDir?: string; usageName?: string; aliases?: string[] }[] };
}

/** Loom's state lives in LOOM_HOME, default ~/.tango/loom. The port is LOOM_PORT, default 9420. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoomConfig {
  const home = env.LOOM_HOME || join(homedir(), ".tango", "loom");
  return {
    home,
    port: Number(env.LOOM_PORT ?? 9420),
    dbPath: join(home, "loom.sqlite"),
    ownerPath: join(home, "owner.sqlite"),
    tokenPath: join(home, "token"),
    accountsPath: env.LOOM_ACCOUNTS || join(home, "accounts.json"),
    claudeProjectsDir: join(home, "claude-projects"),
    usageUrl: env.LOOM_USAGE_URL ?? "http://127.0.0.1:9380/api/usage",
  };
}

/** Read the API token, creating it (mode 0600) on first run. */
export function ensureToken(config: LoomConfig): string {
  mkdirSync(config.home, { recursive: true, mode: 0o700 });
  if (existsSync(config.tokenPath)) return readFileSync(config.tokenPath, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(config.tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(config.tokenPath, 0o600);
  return token;
}

const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

/**
 * Accounts live in a private file outside the repo (default
 * ~/.tango/loom/accounts.json):
 *
 *   { "claude": { "default": "main", "accounts": [{ "name": "main", "usageName": "Main" }, { "name": "work", "configDir": "~/.claude-work" }] } }
 *
 * An account without configDir is the default ~/.claude login. usageName is
 * the account's profileName in the usage monitor; without it the pool can't
 * see the account's room and ranks it after the others.
 */
export function loadAccounts(config: LoomConfig): AccountsFile {
  if (!existsSync(config.accountsPath)) return {};
  const parsed = JSON.parse(readFileSync(config.accountsPath, "utf8")) as AccountsFile;
  if (parsed.claude) {
    parsed.claude.accounts = parsed.claude.accounts.map((a) => (a.configDir ? { ...a, configDir: expandHome(a.configDir) } : a));
    if (!parsed.claude.accounts.some((a) => a.name === parsed.claude!.default)) {
      throw new Error(`accounts.json: default Claude account "${parsed.claude.default}" is not in the list`);
    }
  }
  if (parsed.codex) {
    parsed.codex.accounts = parsed.codex.accounts.map(a => ({ ...a, home: expandHome(a.home) }));
    if (!parsed.codex.accounts.some(a => a.name === parsed.codex!.default)) throw new Error(`accounts.json: default Codex account "${parsed.codex.default}" is not in the list`);
  }
  return parsed;
}
