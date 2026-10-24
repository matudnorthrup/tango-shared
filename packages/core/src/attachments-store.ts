import type { DatabaseSync } from "node:sqlite";

export type AttachmentFileRole = "source" | "derived";
export type AttachmentFileStatus = "available" | "missing" | "failed" | "retired";
export type AttachmentStatus = "received" | "processing" | "partial" | "ready" | "failed" | "retired";
export type AttachmentJobKind =
  | "classify"
  | "embedded_text"
  | "apple_ocr"
  | "chunk"
  | "directory"
  | "llm_fallback"
  | "retention_review";
export type AttachmentJobStatus = "pending" | "running" | "succeeded" | "failed" | "canceled";
export type AttachmentDirectoryStatus = "building" | "ready" | "stale" | "failed" | "retired";
export type AttachmentRetentionDecision = "keep" | "delete" | "review" | "retire";
export type AttachmentRetentionStatus = "proposed" | "approved" | "applied" | "superseded" | "canceled";

export interface AttachmentFileRecord {
  id: number;
  role: AttachmentFileRole;
  sha256: string;
  bytes: number;
  contentType: string | null;
  originalFilename: string | null;
  storagePath: string;
  status: AttachmentFileStatus;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentFileUpsertInput {
  role?: AttachmentFileRole;
  sha256: string;
  bytes: number;
  contentType?: string | null;
  originalFilename?: string | null;
  storagePath: string;
  status?: AttachmentFileStatus;
  metadata?: Record<string, unknown> | null;
}

export interface AttachmentRecord {
  id: number;
  projectId: string | null;
  agentId: string | null;
  sessionId: string | null;
  messageId: string | null;
  channelId: string | null;
  threadId: string | null;
  userId: string | null;
  discordAttachmentId: string | null;
  fileId: number | null;
  title: string | null;
  originalFilename: string | null;
  contentType: string | null;
  bytes: number | null;
  status: AttachmentStatus;
  retentionPolicyId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentCreateInput {
  projectId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  userId?: string | null;
  discordAttachmentId?: string | null;
  fileId?: number | null;
  title?: string | null;
  originalFilename?: string | null;
  contentType?: string | null;
  bytes?: number | null;
  status?: AttachmentStatus;
  retentionPolicyId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AttachmentListFilters {
  projectId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  userId?: string | null;
  discordAttachmentId?: string | null;
  fileId?: number | null;
  status?: AttachmentStatus | AttachmentStatus[];
  limit?: number;
}

export interface AttachmentJobRecord {
  id: number;
  attachmentId: number;
  kind: AttachmentJobKind;
  status: AttachmentJobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockedAt: string | null;
  lockedBy: string | null;
  error: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentJobEnqueueInput {
  attachmentId: number;
  kind: AttachmentJobKind;
  runAfter?: string | Date | null;
  maxAttempts?: number;
  metadata?: Record<string, unknown> | null;
}

export interface AttachmentJobListFilters {
  attachmentId?: number;
  kind?: AttachmentJobKind | AttachmentJobKind[];
  status?: AttachmentJobStatus | AttachmentJobStatus[];
  lockedBy?: string | null;
  limit?: number;
}

export interface AttachmentJobStatusSummary {
  attachmentId: number;
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  canceled: number;
}

export interface AttachmentExtractionRecord {
  id: number;
  attachmentId: number;
  method: string;
  text: string;
  confidence: number | null;
  quality: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentExtractionInput {
  attachmentId: number;
  method: string;
  text: string;
  confidence?: number | null;
  quality?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface AttachmentChunkRecord {
  id: number;
  attachmentId: number;
  extractionId: number;
  ordinal: number;
  text: string;
  tokenEstimate: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentChunkInput {
  attachmentId: number;
  extractionId: number;
  ordinal: number;
  text: string;
  tokenEstimate?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface AttachmentDirectoryRecord {
  id: number;
  attachmentId: number;
  schemaVersion: number;
  directory: unknown;
  projectId: string | null;
  agentId: string | null;
  sessionId: string | null;
  messageId: string | null;
  channelId: string | null;
  threadId: string | null;
  userId: string | null;
  status: AttachmentDirectoryStatus;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentDirectoryInput {
  attachmentId: number;
  schemaVersion: number;
  directory: unknown;
  projectId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  messageId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  userId?: string | null;
  status?: AttachmentDirectoryStatus;
  metadata?: Record<string, unknown> | null;
}

export interface AttachmentDirectoryContextFilters extends Omit<AttachmentListFilters, "status"> {
  attachmentStatus?: AttachmentStatus | AttachmentStatus[];
  directoryStatus?: AttachmentDirectoryStatus | AttachmentDirectoryStatus[];
}

export interface AttachmentDirectoryContextRecord {
  attachment: AttachmentRecord;
  directory: AttachmentDirectoryRecord;
}

export interface AttachmentRetentionDecisionRecord {
  id: number;
  attachmentId: number;
  retentionPolicyId: string | null;
  decision: AttachmentRetentionDecision;
  status: AttachmentRetentionStatus;
  decidedBy: string | null;
  reason: string | null;
  effectiveAt: string | null;
  reviewAfter: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentRetentionDecisionInput {
  attachmentId: number;
  retentionPolicyId?: string | null;
  decision: AttachmentRetentionDecision;
  status?: AttachmentRetentionStatus;
  decidedBy?: string | null;
  reason?: string | null;
  effectiveAt?: string | Date | null;
  reviewAfter?: string | Date | null;
  metadata?: Record<string, unknown> | null;
}

export interface AttachmentRetentionDecisionListFilters {
  attachmentId?: number;
  retentionPolicyId?: string | null;
  decision?: AttachmentRetentionDecision | AttachmentRetentionDecision[];
  status?: AttachmentRetentionStatus | AttachmentRetentionStatus[];
  reviewDueBefore?: string | Date | null;
  limit?: number;
}

type SqliteValue = string | number | null;

interface AttachmentFileRow extends Omit<AttachmentFileRecord, "metadata"> {
  metadataJson: string | null;
}

interface AttachmentRow extends Omit<AttachmentRecord, "metadata"> {
  metadataJson: string | null;
}

interface AttachmentJobRow extends Omit<AttachmentJobRecord, "error" | "metadata"> {
  errorJson: string | null;
  metadataJson: string | null;
}

interface AttachmentExtractionRow extends Omit<AttachmentExtractionRecord, "quality" | "metadata"> {
  qualityJson: string | null;
  metadataJson: string | null;
}

interface AttachmentChunkRow extends Omit<AttachmentChunkRecord, "metadata"> {
  metadataJson: string | null;
}

interface AttachmentDirectoryRow extends Omit<AttachmentDirectoryRecord, "directory" | "metadata"> {
  directoryJson: string;
  metadataJson: string | null;
}

interface AttachmentRetentionDecisionRow
  extends Omit<AttachmentRetentionDecisionRecord, "metadata"> {
  metadataJson: string | null;
}

const ATTACHMENT_FILE_COLUMNS = `
  id,
  role,
  sha256,
  bytes,
  content_type AS contentType,
  original_filename AS originalFilename,
  storage_path AS storagePath,
  status,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const ATTACHMENT_COLUMNS = `
  id,
  project_id AS projectId,
  agent_id AS agentId,
  session_id AS sessionId,
  message_id AS messageId,
  channel_id AS channelId,
  thread_id AS threadId,
  user_id AS userId,
  discord_attachment_id AS discordAttachmentId,
  file_id AS fileId,
  title,
  original_filename AS originalFilename,
  content_type AS contentType,
  bytes,
  status,
  retention_policy_id AS retentionPolicyId,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const ATTACHMENT_JOB_COLUMNS = `
  id,
  attachment_id AS attachmentId,
  kind,
  status,
  attempts,
  max_attempts AS maxAttempts,
  run_after AS runAfter,
  locked_at AS lockedAt,
  locked_by AS lockedBy,
  error_json AS errorJson,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const ATTACHMENT_EXTRACTION_COLUMNS = `
  id,
  attachment_id AS attachmentId,
  method,
  text,
  confidence,
  quality_json AS qualityJson,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const ATTACHMENT_CHUNK_COLUMNS = `
  id,
  attachment_id AS attachmentId,
  extraction_id AS extractionId,
  ordinal,
  text,
  token_estimate AS tokenEstimate,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const ATTACHMENT_DIRECTORY_COLUMNS = `
  id,
  attachment_id AS attachmentId,
  schema_version AS schemaVersion,
  directory_json AS directoryJson,
  project_id AS projectId,
  agent_id AS agentId,
  session_id AS sessionId,
  message_id AS messageId,
  channel_id AS channelId,
  thread_id AS threadId,
  user_id AS userId,
  status,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const ATTACHMENT_RETENTION_DECISION_COLUMNS = `
  id,
  attachment_id AS attachmentId,
  retention_policy_id AS retentionPolicyId,
  decision,
  status,
  decided_by AS decidedBy,
  reason,
  effective_at AS effectiveAt,
  review_after AS reviewAfter,
  metadata_json AS metadataJson,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export class AttachmentStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertFile(input: AttachmentFileUpsertInput): AttachmentFileRecord {
    const role = input.role ?? "source";
    const values = [
      role,
      input.sha256,
      input.bytes,
      input.contentType ?? null,
      input.originalFilename ?? null,
      input.storagePath,
      input.status ?? "available",
      toJsonOrNull(input.metadata),
    ] as const;

    if (role === "source") {
      this.db
        .prepare(
          `INSERT INTO attachment_files (
             role, sha256, bytes, content_type, original_filename, storage_path, status, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sha256) WHERE role = 'source' DO UPDATE SET
             bytes = excluded.bytes,
             content_type = excluded.content_type,
             original_filename = excluded.original_filename,
             storage_path = excluded.storage_path,
             status = excluded.status,
             metadata_json = excluded.metadata_json,
             updated_at = datetime('now')`
        )
        .run(...values);

      const record = this.findSourceFileBySha256(input.sha256);
      if (!record) {
        throw new Error(`Attachment source file upsert did not return sha256 ${input.sha256}`);
      }
      return record;
    }

    const result = this.db
      .prepare(
        `INSERT INTO attachment_files (
           role, sha256, bytes, content_type, original_filename, storage_path, status, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...values);

    const record = this.getFile(toNumber(result.lastInsertRowid));
    if (!record) {
      throw new Error("Attachment derived file insert did not return a row");
    }
    return record;
  }

  findFileBySha256(sha256: string): AttachmentFileRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${ATTACHMENT_FILE_COLUMNS}
         FROM attachment_files
         WHERE sha256 = ?
         ORDER BY CASE role WHEN 'source' THEN 0 ELSE 1 END, id ASC
         LIMIT 1`
      )
      .get(sha256) as AttachmentFileRow | undefined;
    return row ? toAttachmentFileRecord(row) : null;
  }

  findSourceFileBySha256(sha256: string): AttachmentFileRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${ATTACHMENT_FILE_COLUMNS}
         FROM attachment_files
         WHERE sha256 = ? AND role = 'source'
         LIMIT 1`
      )
      .get(sha256) as AttachmentFileRow | undefined;
    return row ? toAttachmentFileRecord(row) : null;
  }

  getFile(id: number): AttachmentFileRecord | null {
    const row = this.db
      .prepare(`SELECT ${ATTACHMENT_FILE_COLUMNS} FROM attachment_files WHERE id = ?`)
      .get(id) as AttachmentFileRow | undefined;
    return row ? toAttachmentFileRecord(row) : null;
  }

  createAttachment(input: AttachmentCreateInput): AttachmentRecord {
    const result = this.db
      .prepare(
        `INSERT INTO attachments (
           project_id, agent_id, session_id, message_id, channel_id, thread_id, user_id,
           discord_attachment_id, file_id, title, original_filename, content_type, bytes,
           status, retention_policy_id, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.projectId ?? null,
        input.agentId ?? null,
        input.sessionId ?? null,
        input.messageId ?? null,
        input.channelId ?? null,
        input.threadId ?? null,
        input.userId ?? null,
        input.discordAttachmentId ?? null,
        input.fileId ?? null,
        input.title ?? null,
        input.originalFilename ?? null,
        input.contentType ?? null,
        input.bytes ?? null,
        input.status ?? "received",
        input.retentionPolicyId ?? null,
        toJsonOrNull(input.metadata),
      );

    const record = this.getAttachment(toNumber(result.lastInsertRowid));
    if (!record) {
      throw new Error("Attachment insert did not return a row");
    }
    return record;
  }

  getAttachment(id: number): AttachmentRecord | null {
    const row = this.db
      .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`)
      .get(id) as AttachmentRow | undefined;
    return row ? toAttachmentRecord(row) : null;
  }

  findAttachmentByDiscordAttachmentId(discordAttachmentId: string): AttachmentRecord | null {
    const row = this.db
      .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE discord_attachment_id = ?`)
      .get(discordAttachmentId) as AttachmentRow | undefined;
    return row ? toAttachmentRecord(row) : null;
  }

  updateAttachmentStatus(
    id: number,
    status: AttachmentStatus,
    options: { metadata?: Record<string, unknown> | null } = {},
  ): AttachmentRecord | null {
    if ("metadata" in options) {
      this.db
        .prepare(
          `UPDATE attachments
           SET status = ?, metadata_json = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(status, toJsonOrNull(options.metadata), id);
    } else {
      this.db
        .prepare(
          `UPDATE attachments
           SET status = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(status, id);
    }
    return this.getAttachment(id);
  }

  listAttachments(filters: AttachmentListFilters = {}): AttachmentRecord[] {
    const { where, values } = buildAttachmentWhere(filters);
    values.push(normalizeLimit(filters.limit));
    const rows = this.db
      .prepare(
        `SELECT ${ATTACHMENT_COLUMNS}
         FROM attachments
         ${where}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(...values) as unknown as AttachmentRow[];
    return rows.map(toAttachmentRecord);
  }

  /**
   * T-I-125 Phase 1 — enumeration support (attachment_enumerate). Unlike
   * listAttachments(), this is deliberately UNBOUNDED (no LIMIT clause,
   * normalizeLimit's 500 cap does not apply): the acceptance test
   * ("every PDF, every image... 100% recall") requires an exact total across
   * the whole library, not a capped sample. Callers that want paging apply
   * limit/offset themselves after filtering — see attachment-enumeration in
   * packages/discord for the tool-level page slice.
   */
  listAllAttachments(filters: Omit<AttachmentListFilters, "limit"> = {}): AttachmentRecord[] {
    const { where, values } = buildAttachmentWhere(filters);
    const rows = this.db
      .prepare(
        `SELECT ${ATTACHMENT_COLUMNS}
         FROM attachments
         ${where}
         ORDER BY id ASC`
      )
      .all(...values) as unknown as AttachmentRow[];
    return rows.map(toAttachmentRecord);
  }

  /**
   * T-I-125 Phase 1 (v0) — operator write surface, REAL COLUMNS ONLY.
   * Touches title and/or project_id (plus updated_at); never writes
   * directory_json, tags, or any other column. Only the fields present as
   * own keys of `fields` are updated — `{}` is a no-op read-back, not a
   * blanket NULL-out.
   */
  updateAttachmentOperatorFields(
    id: number,
    fields: { title?: string | null; projectId?: string | null },
  ): AttachmentRecord | null {
    const sets: string[] = [];
    const values: SqliteValue[] = [];
    if ("title" in fields) {
      sets.push("title = ?");
      values.push(fields.title ?? null);
    }
    if ("projectId" in fields) {
      sets.push("project_id = ?");
      values.push(fields.projectId ?? null);
    }
    if (sets.length === 0) {
      return this.getAttachment(id);
    }
    sets.push("updated_at = datetime('now')");
    values.push(id);
    this.db
      .prepare(`UPDATE attachments SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.getAttachment(id);
  }

  enqueueJob(input: AttachmentJobEnqueueInput): AttachmentJobRecord {
    const result = this.db
      .prepare(
        `INSERT INTO attachment_jobs (
           attachment_id, kind, max_attempts, run_after, metadata_json
         ) VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?)`
      )
      .run(
        input.attachmentId,
        input.kind,
        input.maxAttempts ?? 3,
        normalizeDateTime(input.runAfter),
        toJsonOrNull(input.metadata),
      );

    const record = this.getJob(toNumber(result.lastInsertRowid));
    if (!record) {
      throw new Error("Attachment job insert did not return a row");
    }
    return record;
  }

  getJob(id: number): AttachmentJobRecord | null {
    const row = this.db
      .prepare(`SELECT ${ATTACHMENT_JOB_COLUMNS} FROM attachment_jobs WHERE id = ?`)
      .get(id) as AttachmentJobRow | undefined;
    return row ? toAttachmentJobRecord(row) : null;
  }

  claimNextJob(input: {
    workerId: string;
    kinds?: AttachmentJobKind[];
    now?: string | Date;
  }): AttachmentJobRecord | null {
    const now = normalizeDateTime(input.now) ?? currentSqliteDateTime();
    const values: SqliteValue[] = [now];
    const kindClause = buildInClause("kind", input.kinds, values);

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db
        .prepare(
          `SELECT id
           FROM attachment_jobs
           WHERE status = 'pending'
             AND run_after <= ?
             AND attempts < max_attempts
             ${kindClause}
           ORDER BY run_after ASC, created_at ASC, id ASC
           LIMIT 1`
        )
        .get(...values) as { id: number } | undefined;

      if (!row) {
        this.db.exec("COMMIT;");
        return null;
      }

      this.db
        .prepare(
          `UPDATE attachment_jobs
           SET status = 'running',
               attempts = attempts + 1,
               locked_at = datetime('now'),
               locked_by = ?,
               updated_at = datetime('now')
           WHERE id = ? AND status = 'pending'`
        )
        .run(input.workerId, row.id);
      this.db.exec("COMMIT;");
      return this.getJob(row.id);
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  completeJob(
    id: number,
    options: { metadata?: Record<string, unknown> | null } = {},
  ): AttachmentJobRecord | null {
    if ("metadata" in options) {
      this.db
        .prepare(
          `UPDATE attachment_jobs
           SET status = 'succeeded',
               locked_at = NULL,
               locked_by = NULL,
               error_json = NULL,
               metadata_json = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(toJsonOrNull(options.metadata), id);
    } else {
      this.db
        .prepare(
          `UPDATE attachment_jobs
           SET status = 'succeeded',
               locked_at = NULL,
               locked_by = NULL,
               error_json = NULL,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(id);
    }
    return this.getJob(id);
  }

  failJob(
    id: number,
    error: string | Record<string, unknown>,
    options: {
      metadata?: Record<string, unknown> | null;
      retryAt?: string | Date | null;
    } = {},
  ): AttachmentJobRecord | null {
    const errorJson = typeof error === "string" ? { message: error } : error;
    const isRetry = "retryAt" in options;
    const status: AttachmentJobStatus = isRetry ? "pending" : "failed";

    if (isRetry && "metadata" in options) {
      this.db
        .prepare(
          `UPDATE attachment_jobs
           SET status = ?,
               locked_at = NULL,
               locked_by = NULL,
               run_after = ?,
               error_json = ?,
               metadata_json = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          status,
          normalizeDateTime(options.retryAt) ?? currentSqliteDateTime(),
          toJsonOrNull(errorJson),
          toJsonOrNull(options.metadata),
          id,
        );
    } else if (isRetry) {
      this.db
        .prepare(
          `UPDATE attachment_jobs
           SET status = ?,
               locked_at = NULL,
               locked_by = NULL,
               run_after = ?,
               error_json = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          status,
          normalizeDateTime(options.retryAt) ?? currentSqliteDateTime(),
          toJsonOrNull(errorJson),
          id,
        );
    } else if ("metadata" in options) {
      this.db
        .prepare(
          `UPDATE attachment_jobs
           SET status = ?,
               locked_at = NULL,
               locked_by = NULL,
               error_json = ?,
               metadata_json = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(status, toJsonOrNull(errorJson), toJsonOrNull(options.metadata), id);
    } else {
      this.db
        .prepare(
          `UPDATE attachment_jobs
           SET status = ?,
               locked_at = NULL,
               locked_by = NULL,
               error_json = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(status, toJsonOrNull(errorJson), id);
    }
    return this.getJob(id);
  }

  recoverStaleLocks(input: {
    staleBefore: string | Date;
    lockedBy?: string | null;
    runAfter?: string | Date | null;
  }): number {
    const values: SqliteValue[] = [
      normalizeDateTime(input.runAfter) ?? currentSqliteDateTime(),
      normalizeDateTime(input.staleBefore) ?? currentSqliteDateTime(),
    ];
    let lockedByClause = "";
    if (input.lockedBy !== undefined) {
      if (input.lockedBy === null) {
        lockedByClause = "AND locked_by IS NULL";
      } else {
        lockedByClause = "AND locked_by = ?";
        values.push(input.lockedBy);
      }
    }

    const result = this.db
      .prepare(
        `UPDATE attachment_jobs
         SET status = 'pending',
             locked_at = NULL,
             locked_by = NULL,
             run_after = ?,
             updated_at = datetime('now')
         WHERE status = 'running'
           AND locked_at IS NOT NULL
           AND locked_at <= ?
           ${lockedByClause}`
      )
      .run(...values);
    return toNumber(result.changes);
  }

  listJobs(filters: AttachmentJobListFilters = {}): AttachmentJobRecord[] {
    const { where, values } = buildJobWhere(filters);
    values.push(normalizeLimit(filters.limit));
    const rows = this.db
      .prepare(
        `SELECT ${ATTACHMENT_JOB_COLUMNS}
         FROM attachment_jobs
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(...values) as unknown as AttachmentJobRow[];
    return rows.map(toAttachmentJobRecord);
  }

  getJobStatusSummary(attachmentId: number): AttachmentJobStatusSummary {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) AS canceled
         FROM attachment_jobs
         WHERE attachment_id = ?`
      )
      .get(attachmentId) as
      | {
          total: number;
          pending: number | null;
          running: number | null;
          succeeded: number | null;
          failed: number | null;
          canceled: number | null;
        }
      | undefined;

    return {
      attachmentId,
      total: row?.total ?? 0,
      pending: row?.pending ?? 0,
      running: row?.running ?? 0,
      succeeded: row?.succeeded ?? 0,
      failed: row?.failed ?? 0,
      canceled: row?.canceled ?? 0,
    };
  }

  addExtraction(input: AttachmentExtractionInput): AttachmentExtractionRecord {
    const result = this.db
      .prepare(
        `INSERT INTO attachment_extractions (
           attachment_id, method, text, confidence, quality_json, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.attachmentId,
        input.method,
        input.text,
        input.confidence ?? null,
        toJsonOrNull(input.quality),
        toJsonOrNull(input.metadata),
      );
    const record = this.getExtraction(toNumber(result.lastInsertRowid));
    if (!record) {
      throw new Error("Attachment extraction insert did not return a row");
    }
    return record;
  }

  getExtraction(id: number): AttachmentExtractionRecord | null {
    const row = this.db
      .prepare(`SELECT ${ATTACHMENT_EXTRACTION_COLUMNS} FROM attachment_extractions WHERE id = ?`)
      .get(id) as AttachmentExtractionRow | undefined;
    return row ? toAttachmentExtractionRecord(row) : null;
  }

  listExtractions(attachmentId: number): AttachmentExtractionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${ATTACHMENT_EXTRACTION_COLUMNS}
         FROM attachment_extractions
         WHERE attachment_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(attachmentId) as unknown as AttachmentExtractionRow[];
    return rows.map(toAttachmentExtractionRecord);
  }

  addChunk(input: AttachmentChunkInput): AttachmentChunkRecord {
    const result = this.db
      .prepare(
        `INSERT INTO attachment_chunks (
           attachment_id, extraction_id, ordinal, text, token_estimate, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.attachmentId,
        input.extractionId,
        input.ordinal,
        input.text,
        input.tokenEstimate ?? null,
        toJsonOrNull(input.metadata),
      );
    const record = this.getChunk(toNumber(result.lastInsertRowid));
    if (!record) {
      throw new Error("Attachment chunk insert did not return a row");
    }
    return record;
  }

  getChunk(id: number): AttachmentChunkRecord | null {
    const row = this.db
      .prepare(`SELECT ${ATTACHMENT_CHUNK_COLUMNS} FROM attachment_chunks WHERE id = ?`)
      .get(id) as AttachmentChunkRow | undefined;
    return row ? toAttachmentChunkRecord(row) : null;
  }

  listChunks(attachmentId: number): AttachmentChunkRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${ATTACHMENT_CHUNK_COLUMNS}
         FROM attachment_chunks
         WHERE attachment_id = ?
         ORDER BY ordinal ASC, id ASC`
      )
      .all(attachmentId) as unknown as AttachmentChunkRow[];
    return rows.map(toAttachmentChunkRecord);
  }

  addDirectory(input: AttachmentDirectoryInput): AttachmentDirectoryRecord {
    const result = this.db
      .prepare(
        `INSERT INTO attachment_directories (
           attachment_id, schema_version, directory_json, project_id, agent_id, session_id, message_id,
           channel_id, thread_id, user_id, status, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.attachmentId,
        input.schemaVersion,
        JSON.stringify(input.directory),
        input.projectId ?? null,
        input.agentId ?? null,
        input.sessionId ?? null,
        input.messageId ?? null,
        input.channelId ?? null,
        input.threadId ?? null,
        input.userId ?? null,
        input.status ?? "building",
        toJsonOrNull(input.metadata),
      );
    const record = this.getDirectory(toNumber(result.lastInsertRowid));
    if (!record) {
      throw new Error("Attachment directory insert did not return a row");
    }
    return record;
  }

  getDirectory(id: number): AttachmentDirectoryRecord | null {
    const row = this.db
      .prepare(`SELECT ${ATTACHMENT_DIRECTORY_COLUMNS} FROM attachment_directories WHERE id = ?`)
      .get(id) as AttachmentDirectoryRow | undefined;
    return row ? toAttachmentDirectoryRecord(row) : null;
  }

  listDirectories(attachmentId: number): AttachmentDirectoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${ATTACHMENT_DIRECTORY_COLUMNS}
         FROM attachment_directories
         WHERE attachment_id = ?
         ORDER BY created_at ASC, id ASC`
      )
      .all(attachmentId) as unknown as AttachmentDirectoryRow[];
    return rows.map(toAttachmentDirectoryRecord);
  }

  listDirectoriesForContext(
    filters: AttachmentDirectoryContextFilters = {},
  ): AttachmentDirectoryContextRecord[] {
    const limit = normalizeLimit(filters.limit);
    const attachments = this.listAttachments({
      projectId: filters.projectId,
      agentId: filters.agentId,
      sessionId: filters.sessionId,
      messageId: filters.messageId,
      channelId: filters.channelId,
      threadId: filters.threadId,
      userId: filters.userId,
      discordAttachmentId: filters.discordAttachmentId,
      fileId: filters.fileId,
      status: filters.attachmentStatus ?? ["ready", "partial"],
      limit: Math.min(limit * 4, 500),
    });
    const records: AttachmentDirectoryContextRecord[] = [];

    for (const attachment of attachments) {
      const directory = this.listDirectories(attachment.id).at(-1) ?? null;
      if (!directory) continue;
      if (!matchesValueOrArray(directory.status, filters.directoryStatus)) continue;
      records.push({ attachment, directory });
      if (records.length >= limit) break;
    }

    return records;
  }

  addRetentionDecision(input: AttachmentRetentionDecisionInput): AttachmentRetentionDecisionRecord {
    const result = this.db
      .prepare(
        `INSERT INTO attachment_retention_decisions (
           attachment_id, retention_policy_id, decision, status, decided_by, reason,
           effective_at, review_after, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.attachmentId,
        input.retentionPolicyId ?? null,
        input.decision,
        input.status ?? "proposed",
        input.decidedBy ?? null,
        input.reason ?? null,
        normalizeDateTime(input.effectiveAt),
        normalizeDateTime(input.reviewAfter),
        toJsonOrNull(input.metadata),
      );
    const record = this.getRetentionDecision(toNumber(result.lastInsertRowid));
    if (!record) {
      throw new Error("Attachment retention decision insert did not return a row");
    }
    return record;
  }

  getRetentionDecision(id: number): AttachmentRetentionDecisionRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${ATTACHMENT_RETENTION_DECISION_COLUMNS}
         FROM attachment_retention_decisions
         WHERE id = ?`
      )
      .get(id) as AttachmentRetentionDecisionRow | undefined;
    return row ? toAttachmentRetentionDecisionRecord(row) : null;
  }

  listRetentionDecisions(attachmentId: number): AttachmentRetentionDecisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${ATTACHMENT_RETENTION_DECISION_COLUMNS}
         FROM attachment_retention_decisions
         WHERE attachment_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(attachmentId) as unknown as AttachmentRetentionDecisionRow[];
    return rows.map(toAttachmentRetentionDecisionRecord);
  }

  listRetentionDecisionQueue(
    filters: AttachmentRetentionDecisionListFilters = {},
  ): AttachmentRetentionDecisionRecord[] {
    const clauses: string[] = [];
    const values: SqliteValue[] = [];
    if (filters.attachmentId !== undefined) {
      clauses.push("attachment_id = ?");
      values.push(filters.attachmentId);
    }
    addNullableFilter(clauses, values, "retention_policy_id", filters.retentionPolicyId);
    addValueOrInFilter(clauses, values, "decision", filters.decision);
    addValueOrInFilter(clauses, values, "status", filters.status);
    if (filters.reviewDueBefore !== undefined) {
      clauses.push("(review_after IS NULL OR datetime(review_after) <= datetime(?))");
      values.push(normalizeDateTime(filters.reviewDueBefore) ?? currentSqliteDateTime());
    }
    values.push(normalizeLimit(filters.limit));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT ${ATTACHMENT_RETENTION_DECISION_COLUMNS}
         FROM attachment_retention_decisions
         ${where}
         ORDER BY
           CASE status
             WHEN 'proposed' THEN 0
             WHEN 'approved' THEN 1
             ELSE 2
           END,
           datetime(COALESCE(review_after, created_at)) ASC,
           created_at ASC,
           id ASC
         LIMIT ?`
      )
      .all(...values) as unknown as AttachmentRetentionDecisionRow[];
    return rows.map(toAttachmentRetentionDecisionRecord);
  }
}

function buildAttachmentWhere(filters: AttachmentListFilters): {
  where: string;
  values: SqliteValue[];
} {
  const clauses: string[] = [];
  const values: SqliteValue[] = [];

  addNullableFilter(clauses, values, "project_id", filters.projectId);
  addNullableFilter(clauses, values, "agent_id", filters.agentId);
  addNullableFilter(clauses, values, "session_id", filters.sessionId);
  addNullableFilter(clauses, values, "message_id", filters.messageId);
  addNullableFilter(clauses, values, "channel_id", filters.channelId);
  addNullableFilter(clauses, values, "thread_id", filters.threadId);
  addNullableFilter(clauses, values, "user_id", filters.userId);
  addNullableFilter(clauses, values, "discord_attachment_id", filters.discordAttachmentId);
  addNullableFilter(clauses, values, "file_id", filters.fileId);
  addValueOrInFilter(clauses, values, "status", filters.status);

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

function buildJobWhere(filters: AttachmentJobListFilters): {
  where: string;
  values: SqliteValue[];
} {
  const clauses: string[] = [];
  const values: SqliteValue[] = [];

  if (filters.attachmentId !== undefined) {
    clauses.push("attachment_id = ?");
    values.push(filters.attachmentId);
  }
  addValueOrInFilter(clauses, values, "kind", filters.kind);
  addValueOrInFilter(clauses, values, "status", filters.status);
  addNullableFilter(clauses, values, "locked_by", filters.lockedBy);

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

function addNullableFilter(
  clauses: string[],
  values: SqliteValue[],
  column: string,
  value: SqliteValue | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    clauses.push(`${column} IS NULL`);
    return;
  }
  clauses.push(`${column} = ?`);
  values.push(value);
}

function addValueOrInFilter<T extends string>(
  clauses: string[],
  values: SqliteValue[],
  column: string,
  value: T | T[] | undefined,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    clauses.push(`${column} IN (${value.map(() => "?").join(", ")})`);
    values.push(...value);
    return;
  }
  clauses.push(`${column} = ?`);
  values.push(value);
}

function matchesValueOrArray<T extends string>(
  value: T,
  expected: T | T[] | undefined,
): boolean {
  if (expected === undefined) return true;
  return Array.isArray(expected) ? expected.includes(value) : value === expected;
}

function buildInClause<T extends string>(
  column: string,
  values: T[] | undefined,
  sqlValues: SqliteValue[],
): string {
  if (!values || values.length === 0) return "";
  sqlValues.push(...values);
  return `AND ${column} IN (${values.map(() => "?").join(", ")})`;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? 0) || !limit) return 100;
  return Math.max(1, Math.min(Math.trunc(limit), 500));
}

function normalizeDateTime(value: string | Date | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return toSqliteDateTime(value);
  return value;
}

function currentSqliteDateTime(): string {
  return toSqliteDateTime(new Date());
}

function toSqliteDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function toJsonOrNull(value: unknown | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJsonValue(input: string | null): unknown {
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function parseJsonRecord(input: string | null): Record<string, unknown> | null {
  const value = parseJsonValue(input);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function toAttachmentFileRecord(row: AttachmentFileRow): AttachmentFileRecord {
  const { metadataJson, ...record } = row;
  return {
    ...record,
    metadata: parseJsonRecord(metadataJson),
  };
}

function toAttachmentRecord(row: AttachmentRow): AttachmentRecord {
  const { metadataJson, ...record } = row;
  return {
    ...record,
    metadata: parseJsonRecord(metadataJson),
  };
}

function toAttachmentJobRecord(row: AttachmentJobRow): AttachmentJobRecord {
  const { errorJson, metadataJson, ...record } = row;
  return {
    ...record,
    error: parseJsonRecord(errorJson),
    metadata: parseJsonRecord(metadataJson),
  };
}

function toAttachmentExtractionRecord(row: AttachmentExtractionRow): AttachmentExtractionRecord {
  const { qualityJson, metadataJson, ...record } = row;
  return {
    ...record,
    quality: parseJsonRecord(qualityJson),
    metadata: parseJsonRecord(metadataJson),
  };
}

function toAttachmentChunkRecord(row: AttachmentChunkRow): AttachmentChunkRecord {
  const { metadataJson, ...record } = row;
  return {
    ...record,
    metadata: parseJsonRecord(metadataJson),
  };
}

function toAttachmentDirectoryRecord(row: AttachmentDirectoryRow): AttachmentDirectoryRecord {
  const { directoryJson, metadataJson, ...record } = row;
  return {
    ...record,
    directory: parseJsonValue(directoryJson),
    metadata: parseJsonRecord(metadataJson),
  };
}

function toAttachmentRetentionDecisionRecord(
  row: AttachmentRetentionDecisionRow,
): AttachmentRetentionDecisionRecord {
  const { metadataJson, ...record } = row;
  return {
    ...record,
    metadata: parseJsonRecord(metadataJson),
  };
}
