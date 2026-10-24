# Private launch wrappers

These files are reviewable installation inputs, not an installer. Do not apply
them until the matching Loom release is deployed and the operator authorizes
updating private scripts. Keep a verified copy of each original script first;
restore that copy to undo the wrapper change.

- `tshare.patch` changes only `port` in the existing private `tshare` script.
  Check it with `patch --dry-run <path-to-tshare> tshare.patch`, then apply the
  same patch without `--dry-run` when authorized. Artifact commands are unchanged.
- `loom-dev-server` is an optional executable wrapper for foreground commands.
  Install it on the private PATH after review. Outside Loom (including isolated
  sessions without `TANGO_DESK_ITEM`) it executes the original command directly.

Inside Loom, both call `loom resource` before launching anything. An API failure,
missing identity or unavailable coordinator is an error, never a fallback.
Each turn supplies its immutable `LOOM_RUN_ID` in its runtime context. Prefix
**each invocation** with that assignment; do not discover the current run from
the thread, read an updating identity file, or reuse an old shell's exported ID.
Old shells retain old IDs and are rejected after their run ends.

```sh
LOOM_RUN_ID=<this-turn-id> loom-dev-server npm run dev -- --host 127.0.0.1
LOOM_RUN_ID=<this-turn-id> tshare port 3100
```

The direct equivalents are `loom resource dev-server -- <command> [args...]`
and `loom resource port <localport>`. Commands must remain foreground and keep
all children in the supplied process group; do not pass a daemonizing command.
The dev-server client sends its actual working directory. Loom resolves it with
`realpath` and starts the command there only if it is an existing directory inside
this thread's owned worktree. Subpackages and symlinks within that worktree work;
missing paths and symlinks escaping it are rejected. Run the wrapper from the
intended subdirectory; Loom never substitutes the worktree root.
The first returns JSON containing its lease and bounded log path. The second
returns the leased HTTPS URL. Inside Loom, `tshare` prints a `:1xxxx` port
(for example, local 3100 becomes HTTPS 13100); always use the printed URL,
not the local port or an older persistent mapping URL. Its HTTPS port is `10000 + localport`, so local
ports must be between 1 and 55535. An occupied unowned mapping is rejected even
if it already points to the same local server. An unchanged, active mapping
already leased by this thread can be reused across turns.

To stop one resource early, use the returned lease ID:

```sh
LOOM_RUN_ID=<this-turn-id> loom resource release <lease-id>
```

Release requires the current active run and a lease owned by this thread, including
one created in an earlier turn. It reuses the cleanup backend's process/mapping
identity checks. Unknown or changed ownership fails closed; an already reclaimed
lease returns success. No force release or cross-thread release is supported.
Releasing a dev server does not release its separate port mapping lease; release
that mapping by its own lease ID when it is no longer needed.

Managed dev servers and mappings survive run completion while the thread stays
warm. They are reclaimed on cooling, stop, finish or deletion. Existing persistent
Serve mappings, Funnel configurations and resources outside the lease store
remain untouched. Mapping transport requires the installed Tailscale LocalAPI
foreground session and ETag interfaces; unsupported versions fail closed.

## Managed browser client

`loom-browser` is an optional private wrapper. Outside Loom it passes its arguments
unchanged to `agent-browser`. Inside Loom it calls `loom resource browser -- ...`:

```sh
LOOM_RUN_ID=<this-turn-id> loom-browser open http://127.0.0.1:3100
LOOM_RUN_ID=<this-turn-id> loom-browser snapshot -i
LOOM_RUN_ID=<this-turn-id> loom-browser close
```

The coordinator launches installed Chrome directly in the leased process group,
with a newly owned profile and loopback debugging port. Configure `LOOM_CHROME_PATH`
on the coordinator if Chrome is outside the standard system locations. `lsof` is
required to verify that the listener belongs to the nonce-owned group. Failed
readiness releases only that lease. A browser can be reused within the same run;
a new run gets a new profile/session. Run-end cleanup removes the browser group
and, after confirmed absence, its owned profile. Shared profiles are never used.

The wrapper invokes the supported `agent-browser --cdp <port> --session <name>`
CLI, with an empty explicit config and browser environment overrides removed.
It supports basic navigation, snapshots, screenshots, inspection and interactions;
unknown options, connection overrides, nested batches and alternate providers are
rejected. Positional values beginning with a dash (for example `fill @e1 -5`)
are also rejected by the current argument validator. Use the printed error rather than falling back to plain `agent-browser`.
No private daemon protocol is used. The HTTP caller still needs its exact run ID.

**Client limitation:** agent-browser can spawn a detached client daemon. That
client is outside the Chrome lease and remains report-only in resource discovery.
Its session can remain listed after Chrome cleanup. Use the
supported per-session `close` command before ending work to disconnect it; this
leaves the leased Chrome running until run-end cleanup. If a session remains after
a run, inspect it and close that exact session with `agent-browser --session
<leased-session> close`. Never use `close --all` or kill a process by name. This
wrapper does not claim durable ownership or automatic reclamation of that client.
