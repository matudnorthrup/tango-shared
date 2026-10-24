import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deserializeEmbedding, type EmbeddingProvider } from "./embeddings.js";
import { backfillMarkdownFiles } from "./memory-backfill.js";
import { resolveTangoProfileDir } from "./runtime-paths.js";
import { TangoStorage } from "./storage.js";

const LEGACY_VAULT_PATH = "~/Documents/main";
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const DEFAULT_EXCLUDED_PREFIXES = [
  ".obsidian/",
  "_Schema/",
  "Attachments/",
  "AI/Conversations/",
  "AI/Digests/",
  "AI/Insights/",
  "AI/Threads/",
  "Clippings/",
];

export interface ObsidianIndexInput {
  storage: TangoStorage;
  paths?: string[];
  chunkChars?: number;
  dryRun?: boolean;
  includeClippings?: boolean;
  includeAiTranscripts?: boolean;
  excludePrefixes?: string[];
  embeddingProvider?: EmbeddingProvider | null;
  secondarySink?: ObsidianIndexSecondarySink | null;
  now?: Date;
}

export interface IndexedObsidianFile {
  filePath: string;
  status: "new" | "updated";
  chunkCount: number;
  deletedMemoryCount: number;
}

export interface RemovedObsidianFile {
  filePath: string;
  deletedMemoryCount: number;
}

export interface ObsidianIndexResult {
  scannedFileCount: number;
  indexedFileCount: number;
  unchangedFileCount: number;
  removedFileCount: number;
  insertedMemoryCount: number;
  deletedMemoryCount: number;
  /** Inserted memories that received an embedding. */
  embeddedMemoryCount: number;
  /** Inserted memories left without an embedding after retries. */
  embedFailedCount: number;
  /** Unique embedding error messages (capped) for job summaries. */
  embedErrors: string[];
  /** Chunks mirrored into the secondary sink (Atlas), when one is configured. */
  sinkSyncedCount: number;
  /** Secondary-sink failures — sync is best-effort and never fails the index run. */
  sinkErrorCount: number;
  indexedFiles: IndexedObsidianFile[];
  removedFiles: RemovedObsidianFile[];
}

/** A chunk handed to the secondary sink, embedding included (computed upstream). */
export interface ObsidianSinkChunk {
  content: string;
  sourceRef: string;
  importance: number;
  metadata: Record<string, unknown> | null;
  embedding: number[] | null;
  embeddingModel: string | null;
  /** Content age from the source note (frontmatter date / file mtime). */
  createdAt: string | null;
}

/**
 * Optional mirror target for indexed chunks (e.g. the Atlas store) so agent
 * memory_search sees fresh vault content without re-embedding (TGO-691).
 */
export interface ObsidianIndexSecondarySink {
  prune(sourceRefPrefix: string): unknown;
  addChunks(chunks: ObsidianSinkChunk[]): unknown;
}

type PruneScope = {
  path: string;
  kind: "directory" | "file";
};

/**
 * Resolve the Obsidian vault root used across indexing and the agent-facing
 * obsidian tool: TANGO_OBSIDIAN_VAULT, then the profile notes dir, then the
 * legacy ~/Documents/main vault.
 */
export function resolveDefaultObsidianVaultPath(): string {
  const configured = process.env.TANGO_OBSIDIAN_VAULT?.trim();
  if (configured && configured.length > 0) {
    return configured;
  }

  const profileNotesPath = path.join(resolveTangoProfileDir(), "notes");
  if (fs.existsSync(profileNotesPath)) {
    return profileNotesPath;
  }

  const legacyVaultPath = expandHome(LEGACY_VAULT_PATH);
  if (fs.existsSync(legacyVaultPath)) {
    return LEGACY_VAULT_PATH;
  }

  return profileNotesPath;
}

export async function indexObsidianVault(
  input: ObsidianIndexInput
): Promise<ObsidianIndexResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const inputPaths = input.paths ?? [resolveDefaultObsidianVaultPath()];
  const files = collectEligibleFiles(inputPaths, {
    includeClippings: input.includeClippings === true,
    includeAiTranscripts: input.includeAiTranscripts === true,
    excludePrefixes: input.excludePrefixes ?? [],
  });
  const pruneScopes = resolvePruneScopes(inputPaths);
  const indexedEntries = input.storage.listObsidianIndexEntries(50_000);
  const indexedByPath = new Map(indexedEntries.map((entry) => [entry.filePath, entry]));
  const liveFiles = new Set(files);
  const result: ObsidianIndexResult = {
    scannedFileCount: files.length,
    indexedFileCount: 0,
    unchangedFileCount: 0,
    removedFileCount: 0,
    insertedMemoryCount: 0,
    deletedMemoryCount: 0,
    embeddedMemoryCount: 0,
    embedFailedCount: 0,
    embedErrors: [],
    sinkSyncedCount: 0,
    sinkErrorCount: 0,
    indexedFiles: [],
    removedFiles: [],
  };
  const embedErrors = new Set<string>();

  const syncToSink = (sourceRefPrefix: string, insertedIds: number[]): void => {
    if (!input.secondarySink) return;
    try {
      input.secondarySink.prune(sourceRefPrefix);
      const chunks: ObsidianSinkChunk[] = [];
      for (const memoryId of insertedIds) {
        const memory = input.storage.getMemory(memoryId);
        if (!memory?.sourceRef?.startsWith(sourceRefPrefix)) continue;
        chunks.push({
          content: memory.content,
          sourceRef: memory.sourceRef,
          importance: memory.importance,
          metadata: memory.metadata,
          embedding: deserializeEmbedding(memory.embeddingJson),
          embeddingModel: memory.embeddingModel,
          createdAt: memory.createdAt ?? null,
        });
      }
      if (chunks.length > 0) {
        input.secondarySink.addChunks(chunks);
        result.sinkSyncedCount += chunks.length;
      }
    } catch (error) {
      result.sinkErrorCount += 1;
      console.warn(
        `[tango-memory] obsidian secondary sink sync failed for ${sourceRefPrefix}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  for (const filePath of files) {
    const fileHash = hashFile(filePath);
    const existing = indexedByPath.get(filePath);
    if (existing?.fileHash === fileHash) {
      result.unchangedFileCount += 1;
      continue;
    }

    const status: "new" | "updated" = existing ? "updated" : "new";
    const sourceRefPrefix = buildSourceRefPrefix(filePath);

    if (input.dryRun) {
      result.indexedFileCount += 1;
      result.indexedFiles.push({
        filePath,
        status,
        chunkCount: existing?.chunkCount ?? 0,
        deletedMemoryCount: existing?.chunkCount ?? 0,
      });
      continue;
    }

    const deletedMemoryCount = input.storage.deleteMemoriesBySourceRefPrefix("obsidian", sourceRefPrefix);
    const backfillResult = await backfillMarkdownFiles({
      storage: input.storage,
      paths: [filePath],
      memorySource: "obsidian",
      chunkChars: input.chunkChars,
      embeddingProvider: input.embeddingProvider,
    });
    const chunkCount = backfillResult.insertedSourceRefs.filter((sourceRef) =>
      sourceRef.startsWith(sourceRefPrefix)
    ).length;

    input.storage.upsertObsidianIndexEntry({
      filePath,
      fileHash,
      chunkCount,
      lastIndexedAt: nowIso,
    });

    syncToSink(sourceRefPrefix, backfillResult.insertedIds);

    result.indexedFileCount += 1;
    result.insertedMemoryCount += backfillResult.insertedCount;
    result.deletedMemoryCount += deletedMemoryCount;
    result.embeddedMemoryCount += backfillResult.embeddedCount;
    result.embedFailedCount += backfillResult.embedFailedCount;
    for (const message of backfillResult.embedErrors) {
      if (embedErrors.size < 3) embedErrors.add(message);
    }
    result.indexedFiles.push({
      filePath,
      status,
      chunkCount,
      deletedMemoryCount,
    });
  }
  result.embedErrors = [...embedErrors];

  for (const entry of indexedEntries) {
    if (liveFiles.has(entry.filePath)) continue;
    if (!isFileInPruneScopes(entry.filePath, pruneScopes)) continue;

    if (input.dryRun) {
      result.removedFileCount += 1;
      result.removedFiles.push({
        filePath: entry.filePath,
        deletedMemoryCount: entry.chunkCount,
      });
      continue;
    }

    const removedSourceRefPrefix = buildSourceRefPrefix(entry.filePath);
    const deletedMemoryCount = input.storage.deleteMemoriesBySourceRefPrefix(
      "obsidian",
      removedSourceRefPrefix
    );
    input.storage.deleteObsidianIndexEntry(entry.filePath);
    syncToSink(removedSourceRefPrefix, []);

    result.removedFileCount += 1;
    result.deletedMemoryCount += deletedMemoryCount;
    result.removedFiles.push({
      filePath: entry.filePath,
      deletedMemoryCount,
    });
  }

  return result;
}

function resolvePruneScopes(inputs: string[]): PruneScope[] {
  return inputs.map((inputPath) => {
    const resolved = path.resolve(expandHome(inputPath));
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return { path: resolved, kind: "directory" };
    }
    return { path: resolved, kind: "file" };
  });
}

function isFileInPruneScopes(filePath: string, scopes: PruneScope[]): boolean {
  const resolvedFilePath = path.resolve(filePath);
  return scopes.some((scope) => {
    if (scope.kind === "file") {
      return resolvedFilePath === scope.path;
    }

    const relativePath = path.relative(scope.path, resolvedFilePath);
    return relativePath.length === 0
      || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  });
}

function collectEligibleFiles(
  inputs: string[],
  options: {
    includeClippings: boolean;
    includeAiTranscripts: boolean;
    excludePrefixes: string[];
  }
): string[] {
  const results = new Set<string>();

  for (const inputPath of inputs) {
    const resolved = path.resolve(expandHome(inputPath));
    if (!fs.existsSync(resolved)) continue;

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      walkDirectory(resolved, resolved, options, (filePath) => {
        results.add(filePath);
      });
      continue;
    }

    if (
      isMarkdownFile(resolved)
      && !path.basename(resolved).startsWith(".")
      && !isGeneratedObsidianProjection(fs.readFileSync(resolved, "utf8"))
    ) {
      results.add(resolved);
    }
  }

  return [...results].sort((left, right) => left.localeCompare(right));
}

function walkDirectory(
  rootPath: string,
  currentPath: string,
  options: {
    includeClippings: boolean;
    includeAiTranscripts: boolean;
    excludePrefixes: string[];
  },
  visit: (filePath: string) => void
): void {
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;

    const entryPath = path.join(currentPath, entry.name);
    const relativePath = toRelativePath(rootPath, entryPath);
    if (!shouldIncludeRelativePath(relativePath, options)) continue;

    if (entry.isDirectory()) {
      walkDirectory(rootPath, entryPath, options, visit);
      continue;
    }

    if (
      entry.isFile()
      && isMarkdownFile(entryPath)
      && !isGeneratedObsidianProjection(fs.readFileSync(entryPath, "utf8"))
    ) {
      visit(entryPath);
    }
  }
}

function shouldIncludeRelativePath(
  relativePath: string,
  options: {
    includeClippings: boolean;
    includeAiTranscripts: boolean;
    excludePrefixes: string[];
  }
): boolean {
  const normalized = relativePath.replace(/\\/gu, "/");
  if (normalized.length === 0) return false;
  if (normalized.split("/").some((segment) => segment.startsWith(".") || segment.startsWith(".!"))) {
    return false;
  }

  const excludedPrefixes = [...DEFAULT_EXCLUDED_PREFIXES, ...options.excludePrefixes]
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => prefix.replace(/\\/gu, "/").replace(/^\/+/u, ""));

  for (const prefix of excludedPrefixes) {
    if (prefix === "Clippings/" && options.includeClippings) continue;
    if (
      (prefix === "AI/Conversations/" ||
        prefix === "AI/Digests/" ||
        prefix === "AI/Insights/" ||
        prefix === "AI/Threads/") &&
      options.includeAiTranscripts
    ) {
      continue;
    }

    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) {
      return false;
    }
  }

  return true;
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isMarkdownFile(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Generated state views are read-only projections, not narrative memory. */
export function isGeneratedObsidianProjection(content: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  if (!frontmatter) return false;
  return /^read_only_projection:\s*(?:true|["']true["'])\s*$/imu.test(frontmatter)
    || /^tango_view:\s*\S.*$/imu.test(frontmatter);
}

function buildSourceRefPrefix(filePath: string): string {
  return `obsidian:${filePath}#`;
}

function toRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join("/");
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return process.env.HOME ?? inputPath;
  if (inputPath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", inputPath.slice(2));
  }
  return inputPath;
}
