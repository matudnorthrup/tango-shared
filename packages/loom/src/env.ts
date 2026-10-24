import { execFile } from "node:child_process";
import { delimiter } from "node:path";

type Exec = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const START = "__LOOM_PATH_START__";
const END = "__LOOM_PATH_END__";

const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

/** Pull PATH out of login-shell output. Marker lines keep rc-file noise out. */
export function parseShellPath(output: string): string | null {
  const start = output.lastIndexOf(START);
  const end = output.lastIndexOf(END);
  if (start < 0 || end < start) return null;
  const value = output.slice(start + START.length, end).trim();
  return value.length > 0 ? value : null;
}

export function mergePaths(preferred: string, inherited: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...preferred.split(delimiter), ...inherited.split(delimiter)]) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(delimiter);
}

/**
 * launchd starts services with a bare PATH, so harness binaries installed by
 * nvm or Homebrew are missing. Read the login shell's PATH once at startup,
 * before any harness probe, and put it ahead of the inherited one.
 * Falls back to `launchctl getenv PATH`.
 */
export async function hydratePath(env: NodeJS.ProcessEnv = process.env, exec: Exec = defaultExec): Promise<string> {
  const inherited = env.PATH ?? "";
  const shell = env.SHELL || "/bin/zsh";
  let found: string | null = null;
  try {
    found = parseShellPath(await exec(shell, ["-ilc", `printf '${START}'; printenv PATH; printf '${END}'`], 5000));
  } catch {
    found = null;
  }
  if (!found) {
    try {
      found = (await exec("/bin/launchctl", ["getenv", "PATH"], 2000)).trim() || null;
    } catch {
      found = null;
    }
  }
  const merged = found ? mergePaths(found, inherited) : inherited;
  env.PATH = merged;
  if (!env.HOME) env.HOME = (await import("node:os")).homedir();
  return merged;
}
