#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import {
  openAtlasMemoryDatabase,
  resolveAtlasMemoryDatabasePath,
  runInTransaction,
} from "../packages/atlas-memory/src/schema.ts";
import { decodeEmbedding, encodeEmbedding } from "../packages/atlas-memory/src/search.ts";
import type { SqliteDatabase } from "../packages/atlas-memory/src/types.ts";
import { resolveDatabasePath } from "../packages/core/src/storage.ts";

interface CliOptions {
  sourceDbPath?: string;
  targetDbPath?: string;
  force: boolean;
}

interface SourceMemoryRow {
  id: number;
  session_id: string | null;
  agent_id: string | null;
  source: string;
  content: string;
  importance: number;
  source_ref: string | null;
  embedding_json: string | null;
  embedding_model: string | null;
  created_at: string;
  last_accessed_at: string;
  access_count: number;
  archived_at: string | null;
  metadata_json: string | null;
}

interface SourcePinnedFactRow {
  id: number;
  scope: string;
  scope_id: string | null;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

interface SourceSessionSummaryRow {
  id: number;
  session_id: string;
  agent_id: string;
  summary_text: string;
  covers_through_message_id: number | null;
  created_at: string;
  updated_at: string;
}

interface MigrationResult<TKey> {
  total: number;
  migrated: number;
  failed: number;
  idMap: Map<TKey, string>;
}

interface ValidationResult {
  ok: boolean;
  label: string;
  detail: string;
}

const LEGACY_MEMORY_SOURCES = new Set([
  "conversation",
  "obsidian",
  "reflection",
  "manual",
  "backfill",
]);

const PINNED_FACT_SCOPES = new Set(["global", "agent", "session"]);

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sourcePath = resolveDatabasePath(options.sourceDbPath);
  const targetPath = resolveAtlasMemoryDatabasePath(process.env, options.targetDbPath);

  ensureDifferentDatabases(sourcePath, targetPath);
  ensureFileExists(sourcePath, "Source database");

  console.log("Starting memory migration...");
  const backupPath = backupSourceDatabase(sourcePath);
  console.log(`Backing up source database to ${backupPath}`);
  console.log(`Source: ${sourcePath}`);
  console.log(`Target: ${targetPath}`);

  const sourceDb = openSourceDatabase(sourcePath);
  const { db: targetDb, path: openedTargetPath } = openAtlasMemoryDatabase({
    dbPath: options.targetDbPath,
  });

  try {
    if (hasTargetData(targetDb)) {
      const canReplace =
        options.force || await confirmReplaceTargetData(openedTargetPath);
      if (!canReplace) {
        console.log("Migration cancelled. Target database already contains data.");
        return;
      }

      clearTargetTables(targetDb);
    }

    const sourceMemoryRows = loadSourceMemoryRows(sourceDb);
    const sourcePinnedFactRows = loadSourcePinnedFactRows(sourceDb);
    const sourceSessionSummaryRows = loadSourceSessionSummaryRows(sourceDb);

    const memoryResult = migrateMemories(targetDb, sourceMemoryRows);
    const pinnedFactResult = migratePinnedFacts(targetDb, sourcePinnedFactRows);
    const summaryResult = migrateConversationSummaries(targetDb, sourceSessionSummaryRows);

    console.log("\nValidation:");

    const validations: ValidationResult[] = [
      validateRowCounts(
        "memories",
        sourceMemoryRows.length,
        countRows(targetDb, "memories"),
      ),
      validateRowCounts(
        "pinned_facts",
        sourcePinnedFactRows.length,
        countRows(targetDb, "pinned_facts"),
      ),
      validateRowCounts(
        "conversation_summaries",
        sourceSessionSummaryRows.length,
        countRows(targetDb, "conversation_summaries"),
      ),
      validateSpotCheck(targetDb, sourceMemoryRows, memoryResult.idMap, 5),
      validateEmbeddings(targetDb, sourceMemoryRows, memoryResult.idMap, 3),
    ];

    for (const validation of validations) {
      console.log(`  ${validation.detail} ${validation.ok ? "✓" : "✗"}`);
    }

    const totalFailedRows =
      memoryResult.failed + pinnedFactResult.failed + summaryResult.failed;
    const hasFailures =
      totalFailedRows > 0 || validations.some((validation) => !validation.ok);

    if (hasFailures) {
      console.log(
        "\nMigration complete with validation failures. Source tables preserved as read-only backup.",
      );
      if (totalFailedRows > 0) {
        console.error(
          `Skipped ${totalFailedRows} row(s) due to transform or insert errors.`,
        );
      }
      console.error(
        "Source tables preserved. Legacy code can still read them.",
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      "\nMigration complete. Source tables preserved as read-only backup.",
    );
  } finally {
    sourceDb.close();
    targetDb.close();
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    force: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--db":
      case "--db-path":
      case "--source-db":
      case "--source-db-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.sourceDbPath = next;
        index += 1;
        break;
      case "--target-db":
      case "--target-db-path":
      case "--atlas-db":
        if (!next) throw new Error(`${arg} requires a value`);
        options.targetDbPath = next;
        index += 1;
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsage(): void {
  console.log(`
Usage:
  npx tsx scripts/migrate-memory-to-atlas.ts [options]

Options:
  --db-path <path>         Override the source Tango SQLite path
  --target-db-path <path>  Override the target Atlas memory SQLite path
  --force                  Replace existing Atlas memory rows without prompting
`);
}

function ensureDifferentDatabases(sourcePath: string, targetPath: string): void {
  const resolvedSource = path.resolve(sourcePath);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedSource === resolvedTarget) {
    throw new Error("Source and target database paths must be different.");
  }
}

function ensureFileExists(filePath: string, label: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
}

function backupSourceDatabase(sourcePath: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = `${sourcePath}.bak-${timestamp}`;

  fs.copyFileSync(sourcePath, backupPath);
  copySidecarIfExists(`${sourcePath}-wal`, `${backupPath}-wal`);
  copySidecarIfExists(`${sourcePath}-shm`, `${backupPath}-shm`);

  return backupPath;
}

function copySidecarIfExists(sourcePath: string, targetPath: string): void {
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function openSourceDatabase(sourcePath: string): SqliteDatabase {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA query_only = ON;");
  return db;
}

function hasTargetData(db: SqliteDatabase): boolean {
  return (
    countRows(db, "memories") > 0 ||
    countRows(db, "pinned_facts") > 0 ||
    countRows(db, "conversation_summaries") > 0
  );
}

async function confirmReplaceTargetData(targetPath: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Target database already has data at ${targetPath}. Re-run with --force to replace it.`,
    );
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await readline.question(
      `Target database already has data at ${targetPath}. Replace it? [y/N] `,
    );
    return /^(y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

function clearTargetTables(db: SqliteDatabase): void {
  runInTransaction(db, () => {
    db.prepare("DELETE FROM conversation_summaries").run();
    db.prepare("DELETE FROM pinned_facts").run();
    db.prepare("DELETE FROM memories").run();
  });
}

function loadSourceMemoryRows(db: SqliteDatabase): SourceMemoryRow[] {
  return db.prepare(`
    SELECT
      id,
      session_id,
      agent_id,
      source,
      content,
      importance,
      source_ref,
      embedding_json,
      embedding_model,
      created_at,
      last_accessed_at,
      access_count,
      archived_at,
      metadata_json
    FROM memories
    ORDER BY id ASC
  `).all() as SourceMemoryRow[];
}

function loadSourcePinnedFactRows(db: SqliteDatabase): SourcePinnedFactRow[] {
  return db.prepare(`
    SELECT
      id,
      scope,
      scope_id,
      key,
      value,
      created_at,
      updated_at
    FROM pinned_facts
    ORDER BY id ASC
  `).all() as SourcePinnedFactRow[];
}

function loadSourceSessionSummaryRows(db: SqliteDatabase): SourceSessionSummaryRow[] {
  return db.prepare(`
    SELECT
      id,
      session_id,
      agent_id,
      summary_text,
      covers_through_message_id,
      created_at,
      updated_at
    FROM session_summaries
    ORDER BY id ASC
  `).all() as SourceSessionSummaryRow[];
}

function migrateMemories(
  targetDb: SqliteDatabase,
  rows: SourceMemoryRow[],
): MigrationResult<number> {
  process.stdout.write(`\nMigrating memories: ${rows.length} rows... `);

  const result: MigrationResult<number> = {
    total: rows.length,
    migrated: 0,
    failed: 0,
    idMap: new Map<number, string>(),
  };

  const insert = targetDb.prepare(`
    INSERT INTO memories (
      id,
      content,
      source,
      agent_id,
      importance,
      tags,
      embedding,
      embedding_model,
      created_at,
      last_accessed_at,
      access_count,
      archived_at,
      metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runInTransaction(targetDb, () => {
    for (const row of rows) {
      try {
        const targetId = randomUUID();
        const metadata = parseJsonObject(row.metadata_json) ?? {};
        const mergedMetadata = {
          session_id: row.session_id,
          source_ref: row.source_ref,
          ...metadata,
        };

        insert.run(
          targetId,
          requireString(row.content, "memories.content", row.id),
          requireMemorySource(row.source, row.id),
          optionalTrimmedString(row.agent_id),
          requireFiniteNumber(row.importance, "memories.importance", row.id),
          JSON.stringify(extractTags(metadata)),
          parseEmbeddingBuffer(row.embedding_json, row.id),
          optionalTrimmedString(row.embedding_model),
          requireString(row.created_at, "memories.created_at", row.id),
          requireString(row.last_accessed_at, "memories.last_accessed_at", row.id),
          requireInteger(row.access_count, "memories.access_count", row.id),
          optionalTrimmedString(row.archived_at),
          JSON.stringify(mergedMetadata),
        );

        result.idMap.set(row.id, targetId);
        result.migrated += 1;
      } catch (error) {
        result.failed += 1;
        logRowError("memories", row.id, error);
      }
    }
  });
  console.log("done");
  return result;
}

function migratePinnedFacts(
  targetDb: SqliteDatabase,
  rows: SourcePinnedFactRow[],
): MigrationResult<number> {
  process.stdout.write(`Migrating pinned_facts: ${rows.length} rows... `);

  const result: MigrationResult<number> = {
    total: rows.length,
    migrated: 0,
    failed: 0,
    idMap: new Map<number, string>(),
  };

  const insert = targetDb.prepare(`
    INSERT INTO pinned_facts (
      id,
      scope,
      scope_id,
      key,
      value,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  runInTransaction(targetDb, () => {
    for (const row of rows) {
      try {
        const targetId = randomUUID();

        insert.run(
          targetId,
          requirePinnedFactScope(row.scope, row.id),
          optionalTrimmedString(row.scope_id),
          requireString(row.key, "pinned_facts.key", row.id),
          requireString(row.value, "pinned_facts.value", row.id),
          requireString(row.created_at, "pinned_facts.created_at", row.id),
          requireString(row.updated_at, "pinned_facts.updated_at", row.id),
        );

        result.idMap.set(row.id, targetId);
        result.migrated += 1;
      } catch (error) {
        result.failed += 1;
        logRowError("pinned_facts", row.id, error);
      }
    }
  });
  console.log("done");
  return result;
}

function migrateConversationSummaries(
  targetDb: SqliteDatabase,
  rows: SourceSessionSummaryRow[],
): MigrationResult<number> {
  process.stdout.write(
    `Migrating session_summaries → conversation_summaries: ${rows.length} rows... `,
  );

  const result: MigrationResult<number> = {
    total: rows.length,
    migrated: 0,
    failed: 0,
    idMap: new Map<number, string>(),
  };

  const insert = targetDb.prepare(`
    INSERT INTO conversation_summaries (
      id,
      session_id,
      agent_id,
      summary,
      covers_through,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  runInTransaction(targetDb, () => {
    for (const row of rows) {
      try {
        const targetId = randomUUID();

        insert.run(
          targetId,
          requireString(row.session_id, "session_summaries.session_id", row.id),
          requireString(row.agent_id, "session_summaries.agent_id", row.id),
          requireString(row.summary_text, "session_summaries.summary_text", row.id),
          row.covers_through_message_id === null
            ? null
            : String(requireInteger(
              row.covers_through_message_id,
              "session_summaries.covers_through_message_id",
              row.id,
            )),
          requireString(row.created_at, "session_summaries.created_at", row.id),
        );

        result.idMap.set(row.id, targetId);
        result.migrated += 1;
      } catch (error) {
        result.failed += 1;
        logRowError("session_summaries", row.id, error);
      }
    }
  });
  console.log("done");
  return result;
}

function validateRowCounts(
  label: string,
  sourceCount: number,
  targetCount: number,
): ValidationResult {
  return {
    ok: sourceCount === targetCount,
    label,
    detail: `${label}: ${sourceCount} → ${targetCount}`,
  };
}

function validateSpotCheck(
  targetDb: SqliteDatabase,
  sourceRows: SourceMemoryRow[],
  idMap: Map<number, string>,
  sampleSize: number,
): ValidationResult {
  const eligibleRows = sourceRows.filter((row) => idMap.has(row.id));
  const sample = pickRandomItems(eligibleRows, sampleSize);
  const select = targetDb.prepare(`
    SELECT content
    FROM memories
    WHERE id = ?
  `);

  let matches = 0;
  for (const row of sample) {
    const targetId = idMap.get(row.id);
    if (!targetId) {
      continue;
    }

    const targetRow = select.get(targetId) as { content: string } | undefined;
    if (targetRow?.content === row.content) {
      matches += 1;
    }
  }

  return {
    ok: matches === sample.length,
    label: "spot-check",
    detail: `Spot-check: ${matches}/${sample.length} memories content match`,
  };
}

function validateEmbeddings(
  targetDb: SqliteDatabase,
  sourceRows: SourceMemoryRow[],
  idMap: Map<number, string>,
  sampleSize: number,
): ValidationResult {
  const eligibleRows = sourceRows.filter((row) => {
    return row.embedding_json !== null && row.embedding_json.trim().length > 0 && idMap.has(row.id);
  });
  const sample = pickRandomItems(eligibleRows, sampleSize);
  const select = targetDb.prepare(`
    SELECT embedding
    FROM memories
    WHERE id = ?
  `);

  let matches = 0;
  for (const row of sample) {
    const targetId = idMap.get(row.id);
    if (!targetId) {
      continue;
    }

    try {
      const expectedNumbers = parseEmbeddingNumbers(row.embedding_json, row.id);
      const expectedBuffer = encodeEmbedding(expectedNumbers);
      const targetRow = select.get(targetId) as { embedding: Buffer | null } | undefined;
      const actualEmbedding = targetRow?.embedding ?? null;
      const decoded = decodeEmbedding(actualEmbedding);

      if (
        actualEmbedding !== null &&
        Buffer.from(actualEmbedding).equals(expectedBuffer) &&
        arrayEquals(decoded, expectedNumbers)
      ) {
        matches += 1;
      }
    } catch {
      // Count the sample as failed validation.
    }
  }

  return {
    ok: matches === sample.length,
    label: "embedding-check",
    detail: `Embedding check: ${matches}/${sample.length} embeddings decode correctly`,
  };
}

function countRows(db: SqliteDatabase, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
    count: number;
  };
  return row.count;
}

function requireMemorySource(value: string, rowId: number): string {
  const normalized = value.trim();
  if (!LEGACY_MEMORY_SOURCES.has(normalized)) {
    throw new Error(`row ${rowId} has unsupported memory source "${value}"`);
  }
  return normalized;
}

function requirePinnedFactScope(value: string, rowId: number): string {
  const normalized = value.trim();
  if (!PINNED_FACT_SCOPES.has(normalized)) {
    throw new Error(`row ${rowId} has unsupported pinned fact scope "${value}"`);
  }
  return normalized;
}

function requireString(value: string | null, fieldName: string, rowId: number): string {
  if (typeof value !== "string") {
    throw new Error(`row ${rowId} has non-string ${fieldName}`);
  }
  return value;
}

function optionalTrimmedString(value: string | null): string | null {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function requireFiniteNumber(value: number, fieldName: string, rowId: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`row ${rowId} has invalid ${fieldName}`);
  }
  return value;
}

function requireInteger(value: number, fieldName: string, rowId: number): number {
  const numberValue = requireFiniteNumber(value, fieldName, rowId);
  if (!Number.isInteger(numberValue)) {
    throw new Error(`row ${rowId} has non-integer ${fieldName}`);
  }
  return numberValue;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("metadata_json must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

function extractTags(metadata: Record<string, unknown>): string[] {
  const rawTags = metadata.tags;
  if (!Array.isArray(rawTags)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of rawTags) {
    if (typeof tag !== "string") {
      continue;
    }
    const value = tag.trim().toLowerCase();
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function parseEmbeddingBuffer(embeddingJson: string | null, rowId: number): Buffer | null {
  if (typeof embeddingJson !== "string" || embeddingJson.trim().length === 0) {
    return null;
  }
  return encodeEmbedding(parseEmbeddingNumbers(embeddingJson, rowId));
}

function parseEmbeddingNumbers(embeddingJson: string, rowId: number): number[] {
  const parsed = JSON.parse(embeddingJson) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`row ${rowId} has non-array embedding_json`);
  }

  return parsed.map((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`row ${rowId} has invalid embedding value at index ${index}`);
    }
    return value;
  });
}

function pickRandomItems<T>(values: T[], sampleSize: number): T[] {
  if (values.length <= sampleSize) {
    return [...values];
  }

  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex] as T;
    shuffled[swapIndex] = current as T;
  }

  return shuffled.slice(0, sampleSize);
}

function arrayEquals(left: number[] | null, right: number[]): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function logRowError(tableName: string, rowId: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[warn] Skipping ${tableName} row ${rowId}: ${message}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
