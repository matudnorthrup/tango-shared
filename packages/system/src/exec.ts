import { execFile } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The binary was missing or could not start. */
  error?: string;
}

/** Every external command goes through this, so tests can replace it and every call has a timeout. */
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; input?: string; cwd?: string }) => Promise<ExecResult>;

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 5000, maxBuffer: 16 * 1024 * 1024, cwd: opts.cwd, killSignal: "SIGKILL", encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, timedOut: false });
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
        if (typeof e.code === "string") return resolve({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: false, error: e.message });
        const timedOut = Boolean(e.killed && e.signal === "SIGKILL");
        resolve({ code: typeof e.code === "number" ? e.code : null, stdout: stdout ?? "", stderr: stderr ?? "", timedOut, error: timedOut ? "timed out" : undefined });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });

export type Fetch = (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<{ status: number; text: string } | { error: string }>;

export const realFetch: Fetch = async (url, init = {}) => {
  const { timeoutMs = 3000, ...rest } = init;
  try {
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  } catch (err) {
    return { error: err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : err.message) : String(err) };
  }
};
