# T3 retirement

Tango uses Loom for coding conversations. Discord and Tango agent conversations
remain supported. T3 is no longer a desk source: Tango does not poll its database
or API, deliver messages to it, or start threads in it. A T3 thread id passed to
the CLI is rejected with “T3 is retired; use Loom”. Use a `loom:<id>` instead.

The one-time cutover handed live conversations to Loom before archiving their
T3 copies. The former `scripts/t3/handoff.mjs` snapshotted a source, verified it
was idle, started its Loom successor, then verified the start before archiving.
Its implementation and tests remain in git history. No active repository caller
requires it, so the migration tool and the stock-app installer and single-copy
guard scripts were removed together with the integration.

Removing integration code does not delete the T3 app, retained conversation data,
source worktrees, or private handoff documents. Those require a separate operator
decision. External scheduler bridges, installed scripts, and other repositories'
agent instructions must be reconciled by their owners; this repository cannot
update them as part of its build or deploy.

For current usage, see [Loom](loom.md), [the operating guide](../guides/agent-operating-model.md),
and [the desk specification](../specs/agent-desk-next.md). Older desk specifications
retain T3 details only as historical design records. Loom's T3 Code attribution
is likewise historical and remains valid.
