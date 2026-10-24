#!/usr/bin/env node
/**
 * tango-event --source <name> --kind <kind> --severity <sev> --title "<text>"
 *             [--job <id>] [--detail "<text>"] [--data '<json>'] [--at <iso>] [--strict]
 *
 * Records one event in the system ledger. Exits 0 even when the ledger is
 * unavailable (it prints a warning), so it never breaks the calling script.
 * --strict exits 2 instead when the event was not written, for callers that
 * fall back to their own alert.
 */
import { fileURLToPath } from "node:url";

const SEVERITIES = new Set(["critical", "error", "warning", "info", "recovery"]);
const USAGE = 'usage: tango-event --source <name> --kind <kind> --severity <critical|error|warning|info|recovery> --title "<text>" [--job <id>] [--detail "<text>"] [--data \'<json>\'] [--resolves-kind <kind> --resolves-title "<incident title>"] [--strict]';

export interface EventCliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  dbPath?: string;
}

export function parseEventArgs(argv: string[]): { flags: Record<string, string>; strict: boolean; help: boolean } {
  const flags: Record<string, string> = {};
  let strict = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--strict") strict = true;
    else if (a === "-h" || a === "--help") help = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = argv[++i] ?? "";
    }
  }
  return { flags, strict, help };
}

export async function runEventCli(argv: string[], io: EventCliIo = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }): Promise<number> {
  const { flags, strict, help } = parseEventArgs(argv);
  const fail = (msg: string) => {
    io.stderr(`tango-event: warning: ${msg}\n`);
    return strict ? 2 : 0;
  };
  if (help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  const { source, kind, severity, title } = flags;
  if (!source || !kind || !severity || !title) return fail(`missing a required flag\n${USAGE}`);
  if (!SEVERITIES.has(severity)) return fail(`unknown severity '${severity}'`);
  let data: Record<string, unknown> | undefined;
  if (flags.data) {
    try {
      const parsed = JSON.parse(flags.data) as unknown;
      data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch {
      data = { raw: flags.data };
    }
  }
  try {
    const { openLedger } = await import("../ledger.js");
    const { recordEvent } = await import("../incidents.js");
    const l = openLedger({ path: io.dbPath });
    try {
      const r = recordEvent(l, {
        source,
        kind,
        severity: severity as "critical",
        title,
        jobId: flags.job || undefined,
        detail: flags.detail || undefined,
        data,
        at: flags.at || undefined,
        // A recovery scoped to one incident (its kind and title), not every incident of that kind on the job.
        ...(flags["resolves-kind"] && flags["resolves-title"] ? { resolves: { kind: flags["resolves-kind"], title: flags["resolves-title"] } } : {}),
      });
      io.stdout(`${JSON.stringify(r)}\n`);
      return 0;
    } finally {
      l.close();
    }
  } catch (err) {
    return fail(`event not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1])) {
  const strict = process.argv.includes("--strict");
  runEventCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`tango-event: warning: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = strict ? 2 : 0;
    });
}
