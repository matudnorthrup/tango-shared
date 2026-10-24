# Decision Models (Jev)

Decision models answer typed questions about a state with calibrated
probabilities and never write text. Tango calls TypeSafe's Jev
(`typesafe/jev-1.13`) through OpenRouter's decisions endpoint, the same route
a production text-decisions service uses. A call costs only input
tokens (about $0.04 per million) and returns in about 0.3 s including the
network.

## What it does today: shadow mode

Jev runs **beside** four existing classifiers and never decides anything. Each
call appends one JSONL line with both answers, Jev's confidence, whether they
agree, and the state and options Jev saw, which a judge later needs.

| Site | Classifier that decides | Jev questions |
|---|---|---|
| `desk.step` | Desk summarizer (`SCREEN_INBOX_MODEL`) | step (your_move/watching/fyi) + ack-only |
| `runtime.task_shape` | per-turn task router (`role:task-router`) | JUDGMENT/DATA/OTHER |
| `operator.unfinished` | `looksUnfinished` heuristics | was the speech cut off? |
| `operator.destination` | `matchDestinationAnswer` word matching | the reply to "main chat, or the … thread?": main / a thread / cancel / unclear |

A shadow call is fire-and-forget. It can't throw into the caller and never adds
latency. It is dropped beyond four in flight. After a spent cap, a bad key, or a
rate limit, it pauses (30 min, or 1 min for a rate limit).

## Configuration

| Env | Meaning |
|---|---|
| `OPENROUTER_API_KEY` | Turns shadow mode on. Use a dedicated key with a daily credit limit; Jev's own usage is cents per day. |
| `TANGO_DECISION_SHADOW=off` | Turns it off even with a key. |
| `TANGO_DECISION_MODEL` | Default `typesafe/jev-1.13`. |
| `TANGO_DECISION_LOG_DIR` | Default `<profile>/data/decisions/`, one `shadow-YYYY-MM-DD.jsonl` per day. |

The voice operator, screen service and Discord bot each read the key from
their own env file. Set it in every one that should shadow.

## Judging the results

Agreement with the current classifier is **not** accuracy. The classifiers that decide today have
routing and status bugs of their own, so neither side is the reference. Each row is ruled on by a
judge instead:

```bash
node scripts/decisions-adjudicate.mjs --days 7          # judge new rows (skips judged ones)
node scripts/decisions-shadow-report.mjs --days 7       # accuracy per system from the rulings
```

- **Blind:** the judge (Claude, headless `claude -p`) sees the two answers as A and B in random
  order, never which system gave which.
- **Hindsight:** it gets what happened next. For `desk.step`, the conversation and desk actions in
  the 48 hours after the card was summarized. For `operator.*`, the operator trace in the next
  5 minutes.
- **Its own call:** it picks the correct option from the full list, so "both wrong" is a possible
  ruling.
- **Waits for hindsight:** a row is judged only once its window has closed: 48 h for `desk.step`,
  10 min for the operator sites. Operator hindsight is limited to the same voice session.
- **Coverage:** every disagreement is judged, plus a sample of agreements (`--agree-sample`, default
  0.2). Two systems agreeing can still both be wrong.

Rulings append to `adjudications.jsonl` beside the shadow log. For each site the report shows:

- who was right on disagreements;
- how often sampled agreements were both right;
- the estimated accuracy of each system over all traffic;
- Jev's accuracy when it was confident.

A site moves from shadow to Jev deciding only when Jev's judged accuracy beats the current
system's. Then set its confidence gate from the judged rows.

## Adding a site

1. Write a prompt builder that returns a `DecisionPrompt`. Always give the
   `choice` questions an escape option such as `none`: Jev answers an
   out-of-category input with high confidence.
2. Call `getDecisionShadow().run({ site, prompt, incumbent, agree?, excerpt })`
   after the deciding classifier answers. `incumbent` uses the same keys as the
   Jev questions.
3. Keep the state to what the questions read. Unrelated context lowers Jev's
   accuracy.

Jev can't do arithmetic, counting, date comparisons or free text. Leave those
decisions with the LLM.
