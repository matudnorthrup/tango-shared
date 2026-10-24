import type { AgentTool } from "@tango/core";
import {
  AttachmentStore,
  TangoStorage,
  normalizeComparable,
  resolveDatabasePath,
  type AttachmentChunkRecord,
  type AttachmentDirectoryRecord,
  type AttachmentExtractionRecord,
  type AttachmentJobKind,
  type AttachmentRecord,
} from "@tango/core";

export interface AttachmentToolOptions {
  storage?: TangoStorage;
  store?: AttachmentStore;
  dbPath?: string;
}

interface AttachmentToolContext {
  storage: TangoStorage | null;
  store: AttachmentStore;
}

interface DirectoryPayload {
  schema?: unknown;
  schema_version?: unknown;
  title?: unknown;
  status?: unknown;
  summary?: unknown;
  types?: unknown;
  tags?: unknown;
  source?: unknown;
  source_refs?: unknown;
  extraction?: unknown;
  snippets?: unknown;
  key_facts?: unknown;
  notable_quotes?: unknown;
  tables?: unknown;
  visual_notes?: unknown;
  available_reads?: unknown;
  chunks?: unknown;
  warnings?: unknown;
  content_profile?: unknown;
}

const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 25;
const DEFAULT_STATUS_LIMIT = 20;
const MAX_STATUS_LIMIT = 100;
const DEFAULT_READ_LIMIT = 5;
const MAX_READ_LIMIT = 20;
const DEFAULT_TEXT_CHARS = 4_000;
const MAX_TEXT_CHARS = 12_000;
// T-I-125 Phase 1 — attachment_reprocess context_hint + batch ids, and
// attachment_update's batch ids. Same cap for both; not exported (no other
// caller needs it yet, unlike the DEFAULT_TEXT_CHARS-class constants above).
const MAX_CONTEXT_HINT_CHARS = 500;
const MAX_REPROCESS_BATCH_IDS = 25;
const MAX_UPDATE_BATCH_IDS = 25;
const DEFAULT_LABEL_PAGE_LIMIT = 50;
const MAX_LABEL_PAGE_LIMIT = 200;
// attachment_update v0 (T-I-125 Phase 1): real columns only. Any other key —
// including description/tags/role, the fields the owner's storage-schema answer
// gates — is refused in-band with this exact message, never silently
// dropped. Keep this string and ATTACHMENT_UPDATE_ALLOWED_KEYS in sync.
const ATTACHMENT_UPDATE_ALLOWED_KEYS = new Set(["id", "attachment_id", "ids", "title", "project"]);
const ATTACHMENT_UPDATE_GATED_MESSAGE =
  "attachment_update v0 edits title and project only; description/tags/roles are gated on the upstream design conversation (T-I-125)";
const DEFAULT_SNIPPET_CHARS = 600;
const MAX_SNIPPET_CHARS = 1_500;

export function createAttachmentTools(options: AttachmentToolOptions = {}): AgentTool[] {
  const context = createAttachmentToolContext(options);

  return [
    {
      name: "attachment_search",
      description: [
        "Search processed Tango attachments using compact directory records and chunks.",
        "Use this when the user asks about an uploaded image, document, screenshot, PDF, CSV, or prior attachment.",
        "Returns bounded summaries, snippets, statuses, and source refs. It does not return full documents.",
        "",
        "Fields:",
        "  query - optional search text. Empty query returns recent matching attachments.",
        "  limit - max results (default 8, hard max 25).",
        "  types - optional MIME/normalized type filters, e.g. image, ocr_text, text/markdown.",
        "  project_id, agent_id, session_id, channel_id, thread_id, user_id - optional scope filters.",
        "  status - optional attachment status filter: received, processing, partial, ready, failed, retired.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query; optional for recent attachments" },
          limit: { type: "number", description: "Maximum results, default 8, max 25" },
          types: {
            type: "array",
            items: { type: "string" },
            description: "Optional type filters such as image, ocr_text, text/markdown",
          },
          project_id: { type: "string" },
          agent_id: { type: "string" },
          session_id: { type: "string" },
          channel_id: { type: "string" },
          thread_id: { type: "string" },
          user_id: { type: "string" },
          status: {
            type: "string",
            enum: ["received", "processing", "partial", "ready", "failed", "retired"],
          },
        },
      },
      handler: async (input) => attachmentSearch(context.store, input),
    },
    {
      name: "attachment_read",
      description: [
        "Read a bounded portion of a processed attachment by attachment id or source ref.",
        "Prefer summary/directory/snippets first; use chunks or extracted_text only when the user needs exact text.",
        "Every exact text response includes source refs. Long extracted text is truncated by default.",
        "",
        "Fields:",
        "  id or attachment_id - attachment id, numeric string, or attachment:<id> ref.",
        "  mode - summary, directory, snippets, chunks, chunk, quotes, tables, visual_notes, source_file, extracted_text.",
        "  query - optional filter for chunks/snippets.",
        "  chunk_id or chunk_ordinal - for mode=chunk.",
        "  offset, max_chars - for mode=extracted_text. Default max_chars 4000, hard max 12000.",
        "  limit - item limit for chunks/snippets/tables, default 5, max 20.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Attachment id or attachment:<id> ref" },
          attachment_id: { type: "number", description: "Attachment id" },
          mode: {
            type: "string",
            enum: [
              "summary",
              "directory",
              "snippets",
              "chunks",
              "chunk",
              "quotes",
              "tables",
              "visual_notes",
              "source_file",
              "extracted_text",
            ],
          },
          query: { type: "string" },
          chunk_id: { type: "number" },
          chunk_ordinal: { type: "number" },
          offset: { type: "number" },
          max_chars: { type: "number" },
          limit: { type: "number" },
        },
      },
      handler: async (input) => attachmentRead(context.store, input),
    },
    {
      name: "attachment_status",
      description: [
        "Report attachment processing status in a scope.",
        "Use this when a user asks whether attachments/images/documents are ready, failed, pending, or available.",
        "",
        "Fields:",
        "  project_id, agent_id, session_id, channel_id, thread_id, user_id - optional scope filters.",
        "  status - optional attachment status filter.",
        "  limit - recent attachment rows to include, default 20, max 100.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          agent_id: { type: "string" },
          session_id: { type: "string" },
          channel_id: { type: "string" },
          thread_id: { type: "string" },
          user_id: { type: "string" },
          status: {
            type: "string",
            enum: ["received", "processing", "partial", "ready", "failed", "retired"],
          },
          limit: { type: "number", description: "Recent rows to include, default 20, max 100" },
        },
      },
      handler: async (input) => attachmentStatus(context.store, input),
    },
    {
      name: "attachment_reprocess",
      description: [
        "Queue reprocessing for an attachment. This is a write/admin tool and is not in default agent allowlists.",
        "Use only after user/admin intent is explicit or when a processing strategy needs to be retried.",
        "",
        "Fields:",
        "  id or attachment_id - attachment id, numeric string, or attachment:<id> ref.",
        "  ids - optional array of attachment ids/attachment:<id> refs (max 25); batch alternative to id/attachment_id.",
        "        The same strategy, reason, and context_hint apply to every id in the batch.",
        "  strategy - classify, embedded_text, apple_ocr, chunk, directory, llm_fallback, retention_review.",
        "  reason - optional audit reason.",
        "  context_hint - optional operator context (max 500 chars, e.g. a venue or project name) fed into the",
        "                 directory builder's summary AND tags when strategy=directory. Recorded verbatim in the",
        "                 resulting directory payload (context_hint + hint_guided: true) so the human-guided",
        "                 description stays distinguishable from unguided machine output. Refused (not silently",
        "                 dropped) on any effective strategy other than directory, including the omitted-strategy",
        "                 default (classify).",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          attachment_id: { type: "number" },
          ids: {
            type: "array",
            items: { type: ["string", "number"] },
            description: "Attachment ids or attachment:<id> refs, max 25, batch alternative to id/attachment_id",
          },
          strategy: {
            type: "string",
            enum: [
              "classify",
              "embedded_text",
              "apple_ocr",
              "chunk",
              "directory",
              "llm_fallback",
              "retention_review",
            ],
          },
          reason: { type: "string" },
          context_hint: {
            type: "string",
            description: "Operator context fed into the directory builder (max 500 chars); see attachment-reprocess.md",
          },
        },
      },
      handler: async (input) => attachmentReprocess(context.store, input),
    },
    {
      name: "attachment_update",
      description: [
        "Update operator-editable fields on an attachment: title and project only (v0, real columns, no schema change).",
        "This is a write/admin tool and is not in default agent allowlists.",
        "Use this to correct a filename-derived title, or to file/re-file an attachment into a project after upload",
        "(the late-arrival case: 'connect this to the right project').",
        "",
        "Fields:",
        "  id or attachment_id - attachment id, numeric string, or attachment:<id> ref.",
        "  ids - optional array of attachment ids/attachment:<id> refs (max 25); batch alternative to id/attachment_id.",
        "        The same title/project apply to every id in the batch.",
        "  title - optional new title (sets attachments.title).",
        "  project - optional new project id (sets attachments.project_id). Use attachment_enumerate mode=list_projects",
        "            to see existing projects before minting a new one (avoids near-duplicate project names).",
        "",
        "v0 scope is intentionally narrow: description, tags, and lifecycle role are NOT accepted here and are",
        "refused in-band, never silently dropped — they are gated on the upstream storage-schema design conversation",
        "(T-I-125). Use attachment_reprocess's context_hint for description/tag repair in the meantime.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          attachment_id: { type: "number" },
          ids: {
            type: "array",
            items: { type: ["string", "number"] },
            description: "Attachment ids or attachment:<id> refs, max 25, batch alternative to id/attachment_id",
          },
          title: { type: "string" },
          project: { type: "string" },
        },
        additionalProperties: false,
      },
      handler: async (input) => attachmentUpdate(context.store, input),
    },
    {
      name: "attachment_enumerate",
      description: [
        "Enumerate Folio attachments by label — EXHAUSTIVE listing, never ranked/similarity search.",
        "Use this when the ask is completeness ('every PDF, every image tagged X'), not relevance ('find something about X');",
        "for relevance use attachment_search instead.",
        "",
        "Fields:",
        "  mode - required: list_projects, list_tags, or by_label.",
        "  list_projects - returns every distinct project_id with its attachment count. No other fields needed.",
        "  list_tags - returns every distinct tag (case-insensitive, from each attachment's LATEST directory row)",
        "              with its count. Optional project_id narrows to one project.",
        "  by_label - returns ALL attachments matching tag and/or project_id (id, title, content_type, created_at),",
        "             with an exact `total` count that holds across pages. Fields: tag (case-insensitive exact",
        "             match), project_id, limit (default 50, max 200), offset (default 0). At least one of",
        "             tag/project_id is required.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["list_projects", "list_tags", "by_label"] },
          tag: { type: "string" },
          project_id: { type: "string" },
          limit: { type: "number", description: "by_label page size, default 50, max 200" },
          offset: { type: "number", description: "by_label page offset, default 0" },
        },
        required: ["mode"],
      },
      handler: async (input) => attachmentEnumerate(context.store, input),
    },
  ];
}

function createAttachmentToolContext(options: AttachmentToolOptions): AttachmentToolContext {
  if (options.store) {
    return { storage: options.storage ?? null, store: options.store };
  }
  const storage = options.storage ?? new TangoStorage(resolveDatabasePath(options.dbPath));
  return {
    storage,
    store: new AttachmentStore(storage.getDatabase()),
  };
}

function attachmentSearch(store: AttachmentStore, input: Record<string, unknown>) {
  const query = normalizeOptionalString(input.query);
  const terms = tokenizeQuery(query);
  const limit = clampLimit(input.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const typeFilters = normalizeStringArray(input.types).map((value) => value.toLowerCase());
  const attachments = store.listAttachments({
    projectId: normalizeScopeFilter(input.project_id),
    agentId: normalizeScopeFilter(input.agent_id),
    sessionId: normalizeScopeFilter(input.session_id),
    channelId: normalizeScopeFilter(input.channel_id),
    threadId: normalizeScopeFilter(input.thread_id),
    userId: normalizeScopeFilter(input.user_id),
    status: normalizeAttachmentStatus(input.status),
    limit: Math.max(250, limit * 20),
  });

  const results = attachments
    .map((attachment) => buildSearchCandidate(store, attachment, terms, typeFilters))
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((left, right) => right.score - left.score || right.attachment_id - left.attachment_id)
    .slice(0, limit);

  return {
    query: query ?? "",
    result_count: results.length,
    results,
  };
}

function attachmentRead(store: AttachmentStore, input: Record<string, unknown>) {
  const attachmentId = resolveAttachmentId(input);
  if (attachmentId === null) {
    return { error: "attachment_read requires id or attachment_id" };
  }

  const attachment = store.getAttachment(attachmentId);
  if (!attachment) {
    return { error: `Attachment ${attachmentId} not found` };
  }

  const directoryRecord = latestDirectory(store, attachment.id);
  const directory = asDirectoryPayload(directoryRecord?.directory);
  const chunks = store.listChunks(attachment.id);
  const extraction = latestExtraction(store, attachment.id);
  const mode = normalizeReadMode(input.mode);

  switch (mode) {
    case "summary":
      return {
        attachment: summarizeAttachment(attachment, directoryRecord, directory),
        summary: stringValue(directory?.summary),
        snippets: limitArray(asArray(directory?.snippets), DEFAULT_READ_LIMIT),
        available_reads: asArray(directory?.available_reads),
        source: directory?.source ?? buildFallbackSource(attachment),
        extraction: directory?.extraction ?? summarizeExtraction(extraction, chunks.length),
      };
    case "directory":
      return {
        attachment: summarizeAttachment(attachment, directoryRecord, directory),
        directory,
        truncated: false,
      };
    case "snippets":
    case "quotes":
      return readDirectoryEntries(directory, mode, input);
    case "tables":
      return {
        attachment: summarizeAttachment(attachment, directoryRecord, directory),
        mode,
        tables: limitArray(asArray(directory?.tables), clampLimit(input.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT)),
      };
    case "visual_notes":
      return {
        attachment: summarizeAttachment(attachment, directoryRecord, directory),
        mode,
        visual_notes: limitArray(
          asArray(directory?.visual_notes),
          clampLimit(input.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT),
        ),
      };
    case "source_file":
      return {
        attachment: summarizeAttachment(attachment, directoryRecord, directory),
        mode,
        source: directory?.source ?? buildFallbackSource(attachment),
        note: "Source file paths are not exposed through this tool; use source refs with attachment_read/search.",
      };
    case "chunks":
      return readChunks(attachment, chunks, extraction, input);
    case "chunk":
      return readSingleChunk(attachment, chunks, extraction, input);
    case "extracted_text":
      return readExtractedText(attachment, extraction, input);
  }
}

function attachmentStatus(store: AttachmentStore, input: Record<string, unknown>) {
  const limit = clampLimit(input.limit, DEFAULT_STATUS_LIMIT, MAX_STATUS_LIMIT);
  const attachments = store.listAttachments({
    projectId: normalizeScopeFilter(input.project_id),
    agentId: normalizeScopeFilter(input.agent_id),
    sessionId: normalizeScopeFilter(input.session_id),
    channelId: normalizeScopeFilter(input.channel_id),
    threadId: normalizeScopeFilter(input.thread_id),
    userId: normalizeScopeFilter(input.user_id),
    status: normalizeAttachmentStatus(input.status),
    limit,
  });
  const counts = {
    total: attachments.length,
    received: 0,
    processing: 0,
    partial: 0,
    ready: 0,
    failed: 0,
    retired: 0,
  };

  const recent = attachments.map((attachment) => {
    counts[attachment.status] += 1;
    const directoryRecord = latestDirectory(store, attachment.id);
    const directory = asDirectoryPayload(directoryRecord?.directory);
    const jobs = store.getJobStatusSummary(attachment.id);
    return {
      attachment_id: attachment.id,
      title: titleForAttachment(attachment, directory),
      status: attachment.status,
      directory_status: directoryRecord?.status ?? null,
      content_type: attachment.contentType,
      bytes: attachment.bytes,
      source: directory?.source ?? buildFallbackSource(attachment),
      job_summary: jobs,
      updated_at: attachment.updatedAt,
      created_at: attachment.createdAt,
    };
  });

  return {
    counts,
    recent,
  };
}

function attachmentReprocess(store: AttachmentStore, input: Record<string, unknown>) {
  const hint = normalizeContextHint(input.context_hint);
  if (hint.error) {
    return { error: hint.error };
  }

  const strategy = normalizeJobKind(input.strategy) ?? "classify";

  // Fleet review consistency fix (T-I-125) — context_hint only threads
  // forward on strategy=directory (see reprocessOneAttachment and
  // agents/tools/attachments.md). Every other strategy used to accept the
  // field and silently drop it, which contradicted attachment_update's own
  // "never silently dropped" stance on fields it can't honor. Refuse instead
  // of accepting-and-discarding. Default strategy is "classify", so an
  // omitted strategy with a hint is refused too — only a blank/whitespace
  // hint (normalizes to null) is exempt, matching "blank = absent".
  if (hint.value !== null && strategy !== "directory") {
    return {
      error: `attachment_reprocess context_hint applies only to strategy=directory (received strategy: ${strategy})`,
    };
  }

  // Codex round-1 MEDIUM fix: cap the RAW submitted array before any
  // normalization runs — dedupe/discard previously let an arbitrarily large
  // array (duplicates, junk entries) through the post-normalize check and
  // left the normalization loop itself unbounded.
  if (Array.isArray(input.ids) && input.ids.length > MAX_REPROCESS_BATCH_IDS) {
    return {
      error: `attachment_reprocess accepts at most ${MAX_REPROCESS_BATCH_IDS} ids per call (received ${input.ids.length})`,
    };
  }
  const idsInput = normalizeIdRefsArray(input.ids);

  const reason = normalizeOptionalString(input.reason);

  if (idsInput.length > 0) {
    const results = idsInput.map((attachmentId) =>
      reprocessOneAttachment(store, attachmentId, strategy, reason, hint.value),
    );
    return {
      batch: true,
      context_hint: hint.value,
      count: results.length,
      results,
    };
  }

  // Single-id path — no `ids` given. Kept byte-identical to pre-T-I-125
  // behavior when context_hint is also absent (hard bar, see spec Gate 2).
  const attachmentId = resolveAttachmentId(input);
  if (attachmentId === null) {
    return { error: "attachment_reprocess requires id or attachment_id" };
  }
  return reprocessOneAttachment(store, attachmentId, strategy, reason, hint.value);
}

function reprocessOneAttachment(
  store: AttachmentStore,
  attachmentId: number,
  strategy: AttachmentJobKind,
  reason: string | null,
  contextHint: string | null,
): Record<string, unknown> {
  const attachment = store.getAttachment(attachmentId);
  if (!attachment) {
    return { error: `Attachment ${attachmentId} not found` };
  }

  const existing = store
    .listJobs({ attachmentId, kind: strategy, limit: 25 })
    .find((job) => job.status === "pending" || job.status === "running");
  if (existing) {
    return {
      attachment_id: attachmentId,
      queued: false,
      existing_job: {
        job_id: existing.id,
        kind: existing.kind,
        status: existing.status,
        run_after: existing.runAfter,
      },
    };
  }

  const job = store.enqueueJob({
    attachmentId,
    kind: strategy,
    metadata: {
      queuedBy: "attachment_reprocess_tool",
      reason,
      // Only present when a hint was given — keeps job metadata shape
      // identical to pre-T-I-125 output on the default (no-hint) path.
      ...(contextHint ? { contextHint } : {}),
    },
  });
  store.updateAttachmentStatus(attachmentId, "processing");

  return {
    attachment_id: attachmentId,
    queued: true,
    job: {
      job_id: job.id,
      kind: job.kind,
      status: job.status,
      run_after: job.runAfter,
    },
  };
}

function attachmentUpdate(store: AttachmentStore, input: Record<string, unknown>) {
  const unknownKeys = Object.keys(input).filter((key) => !ATTACHMENT_UPDATE_ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return { error: ATTACHMENT_UPDATE_GATED_MESSAGE };
  }

  const hasTitle = Object.prototype.hasOwnProperty.call(input, "title");
  const hasProject = Object.prototype.hasOwnProperty.call(input, "project");
  if (!hasTitle && !hasProject) {
    return { error: "attachment_update requires title and/or project" };
  }

  if (hasTitle && input.title !== null && typeof input.title !== "string") {
    return { error: "attachment_update title must be a string" };
  }
  if (hasProject && input.project !== null && typeof input.project !== "string") {
    return { error: "attachment_update project must be a string" };
  }

  // A trim-to-empty (whitespace-only) value means "no value" — coerce it to
  // null rather than writing/displaying an empty-string title or project.
  const fields: { title?: string | null; projectId?: string | null } = {};
  if (hasTitle) {
    const trimmedTitle = typeof input.title === "string" ? input.title.trim() : null;
    fields.title = trimmedTitle || null;
  }
  if (hasProject) {
    const trimmedProject = typeof input.project === "string" ? input.project.trim() : null;
    fields.projectId = trimmedProject || null;
  }

  // Codex round-1 MEDIUM fix: raw-array cap before normalization (see
  // attachmentReprocess for the class rationale — same defect, same fix).
  if (Array.isArray(input.ids) && input.ids.length > MAX_UPDATE_BATCH_IDS) {
    return {
      error: `attachment_update accepts at most ${MAX_UPDATE_BATCH_IDS} ids per call (received ${input.ids.length})`,
    };
  }
  const idsInput = normalizeIdRefsArray(input.ids);

  const ids = idsInput.length > 0 ? idsInput : resolveIdAsArray(input);
  if (ids.length === 0) {
    return { error: "attachment_update requires id, attachment_id, or ids" };
  }

  const results = ids.map((attachmentId) => updateOneAttachment(store, attachmentId, fields));

  if (idsInput.length > 0) {
    return { batch: true, count: results.length, results };
  }
  return results[0];
}

function updateOneAttachment(
  store: AttachmentStore,
  attachmentId: number,
  fields: { title?: string | null; projectId?: string | null },
): Record<string, unknown> {
  const attachment = store.getAttachment(attachmentId);
  if (!attachment) {
    return { attachment_id: attachmentId, error: `Attachment ${attachmentId} not found` };
  }
  const updated = store.updateAttachmentOperatorFields(attachmentId, fields);
  return {
    attachment_id: attachmentId,
    updated: true,
    title: updated?.title ?? null,
    project_id: updated?.projectId ?? null,
  };
}

function attachmentEnumerate(store: AttachmentStore, input: Record<string, unknown>) {
  const mode = normalizeOptionalString(input.mode);
  switch (mode) {
    case "list_projects":
      return attachmentEnumerateListProjects(store);
    case "list_tags":
      return attachmentEnumerateListTags(store, input);
    case "by_label":
      return attachmentEnumerateByLabel(store, input);
    default:
      return { error: "attachment_enumerate requires mode: list_projects, list_tags, or by_label" };
  }
}

function attachmentEnumerateListProjects(store: AttachmentStore) {
  const attachments = store.listAllAttachments({});
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    if (!attachment.projectId) continue;
    counts.set(attachment.projectId, (counts.get(attachment.projectId) ?? 0) + 1);
  }
  const projects = [...counts.entries()]
    .map(([projectId, count]) => ({ project_id: projectId, count }))
    .sort((left, right) => left.project_id.localeCompare(right.project_id));

  return {
    mode: "list_projects",
    total: projects.length,
    projects,
  };
}

function attachmentEnumerateListTags(store: AttachmentStore, input: Record<string, unknown>) {
  const projectId = normalizeScopeFilter(input.project_id);
  const attachments = store.listAllAttachments({ projectId });
  const counts = new Map<string, { tag: string; count: number }>();
  for (const attachment of attachments) {
    const tags = latestDirectoryTags(store, attachment.id);
    for (const tag of tags) {
      const key = tag.toLowerCase();
      const entry = counts.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        counts.set(key, { tag, count: 1 });
      }
    }
  }
  const tags = [...counts.values()].sort((left, right) => left.tag.localeCompare(right.tag));

  return {
    mode: "list_tags",
    project_id: projectId ?? null,
    total: tags.length,
    tags,
  };
}

function attachmentEnumerateByLabel(store: AttachmentStore, input: Record<string, unknown>) {
  const tag = normalizeOptionalString(input.tag);
  const projectId = normalizeScopeFilter(input.project_id);
  if (!tag && !projectId) {
    return { error: "attachment_enumerate mode=by_label requires tag and/or project_id" };
  }

  const limit = clampLimit(input.limit, DEFAULT_LABEL_PAGE_LIMIT, MAX_LABEL_PAGE_LIMIT);
  const offset = Math.max(0, normalizeInteger(input.offset) ?? 0);
  // Stored hint-derived tags are whitespace-collapsed via normalizeComparable
  // at directory-build time (see buildDirectoryTags in attachment-directory.ts).
  // Normalize the query the same way, or a tag with doubled internal spaces
  // could never match its own stored form.
  const tagLower = tag ? normalizeComparable(tag) : null;

  const attachments = store.listAllAttachments({ projectId });
  const matches = attachments.filter((attachment) => {
    if (!tagLower) return true;
    const tags = latestDirectoryTags(store, attachment.id).map((value) => normalizeComparable(value));
    return tags.includes(tagLower);
  });

  const total = matches.length;
  const page = matches.slice(offset, offset + limit).map((attachment) => {
    const directory = asDirectoryPayload(latestDirectory(store, attachment.id)?.directory);
    return {
      attachment_id: attachment.id,
      title: titleForAttachment(attachment, directory),
      content_type: attachment.contentType,
      created_at: attachment.createdAt,
    };
  });

  return {
    mode: "by_label",
    tag: tag ?? null,
    project_id: projectId ?? null,
    total,
    limit,
    offset,
    result_count: page.length,
    items: page,
  };
}

function latestDirectoryTags(store: AttachmentStore, attachmentId: number): string[] {
  const directory = asDirectoryPayload(latestDirectory(store, attachmentId)?.directory);
  return asStringArray(directory?.tags);
}

function buildSearchCandidate(
  store: AttachmentStore,
  attachment: AttachmentRecord,
  terms: string[],
  typeFilters: string[],
) {
  const directoryRecord = latestDirectory(store, attachment.id);
  const directory = asDirectoryPayload(directoryRecord?.directory);
  if (typeFilters.length > 0 && !matchesTypeFilters(attachment, directory, typeFilters)) {
    return null;
  }

  const chunks = store.listChunks(attachment.id);
  const matchingChunks = buildMatchingChunks(chunks, terms, 3);
  const searchText = buildSearchText(attachment, directory, matchingChunks);
  const score = scoreSearchText(searchText, terms);
  if (terms.length > 0 && score <= 0 && matchingChunks.length === 0) {
    return null;
  }

  return {
    attachment_id: attachment.id,
    title: titleForAttachment(attachment, directory),
    status: attachment.status,
    directory_status: directoryRecord?.status ?? null,
    content_type: attachment.contentType,
    bytes: attachment.bytes,
    types: asStringArray(directory?.types),
    tags: asStringArray(directory?.tags),
    summary: stringValue(directory?.summary),
    snippets: limitArray(asArray(directory?.snippets), 3),
    matching_chunks: matchingChunks,
    available_reads: asArray(directory?.available_reads),
    source: directory?.source ?? buildFallbackSource(attachment),
    extraction: directory?.extraction ?? null,
    score,
    updated_at: attachment.updatedAt,
  };
}

function readDirectoryEntries(
  directory: DirectoryPayload | null,
  mode: "snippets" | "quotes",
  input: Record<string, unknown>,
) {
  const query = normalizeOptionalString(input.query);
  const terms = tokenizeQuery(query);
  const limit = clampLimit(input.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
  const sourceItems =
    mode === "snippets"
      ? asArray(directory?.snippets)
      : [
          ...asArray(directory?.notable_quotes),
          ...asArray(directory?.key_facts),
          ...asArray(directory?.snippets),
        ];
  const items = sourceItems
    .filter((item) => terms.length === 0 || scoreSearchText(JSON.stringify(item), terms) > 0)
    .slice(0, limit);

  return {
    mode,
    result_count: items.length,
    items,
  };
}

function readChunks(
  attachment: AttachmentRecord,
  chunks: AttachmentChunkRecord[],
  extraction: AttachmentExtractionRecord | null,
  input: Record<string, unknown>,
) {
  const query = normalizeOptionalString(input.query);
  const terms = tokenizeQuery(query);
  const limit = clampLimit(input.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
  const maxChars = clampLimit(input.max_chars, DEFAULT_SNIPPET_CHARS, MAX_SNIPPET_CHARS);
  const selected = chunks
    .filter((chunk) => terms.length === 0 || scoreSearchText(chunk.text, terms) > 0)
    .slice(0, limit)
    .map((chunk) => chunkToOutput(chunk, extraction, maxChars));
  return {
    attachment_id: attachment.id,
    mode: "chunks",
    result_count: selected.length,
    chunks: selected,
  };
}

function readSingleChunk(
  attachment: AttachmentRecord,
  chunks: AttachmentChunkRecord[],
  extraction: AttachmentExtractionRecord | null,
  input: Record<string, unknown>,
) {
  const chunkId = normalizeInteger(input.chunk_id);
  const ordinal = normalizeInteger(input.chunk_ordinal);
  const chunk =
    typeof chunkId === "number"
      ? chunks.find((candidate) => candidate.id === chunkId)
      : typeof ordinal === "number"
        ? chunks.find((candidate) => candidate.ordinal === ordinal)
        : chunks[0];
  if (!chunk) {
    return { error: `No matching chunk found for attachment ${attachment.id}` };
  }
  return {
    attachment_id: attachment.id,
    mode: "chunk",
    chunk: chunkToOutput(chunk, extraction, clampLimit(input.max_chars, DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS)),
  };
}

function readExtractedText(
  attachment: AttachmentRecord,
  extraction: AttachmentExtractionRecord | null,
  input: Record<string, unknown>,
) {
  if (!extraction) {
    return { error: `Attachment ${attachment.id} has no extraction text yet` };
  }
  const offset = Math.max(0, normalizeInteger(input.offset) ?? 0);
  const maxChars = clampLimit(input.max_chars, DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS);
  const text = extraction.text.slice(offset, offset + maxChars);
  return {
    attachment_id: attachment.id,
    mode: "extracted_text",
    extraction_id: extraction.id,
    method: extraction.method,
    source_ref: `text:${extraction.id}:chars:${offset}-${offset + text.length}`,
    offset,
    max_chars: maxChars,
    text,
    truncated: offset + text.length < extraction.text.length,
    total_chars: extraction.text.length,
  };
}

function buildMatchingChunks(
  chunks: AttachmentChunkRecord[],
  terms: string[],
  limit: number,
): Array<Record<string, unknown>> {
  if (terms.length === 0) return [];
  return chunks
    .map((chunk) => ({
      chunk,
      score: scoreSearchText(chunk.text, terms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => ({
      chunk_id: entry.chunk.id,
      ordinal: entry.chunk.ordinal,
      source_ref: chunkTextRef(entry.chunk),
      chunk_ref: `chunk:${entry.chunk.id}`,
      snippet: extractQuerySnippet(entry.chunk.text, terms, DEFAULT_SNIPPET_CHARS),
      score: entry.score,
    }));
}

function chunkToOutput(
  chunk: AttachmentChunkRecord,
  extraction: AttachmentExtractionRecord | null,
  maxChars: number,
) {
  const text = chunk.text.slice(0, maxChars);
  return {
    chunk_id: chunk.id,
    ordinal: chunk.ordinal,
    token_estimate: chunk.tokenEstimate,
    source_ref: chunkTextRef(chunk, extraction),
    chunk_ref: `chunk:${chunk.id}`,
    char_start: metadataNumber(chunk.metadata, "charStart"),
    char_end: metadataNumber(chunk.metadata, "charEnd"),
    text,
    truncated: text.length < chunk.text.length,
  };
}

function latestDirectory(
  store: AttachmentStore,
  attachmentId: number,
): AttachmentDirectoryRecord | null {
  return store.listDirectories(attachmentId).at(-1) ?? null;
}

function latestExtraction(
  store: AttachmentStore,
  attachmentId: number,
): AttachmentExtractionRecord | null {
  return store.listExtractions(attachmentId).at(-1) ?? null;
}

function summarizeAttachment(
  attachment: AttachmentRecord,
  directoryRecord: AttachmentDirectoryRecord | null,
  directory: DirectoryPayload | null,
) {
  return {
    attachment_id: attachment.id,
    title: titleForAttachment(attachment, directory),
    status: attachment.status,
    directory_status: directoryRecord?.status ?? null,
    content_type: attachment.contentType,
    bytes: attachment.bytes,
    created_at: attachment.createdAt,
    updated_at: attachment.updatedAt,
  };
}

function summarizeExtraction(
  extraction: AttachmentExtractionRecord | null,
  chunkCount: number,
) {
  return extraction
    ? {
        extraction_id: extraction.id,
        method: extraction.method,
        confidence: extraction.confidence,
        chunk_count: chunkCount,
        source_ref: `extraction:${extraction.id}`,
      }
    : null;
}

function buildFallbackSource(attachment: AttachmentRecord) {
  return {
    attachment_id: attachment.id,
    attachment_ref: `attachment:${attachment.id}`,
    file_id: attachment.fileId,
    discord_attachment_id: attachment.discordAttachmentId,
    message_ref: buildMessageRef(attachment),
  };
}

function buildSearchText(
  attachment: AttachmentRecord,
  directory: DirectoryPayload | null,
  matchingChunks: Array<Record<string, unknown>>,
): string {
  return [
    attachment.title,
    attachment.originalFilename,
    attachment.contentType,
    directory?.title,
    directory?.summary,
    JSON.stringify(directory?.types ?? []),
    JSON.stringify(directory?.tags ?? []),
    JSON.stringify(directory?.snippets ?? []),
    JSON.stringify(directory?.key_facts ?? []),
    JSON.stringify(directory?.visual_notes ?? []),
    JSON.stringify(matchingChunks),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function scoreSearchText(text: string, terms: string[]): number {
  if (terms.length === 0) return 1;
  const normalized = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += term.length >= 5 ? 3 : 1;
  }
  return score;
}

function extractQuerySnippet(text: string, terms: string[], maxChars: number): string {
  const normalized = text.toLowerCase();
  const firstIndex = terms
    .map((term) => normalized.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, firstIndex - Math.floor(maxChars / 3));
  const snippet = text.slice(start, start + maxChars).replace(/\s+/gu, " ").trim();
  return start > 0 ? `...${snippet}` : snippet;
}

function chunkTextRef(
  chunk: AttachmentChunkRecord,
  extraction?: AttachmentExtractionRecord | null,
): string {
  const charStart = metadataNumber(chunk.metadata, "charStart");
  const charEnd = metadataNumber(chunk.metadata, "charEnd");
  if (typeof charStart === "number" && typeof charEnd === "number") {
    return `text:${extraction?.id ?? chunk.extractionId}:chars:${charStart}-${charEnd}`;
  }
  return `chunk:${chunk.id}`;
}

function matchesTypeFilters(
  attachment: AttachmentRecord,
  directory: DirectoryPayload | null,
  filters: string[],
): boolean {
  const candidates = new Set([
    attachment.contentType?.toLowerCase() ?? "",
    ...asStringArray(directory?.types).map((value) => value.toLowerCase()),
    ...asStringArray(directory?.tags).map((value) => value.toLowerCase()),
  ]);
  return filters.some((filter) => candidates.has(filter) || [...candidates].some((value) => value.includes(filter)));
}

function resolveAttachmentId(input: Record<string, unknown>): number | null {
  const direct = normalizeInteger(input.attachment_id);
  if (typeof direct === "number") return direct;
  const id = normalizeOptionalString(input.id);
  if (!id) return null;
  const match = /^attachment:(\d+)$/iu.exec(id) ?? /^(\d+)$/u.exec(id);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

// T-I-125 Phase 1 — shared by attachment_reprocess and attachment_update.
// Each array item may be a numeric id, a numeric string, or an
// "attachment:<id>" ref — the same shapes resolveAttachmentId accepts for a
// single id, applied per-item. Invalid/unparseable items are silently
// dropped (a malformed id inside an otherwise-valid batch does not abort the
// whole call); duplicates are deduped, order preserved.
function normalizeIdRefsArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of value) {
    let id: number | null = null;
    if (typeof item === "number") {
      id = normalizeInteger(item);
    } else if (typeof item === "string") {
      const match = /^attachment:(\d+)$/iu.exec(item) ?? /^(\d+)$/u.exec(item.trim());
      id = match ? Number.parseInt(match[1]!, 10) : null;
    }
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function resolveIdAsArray(input: Record<string, unknown>): number[] {
  const id = resolveAttachmentId(input);
  return id === null ? [] : [id];
}

// T-I-125 Phase 1 — attachment_reprocess's context_hint. Trims, caps at
// MAX_CONTEXT_HINT_CHARS, and refuses (rather than silently truncating) over
// the cap so the operator knows to shorten it. Absent/blank input yields
// `value: null` with no error — the default, hint-free path.
function normalizeContextHint(value: unknown): { value: string | null; error?: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") {
    return { value: null, error: "attachment_reprocess context_hint must be a string" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { value: null };
  if (trimmed.length > MAX_CONTEXT_HINT_CHARS) {
    return {
      value: null,
      error: `attachment_reprocess context_hint must be ${MAX_CONTEXT_HINT_CHARS} characters or fewer (received ${trimmed.length})`,
    };
  }
  return { value: trimmed };
}

function normalizeReadMode(value: unknown):
  | "summary"
  | "directory"
  | "snippets"
  | "chunks"
  | "chunk"
  | "quotes"
  | "tables"
  | "visual_notes"
  | "source_file"
  | "extracted_text" {
  const mode = normalizeOptionalString(value);
  switch (mode) {
    case "directory":
    case "snippets":
    case "chunks":
    case "chunk":
    case "quotes":
    case "tables":
    case "visual_notes":
    case "source_file":
    case "extracted_text":
      return mode;
    default:
      return "summary";
  }
}

function normalizeJobKind(value: unknown): AttachmentJobKind | null {
  const normalized = normalizeOptionalString(value);
  switch (normalized) {
    case "classify":
    case "embedded_text":
    case "apple_ocr":
    case "chunk":
    case "directory":
    case "llm_fallback":
    case "retention_review":
      return normalized;
    default:
      return null;
  }
}

function normalizeAttachmentStatus(value: unknown):
  | AttachmentRecord["status"]
  | undefined {
  const normalized = normalizeOptionalString(value);
  switch (normalized) {
    case "received":
    case "processing":
    case "partial":
    case "ready":
    case "failed":
    case "retired":
      return normalized;
    default:
      return undefined;
  }
}

function asDirectoryPayload(value: unknown): DirectoryPayload | null {
  return isRecord(value) ? value as DirectoryPayload : null;
}

function titleForAttachment(
  attachment: AttachmentRecord,
  directory: DirectoryPayload | null,
): string {
  const attachmentTitle = attachment.title && attachment.title.length > 0 ? attachment.title : null;
  return attachmentTitle
    ?? stringValue(directory?.title)
    ?? attachment.originalFilename
    ?? `Attachment ${attachment.id}`;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeScopeFilter(value: unknown): string | undefined {
  return normalizeOptionalString(value) ?? undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => Boolean(item));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function limitArray<T>(value: T[], limit: number): T[] {
  return value.slice(0, limit);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function clampLimit(value: unknown, defaultValue: number, maxValue: number): number {
  const integer = normalizeInteger(value);
  if (typeof integer !== "number" || integer <= 0) return defaultValue;
  return Math.min(integer, maxValue);
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function metadataNumber(metadata: Record<string, unknown> | null, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildMessageRef(attachment: AttachmentRecord): string | null {
  const messageId = metadataString(attachment.metadata, "discordMessageId") ?? attachment.messageId;
  if (!attachment.channelId && !messageId) return null;
  return [
    "discord",
    attachment.channelId ?? "unknown-channel",
    attachment.threadId ?? null,
    messageId ?? null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(":");
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function tokenizeQuery(query: string | null): string[] {
  if (!query) return [];
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9$%.:-]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
  )];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
