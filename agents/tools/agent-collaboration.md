# collaborate_with_agent

Request bounded help from another configured Tango agent.

This is a request/result collaboration tool, not an open-ended chat channel. The
requesting agent keeps responsibility for the user goal. The target agent uses
its own runtime, tools, governance, memory scope, and profile overlays.

## Input

```json
{
  "target_agent_id": "research",
  "purpose": "source-check",
  "objective": "Verify whether the cited source supports the claim.",
  "context_summary": "A draft contains one source-backed claim.",
  "deliverable": {
    "format": "concise_result",
    "required_fields": ["answer", "evidence"],
    "max_words": 150
  },
  "constraints": ["Do not write to external systems."],
  "visibility": "summary",
  "budget": {
    "max_turns": 1,
    "max_duration_seconds": 120,
    "max_tool_calls": 5
  }
}
```

## Parameters

- `target_agent_id`: agent id to ask for help.
- `purpose`: configured collaboration purpose, such as `source-check` or `finance-summary`.
- `objective`: specific bounded goal for the target agent.
- `context_summary`: minimum context needed by the target. Avoid unrelated private transcript.
- `deliverable`: expected result format, required fields, and optional word limit.
- `constraints`: explicit limits, such as read-only, no purchases, or no external writes.
- `visibility`: one of `summary`, `digest`, `thread`, `transcript`, or `silent`.
- `budget`: requested caps. The policy layer denies requests above the target's configured caps.

The requester identity is injected by the governed runtime. Do not pass
`requester_agent_id`; caller-supplied identity is ignored.

## Output

```json
{
  "collaborationId": "uuid",
  "status": "completed",
  "answer": "The source supports the claim.",
  "evidence": [],
  "actionsTaken": [],
  "actionsNotTaken": [],
  "needsUser": false,
  "policyDecision": {
    "granted": true,
    "reason": "granted"
  }
}
```

Statuses include:

- `completed`: target returned the requested result.
- `waiting_on_user`: target needs user input before it can continue.
- `failed`: target failed or the bridge was unavailable.
- `denied`: collaboration policy rejected the request.

## Operating Notes

- Use collaboration only when another agent has a configured responsibility for
  the requested purpose.
- Send the smallest useful context. The collaboration log is durable.
- Do not use this as a way to obtain tools outside your own responsibility. The
  target agent must independently be allowed and willing to do the work.
- Prefer one bounded request with a clear deliverable over back-and-forth.
- If the target returns `waiting_on_user`, summarize the blocker to the user
  instead of asking the target to keep talking.
