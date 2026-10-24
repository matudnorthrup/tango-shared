#!/usr/bin/env bash
# Tango health check: run every minute (LaunchAgent, see install-healthcheck.sh).
#
# Nothing outside the bot watched the bot: on 10/06 its event loop froze for ~30
# minutes (HTTP connections piling up in CLOSE_WAIT) and nobody was told. This
# probes each service from outside, alerts the scheduler-alerts Discord channel
# through the REST API (works while the bot is frozen) once per incident plus a
# "recovered" note, and recovers what is safe to recover:
#   - bot frozen (:9200 unanswered 5 min in a row): sample it, kill -9 the node
#     process; the supervisor loop restarts it (restart.sh if no supervisor).
#   - screen service unanswered 3 min: launchctl kickstart.
# Alert only: voice bridge, operator, tailnet route, hung network mounts,
# processes stuck in uninterruptible I/O. Never lsof (it hangs on a stalled
# network mount); every probe has a hard timeout.
#
# Env: TANGO_REPO_DIR (live checkout, default: this repo), TANGO_ENV_FILE
# (default $TANGO_REPO_DIR/.env), TANGO_HEALTH_DIR (state, default
# ~/.tango/health), TANGO_HEALTH_DRY_RUN=1 (report actions, take none),
# TANGO_SERVICE_TMUX_SOCKET, TANGO_HEALTH_TAILNET_URL (optional),
# TANGO_HEALTH_BOT_URL / _MCP_URL / _VOICE_URL / _SCREEN_URL (probe overrides).
set -uo pipefail

REPO_DIR="${TANGO_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/tango-server.sh"
TS_UNAVAILABLE=skip  # a managed service whose server is unreachable is skipped, never restarted here
ENV_FILE="${TANGO_ENV_FILE:-$REPO_DIR/.env}"
STATE_DIR="${TANGO_HEALTH_DIR:-$HOME/.tango/health}"
DRY="${TANGO_HEALTH_DRY_RUN:-0}"
BOT_URL="${TANGO_HEALTH_BOT_URL:-http://127.0.0.1:9200/status/work}"
MCP_URL="${TANGO_HEALTH_MCP_URL:-http://127.0.0.1:9100/health}"
VOICE_URL="${TANGO_HEALTH_VOICE_URL:-http://127.0.0.1:8787/health}"
SCREEN_URL="${TANGO_HEALTH_SCREEN_URL:-http://127.0.0.1:9410/api/status}"
TAILNET_URL="${TANGO_HEALTH_TAILNET_URL:-}"
# The screen service's launchd label (host-specific; set by the installer). Unset: alert only.
SCREEN_AGENT="${TANGO_HEALTH_SCREEN_AGENT:-}"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/healthcheck.log"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }
get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d "\"'"; }

# The system ledger owns alerting (one sender, grouped incidents; see
# docs/specs/system-visibility.md). Discord directly is the fallback for when the
# ledger can't be written.
EVENT_BIN="${TANGO_EVENT_BIN:-$HOME/bin/tango-event}"
ledger_event() {
  local name="$1" text="$2" kind severity
  [[ -x "$EVENT_BIN" ]] || return 1
  if [[ "$text" == Recovered:* ]]; then kind=service.up; severity=recovery; else kind=service.down; severity=critical; fi
  "$EVENT_BIN" --strict --source healthcheck --kind "$kind" --severity "$severity" \
    --job "service:$name" --title "$text" >/dev/null 2>&1
}

notify() {
  local msg="🩺 $1" name="${2:-}"
  log "ALERT $1"
  if [[ "$DRY" == "1" ]]; then printf 'would alert: %s\n' "$1" >&2; return 0; fi
  if [[ -n "$name" ]] && ledger_event "$name" "$1"; then return 0; fi
  local token channel payload
  token="$(get_env DISCORD_TOKEN)"
  channel="${TANGO_HEALTH_ALERT_CHANNEL_ID:-$(get_env TANGO_SCHEDULER_ALERTS_CHANNEL_ID)}"
  [[ -z "$token" || -z "$channel" ]] && { log "no token/channel for alerts"; return 1; }
  payload="$(python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1][:1900]}))' "$msg")"
  # --fail: a Discord 401/429 is a failed alert, kept eligible for the next run.
  curl -s --fail -m 10 -o /dev/null -X POST "https://discord.com/api/v10/channels/$channel/messages" \
    -H "Authorization: Bot $token" -H "Content-Type: application/json" -d "$payload" || { log "alert post failed"; return 1; }
}

# Alert once per incident, from the threshold on: an alert Discord didn't take is retried next run.
alert_once() {
  local name="$1" n="$2" threshold="$3" msg="$4"
  (( n >= threshold )) || return 1
  alerted "$name" && return 1
  # A dry run sends nothing, so it records nothing as delivered.
  notify "$msg" "$name" && [[ "$DRY" != "1" ]] && touch "$STATE_DIR/$name.alerted"
  return 0
}

act() {
  log "ACTION $*"
  if [[ "$DRY" == "1" ]]; then printf 'would run: %s\n' "$*"; return 0; fi
  "$@"
}

# Consecutive-failure counters, one file per check.
fails() { cat "$STATE_DIR/$1.fails" 2>/dev/null || echo 0; }
set_fails() { echo "$2" > "$STATE_DIR/$1.fails"; }
alerted() { [[ -f "$STATE_DIR/$1.alerted" ]]; }

# One check result: ok → clears its counter (and says "recovered" if it had alerted).
record() {
  local name="$1" ok="$2" label="$3"
  if [[ "$ok" == "1" ]]; then
    # Cleared only once the recovery note is delivered (otherwise it's retried next run).
    if alerted "$name" && notify "Recovered: $label" "$name" && [[ "$DRY" != "1" ]]; then rm -f "$STATE_DIR/$name.alerted"; fi
    set_fails "$name" 0
    return 1
  fi
  local n=$(( $(fails "$name") + 1 ))
  set_fails "$name" "$n"
  echo "$n"
}

http_ok() { curl -s -m "${2:-5}" -o /dev/null -w '%{http_code}' "$1" 2>/dev/null | grep -qE '^(2|3)'; }

bot_pid() { ps -axo pid=,command= | awk '$2 ~ /node$/ && /packages\/discord\/dist\/main\.js/ {print $1; exit}'; }
bot_age_s() {
  local pid="$1" etime
  etime="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')"
  python3 -c '
import sys
t=sys.argv[1]; d=0
if "-" in t: d,t=t.split("-"); d=int(d)
p=[int(x) for x in t.split(":")]
while len(p)<3: p=[0]+p
print(d*86400+p[0]*3600+p[1]*60+p[2])' "${etime:-0}"
}

# Seconds since the Mac booted. startup-live brings production up about 45 s
# after boot; restarting the bot from here before that races it.
boot_age_s() {
  local sec; sec="$(sysctl -n kern.boottime 2>/dev/null | sed -E 's/^[{] sec = ([0-9]+),.*/\1/')"
  [[ -n "$sec" ]] && echo $(( $(date +%s) - sec )) || echo 999999
}
BOOT_GRACE_S="${TANGO_HEALTH_BOOT_GRACE_S:-300}"

# ── bot ─────────────────────────────────────────────────────────────────
if ts_managed discord; then
  log "SKIP discord: managed by Tango Server"
else
pid="$(bot_pid)"
if [[ -z "$pid" ]]; then
  if n="$(record bot-process 0 "the Tango bot")"; then
    alert_once bot-process "$n" 2 "The Tango bot is not running. Restarting it." || true
    # Restart at 2 min, then retry every 5 min while it stays down (a restart can fail transiently).
    if (( $(boot_age_s) < BOOT_GRACE_S )); then
      log "bot missing $(boot_age_s)s after boot; leaving it to startup-live"
    elif (( n >= 2 && (n - 2) % 5 == 0 )); then
      act env TANGO_SERVICE_TMUX_SOCKET="${TANGO_SERVICE_TMUX_SOCKET:-}" bash "$REPO_DIR/scripts/tmux/restart.sh"
    fi
  fi
else
  record bot-process 1 "the Tango bot is running again" >/dev/null
  if http_ok "$BOT_URL" 5; then
    record bot-http 1 "the bot is answering again" >/dev/null
  elif n="$(record bot-http 0 "the bot")"; then
    alert_once bot-http "$n" 3 "The Tango bot is alive but not answering (:9200, 3 min). Will restart it at 5 min." || true
    if (( n >= 5 && (n - 5) % 5 == 0 )); then
      sample "$pid" 3 -file "$STATE_DIR/bot-frozen-$(date +%Y%m%d-%H%M%S).txt" >/dev/null 2>&1 &
      sleep 4
      parent="$(ps -o ppid= -p "$pid" | tr -d ' ')"
      if ps -o command= -p "$parent" 2>/dev/null | grep -q "while :"; then
        notify "Killing the frozen Tango bot (pid $pid); its supervisor restarts it. Sample saved in $STATE_DIR."
        act kill -9 "$pid"
      else
        notify "Restarting the frozen Tango bot (pid $pid, no supervisor)."
        act kill -9 "$pid"
        act env TANGO_SERVICE_TMUX_SOCKET="${TANGO_SERVICE_TMUX_SOCKET:-}" bash "$REPO_DIR/scripts/tmux/restart.sh"
      fi
    fi
  fi
  if http_ok "$MCP_URL" 5; then record bot-mcp 1 "the bot's MCP tool server" >/dev/null
  elif n="$(record bot-mcp 0 x)"; then alert_once bot-mcp "$n" 3 "The bot's MCP tool server (:9100) isn't answering; agent tools will fail." || true; fi
  # The voice bridge comes up after Discord connects: skip right after a (re)start.
  if (( $(bot_age_s "$pid") > 180 )); then
    if http_ok "$VOICE_URL" 5; then record voice-bridge 1 "the voice bridge" >/dev/null
    elif n="$(record voice-bridge 0 x)"; then alert_once voice-bridge "$n" 3 "The voice bridge (:8787) isn't answering; voice can't reach agents." || true; fi
  fi
fi

fi

# ── screen service ──────────────────────────────────────────────────────
if ts_managed screen; then
  log "SKIP screen: managed by Tango Server"
elif http_ok "$SCREEN_URL" 5; then
  record screen 1 "the screen service" >/dev/null
elif n="$(record screen 0 x)"; then
  if [[ -n "$SCREEN_AGENT" ]]; then
    alert_once screen "$n" 3 "The screen service isn't answering. Restarting it." || true
    (( n >= 3 && (n - 3) % 5 == 0 )) && act launchctl kickstart -k "gui/$(id -u)/$SCREEN_AGENT"
  else
    alert_once screen "$n" 3 "The screen service isn't answering." || true
  fi
fi

# ── tailnet route (local service fine, tailnet path not) ────────────────
if [[ -n "$TAILNET_URL" ]] && http_ok "$SCREEN_URL" 5; then
  if http_ok "$TAILNET_URL" 10; then record tailnet 1 "the tailnet route" >/dev/null
  elif n="$(record tailnet 0 x)"; then alert_once tailnet "$n" 3 "Tailnet route down ($TAILNET_URL) while the service answers locally: check tailscale serve." || true; fi
fi

# ── network mounts: a stalled share hangs anything that touches it ──────
# One probe per mount: a stat stuck on a hung share can't be killed, so while the previous one is
# still blocked the share is still hung, and no new probe is started (they'd pile up every minute).
hung=""
while IFS= read -r mnt; do
  [[ -z "$mnt" ]] && continue
  pidfile="$STATE_DIR/mount-$(printf '%s' "$mnt" | shasum | cut -c1-12).pid"
  old="$(cat "$pidfile" 2>/dev/null)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null && ps -o command= -p "$old" 2>/dev/null | grep -q '^stat '; then
    hung="${hung:+$hung, }$mnt"
    continue
  fi
  stat -f %N "$mnt" >/dev/null 2>&1 &
  probe=$!
  for _ in 1 2 3 4 5 6; do kill -0 "$probe" 2>/dev/null || break; sleep 0.5; done
  if kill -0 "$probe" 2>/dev/null; then
    echo "$probe" > "$pidfile"
    hung="${hung:+$hung, }$mnt"
  else
    rm -f "$pidfile"
  fi
done < <(mount | awk '/\((smbfs|nfs|afpfs|webdav)/ { sub(/^.* on /, ""); sub(/ \((smbfs|nfs|afpfs|webdav).*$/, ""); print }')
if [[ -z "$hung" ]]; then record mounts 1 "network shares are answering" >/dev/null
elif n="$(record mounts 0 x)"; then alert_once mounts "$n" 2 "Network share(s) not answering: $hung. Anything touching them hangs (Finder, copy jobs)." || true; fi

# ── processes stuck in uninterruptible I/O for 2+ minutes ───────────────
# Only the kinds of process Tango runs (apps and macOS daemons wait on slow disks and iCloud
# routinely: Photos, Obsidian, cloudphotod), so an alert is something a share is actually blocking.
stuck="$(ps -axo stat=,etime=,pid=,comm= | awk '$1 ~ /^U/ { n = split($4, parts, "/"); name = tolower(parts[n]); if (name !~ /^(node|stat|lsof|rsync|cp|mv|curl|bash|zsh|sh|tmux|python3?|git|claude|npm|tsx|restic|ssh)$/) next; { split($2, a, ":"); n = length(a); secs = a[n] + 60 * a[n-1] + (n > 2 ? 3600 * a[n-2] : 0); if ($2 ~ /-/ || secs >= 120) print $3 " " $4 } }' | head -5 | tr '\n' ';')"
if [[ -z "$stuck" ]]; then record stuck-io 1 "no processes stuck in I/O" >/dev/null
elif n="$(record stuck-io 0 x)"; then alert_once stuck-io "$n" 5 "Processes stuck in uninterruptible I/O 2+ min (usually a hung network share): $stuck" || true; fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_DIR/last-run"
