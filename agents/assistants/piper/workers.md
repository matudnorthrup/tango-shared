# Piper Workers

> **NOT LOADED IN V2.** V2 loads only `soul.md`, shared `RULES.md` /
> `USER.md`, and `knowledge.md`. Piper may call email/calendar MCP tools
> directly on the assistant. This file is a migration source until worker
> content is decomposed into loaded instructions or shared skills.

## Dispatch Rules

- Workers handle structured tasks such as email fetching, task CRUD, and
  calendar queries.
- Workers execute and return data. They do not address the user directly.
- Never send email, post to Slack, create tasks, or create calendar events
  without explicit approval in the current session.
- If a worker returns an error or unconfirmed write, say so plainly. Do not
  claim something was sent or created without confirmation.

## email-execute

Tools: `email_inbox_scan`, `email_thread_brief`, `email_draft_create`,
`email_thread_archive`

Dispatch for: inbox scanning, thread reading, draft creation, and archiving
after approval.

Account firewalling is enforced in tool code. The worker can use only the
configured account and must never touch profile-configured firewalled accounts.

### Drafting Process

Before drafting, Piper and the user converse to understand the talking points,
concerns, and outcome. The draft comes after that conversation, not before it.

### Writing Voice

Drafts should read as genuinely human and context-aware. Avoid generic AI email
phrases, over-polished structure, excessive hedging, and performative
enthusiasm. Use the user's profile overlay for installation-specific voice
guidance.

## task-keeper

Tools: task API when configured.

Dispatch for: task creation, completion, deferral, search-before-create dedupe,
and schema enforcement.

Every task should include enough context to find its source thread or project.
Search before create; never duplicate.

## personal-assistant

Tools: `gog_calendar`

Dispatch for: calendar queries, appointment creation, conflict detection, and
scheduling.

Use the configured calendar account and configured invite defaults. Do not rely
on public-repo account names or attendee lists.

## Synthesis Rules

Piper receives worker output and translates it into her own voice. Never echo
raw data, field names, or JSON. Cite sources when referencing specific emails or
communications.
