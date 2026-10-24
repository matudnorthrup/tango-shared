#!/usr/bin/env node
/**
 * tango-run <job-id> -- <command...>
 *
 * Wraps a job (usually a launchd agent): records a run in the system ledger
 * (start, end, exit, duration, last 4 KB of combined output), passes stdout
 * and stderr through unchanged, and exits with the command's code. A non-zero
 * exit records run.failed subject to the job's threshold; a success after a
 * failure records the recovery. The ledger being unavailable never changes
 * what the command does or how it exits.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

export interface RunCliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  dbPath?: string;
  /** Forward these signals to the child (the real CLI does; tests don't). */
  forwardSignals?: boolean;
}

const TAIL_KEEP = 8192;

export async function runRunCli(argv: string[], io: RunCliIo = { stdout: process.stdout, stderr: process.stderr, forwardSignals: true }): Promise<number> {
  const sep = argv.indexOf("--");
  const jobId = (sep >= 0 ? argv.slice(0, sep) : argv.slice(0, 1))[0];
  const command = sep >= 0 ? argv.slice(sep + 1) : argv.slice(1);
  if (!jobId || command.length === 0) {
    io.stderr.write("usage: tango-run <job-id> -- <command...>\n");
    return 64;
  }
  const warn = (m: string) => io.stderr.write(`tango-run: warning: ${m}\n`);

  let ledger: { finish: (status: "ok" | "failed", exitCode: number, summary: string, tail: string) => void; close: () => void } | null = null;
  try {
    const { openLedger } = await import("../ledger.js");
    const { startRun, finishRun } = await import("../runs.js");
    const l = openLedger({ path: io.dbPath });
    const runId = startRun(l, jobId);
    ledger = {
      finish: (status, exitCode, summary, tail) => finishRun(l, runId, { status, exitCode, summary, outputTail: tail }),
      close: () => l.close(),
    };
  } catch (err) {
    warn(`run not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }

  let tail = "";
  const keep = (chunk: Buffer) => {
    tail += chunk.toString("utf8");
    if (tail.length > TAIL_KEEP) tail = tail.slice(tail.length - TAIL_KEEP);
  };

  const result = await new Promise<{ code: number; summary: string }>((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: ["inherit", "pipe", "pipe"] });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    const handlers: Array<[NodeJS.Signals, () => void]> = io.forwardSignals ? (["SIGTERM", "SIGINT", "SIGHUP"] as NodeJS.Signals[]).map((s) => [s, forward(s)]) : [];
    for (const [s, h] of handlers) process.on(s, h);
    child.stdout!.on("data", (c: Buffer) => {
      io.stdout.write(c);
      keep(c);
    });
    child.stderr!.on("data", (c: Buffer) => {
      io.stderr.write(c);
      keep(c);
    });
    child.on("error", (err) => {
      for (const [s, h] of handlers) process.off(s, h);
      const msg = `tango-run: cannot start ${command[0]}: ${err.message}\n`;
      io.stderr.write(msg);
      keep(Buffer.from(msg));
      resolve({ code: 127, summary: `could not start: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      for (const [s, h] of handlers) process.off(s, h);
      if (signal) {
        const num = os.constants.signals[signal] ?? 0;
        resolve({ code: 128 + num, summary: `killed by ${signal}` });
      } else {
        resolve({ code: code ?? 1, summary: `exit ${code ?? 1}` });
      }
    });
  });

  if (ledger) {
    try {
      ledger.finish(result.code === 0 ? "ok" : "failed", result.code, result.summary, tail);
    } catch (err) {
      warn(`run not finished in the ledger: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      ledger.close();
    }
  }
  return result.code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  // exitCode, not exit(): stdout may be an async pipe that still has the child's last bytes queued.
  runRunCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`tango-run: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
