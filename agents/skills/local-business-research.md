# local_business_research

Reusable guidance for restaurants, local businesses, activities, classes,
venues, tours, and events.

Use this when the user wants to choose somewhere to go, make plans, contact a
business, verify event details, or compare local options.

## Reliability Standard

Local recommendations are decision support, not casual trivia. Treat these as
source-grounded research tasks whenever the answer could affect where the user
goes, when they show up, who they contact, or what they spend.

Do not rely on a single AI answer, summary snippet, or one search result. For
time, date, hours, booking, price, phone, WhatsApp, address, meeting point, or
availability claims, verify the exact detail against a source that can plausibly
own the fact.

## Source Order

Prefer sources in this order:

1. Official business, venue, organizer, event, or government/nonprofit page.
2. Official social profile controlled by the business or organizer.
3. Booking/ticketing platform, reservation page, or marketplace listing.
4. Map/business directory listing.
5. Recent local guide, newspaper, travel site, or review platform.
6. Forum posts, blogs, and generic AI/search summaries.

If a weaker source conflicts with a stronger source, use the stronger source
and call out the conflict when it matters.

## Workflow

1. Build a candidate inventory.
   - Use `local_business_search` for restaurants, businesses, attractions,
     classes, tours, venues, and local event providers near a place.
   - Also run web searches for "best", "top rated", "near me", neighborhood,
     cuisine/activity type, and local-language variants when relevant.
   - For broad shortlists, inspect at least 12-25 candidates before narrowing.
2. Verify decision-critical facts.
   - Use official pages or controlled social pages for hours, schedules,
     event times, release times, booking rules, price, address, and contact
     details.
   - Use browser/page reads when a search result only exposes a snippet.
   - For WhatsApp or phone numbers, copy the exact number only from an official
     page/profile or a reputable booking/listing page. Label third-party-only
     numbers as unverified.
3. Compare on the user's decision axes.
   - Fit for the user request, rating/review signal, evidence strength,
     distance/route/walkability, current availability, price, ambiance, and
     any dietary/accessibility constraints.
4. Resolve contradictions.
   - If hours, event times, phone numbers, addresses, or prices differ, run a
     targeted follow-up search and report the conflict instead of smoothing it
     over.

## Required Fields

For each recommendation or verified option, preserve:

- Name
- Category or activity type
- Address or area
- Why it fits
- Rating/review signal when available, with source
- Hours or event time when relevant
- Booking/contact method when relevant
- Official URL or strongest source URL
- Verification status: verified, partially verified, or unverified

For event/activity planning, also include:

- Date or schedule
- Arrival/check-in time if different from event time
- Price or donation if relevant
- Meeting point
- Cancellation, booking, or weather caveat when relevant

## Output

Lead with the recommendation or shortlist. Keep it compact, but include enough
source evidence that the user can trust the plan.

Use confidence labels:

- High: official/current source confirms the critical details.
- Medium: multiple good non-official sources agree, but no official source was
  found.
- Low: candidate looks promising but details are sparse, old, or conflicting.

If the answer would require a time, date, phone, WhatsApp number, booking link,
or address that was not verified, say so directly instead of guessing.
