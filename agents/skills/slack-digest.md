# Slack Digest

Summarize Slack activity into a concise, synthesized briefing. The goal is insight, not information — the reader should finish knowing what matters without having to read Slack themselves.

## Workflow

### 1. Gather Data

Use the `slack` tool:

1. `list_channels` to discover available channels.
2. `channel_history` for each target channel (default: last 24 hours).
3. `user_info` to resolve user IDs to display names (cache results — don't re-fetch the same user).
4. `thread_replies` for any thread with high reply_count to get full context.

### 2. Filter Signal from Noise

**Signal indicators (include):**
- Messages with `reply_count >= 2` (multi-person threads — real discussions)
- Messages with 2+ emoji reactions (community agreement/interest)
- Production issues, outages, or error reports
- Decision discussions or process changes (keywords: decided, approved, shipped, launched, released, merged, rollback, deploy)
- Mentions of key people or work areas

**Noise indicators (skip):**
- Single messages with no replies or reactions (monologues)
- Bot-only activity (unless it reveals production issues)
- Channel join/leave notifications (subtype field present)
- Simple emoji-only messages
- Routine status updates with no discussion

### 3. Synthesize — This Is the Hard Part

**Organize by significance, NOT by channel.** Lead with the most important items. Group related discussions that span channels (e.g., an outage discussed in #engineering and #incidents is one story, not two).

**Structure:**
- Open with the biggest news or most active discussion
- Group related items across channels into coherent topics
- Note channels that are usually active but were quiet today (this is informative)
- Attribute key contributions to people by name
- For threads with real discussion, summarize the arc (question → debate → resolution) not just the first message

**Tone:** Natural and concise. Like briefing a colleague over coffee. No bullet-point walls. No "In #channel-name, User posted..." for every item — weave it into a narrative.

**Length:** Target 3-5 minutes of reading. If it's shorter than that, the day was genuinely quiet — don't pad.

### 4. Output

Write the synthesized briefing as your final response. The scheduler will deliver it to Discord.

If there was no meaningful activity across any channel, say so briefly — don't fabricate content.

## Anti-Patterns

- Listing every message per channel with a quote block (this is a dump, not a digest)
- Channel-by-channel organization (bury the lede — lead with what matters)
- Including low-signal messages to make the summary look comprehensive
- Omitting names (people want to know *who* said the important things)
- Ignoring thread context (the first message alone often misses the point)

## Fallback When `slack` Is Unavailable

If the worker session does not expose the `slack` tool, do not fabricate a digest.

1. Check `data/tango.sqlite`:
   - `schedule_runs` for the relevant schedule (`ai-intelligence-briefing` or `slack-summary`) using `schedule_id`
   - `messages` for the delivery channel's most recent outbound post using `discord_channel_id`
   - prefer `schedule_runs.summary`; if that is empty, fall back to `messages.content`
2. Report one of:
   - the latest delivered digest text if a recent run completed successfully
   - the blocked state if the current run is still `running` or failed
3. Make the limitation explicit: scheduler/database state is verified, but live Slack history was not retrievable in the current session.

Current schema notes:
- `schedule_runs`: `schedule_id`, `status`, `started_at`, `finished_at`, `error`, `summary`, `delivery_status`, `delivery_error`
- `messages`: `discord_channel_id`, `direction`, `content`, `created_at`
