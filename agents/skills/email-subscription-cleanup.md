# email_subscription_cleanup

Workflow for finding email subscriptions that are likely worth removing and,
after explicit user confirmation, unsubscribing from them.

## Modes

### Nightly Discovery

Scheduled discovery is recommendation-only. It may search and read email,
update the subscription tracking note, and write a summary, but it must not
click unsubscribe links or send unsubscribe requests.

1. Read the email triage rules at `References/Email Triage Rules.md`.
2. Read the subscription tracking note at
   `Records/Finance/Email Subscriptions.md` if it exists. Use it to avoid
   re-surfacing senders already marked `keep`, `unsubscribed`, `ignored`, or
   recently reviewed.
3. Scan every accessible Gmail account. Search recent mail for subscription
   signals such as:
   - `newer_than:30d (unsubscribe OR "manage preferences" OR "email preferences")`
   - `newer_than:30d category:promotions`
   - `newer_than:30d (from:noreply OR from:no-reply OR from:notifications)`
4. Group messages by sender/newsletter identity across accounts. Prefer the
   sending domain plus visible newsletter name over raw display-name variants.
5. Recommend unsubscribe candidates when the pattern is noisy, recurring, and
   low value: marketing blasts, unread newsletters, product updates, sales
   promotions, generic community notifications, and duplicate alerts.
6. Do not recommend unsubscribe for receipts, invoices, security alerts,
   account access, billing, tax/legal/medical notices, family/school messages,
   client/customer mail, work-operational alerts, or anything the triage rules
   say to keep.

## Candidate Output

The nightly summary must include a parsable flagged section. Use concise bullets
that the daily brief can promote directly:

```markdown
**Summary:** Scanned all accessible Gmail accounts; 3 unsubscribe candidates need confirmation.

**Flagged:**
- [ ] USUB-2026-06-19-01: Unsubscribe from Example Weekly on personal@example.com -- frequent promotions; no action value found in recent messages.
- [ ] USUB-2026-06-19-02: Unsubscribe from Vendor Updates on work@example.com -- duplicate product-news digest already covered elsewhere.
```

If there are no candidates, say `No flagged items.` Do not include a generic
"review needed" line when there are specific candidates.

## Confirmation Mode

When the user confirms in the Watson channel, treat explicit references such as
"unsubscribe 1 and 3", "remove USUB-...", or "unsubscribe from Example Weekly"
as authorization for only those named candidates.

1. Read the latest `Email Unsubscribe Review` entry from
   `Records/Jobs/Email/YYYY-MM.md` and match the requested candidates by ID,
   number, sender, or account.
2. Re-fetch the latest representative message before acting. Do not rely only
   on stale log text.
3. Find the unsubscribe path. Prefer an HTTPS unsubscribe or preferences URL
   from the email body or `List-Unsubscribe` headers. Use `mailto:` only if the
   user explicitly approved that sender and no browser path exists.
4. Use the browser tool for website flows:
   - launch the browser first,
   - open the unsubscribe URL,
   - choose full unsubscribe over "pause" or "reduce frequency",
   - avoid adding personal data unless it is already prefilled,
   - stop and report if login, 2FA, CAPTCHA, payment, or account deletion is
     required.
5. After a successful unsubscribe, update the subscription tracking note with
   status `unsubscribed`, date, account, source sender, and evidence message or
   thread ID.
6. Archive only the source newsletter thread after success if it is still in
   the inbox. Do not bulk-delete mail.

## Safety Rails

- Never unsubscribe from financial, security, medical, legal, school, family,
  government, or account-access mail without a second explicit confirmation
  that names the risk.
- Do not unsubscribe a whole Google Group, Slack, Linear, GitHub, bank, Apple,
  Stripe, ExpenseDesk, payroll, domain registrar, or cloud-provider notification unless
  the candidate is clearly a marketing list and the confirmation names it.
- If the unsubscribe page is ambiguous, stop with a short status and leave the
  candidate as `needs-review`.
- Record partial failures in the Email job log or the tracking note so the next
  run does not repeat the same blind attempt.
