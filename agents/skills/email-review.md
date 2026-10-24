# email_review

Reusable workflow guidance for email triage, drafting, and cleanup across Gmail accounts.

## Accounts

All phases scan every configured account unless the task specifies otherwise.

Typical setups include:
- one primary work account
- one primary personal account
- optional family, project, or low-volume accounts

## Workflow Phases

Follow these phases in order. Report progress after each phase.

### Phase 1: Scan & Categorize

For each account, run separate searches to classify inbox mail:

- **Newsletters/Promotions**: search `is:inbox category:promotions` — marketing, digests, product updates
- **Notifications**: search `is:inbox (category:updates OR from:noreply OR from:no-reply OR from:notifications)` — automated alerts, receipts, status updates
- **Actionable**: everything else in the inbox that doesn't match the above — real messages from real people requiring a response, decision, or follow-up

Present an overview with counts per category per account, then a numbered list of only the actionable emails (sender + one-line summary). Do NOT list every newsletter and notification individually — just counts.

### Phase 2: Process Actionable Emails

Handle each actionable email one at a time:

1. Fetch the full thread.
2. Summarize: who sent it, thread history, what they need now.
3. Present options: respond, skip, defer.
4. Wait for direction before drafting.
5. After resolution (draft created or skipped), archive the thread.
6. Move to the next email with a clear transition.

### Phase 3: Notifications & Newsletters Review

Review the non-actionable mail before bulk archiving.

1. Fetch subjects for notifications and newsletters across accounts.
2. Categorize into groups:
   - **Action/Attention** — renewals, billing, deadlines, security alerts that need response
   - **Business/Work** — reports, app reviews, stability alerts worth a glance
   - **Family** — kids' activity reports, school notifications
   - **Sales/Revenue** — purchase confirmations and business transactions from the user's own businesses/side projects
   - **Safe to archive** — marketing, promos, routine automated alerts
3. Present the categorized summary. Flag anything that might need attention.
4. Wait for direction on flagged items. Fetch full email if requested.
5. Archive remaining in bulk.

### Phase 4: Summary

Present a final summary: actionable processed, drafts created, notifications/newsletters archived, total inbox reduction.

## Drafting Conventions

- **Reply-all by default.** Check original To/Cc and include all recipients.
- **Thread correctly.** Get the last message ID from the thread and use `--reply-to-message-id`.
- **Use `--body-file -`** with stdin for message bodies (handles multiline and special characters).
- **Match the subject.** Use `Re: Original Subject` for replies.

## User Email Voice

- Casual but professional
- Short paragraphs, 2-3 sentences max
- Signs off with "Thanks!" or a dash signature using the user's preferred name
- Uses scheduling link for external meetings rather than availability back-and-forth
- Scheduling link: use the installation's configured scheduling link if available

## Calendar Holds

When an email involves proposing meeting times, create a calendar hold with `(pending)` in the title and `--send-updates none` to avoid notifying attendees prematurely.

## Decision Rules

- Archive after processing — don't leave resolved threads in inbox.
- Skip without guilt — not every email needs a response.
- When unsure about tone or content, present a draft and ask for direction rather than guessing.
- For bulk newsletter cleanup, group by type and confirm before archiving.
