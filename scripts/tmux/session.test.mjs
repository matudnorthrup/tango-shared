// Bot restarts must never take the other service windows down with them. These run the real
// session.sh helpers against a real tmux server on a private temp socket.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SESSION_SH = path.join(path.dirname(new URL(import.meta.url).pathname), "session.sh");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

function fixture() {
  // Short path: tmux socket paths are limited to ~104 bytes on macOS.
  const dir = fs.mkdtempSync(path.join("/tmp", "tgo-tmux-"));
  const socket = path.join(dir, "s");
  const log = path.join(dir, "startup.log");
  // A stand-in for scripts/startup.sh: lists two services on --dry-run (honoring --skip) and
  // opens a window per id on --only, the way the real runner does.
  const startup = path.join(dir, "startup.sh");
  fs.writeFileSync(startup, `#!/usr/bin/env bash
echo "$*" >> "${log}"
if [ "$1" = "--dry-run" ]; then
  n=0; for id in discord home sample-itinerary; do [ "$id" = "$3" ] && continue; n=$((n+1)); echo "  $n. $id ($id)"; done
  exit 0
fi
IFS=, read -ra ids <<< "$2"
for id in "\${ids[@]}"; do
  tmux -S "${socket}" list-windows -t tango -F '#{window_name}' | grep -qx "$id" || tmux -S "${socket}" new-window -t tango -n "$id" "sleep 600"
done
`, { mode: 0o755 });
  const tmux = (...args) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
  const sh = (script) => spawnSync("bash", ["-c", `source "${SESSION_SH}"; ${script}`], {
    encoding: "utf8",
    env: { ...process.env, TMUX: "", TANGO_SERVICE_TMUX_SOCKET: socket, TANGO_TMUX_SESSION: "tango", TANGO_STARTUP_SCRIPT: startup },
  });
  const windows = () => tmux("list-windows", "-t", "tango", "-F", "#{window_name}=#{pane_pid}").stdout.trim().split("\n").filter(Boolean)
    .map((l) => l.split("=")).reduce((m, [w, p]) => ({ ...m, [w]: p }), {});
  const cleanup = () => { tmux("kill-server"); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, log, tmux, sh, windows, cleanup };
}

test("restarting the bot respawns only its window; the other windows and the server stay", { skip: !hasTmux }, (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.tmux("new-session", "-d", "-s", "tango", "-n", "discord", "sleep 600");
  f.tmux("new-window", "-t", "tango", "-n", "home", "sleep 600");
  const server = f.tmux("display", "-p", "#{pid}").stdout.trim();
  const before = f.windows();

  const r = f.sh(`tango_respawn_discord_window tango:discord /tmp "sleep 601"`);
  assert.equal(r.status, 0, r.stderr);

  const after = f.windows();
  assert.equal(after.home, before.home, "home keeps its process");
  assert.ok(after.discord && after.discord !== before.discord, "the bot gets a new process");
  assert.equal(f.tmux("display", "-p", "#{pid}").stdout.trim(), server, "same tmux server");
  assert.equal(fs.existsSync(f.log), false, "no restore when the session survived");
});

test("respawning the bot when it is the only window keeps the server up", { skip: !hasTmux }, (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.tmux("new-session", "-d", "-s", "tango", "-n", "discord", "sleep 600");
  const server = f.tmux("display", "-p", "#{pid}").stdout.trim();
  assert.equal(f.sh(`tango_respawn_discord_window tango:discord /tmp "sleep 601"`).status, 0);
  assert.equal(f.tmux("display", "-p", "#{pid}").stdout.trim(), server);
});

test("after the tmux server died, opening the bot's window restores the other startup windows", { skip: !hasTmux }, (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(f.sh(`tango_respawn_discord_window tango:discord /tmp "sleep 600"`).status, 1, "nothing to respawn");

  const r = f.sh(`tango_open_discord_window tango discord /tmp "sleep 600"`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(f.windows()).sort(), ["discord", "home", "sample-itinerary"]);
  const calls = fs.readFileSync(f.log, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["--dry-run --skip discord", "--only home,sample-itinerary"], "never asks startup for the bot");
});

test("opening the bot's window in a live session does not run startup", { skip: !hasTmux }, (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.tmux("new-session", "-d", "-s", "tango", "-n", "home", "sleep 600");
  assert.equal(f.sh(`tango_open_discord_window tango discord /tmp "sleep 600"`).status, 0);
  assert.deepEqual(Object.keys(f.windows()).sort(), ["discord", "home"]);
  assert.equal(fs.existsSync(f.log), false);
});

test("a startup config that fails to load is reported, not swallowed", { skip: !hasTmux }, (t) => {
  const f = fixture();
  t.after(f.cleanup);
  fs.writeFileSync(path.join(f.dir, "startup.sh"), `#!/usr/bin/env bash\necho "bad profile yaml" >&2; exit 1\n`, { mode: 0o755 });
  const r = f.sh(`TANGO_DISCORD_WINDOW=bot; tango_open_discord_window tango bot /tmp "sleep 600"`);
  assert.equal(r.status, 0, "the bot still starts");
  assert.match(r.stderr, /not restored[\s\S]*bad profile yaml/);
  assert.deepEqual(Object.keys(f.windows()), ["bot"]);
});

test("restore skips the discord service id even when the bot's window has another name", { skip: !hasTmux }, (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(f.sh(`tango_open_discord_window tango bot /tmp "sleep 600"`).status, 0);
  assert.equal(fs.readFileSync(f.log, "utf8").split("\n")[0], "--dry-run --skip discord");
});
