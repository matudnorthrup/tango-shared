# attachment_search, attachment_read, attachment_status, attachment_reprocess, attachment_update, attachment_enumerate

Use these tools when a user asks about images, screenshots, PDFs, CSVs, markdown files, or other documents they have uploaded to Tango.

Agents may also receive a `Relevant attachment directories` context block. That block is a compact index only: use it to identify likely attachments and source refs, then call these tools when the user needs exact text, quotes, tables, or more detail.

Default behavior:
- Do not ask the user to resend an upload until `attachment_search`/`attachment_status` cannot find it or it is not processed yet.
- Prefer compact summaries, snippets, chunks, and tables over full extracted text.
- Cite returned source refs for exact claims and quotes.
- Do not expose absolute local source-file paths.

## `attachment_search`

Find processed attachments without loading full extracted text.

Use it when:
- The user refers to an uploaded file without giving an exact attachment id.
- You need to find prior images/documents by topic, filename, type, project, channel, or session.
- You need a compact list of summaries, snippets, statuses, and source refs.
- Directory context mentions a likely attachment but you need to confirm its current status or locate related attachments.

Important parameters:
- `query`: optional search text. Empty query returns recent matching attachments.
- `types`: optional filters such as `image`, `ocr_text`, `text/markdown`, `pdf`.
- `project_id`, `agent_id`, `session_id`, `channel_id`, `thread_id`, `user_id`: optional scope filters.
- `limit`: default 8, max 25.

## `attachment_read`

Read a bounded part of one attachment.

Use it when:
- `attachment_search` found a likely match and you need a summary, snippets, chunks, tables, or exact extracted text.
- The user asks for a quote or specific detail from a known attachment.
- You need source refs for a claim.
- Directory context contains `available_reads` and you need one of those bounded views.

Modes:
- `summary`: default compact view.
- `directory`: full compact directory payload.
- `snippets` or `quotes`: source-linked key text.
- `chunks`: bounded chunks, optionally filtered by `query`.
- `chunk`: one chunk by `chunk_id` or `chunk_ordinal`.
- `tables`: detected table previews.
- `visual_notes`: OCR/image processing notes.
- `source_file`: source metadata and refs without exposing absolute file paths.
- `extracted_text`: bounded extracted text. Use `offset` and `max_chars`; default max is 4000, hard max is 12000.

Do not request `extracted_text` first for large documents. Start with `summary`, `snippets`, or `chunks`.

For exact quotes, prefer `snippets`, `quotes`, `chunk`, or filtered `chunks` and include the returned text/source ref in the answer. For long documents, use `offset` and `max_chars` instead of asking for all extracted text.

## `attachment_status`

Check processing state.

Use it when:
- The user asks whether an upload is ready.
- An attachment search/read does not find expected data.
- You need to distinguish pending, partial, failed, and ready attachments.

Status guidance:
- `ready`: directory and retrieval views should be usable.
- `partial`: some text/directory data may exist; answer with caveats and retrieve the available bounded views.
- `processing`, `received`, or pending jobs: tell the user it is still processing and check again later only if a follow-up mechanism is available.
- `failed`: say processing failed and use any returned error/status details. Do not invent OCR or missing text.
- `retired`: source or derived data may no longer be available under retention rules.

## `attachment_reprocess`

This write/admin tool is intentionally not in the default agent allowlists. Use only when explicitly enabled and the user/admin wants to retry or upgrade processing.

Batch form: `ids` - optional array of attachment ids or `attachment:<id>` refs (max 25 raw entries), a batch alternative to `id`/`attachment_id`. The same `strategy`, `reason`, and `context_hint` apply to every id in the batch. An array longer than 25 is refused before any id is processed, naming the raw submitted length, not the deduped count: `attachment_reprocess accepts at most 25 ids per call (received N)`.

Optional `context_hint`: operator context (a venue name, project name, or correction) fed into the directory builder's summary AND tags when `strategy=directory`. Max 500 characters; over the cap the call is refused rather than silently truncated, with this exact message: `attachment_reprocess context_hint must be 500 characters or fewer (received N)` (N is the trimmed hint's length). A hint is recorded verbatim in the resulting directory payload as `context_hint`, alongside `hint_guided: true`, so a human-guided description stays permanently distinguishable from unguided machine output. A non-blank `context_hint` on any strategy other than `directory` (including the omitted-strategy default, `classify`) is refused, never silently dropped, with this exact message: `attachment_reprocess context_hint applies only to strategy=directory (received strategy: X)` (X is the effective strategy). Absent or blank `context_hint` produces output byte-identical to before this field existed. If a directory job is already pending or running for the attachment, the call returns `queued: false` with the `existing_job` it found instead of enqueuing a new one, and any `context_hint` given on that call does not apply; resubmit after the in-flight job completes if the hint still matters.

## `attachment_update`

Edits `attachments.title` and `attachments.project_id` only (v0: real columns, no schema change). This write/admin tool is intentionally not in the default agent allowlists.

As shipped in the T-I-125 phase-1 build, this tool is also UNGRANTED in the governance catalog: the migration that registers its tool id inserts no permission rows, so it is not usable by any agent or worker until an operator grants it through their install's own grant mechanism. Seeing the tool id in a catalog/manual is not the same as being permitted to call it: a tool id can exist in the catalog while holding zero grants — that means "not armed yet," not "does not exist."

Fields:
- `id` or `attachment_id`: the attachment to update.
- `ids`: optional array of attachment ids/`attachment:<id>` refs (max 25 raw entries), a batch alternative to `id`/`attachment_id`. The same `title`/`project` apply to every id. Over-cap is refused before any id is processed, naming the raw submitted length: `attachment_update accepts at most 25 ids per call (received N)`.
- `title`: optional new title.
- `project`: optional new project id.

At least one of `title`/`project` is required. A call with neither is refused, never treated as a silent no-op: `attachment_update requires title and/or project`.

Any field outside `id`, `attachment_id`, `ids`, `title`, `project` is refused, never silently dropped, with this exact message: `attachment_update v0 edits title and project only; description/tags/roles are gated on the upstream design conversation (T-I-125)`. Description, tags, and lifecycle role edits are not available in phase 1; they wait on that upstream design conversation. Description and tags remain machine-generated in phase 1; `attachment_reprocess`'s `context_hint` (documented above) influences what the machine writes.

## `attachment_enumerate`

Exhaustive listing over the attachment library (Folio), the sibling to `attachment_search`: completeness-first, unlike `attachment_search`'s relevance ranking, returning the full matching set (e.g. every PDF, every image tagged a given label) with an exact total.

Read-only, but as shipped in the T-I-125 phase-1 build it is UNGRANTED in the governance catalog for the same reason as `attachment_update` above: the migration registers the tool id, no permission rows are inserted, and it is not usable until an operator grants it. Read-only does not mean pre-armed.

Fields:
- `mode`: required - `list_projects`, `list_tags`, or `by_label`.
- `list_projects`: returns every distinct `project_id` with its attachment count. No other fields needed.
- `list_tags`: returns every distinct tag, matched case-insensitively, with its count, drawn from each attachment's LATEST directory row only (earlier directory versions are not counted). Optional `project_id` narrows to one project.
- `by_label`: returns every attachment matching `tag` and/or `project_id` (`attachment_id`, `title`, `content_type`, `created_at`), with an exact `total` count that holds across pages, plus the current page's `items`. Fields: `tag` (case-insensitive exact match against the latest directory row's tags, not a substring match), `project_id`, `limit` (default 50, max 200), `offset` (default 0). At least one of `tag`/`project_id` is required - a call with neither is refused: `attachment_enumerate mode=by_label requires tag and/or project_id`.

Calling without `mode`, or with an unrecognized `mode`, is refused: `attachment_enumerate requires mode: list_projects, list_tags, or by_label`.

Empty results are honest: an unmatched tag or project returns `total: 0` and an empty list, never an error.
