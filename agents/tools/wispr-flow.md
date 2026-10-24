# wispr_flow

Wispr Flow's remote MCP server — read-only access to the operator's Meeting
Recorder captures (notes, Flow Summary, verbatim transcripts), their Wispr Flow
scratchpad notes, and the Google Calendar linked to that Wispr Flow account.

**This tool is provided by a separate MCP server (`wispr-flow`).** Call the tools
as `mcp__wispr-flow__<tool>`, not as wellness-server tools.

Every tool is read-only. Nothing here writes, shares, or changes sharing
settings. Sharing is changed only by the operator in the Wispr Flow app
(Notetaker tab → menu beside the meeting → Share); say so rather than trying.

## Transport and auth

The server is not in the repo agent config; a profile overlay adds it to the
agent's `mcp_servers` list. Overlay arrays **replace** the repo array rather
than appending to it, so the overlay must carry the agent's complete
`mcp_servers` list (copy the repo list, then add this entry). An overlay with
only this entry drops servers that `mcp.default_servers` still names, and the
layered config fails to load. The entry to add:

```yaml
- name: wispr-flow
  command: npx
  args: ["-y", "mcp-remote@0.8.5", "https://api.wisprflow.ai/connect/mcp"]
```

Pin the `mcp-remote` version: it keys its OAuth token cache to the version
line, so an unpinned bump silently drops the sign-in. Auth goes through `mcp-remote` (OAuth, scopes `openid offline_access`). Tokens are cached outside
the repo in `~/.mcp-auth/`. If a call fails with an auth error, the refresh
token has expired and a human has to redo the browser sign-in by running
`npx -y mcp-remote@0.8.5 https://api.wisprflow.ai/connect/mcp` interactively —
there is no headless re-auth.

## Tools

### Identity

| Tool | Purpose |
|------|---------|
| `get_account_info` | The authenticated user's own name and calendar display-name aliases. Call this first for first-person questions ("what did I commit to", "who did I meet with") so you know which attendee is the user. |

### Recorded meetings

| Tool | Purpose |
|------|---------|
| `search_meetings` | Search/list recorded meetings. `query` + `field` (`title`/`content`/`both`), `attendee_emails` + `attendee_match` (`any`/`all`), `since`/`until` (ISO-8601), `limit` (default 25, max 200), `cursor`. |
| `get_meeting` | One meeting by `meeting_id`: markdown notes, the full Flow Summary, and the attendee list without emails. |
| `get_meeting_by_calendar_id` | Same payload, keyed by `calendar_id` instead. |
| `get_meeting_attendee_emails` | Attendee email addresses for one meeting. Only when the user explicitly asks for contact addresses — the other tools omit emails deliberately. |
| `list_meeting_series` | Every recorded occurrence of a recurring series, given any one `meeting_id` from it. |
| `resolve_share_link` | Resolve a pasted `https://notes.wisprflow.ai/shared/…` link. Shared notes are usually *other people's* meetings, which `search_meetings` will never return — use this instead of guessing at the link's contents. |

### Scratchpad notes

| Tool | Purpose |
|------|---------|
| `search_scratchpad_notes` | Search/list notes. Same `query`/`field`/`since`/`until`/`limit`/`cursor` shape as `search_meetings`. |
| `get_scratchpad_note` | One note's normalized text by `note_id`. |

### Calendar

| Tool | Purpose |
|------|---------|
| `search_calendar_events` | Search/list events on the linked Google Calendar by keyword, `attendee_emails`, or date window. |
| `get_calendar_event` | One event by `calendar_id`, with the complete attendee list. |
| `resolve_calendar_link` | Resolve a pasted Google Calendar / Meet / Zoom URL to the matching event. |
| `list_upcoming_meetings` | Upcoming events in the next `window_hours` (default 24, max 168), soonest first. |
| `get_upcoming_meeting` | One upcoming event by `calendar_id`, with its pre-read when available. |

These are calendar events, not recorded meetings. Cross from one to the other
with `get_meeting_by_calendar_id`.

## Reading long content

`get_meeting`, `get_scratchpad_note`, and `resolve_share_link` return
character-bounded ranges, not whole documents.

- `view_content` / `view_transcript` each take `{ start_char, char_limit }`
  (default 12000 chars, server max 40000).
- `view_transcript` is **omitted unless you pass it.** Pass `view_transcript={}`
  and answer from the transcript whenever detail matters — the notes are an
  auto-generated summary that drops things; the transcript is verbatim.
- A truncated response appends a marker with the exact continuation offset.
  Pass that offset back as `start_char` to read the next range.
- The Flow Summary is always returned in full. Its next-steps section is where
  action items live.

`resolve_share_link` returns a transcript only when the caller owns the note or
was explicitly invited. Domain-wide or anyone-with-link access returns
`transcript=null` plus a `transcript_access` explanation.

## Pagination

The `search_*` and `list_*` tools page newest-first. When `has_more` is true,
call again with `cursor` set to the returned `next_cursor` verbatim. For
"all"/"every"/"ever" questions, keep paging until `has_more` is false. Paging
caps at 1000 results per query; `truncated=true` means matches exist beyond the
cap — narrow the query rather than reporting a total.

## Timestamps

Every timestamp in every response is UTC (ISO-8601, trailing `Z`). Convert to
the user's local time zone before presenting. Never show raw UTC.

## Overlap with other tools

`gog_calendar` reads the operator's Google Calendars directly and is the right
tool for general calendar work. Reach for the Wispr calendar tools when the
question is anchored to a recording — pairing an event with its captured
meeting, or resolving a link the user pasted.
