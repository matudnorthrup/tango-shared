#!/usr/bin/env node
/**
 * tango-mode                       show working or away
 * tango-mode away [--hours N]      the Mac is free for big jobs (until you say otherwise, or N hours)
 * tango-mode working               you're back; big jobs wait
 * tango-mode auto                  drop the manual choice; the weekly window file decides
 * tango-mode gate [--minutes N] [--gb N] [--path P] [--force]
 *                                  exit 0 when a big job may run now, 75 when it should wait (reason on stderr)
 */
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { checkGate } from "../gate.js";
import { clearManual, currentMode, setAway, setWorking } from "../mode.js";

const value = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

export function describe(m: ReturnType<typeof currentMode>): string {
  if (m.mode === "working") return "working: big jobs wait";
  const left = m.minutesLeft === null ? "until you're back" : m.minutesLeft >= 90 ? `about ${Math.round(m.minutesLeft / 60)} h left` : `${m.minutesLeft} min left`;
  return `away (${m.source}): big jobs may run, ${left}`;
}

export function runModeCli(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s), err: (s: string) => void = (s) => process.stderr.write(s)): number {
  const cmd = argv[0];
  if (cmd === "-h" || cmd === "--help") {
    out("usage: tango-mode [away [--hours N] | working | auto | gate [--minutes N] [--gb N] [--path P] [--force]] [--json]\n");
    return 0;
  }
  const json = argv.includes("--json");
  if (cmd === "away") {
    const hours = value(argv, "--hours");
    if (argv.includes("--hours") && !(Number(hours) > 0 && Number.isFinite(Number(hours)))) {
      err("tango-mode: --hours needs a positive number, like --hours 8\n");
      return 64;
    }
    setAway({ hours: hours ? Number(hours) : null });
  } else if (cmd === "working") setWorking();
  else if (cmd === "auto") clearManual();
  else if (cmd === "gate") {
    const r = checkGate({
      needMinutes: value(argv, "--minutes") ? Number(value(argv, "--minutes")) : undefined,
      needGb: value(argv, "--gb") ? Number(value(argv, "--gb")) : undefined,
      path: value(argv, "--path"),
      force: argv.includes("--force"),
    });
    if (json) out(`${JSON.stringify(r)}\n`);
    else if (!r.allowed) err(`tango-mode: wait: ${r.reason}\n`);
    return r.allowed ? 0 : 75;
  } else if (cmd && !cmd.startsWith("--")) {
    err(`tango-mode: unknown command ${cmd}\n`);
    return 64;
  }
  const m = currentMode();
  out(json ? `${JSON.stringify(m)}\n` : `${describe(m)}\n`);
  return 0;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) process.exit(runModeCli(process.argv.slice(2)));
