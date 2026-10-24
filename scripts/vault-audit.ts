#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

type Severity = "info" | "review" | "warning";

interface CliOptions {
  vaultPath: string;
  dbPath?: string;
  outputPath: string;
  summaryJsonPath?: string;
  maxExamples: number;
  writeReport: boolean;
}

interface Finding {
  code: string;
  severity: Severity;
  message: string;
  filePath?: string;
  detail?: string;
  suggestion?: string;
}

interface NoteRecord {
  filePath: string;
  relativePath: string;
  title: string;
  frontmatter: Record<string, unknown> | null;
  frontmatterError?: string;
  hasFrontmatter: boolean;
  inlineHashtags: string[];
}

interface SchemaCatalog {
  areas: Set<string>;
  types: Set<string>;
  categories: Set<string>;
  noteNames: Set<string>;
  noteTargets: Set<string>;
}

interface AtlasAuditResult {
  dbPath: string;
  available: boolean;
  skippedReason?: string;
  indexRows: number;
  memoryRows: number;
  staleIndexRows: number;
  missingIndexFiles: number;
  missingMemorySourceFiles: number;
  promotionCandidateRows: number | null;
  findings: Finding[];
}

interface TagSummary {
  filesWithFrontmatterTagField: number;
  filesWithFrontmatterTags: number;
  uniqueFrontmatterTags: number;
  frontmatterTagCounts: Map<string, number>;
  inlineHashtagTotal: number;
  uniqueInlineHashtags: number;
  inlineHashtagCounts: Map<string, number>;
}

interface JsonFinding {
  code: string;
  severity: Severity;
  message: string;
  filePath?: string;
  relativePath?: string;
  detail?: string;
  suggestion?: string;
}

interface VaultAuditJsonSummary {
  generatedAt: string;
  vaultPath: string;
  dbPath: string;
  reportPath: string | null;
  notesScanned: number;
  schema: {
    areas: number;
    types: number;
    categories: number;
  };
  tags: {
    filesWithFrontmatterTagField: number;
    filesWithFrontmatterTags: number;
    uniqueFrontmatterTags: number;
    inlineHashtagTotal: number;
    uniqueInlineHashtags: number;
  };
  findings: {
    total: number;
    warnings: number;
    review: number;
    info: number;
    byCode: Record<string, number>;
    items: JsonFinding[];
  };
  atlas: {
    available: boolean;
    skippedReason?: string;
    indexRows: number;
    memoryRows: number;
    staleIndexRows: number;
    missingIndexFiles: number;
    missingMemorySourceFiles: number;
    promotionCandidateRows: number | null;
  };
}

const DEFAULT_VAULT_PATH = process.env.TANGO_OBSIDIAN_VAULT ?? "";
const DEFAULT_OUTPUT_DIR = "data/reports";
const REQUIRED_FRONTMATTER_FIELDS = ["date", "types", "areas"];
const LIST_WIKILINK_FIELDS = ["types", "areas", "categories", "collections"];
const STRUCTURED_NOTE_EXCLUDED_PREFIXES = [
  ".obsidian/",
  "_Schema/",
  "Attachments/",
  "Clippings/",
];
const WORKFLOW_FOLDERS = new Set([
  ".obsidian",
  "_Schema",
  "Attachments",
  "Clippings",
  "Planning",
  "Records",
  "References",
]);
const FOLDERS_TO_RECONCILE = new Set([
  "Projects",
  "Health",
  "Travel",
  "Workouts",
  "Tango",
  "Work",
  "Skills",
  "Templates",
]);
const APPROVED_AREAS = new Set([
  "Home",\n  "Work",\n  "Health",\n  "Finance",\n  "Personal",\n  "Tango",
]);
const APPROVED_TYPES = new Set([
  "Backlog",
  "Brief",
  "Daily Note",
  "Draft",
  "Financial Review",
  "Framework",
  "Health Daily",
  "Indexes",
  "Ingredients",
  "Journal",
  "Reading Plan",
  "Maintenance Record",
  "Person",
  "Process",
  "Project Plan",
  "Quarterly Plan",
  "Receipt",
  "Recipes",
  "Record",
  "Reference",
  "Research",
  "Weekly Plan",
  "Wiki Summary",
]);
const DISCOURAGED_AREA_SUGGESTIONS = new Map([
  [
    "Travel",
    "Do not create _Schema/Areas/Travel.md. Use a specific approved area, and put the trip/event under `collections`.",
  ],
  [
    "Projects",
    "Do not create _Schema/Areas/Projects.md. Use a specific approved area and `collections` for the finite project or initiative.",
  ],
  [
    "Work",
    "Do not create _Schema/Areas/Work.md. Use a specific approved area such as [[Acme]], [[Tango]], [[Sideproject]], [[Personal]], or [[Home]].",
  ],
]);
const DISCOURAGED_TYPE_SUGGESTIONS = new Map([
  [
    "Planning",
    "Do not create _Schema/Types/Planning.md. Use [[Project Plan]] for trip/project plans, or the specific temporal type for daily/weekly/quarterly planning notes.",
  ],
  [
    "Project",
    "Do not create _Schema/Types/Project.md. Use [[Project Plan]] for active plans or [[Reference]] for stable reference material.",
  ],
]);

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const vaultPath = path.resolve(expandHome(options.vaultPath));
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    throw new Error(`Vault path does not exist or is not a directory: ${vaultPath}`);
  }

  const notes = collectMarkdownNotes(vaultPath);
  const schema = collectSchemaCatalog(vaultPath, notes);
  const findings = auditNotes(vaultPath, notes, schema);
  const atlas = auditAtlas({
    dbPath: options.dbPath ? path.resolve(expandHome(options.dbPath)) : resolveDatabasePath(),
    vaultPath,
  });

  const generatedAt = new Date();
  const report = renderReport({
    generatedAt,
    vaultPath,
    notes,
    schema,
    findings,
    atlas,
    maxExamples: options.maxExamples,
  });

  if (options.writeReport) {
    const outputPath = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, report);
    console.log(`Wrote vault audit report: ${outputPath}`);
  } else {
    console.log(report);
  }

  if (options.summaryJsonPath) {
    const summaryPath = path.resolve(options.summaryJsonPath);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(
      summaryPath,
      `${JSON.stringify(buildJsonSummary({
        generatedAt,
        vaultPath,
        dbPath: atlas.dbPath,
        reportPath: options.writeReport ? path.resolve(options.outputPath) : null,
        notes,
        schema,
        findings,
        atlas,
      }), null, 2)}\n`,
    );
  }
}

function parseArgs(args: string[]): CliOptions {
  const today = new Date().toISOString().slice(0, 10);
  const options: CliOptions = {
    vaultPath: DEFAULT_VAULT_PATH,
    outputPath: path.join(DEFAULT_OUTPUT_DIR, `vault-audit-${today}.md`),
    maxExamples: 25,
    writeReport: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case "--vault":
      case "--vault-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.vaultPath = next;
        index += 1;
        break;
      case "--db":
      case "--db-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.dbPath = next;
        index += 1;
        break;
      case "--output":
      case "--output-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.outputPath = next;
        index += 1;
        break;
      case "--summary-json":
      case "--summary-json-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.summaryJsonPath = next;
        index += 1;
        break;
      case "--max-examples":
        if (!next) throw new Error("--max-examples requires a value");
        options.maxExamples = parsePositiveInteger(next, "--max-examples");
        index += 1;
        break;
      case "--stdout":
        options.writeReport = false;
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

function collectMarkdownNotes(vaultPath: string): NoteRecord[] {
  const files = walkMarkdownFiles(vaultPath);
  return files.map((filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = parseFrontmatter(content);
    return {
      filePath,
      relativePath: toVaultRelativePath(vaultPath, filePath),
      title: extractTitle(content, filePath),
      frontmatter: parsed.frontmatter,
      frontmatterError: parsed.error,
      hasFrontmatter: parsed.hasFrontmatter,
      inlineHashtags: extractInlineHashtags(stripFrontmatter(content)),
    };
  });
}

function collectSchemaCatalog(vaultPath: string, notes: NoteRecord[]): SchemaCatalog {
  return {
    areas: collectSchemaNames(path.join(vaultPath, "_Schema", "Areas")),
    types: collectSchemaNames(path.join(vaultPath, "_Schema", "Types")),
    categories: collectSchemaNames(path.join(vaultPath, "_Schema", "Categories")),
    noteNames: new Set(notes.map((note) => path.basename(note.filePath, path.extname(note.filePath)))),
    noteTargets: collectNoteTargets(notes),
  };
}

function auditNotes(
  vaultPath: string,
  notes: NoteRecord[],
  schema: SchemaCatalog,
): Finding[] {
  const findings: Finding[] = auditSchemaCatalog(vaultPath, schema);
  const duplicateTitleMap = new Map<string, NoteRecord[]>();
  const categoryUsageMap = new Map<string, NoteRecord[]>();

  for (const note of notes) {
    const normalizedTitle = normalizeTitle(note.title);
    if (normalizedTitle) {
      const existing = duplicateTitleMap.get(normalizedTitle) ?? [];
      existing.push(note);
      duplicateTitleMap.set(normalizedTitle, existing);
    }

    if (note.frontmatterError) {
      findings.push({
        code: "frontmatter.invalid",
        severity: "warning",
        filePath: note.filePath,
        message: "Frontmatter could not be parsed as YAML.",
        detail: note.frontmatterError,
        suggestion: "Fix YAML before automated cleanup touches this note.",
      });
      continue;
    }

    if (isStructuredNoteCandidate(note.relativePath)) {
      if (!note.hasFrontmatter) {
        findings.push({
          code: "frontmatter.missing",
          severity: "review",
          filePath: note.filePath,
          message: "Structured note candidate has no frontmatter.",
          suggestion: "Add date, types, and areas if this should be a durable structured note.",
        });
      } else {
        for (const field of REQUIRED_FRONTMATTER_FIELDS) {
          if (!hasFrontmatterField(note.frontmatter, field)) {
            findings.push({
              code: "frontmatter.required_missing",
              severity: "review",
              filePath: note.filePath,
              message: `Missing required frontmatter field: ${field}.`,
              suggestion: "Add the field or mark the note as an explicit exception in the maintenance pass.",
            });
          }
        }
      }
    }

    for (const field of LIST_WIKILINK_FIELDS) {
      const value = note.frontmatter?.[field];
      if (value === undefined || value === null) continue;
      if (!Array.isArray(value)) {
        findings.push({
          code: "frontmatter.list_expected",
          severity: "review",
          filePath: note.filePath,
          message: `Frontmatter field '${field}' should be a list.`,
          detail: `Actual value: ${JSON.stringify(value)}`,
          suggestion: "Use a YAML list of wikilinks.",
        });
        continue;
      }

      for (const item of value) {
        if (typeof item !== "string") {
          findings.push({
            code: "frontmatter.list_item_invalid",
            severity: "review",
            filePath: note.filePath,
            message: `Frontmatter field '${field}' contains a non-string item.`,
            detail: JSON.stringify(item),
          });
          continue;
        }

        const linkTarget = extractSingleWikilinkTarget(item);
        if (!linkTarget) {
          findings.push({
            code: "frontmatter.wikilink_expected",
            severity: "review",
            filePath: note.filePath,
            message: `Frontmatter field '${field}' item is not a wikilink.`,
            detail: item,
            suggestion: `Use "[[${item.replace(/^\[+|\]+$/gu, "")}]]" if this is meant to be a schema link.`,
          });
          continue;
        }

        if (field === "types" && !APPROVED_TYPES.has(linkTarget)) {
          findings.push({
            code: "schema.type_unapproved",
            severity: "review",
            filePath: note.filePath,
            message: `Type is not approved in the vault design: [[${linkTarget}]].`,
            suggestion: schemaTypeSuggestion(linkTarget),
          });
        } else if (field === "types" && !schema.types.has(linkTarget)) {
          findings.push({
            code: "schema.type_missing",
            severity: "review",
            filePath: note.filePath,
            message: `Type schema note is missing: [[${linkTarget}]].`,
            suggestion: `Add _Schema/Types/${linkTarget}.md only if the taxonomy is intentionally approved; otherwise update the note to use an existing type.`,
          });
        }

        if (field === "areas" && !APPROVED_AREAS.has(linkTarget)) {
          findings.push({
            code: "schema.area_unapproved",
            severity: "review",
            filePath: note.filePath,
            message: `Area is not approved in the vault design: [[${linkTarget}]].`,
            suggestion: schemaAreaSuggestion(linkTarget),
          });
        } else if (field === "areas" && !schema.areas.has(linkTarget)) {
          findings.push({
            code: "schema.area_missing",
            severity: "review",
            filePath: note.filePath,
            message: `Area schema note is missing: [[${linkTarget}]].`,
            suggestion: `Add _Schema/Areas/${linkTarget}.md only if the taxonomy is intentionally approved; otherwise update the note to use an existing area.`,
          });
        }

        if (field === "categories" && !schema.categories.has(linkTarget)) {
          findings.push({
            code: "schema.category_missing",
            severity: "review",
            filePath: note.filePath,
            message: `Category schema note is missing: [[${linkTarget}]].`,
            suggestion: "Remove the category or migrate it to an area, collection, field, or body link.",
          });
        }

        if (field === "categories") {
          const existing = categoryUsageMap.get(linkTarget) ?? [];
          existing.push(note);
          categoryUsageMap.set(linkTarget, existing);
        }

        if (field === "collections" && !schema.noteTargets.has(linkTarget)) {
          findings.push({
            code: "collection.hub_missing",
            severity: "review",
            filePath: note.filePath,
            message: `Collection hub note is missing: [[${linkTarget}]].`,
            suggestion: "Create the hub note or update the collection link.",
          });
        }
      }
    }

    const sourceKind = readStringFrontmatter(note.frontmatter, "source_kind");
    if (sourceKind === "derived" && !hasAnyFrontmatterField(note.frontmatter, ["sources", "atlas_refs"])) {
      findings.push({
        code: "derived.provenance_missing",
        severity: "review",
        filePath: note.filePath,
        message: "Derived note has no sources or atlas_refs.",
        suggestion: "Add provenance or reclassify source_kind.",
      });
    }

    const tagAudit = auditFrontmatterTags(note);
    findings.push(...tagAudit);

    const topFolder = note.relativePath.split("/")[0] ?? "";
    if (FOLDERS_TO_RECONCILE.has(topFolder)) {
      findings.push({
        code: topFolder === "Templates" ? "folder.legacy_templates" : "folder.reconcile_candidate",
        severity: "review",
        filePath: note.filePath,
        message: `Note is inside folder marked for reconciliation: ${topFolder}/.`,
        suggestion: suggestReconciliationTarget(note.relativePath),
      });
    } else if (topFolder && !WORKFLOW_FOLDERS.has(topFolder) && note.relativePath.includes("/")) {
      findings.push({
        code: "folder.unknown_top_level",
        severity: "info",
        filePath: note.filePath,
        message: `Note is inside an undocumented top-level folder: ${topFolder}/.`,
        suggestion: "Document this folder as a workflow boundary or reconcile it.",
      });
    }
  }

  for (const [normalizedTitle, titleNotes] of duplicateTitleMap.entries()) {
    if (titleNotes.length < 2) continue;
    if (isIntentionalDuplicateTitleGroup(normalizedTitle, titleNotes)) continue;
    findings.push({
      code: "duplicate.title",
      severity: "review",
      message: `Possible duplicate title: ${normalizedTitle}`,
      detail: titleNotes.map((note) => note.relativePath).join("\n"),
      suggestion: "Review whether these are true duplicates, related notes, or intentionally separate records.",
    });
  }

  for (const [category, categoryNotes] of categoryUsageMap.entries()) {
    findings.push({
      code: "categories.deprecated",
      severity: "review",
      message: `Deprecated category is still used: [[${category}]] (${categoryNotes.length} note(s)).`,
      detail: categoryNotes.slice(0, 10).map((note) => note.relativePath).join("\n"),
      suggestion: "Migrate the grouping to areas, collections, explicit fields, or body links; then remove categories from those notes.",
    });
  }

  if (fs.existsSync(path.join(vaultPath, "Templates"))) {
    findings.push({
      code: "folder.legacy_templates_root",
      severity: "review",
      filePath: path.join(vaultPath, "Templates"),
      message: "Legacy Templates/ folder still exists.",
      suggestion: "Reconcile with _Schema/Templates/ before removing.",
    });
  }

  return findings;
}

function auditSchemaCatalog(vaultPath: string, schema: SchemaCatalog): Finding[] {
  const findings: Finding[] = [];

  for (const area of schema.areas) {
    if (APPROVED_AREAS.has(area)) continue;
    findings.push({
      code: "schema.area_schema_unapproved",
      severity: "review",
      filePath: path.join(vaultPath, "_Schema", "Areas", `${area}.md`),
      message: `Area schema note is not approved in the vault design: [[${area}]].`,
      suggestion: schemaAreaSuggestion(area),
    });
  }

  for (const type of schema.types) {
    if (APPROVED_TYPES.has(type)) continue;
    findings.push({
      code: "schema.type_schema_unapproved",
      severity: "review",
      filePath: path.join(vaultPath, "_Schema", "Types", `${type}.md`),
      message: `Type schema note is not approved in the vault design: [[${type}]].`,
      suggestion: schemaTypeSuggestion(type),
    });
  }

  return findings;
}

function schemaAreaSuggestion(area: string): string {
  return DISCOURAGED_AREA_SUGGESTIONS.get(area)
    ?? `Do not create or keep _Schema/Areas/${area}.md unless the owner approves it as a durable area; update notes to an approved area when possible.`;
}

function schemaTypeSuggestion(type: string): string {
  return DISCOURAGED_TYPE_SUGGESTIONS.get(type)
    ?? `Do not create or keep _Schema/Types/${type}.md unless the owner approves it as a durable artifact type; update notes to an approved type when possible.`;
}

function auditAtlas(input: { dbPath: string; vaultPath: string }): AtlasAuditResult {
  const result: AtlasAuditResult = {
    dbPath: input.dbPath,
    available: false,
    indexRows: 0,
    memoryRows: 0,
    staleIndexRows: 0,
    missingIndexFiles: 0,
    missingMemorySourceFiles: 0,
    promotionCandidateRows: null,
    findings: [],
  };

  if (!fs.existsSync(input.dbPath)) {
    return {
      ...result,
      skippedReason: "Tango SQLite database was not found.",
    };
  }

  try {
    result.available = true;

    if (tableExists(input.dbPath, "obsidian_index")) {
      const rows = sqliteJson(input.dbPath, `
        SELECT file_path AS filePath, file_hash AS fileHash, last_indexed_at AS lastIndexedAt
        FROM obsidian_index
      `) as Array<{ filePath: string; fileHash: string; lastIndexedAt: string }>;
      result.indexRows = rows.length;

      for (const row of rows) {
        if (!fs.existsSync(row.filePath)) {
          result.missingIndexFiles += 1;
          result.findings.push({
            code: "atlas.index_file_missing",
            severity: "warning",
            filePath: row.filePath,
            message: "Obsidian index points to a missing file.",
            detail: `Last indexed: ${row.lastIndexedAt}`,
            suggestion: "Run the Obsidian indexer after vault cleanup or delete stale index entries through the normal index refresh path.",
          });
          continue;
        }

        const currentHash = hashFile(row.filePath);
        if (currentHash !== row.fileHash) {
          result.staleIndexRows += 1;
          result.findings.push({
            code: "atlas.index_hash_stale",
            severity: "info",
            filePath: row.filePath,
            message: "Obsidian index hash differs from the current file hash.",
            detail: `Last indexed: ${row.lastIndexedAt}`,
            suggestion: "Run memory:index:obsidian after reviewable vault edits.",
          });
        }
      }
    }

    if (tableExists(input.dbPath, "memories")) {
      const rows = sqliteJson(input.dbPath, `
        SELECT id, source_ref AS sourceRef
        FROM memories
        WHERE source = 'obsidian'
          AND source_ref IS NOT NULL
      `) as Array<{ id: number; sourceRef: string }>;
      result.memoryRows = rows.length;

      const missingSourceRefs = new Set<string>();
      for (const row of rows) {
        const filePath = parseObsidianSourceRefPath(row.sourceRef);
        if (!filePath) continue;
        if (!fs.existsSync(filePath)) {
          missingSourceRefs.add(filePath);
        }
      }

      result.missingMemorySourceFiles = missingSourceRefs.size;
      for (const filePath of missingSourceRefs) {
        result.findings.push({
          code: "atlas.memory_source_missing",
          severity: "warning",
          filePath,
          message: "Obsidian memory source_ref points to a missing file.",
          suggestion: "Run the Obsidian index refresh after vault moves so derived memories are rebuilt.",
        });
      }
    }

    const promotionTable = ["promotion_candidates", "memory_promotion_candidates"]
      .find((tableName) => tableExists(input.dbPath, tableName));
    if (promotionTable) {
      const [row] = sqliteJson(
        input.dbPath,
        `SELECT COUNT(*) AS total FROM ${promotionTable}`,
      ) as Array<{ total: number }>;
      result.promotionCandidateRows = Number(row?.total) || 0;
    }
  } catch (error) {
    return {
      ...result,
      available: false,
      skippedReason: error instanceof Error ? error.message : String(error),
    };
  }

  return result;
}

function renderReport(input: {
  generatedAt: Date;
  vaultPath: string;
  notes: NoteRecord[];
  schema: SchemaCatalog;
  findings: Finding[];
  atlas: AtlasAuditResult;
  maxExamples: number;
}): string {
  const allFindings = [...input.findings, ...input.atlas.findings];
  const byCode = groupFindingsByCode(allFindings);
  const severityCounts = countBy(allFindings, (finding) => finding.severity);
  const topFolderCounts = countTopFolders(input.notes);
  const tagSummary = summarizeTags(input.notes);
  const lines: string[] = [];

  lines.push(`# Vault Audit Report - ${input.generatedAt.toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`Generated: ${input.generatedAt.toISOString()}`);
  lines.push(`Vault: \`${input.vaultPath}\``);
  lines.push(`Tango DB: \`${input.atlas.dbPath}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("| --- | ---: |");
  lines.push(`| Markdown notes scanned | ${input.notes.length} |`);
  lines.push(`| Schema areas | ${input.schema.areas.size} |`);
  lines.push(`| Schema types | ${input.schema.types.size} |`);
  lines.push(`| Schema categories | ${input.schema.categories.size} |`);
  lines.push(`| Files with tags field | ${tagSummary.filesWithFrontmatterTagField} |`);
  lines.push(`| Files with non-empty frontmatter tags | ${tagSummary.filesWithFrontmatterTags} |`);
  lines.push(`| Unique frontmatter tags | ${tagSummary.uniqueFrontmatterTags} |`);
  lines.push(`| Inline hashtag occurrences | ${tagSummary.inlineHashtagTotal} |`);
  lines.push(`| Unique inline hashtags | ${tagSummary.uniqueInlineHashtags} |`);
  lines.push(`| Findings | ${allFindings.length} |`);
  lines.push(`| Warnings | ${severityCounts.get("warning") ?? 0} |`);
  lines.push(`| Review items | ${severityCounts.get("review") ?? 0} |`);
  lines.push(`| Info items | ${severityCounts.get("info") ?? 0} |`);
  lines.push(`| Atlas index rows | ${input.atlas.indexRows} |`);
  lines.push(`| Atlas stale index rows | ${input.atlas.staleIndexRows} |`);
  lines.push(`| Atlas missing indexed files | ${input.atlas.missingIndexFiles} |`);
  lines.push(`| Atlas missing memory source files | ${input.atlas.missingMemorySourceFiles} |`);
  lines.push("");

  if (!input.atlas.available) {
    lines.push(`Atlas audit skipped: ${input.atlas.skippedReason ?? "database unavailable"}`);
    lines.push("");
  } else if (input.atlas.promotionCandidateRows === null) {
    lines.push("Promotion candidate audit skipped: no promotion candidate table exists yet.");
    lines.push("");
  } else {
    lines.push(`Promotion candidate rows: ${input.atlas.promotionCandidateRows}`);
    lines.push("");
  }

  lines.push("## Top-Level Folder Counts");
  lines.push("");
  lines.push("| Folder | Notes |");
  lines.push("| --- | ---: |");
  for (const [folder, count] of [...topFolderCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`| ${folder || "(root)"} | ${count} |`);
  }
  lines.push("");

  lines.push("## Tag Summary");
  lines.push("");
  lines.push("Frontmatter tags and categories are cleanup candidates under the vault design. Inline hashtags are summarized for visibility only because many are source/log content such as Slack channels or social posts.");
  lines.push("");
  lines.push("### Frontmatter Tags");
  lines.push("");
  lines.push("| Tag | Count |");
  lines.push("| --- | ---: |");
  for (const [tag, count] of topEntries(tagSummary.frontmatterTagCounts, 40)) {
    lines.push(`| ${tag} | ${count} |`);
  }
  if (tagSummary.frontmatterTagCounts.size === 0) {
    lines.push("| none | 0 |");
  }
  lines.push("");
  lines.push("### Inline Hashtags");
  lines.push("");
  lines.push("| Hashtag | Count |");
  lines.push("| --- | ---: |");
  for (const [tag, count] of topEntries(tagSummary.inlineHashtagCounts, 25)) {
    lines.push(`| #${tag} | ${count} |`);
  }
  if (tagSummary.inlineHashtagCounts.size === 0) {
    lines.push("| none | 0 |");
  }
  lines.push("");

  lines.push("## Findings By Check");
  lines.push("");
  for (const [code, findings] of [...byCode.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    lines.push(`### ${code} (${findings.length})`);
    lines.push("");
    lines.push(`Severity: \`${highestSeverity(findings)}\``);
    lines.push("");
    for (const finding of findings.slice(0, input.maxExamples)) {
      lines.push(formatFinding(finding, input.vaultPath));
    }
    if (findings.length > input.maxExamples) {
      lines.push(`- ... ${findings.length - input.maxExamples} more omitted from this section`);
    }
    lines.push("");
  }

  lines.push("## Suggested Next Steps");
  lines.push("");
  lines.push("1. Review warnings first, especially broken frontmatter and missing Atlas source files.");
  lines.push("2. Treat unapproved or missing schema findings as note-repair candidates first; add schema files only after the taxonomy is intentionally approved.");
  lines.push("3. Review frontmatter tags/categories and migrate useful meaning into types, areas, collections, fields, or links.");
  lines.push("4. Review folder reconciliation candidates by folder, starting with the smallest folders.");
  lines.push("5. Make one small migration batch, then run this audit again.");
  lines.push("6. Refresh the Obsidian index after approved moves or edits.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function buildJsonSummary(input: {
  generatedAt: Date;
  vaultPath: string;
  dbPath: string;
  reportPath: string | null;
  notes: NoteRecord[];
  schema: SchemaCatalog;
  findings: Finding[];
  atlas: AtlasAuditResult;
}): VaultAuditJsonSummary {
  const allFindings = [...input.findings, ...input.atlas.findings];
  const severityCounts = countBy(allFindings, (finding) => finding.severity);
  const byCode = groupFindingsByCode(allFindings);
  const tagSummary = summarizeTags(input.notes);

  return {
    generatedAt: input.generatedAt.toISOString(),
    vaultPath: input.vaultPath,
    dbPath: input.dbPath,
    reportPath: input.reportPath,
    notesScanned: input.notes.length,
    schema: {
      areas: input.schema.areas.size,
      types: input.schema.types.size,
      categories: input.schema.categories.size,
    },
    tags: {
      filesWithFrontmatterTagField: tagSummary.filesWithFrontmatterTagField,
      filesWithFrontmatterTags: tagSummary.filesWithFrontmatterTags,
      uniqueFrontmatterTags: tagSummary.uniqueFrontmatterTags,
      inlineHashtagTotal: tagSummary.inlineHashtagTotal,
      uniqueInlineHashtags: tagSummary.uniqueInlineHashtags,
    },
    findings: {
      total: allFindings.length,
      warnings: severityCounts.get("warning") ?? 0,
      review: severityCounts.get("review") ?? 0,
      info: severityCounts.get("info") ?? 0,
      byCode: Object.fromEntries(
        [...byCode.entries()].map(([code, findings]) => [code, findings.length]),
      ),
      items: allFindings.map((finding) => toJsonFinding(finding, input.vaultPath)),
    },
    atlas: {
      available: input.atlas.available,
      skippedReason: input.atlas.skippedReason,
      indexRows: input.atlas.indexRows,
      memoryRows: input.atlas.memoryRows,
      staleIndexRows: input.atlas.staleIndexRows,
      missingIndexFiles: input.atlas.missingIndexFiles,
      missingMemorySourceFiles: input.atlas.missingMemorySourceFiles,
      promotionCandidateRows: input.atlas.promotionCandidateRows,
    },
  };
}

function toJsonFinding(finding: Finding, vaultPath: string): JsonFinding {
  return {
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    filePath: finding.filePath,
    relativePath: finding.filePath ? toDisplayPath(finding.filePath, vaultPath) : undefined,
    detail: finding.detail,
    suggestion: finding.suggestion,
  };
}

function walkMarkdownFiles(rootPath: string): string[] {
  const results: string[] = [];

  function visit(currentPath: string): void {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && [".md", ".markdown"].includes(path.extname(entry.name).toLowerCase())) {
        results.push(entryPath);
      }
    }
  }

  visit(rootPath);
  return results.sort((left, right) => left.localeCompare(right));
}

function parseFrontmatter(content: string): {
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown> | null;
  error?: string;
} {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { hasFrontmatter: false, frontmatter: null };
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) {
    return {
      hasFrontmatter: true,
      frontmatter: null,
      error: "Opening frontmatter delimiter exists, but closing delimiter was not found.",
    };
  }

  try {
    const parsed = yaml.load(match[1] ?? "");
    if (parsed === null || parsed === undefined) {
      return { hasFrontmatter: true, frontmatter: {} };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        hasFrontmatter: true,
        frontmatter: null,
        error: "Frontmatter root must be a mapping/object.",
      };
    }
    return { hasFrontmatter: true, frontmatter: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      hasFrontmatter: true,
      frontmatter: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractTitle(_content: string, filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function collectSchemaNames(schemaDir: string): Set<string> {
  if (!fs.existsSync(schemaDir)) return new Set();
  return new Set(
    fs.readdirSync(schemaDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.basename(name, ".md")),
  );
}

function collectNoteTargets(notes: NoteRecord[]): Set<string> {
  const targets = new Set<string>();
  for (const note of notes) {
    const relativeWithoutExtension = note.relativePath.replace(/\.[^.]+$/u, "");
    targets.add(relativeWithoutExtension);
    targets.add(path.basename(note.filePath, path.extname(note.filePath)));
  }
  return targets;
}

function isStructuredNoteCandidate(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/gu, "/");
  return !STRUCTURED_NOTE_EXCLUDED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function hasFrontmatterField(frontmatter: Record<string, unknown> | null, field: string): boolean {
  if (!frontmatter) return false;
  const value = frontmatter[field];
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function hasAnyFrontmatterField(
  frontmatter: Record<string, unknown> | null,
  fields: string[],
): boolean {
  return fields.some((field) => hasFrontmatterField(frontmatter, field));
}

function auditFrontmatterTags(note: NoteRecord): Finding[] {
  const frontmatter = note.frontmatter;
  if (!frontmatter || !hasOwnKey(frontmatter, "tags")) return [];

  const findings: Finding[] = [];
  const extracted = extractFrontmatterTags(frontmatter.tags);
  const normalizedTags = extracted.tags
    .map((tag) => normalizeKnowledgeKey(tag))
    .filter(isPresent);
  const uniqueTags = uniqueValues(normalizedTags);

  if (extracted.invalidReason) {
    findings.push({
      code: "tags.frontmatter_invalid",
      severity: "review",
      filePath: note.filePath,
      message: "Frontmatter tags field is not a clean YAML list of strings.",
      detail: extracted.invalidReason,
      suggestion: "Migrate any useful meaning into types, areas, collections, fields, or direct links, then remove tags.",
    });
  }

  if (uniqueTags.length === 0) {
    findings.push({
      code: "tags.frontmatter_empty",
      severity: "review",
      filePath: note.filePath,
      message: "Frontmatter contains an empty tags field.",
      suggestion: "Remove the empty tags field.",
    });
    return findings;
  }

  findings.push({
    code: "tags.frontmatter_present",
    severity: "review",
    filePath: note.filePath,
    message: "Frontmatter tags are present even though tags are deprecated in the vault design.",
    detail: uniqueTags.map((tag) => `#${tag}`).join(", "),
    suggestion: "Migrate durable meaning to types, areas, collections, fields, or direct links, then remove tags.",
  });

  const duplicateTags = duplicatedValues(normalizedTags);
  if (duplicateTags.length > 0) {
    findings.push({
      code: "tags.duplicate_in_note",
      severity: "review",
      filePath: note.filePath,
      message: "Frontmatter tags contain duplicates after normalization.",
      detail: duplicateTags.map((tag) => `#${tag}`).join(", "),
      suggestion: "Remove duplicated tags during tag cleanup.",
    });
  }

  const propertyValues = normalizedFrontmatterValues(frontmatter, LIST_WIKILINK_FIELDS);
  const overlappingTags = uniqueTags.filter((tag) => propertyValues.has(tag));
  if (overlappingTags.length > 0) {
    findings.push({
      code: "tags.duplicate_properties",
      severity: "review",
      filePath: note.filePath,
      message: "Frontmatter tags duplicate types, areas, categories, or collections.",
      detail: overlappingTags.map((tag) => `#${tag}`).join(", "),
      suggestion: "Keep the structured property and remove the tag.",
    });
  }

  return findings;
}

function extractFrontmatterTags(value: unknown): { tags: string[]; invalidReason?: string } {
  if (value === undefined || value === null) return { tags: [] };

  if (typeof value === "string") {
    return {
      tags: splitTagString(value),
      invalidReason: "Expected tags to be absent. If temporarily retained, tags should be a YAML list rather than a scalar string.",
    };
  }

  if (!Array.isArray(value)) {
    return {
      tags: [],
      invalidReason: `Expected a YAML list of strings or no tags field; found ${typeof value}.`,
    };
  }

  const tags: string[] = [];
  const invalidItems: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      tags.push(...splitTagString(item));
    } else if (item !== null && item !== undefined) {
      invalidItems.push(JSON.stringify(item));
    }
  }

  if (invalidItems.length > 0) {
    return {
      tags,
      invalidReason: `Non-string tag values: ${invalidItems.slice(0, 5).join(", ")}`,
    };
  }

  return { tags };
}

function summarizeTags(notes: NoteRecord[]): TagSummary {
  const frontmatterTagCounts = new Map<string, number>();
  const inlineHashtagCounts = new Map<string, number>();
  let filesWithFrontmatterTagField = 0;
  let filesWithFrontmatterTags = 0;
  let inlineHashtagTotal = 0;

  for (const note of notes) {
    const hasTagField = Boolean(note.frontmatter && hasOwnKey(note.frontmatter, "tags"));
    if (hasTagField) filesWithFrontmatterTagField += 1;

    const frontmatterTags = hasTagField && note.frontmatter
      ? uniqueValues(extractFrontmatterTags(note.frontmatter.tags).tags
        .map((tag) => normalizeKnowledgeKey(tag))
        .filter(isPresent))
      : [];

    if (frontmatterTags.length > 0) {
      filesWithFrontmatterTags += 1;
      for (const tag of frontmatterTags) {
        incrementCount(frontmatterTagCounts, tag);
      }
    }

    for (const hashtag of note.inlineHashtags) {
      inlineHashtagTotal += 1;
      incrementCount(inlineHashtagCounts, hashtag);
    }
  }

  return {
    filesWithFrontmatterTagField,
    filesWithFrontmatterTags,
    uniqueFrontmatterTags: frontmatterTagCounts.size,
    frontmatterTagCounts,
    inlineHashtagTotal,
    uniqueInlineHashtags: inlineHashtagCounts.size,
    inlineHashtagCounts,
  };
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content;
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u);
  return match ? content.slice(match[0].length) : content;
}

function extractInlineHashtags(content: string): string[] {
  const withoutCode = content
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/`[^`\n]*`/gu, "");
  const tags: string[] = [];
  const hashtagPattern = /(^|[^\p{L}\p{N}_/-])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;
  let match: RegExpExecArray | null;

  while ((match = hashtagPattern.exec(withoutCode)) !== null) {
    const normalized = normalizeKnowledgeKey(match[2] ?? "");
    if (normalized) tags.push(normalized);
  }

  return tags;
}

function splitTagString(value: string): string[] {
  return value
    .split(/[,\s]+/u)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function normalizedFrontmatterValues(
  frontmatter: Record<string, unknown>,
  fields: string[],
): Set<string> {
  const values = new Set<string>();

  for (const field of fields) {
    const rawValue = frontmatter[field];
    const items = Array.isArray(rawValue)
      ? rawValue
      : typeof rawValue === "string"
        ? [rawValue]
        : [];

    for (const item of items) {
      if (typeof item !== "string") continue;
      const normalized = normalizeKnowledgeKey(item);
      if (normalized) values.add(normalized);
    }
  }

  return values;
}

function normalizeKnowledgeKey(value: string): string | null {
  const wikilinkTarget = extractSingleWikilinkTarget(value);
  const withoutLink = wikilinkTarget ?? value;
  const normalized = withoutLink
    .trim()
    .replace(/^#+/u, "")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.md$/iu, "")
    .replace(/[_\s]+/gu, "-")
    .replace(/-+/gu, "-")
    .toLowerCase();

  return normalized.length > 0 ? normalized : null;
}

function topEntries(counts: Map<string, number>, limit: number): Array<[string, number]> {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function duplicatedValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return [...duplicates].sort((left, right) => left.localeCompare(right));
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readStringFrontmatter(frontmatter: Record<string, unknown> | null, field: string): string | null {
  const value = frontmatter?.[field];
  return typeof value === "string" ? value.trim() : null;
}

function extractSingleWikilinkTarget(value: string): string | null {
  const match = value.trim().match(/^\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/u);
  return match?.[1]?.trim() || null;
}

function suggestReconciliationTarget(relativePath: string): string {
  const topFolder = relativePath.split("/")[0] ?? "";
  if (topFolder === "Templates") {
    return "Compare with _Schema/Templates/ and delete or move only after confirming the canonical template.";
  }
  if (topFolder === "Skills") {
    return "Review whether this belongs in the Tango repo/skills system or as a root/reference note.";
  }
  return "Likely move to the vault root or References/ with updated frontmatter, after review.";
}

function tableExists(dbPath: string, tableName: string): boolean {
  const rows = sqliteJson(dbPath, `
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ${sqlString(tableName)}
  `) as Array<{ name: string }>;
  return rows.length > 0;
}

function sqliteJson(dbPath: string, sql: string): unknown[] {
  const output = execFileSync("sqlite3", [dbPath, "-json", sql], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("sqlite3 -json returned a non-array result");
  }
  return parsed as unknown[];
}

function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function parseObsidianSourceRefPath(sourceRef: string): string | null {
  if (!sourceRef.startsWith("obsidian:")) return null;
  const rest = sourceRef.slice("obsidian:".length);
  const hashIndex = rest.lastIndexOf("#");
  return hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function groupFindingsByCode(findings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.code) ?? [];
    group.push(finding);
    groups.set(finding.code, group);
  }
  return groups;
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countTopFolders(notes: NoteRecord[]): Map<string, number> {
  return countBy(notes, (note) => {
    const parts = note.relativePath.split("/");
    return parts.length > 1 ? parts[0] ?? "" : "";
  });
}

function highestSeverity(findings: Finding[]): Severity {
  if (findings.some((finding) => finding.severity === "warning")) return "warning";
  if (findings.some((finding) => finding.severity === "review")) return "review";
  return "info";
}

function formatFinding(finding: Finding, vaultPath: string): string {
  const parts: string[] = [];
  const displayPath = finding.filePath ? toDisplayPath(finding.filePath, vaultPath) : "";
  parts.push(`- ${displayPath ? `\`${displayPath}\`: ` : ""}${finding.message}`);
  if (finding.detail) {
    parts.push(`  Detail: ${indentDetail(finding.detail)}`);
  }
  if (finding.suggestion) {
    parts.push(`  Suggestion: ${finding.suggestion}`);
  }
  return parts.join("\n");
}

function toDisplayPath(filePath: string, vaultPath: string): string {
  if (filePath.startsWith(vaultPath)) {
    return toVaultRelativePath(vaultPath, filePath);
  }
  return filePath;
}

function indentDetail(detail: string): string {
  return detail.split(/\r?\n/u).join("\n  ");
}

function toVaultRelativePath(vaultPath: string, filePath: string): string {
  return path.relative(vaultPath, filePath).split(path.sep).join("/");
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

function isIntentionalDuplicateTitleGroup(
  normalizedTitle: string,
  notes: NoteRecord[],
): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(normalizedTitle)) {
    return notes.every((note) => isIntentionalDailyWorkflowPath(normalizedTitle, note.relativePath));
  }

  if (/^\d{4}-\d{2}$/u.test(normalizedTitle)) {
    return notes.every((note) => isIntentionalMonthlyJobLogPath(normalizedTitle, note.relativePath));
  }

  return false;
}

function isIntentionalDailyWorkflowPath(date: string, relativePath: string): boolean {
  return [
    `Planning/Daily/${date}.md`,
    `Records/Briefs/${date}.md`,
    `Records/Health Daily/${date}.md`,
  ].includes(relativePath);
}

function isIntentionalMonthlyJobLogPath(month: string, relativePath: string): boolean {
  return new RegExp(
    `^Records/Jobs/(?:Email|Finance|Planning|Slack|Vault)(?:/Mentions)?/${escapeRegExp(month)}\\.md$`,
    "u",
  ).test(relativePath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function resolveDatabasePath(explicitPath?: string): string {
  const configured = explicitPath?.trim() || process.env.TANGO_DB_PATH?.trim();
  if (configured) return expandHome(configured);

  const profileDb = path.join(os.homedir(), ".tango", "profiles", "default", "data", "tango.sqlite");
  if (fs.existsSync(profileDb)) return profileDb;

  return path.join(process.cwd(), "data", "tango.sqlite");
}

function printUsage(): void {
  console.log(`
Usage:
  node --import tsx ./scripts/vault-audit.ts [options]

Options:
  --vault-path <path>      Obsidian vault path (default: $TANGO_OBSIDIAN_VAULT)
  --db-path <path>         Tango SQLite path (default: active Tango profile DB)
  --output-path <path>     Markdown report path (default: data/reports/vault-audit-YYYY-MM-DD.md)
  --summary-json <path>    Also write a machine-readable JSON summary
  --max-examples <n>       Max examples per finding section (default: 25)
  --stdout                 Print report instead of writing a file
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
