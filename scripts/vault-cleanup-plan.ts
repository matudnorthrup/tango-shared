#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Severity = "info" | "review" | "warning";
type CleanupTier = "safe_auto_fix" | "agent_review" | "human_judgment";
type CleanupStatus = "planned" | "applied" | "not_applicable" | "needs_agent" | "needs_human";

interface CliOptions {
  vaultPath: string;
  auditSummaryPath: string;
  outputJsonPath: string;
  outputPath: string;
  applySafe: boolean;
  writeReport: boolean;
}

interface AuditFinding {
  code: string;
  severity: Severity;
  message: string;
  filePath?: string;
  relativePath?: string;
  detail?: string;
  suggestion?: string;
}

interface AuditSummary {
  generatedAt: string;
  vaultPath: string;
  dbPath: string;
  reportPath: string | null;
  findings: {
    total: number;
    warnings: number;
    review: number;
    info: number;
    byCode: Record<string, number>;
    items: AuditFinding[];
  };
}

interface CleanupPlanItem {
  id: string;
  tier: CleanupTier;
  status: CleanupStatus;
  title: string;
  reason: string;
  relativePath?: string;
  filePath?: string;
  findingCodes: string[];
  findingMessages: string[];
  findingDetails?: string[];
  recommendedAction: string;
  appliedChanges?: string[];
}

interface CleanupPlan {
  generatedAt: string;
  auditGeneratedAt: string;
  vaultPath: string;
  auditReportPath: string | null;
  auditSummaryPath: string;
  applySafe: boolean;
  counts: {
    total: number;
    safeAutoFix: number;
    safeApplied: number;
    agentReview: number;
    humanJudgment: number;
  };
  items: CleanupPlanItem[];
  agentWorkOrder: {
    title: string;
    instructions: string[];
    items: CleanupPlanItem[];
  };
}

const DEFAULT_VAULT_PATH = process.env.TANGO_OBSIDIAN_VAULT ?? "";
const DEFAULT_OUTPUT_DIR = "data/reports";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const vaultPath = path.resolve(expandHome(options.vaultPath));
  const auditSummaryPath = path.resolve(expandHome(options.auditSummaryPath));

  if (!fs.existsSync(auditSummaryPath)) {
    throw new Error(`Audit summary JSON does not exist: ${auditSummaryPath}`);
  }

  const auditSummary = readJson<AuditSummary>(auditSummaryPath);
  const plan = buildCleanupPlan({
    auditSummary,
    auditSummaryPath,
    vaultPath,
    applySafe: options.applySafe,
  });

  const outputJsonPath = path.resolve(options.outputJsonPath);
  fs.mkdirSync(path.dirname(outputJsonPath), { recursive: true });
  fs.writeFileSync(outputJsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const report = renderPlan(plan);
  if (options.writeReport) {
    const outputPath = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, report, "utf8");
    console.log(`Wrote vault cleanup plan: ${outputPath}`);
  } else {
    console.log(report);
  }
}

function parseArgs(args: string[]): CliOptions {
  const today = new Date().toISOString().slice(0, 10);
  const options: CliOptions = {
    vaultPath: DEFAULT_VAULT_PATH,
    auditSummaryPath: path.join(DEFAULT_OUTPUT_DIR, `vault-audit-${today}.json`),
    outputJsonPath: path.join(DEFAULT_OUTPUT_DIR, `vault-cleanup-plan-${today}.json`),
    outputPath: path.join(DEFAULT_OUTPUT_DIR, `vault-cleanup-plan-${today}.md`),
    applySafe: false,
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
      case "--audit-summary":
      case "--summary-json":
      case "--summary-json-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.auditSummaryPath = next;
        index += 1;
        break;
      case "--output-json":
      case "--output-json-path":
      case "--plan-json":
        if (!next) throw new Error(`${arg} requires a value`);
        options.outputJsonPath = next;
        index += 1;
        break;
      case "--output":
      case "--output-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.outputPath = next;
        index += 1;
        break;
      case "--apply-safe":
        options.applySafe = true;
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

function buildCleanupPlan(input: {
  auditSummary: AuditSummary;
  auditSummaryPath: string;
  vaultPath: string;
  applySafe: boolean;
}): CleanupPlan {
  const items: CleanupPlanItem[] = [];
  const safeBriefGroups = groupGeneratedBriefFrontmatterFindings(input.auditSummary.findings.items);
  const handledFindingKeys = new Set<string>();

  for (const group of safeBriefGroups) {
    for (const finding of group.findings) {
      handledFindingKeys.add(findingKey(finding));
    }

    const result = input.applySafe
      ? applyGeneratedBriefFrontmatterFix(input.vaultPath, group.relativePath)
      : { status: "planned" as const, appliedChanges: [] };

    items.push({
      id: stableItemId("brief-frontmatter", group.relativePath),
      tier: "safe_auto_fix",
      status: result.status,
      title: "Repair generated brief frontmatter",
      reason: "Generated morning briefs have a stable schema, so missing `types` or `areas` can be filled deterministically.",
      relativePath: group.relativePath,
      filePath: path.join(input.vaultPath, group.relativePath),
      findingCodes: uniqueValues(group.findings.map((finding) => finding.code)),
      findingMessages: group.findings.map((finding) => finding.message),
      recommendedAction: "Add YAML list values for `types` (`[[Brief]]`) and/or `areas` (`[[Personal]]`) when those fields are missing.",
      appliedChanges: result.appliedChanges,
    });
  }

  for (const finding of input.auditSummary.findings.items) {
    if (handledFindingKeys.has(findingKey(finding))) continue;
    items.push(classifyFinding(finding));
  }

  const counts = {
    total: items.length,
    safeAutoFix: items.filter((item) => item.tier === "safe_auto_fix").length,
    safeApplied: items.filter((item) => item.status === "applied").length,
    agentReview: items.filter((item) => item.tier === "agent_review").length,
    humanJudgment: items.filter((item) => item.tier === "human_judgment").length,
  };

  const agentItems = items.filter((item) => item.tier === "agent_review");
  return {
    generatedAt: new Date().toISOString(),
    auditGeneratedAt: input.auditSummary.generatedAt,
    vaultPath: input.vaultPath,
    auditReportPath: input.auditSummary.reportPath,
    auditSummaryPath: input.auditSummaryPath,
    applySafe: input.applySafe,
    counts,
    items,
    agentWorkOrder: {
      title: "Vault Cleanup Agent Review",
      instructions: [
        "Read `References/Vault Design.md` before editing.",
        "Use this cleanup plan as the work order; do not invent new schema values or folders.",
        "Do not create schema values just because the audit found an unapproved or missing target; prefer updating the note to approved taxonomy.",
        "Apply only small, reviewable batches.",
        "Do not delete notes or merge duplicates without the owner approval.",
        "After edits, run `npm run memory:index:obsidian` and `npm run vault:audit`.",
        "Write or append a maintenance record describing what changed.",
      ],
      items: agentItems,
    },
  };
}

function groupGeneratedBriefFrontmatterFindings(findings: AuditFinding[]): Array<{
  relativePath: string;
  findings: AuditFinding[];
}> {
  const groups = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    if (finding.code !== "frontmatter.required_missing") continue;
    if (!finding.relativePath || !/^Records\/Briefs\/\d{4}-\d{2}-\d{2}\.md$/u.test(finding.relativePath)) continue;
    if (!/Missing required frontmatter field: (types|areas)\./u.test(finding.message)) continue;
    const existing = groups.get(finding.relativePath) ?? [];
    existing.push(finding);
    groups.set(finding.relativePath, existing);
  }
  return [...groups.entries()].map(([relativePath, groupedFindings]) => ({
    relativePath,
    findings: groupedFindings,
  }));
}

function classifyFinding(finding: AuditFinding): CleanupPlanItem {
  const base = {
    id: stableItemId(
      finding.code,
      [
        finding.relativePath ?? finding.filePath ?? "",
        finding.message,
        finding.detail ?? "",
      ].join("\0"),
    ),
    relativePath: finding.relativePath,
    filePath: finding.filePath,
    findingCodes: [finding.code],
    findingMessages: [finding.message],
    findingDetails: finding.detail ? [finding.detail] : undefined,
  };

  if (finding.code === "duplicate.title") {
    return {
      ...base,
      tier: "human_judgment",
      status: "needs_human",
      title: "Resolve possible duplicate note titles",
      reason: "Duplicate notes may be intentionally separate or may require content merging.",
      recommendedAction: "the owner should decide whether these notes are duplicates, companions, or intentionally separate.",
    };
  }

  if (finding.code === "folder.unknown_top_level") {
    return {
      ...base,
      tier: "human_judgment",
      status: "needs_human",
      title: "Decide whether an undocumented folder is intentional",
      reason: "Top-level folders define workflow boundaries and should not be created or removed casually.",
      recommendedAction: "Decide whether to document the folder as a workflow boundary or reconcile the note elsewhere.",
    };
  }

  if (finding.code === "categories.deprecated") {
    return {
      ...base,
      tier: "agent_review",
      status: "needs_agent",
      title: "Migrate deprecated category usage",
      reason: "Categories are deprecated, but each category may need a different replacement: area, collection, field, or body link.",
      recommendedAction: "Prepare a small migration proposal before editing category fields in bulk.",
    };
  }

  if (finding.code === "folder.reconcile_candidate" || finding.code === "folder.legacy_templates") {
    return {
      ...base,
      tier: "agent_review",
      status: "needs_agent",
      title: "Reconcile folder placement",
      reason: "The vault design allows workflow folders only when they are intentional and documented.",
      recommendedAction: "Review the note, choose root or `References/` when appropriate, preserve links, and update frontmatter.",
    };
  }

  if (finding.code.startsWith("schema.") || finding.code.startsWith("tags.") || finding.code.startsWith("frontmatter.")) {
    return {
      ...base,
      tier: "agent_review",
      status: "needs_agent",
      title: "Repair schema or frontmatter issue",
      reason: "The issue is likely editable, but it needs note-specific judgment.",
      recommendedAction: finding.suggestion ?? "Review the note and apply the smallest schema/frontmatter fix.",
    };
  }

  if (finding.code.startsWith("atlas.index_hash_stale")) {
    return {
      ...base,
      tier: "safe_auto_fix",
      status: "planned",
      title: "Refresh stale Atlas index rows",
      reason: "Stale Obsidian index rows are normally repaired by the deterministic index refresh.",
      recommendedAction: "Run `npm run memory:index:obsidian` before the next audit.",
    };
  }

  if (finding.severity === "info") {
    return {
      ...base,
      tier: "human_judgment",
      status: "needs_human",
      title: "Review informational vault finding",
      reason: "Informational findings usually indicate design questions rather than mechanical fixes.",
      recommendedAction: finding.suggestion ?? "Review and decide whether this should become a rule or remain informational.",
    };
  }

  return {
    ...base,
    tier: "agent_review",
    status: "needs_agent",
    title: "Review vault audit finding",
    reason: "No deterministic cleanup rule exists for this finding yet.",
    recommendedAction: finding.suggestion ?? "Review the finding and propose the smallest safe cleanup.",
  };
}

function applyGeneratedBriefFrontmatterFix(vaultPath: string, relativePath: string): {
  status: "applied" | "not_applicable";
  appliedChanges: string[];
} {
  const filePath = path.join(vaultPath, relativePath);
  if (!fs.existsSync(filePath)) {
    return { status: "not_applicable", appliedChanges: ["Skipped because the file no longer exists."] };
  }

  const content = fs.readFileSync(filePath, "utf8");
  if (!isGeneratedMorningBrief(content)) {
    return { status: "not_applicable", appliedChanges: ["Skipped because the note does not look like a generated morning brief."] };
  }

  const parsed = splitFrontmatter(content);
  if (!parsed) {
    return { status: "not_applicable", appliedChanges: ["Skipped because the note does not have editable frontmatter."] };
  }

  const appliedChanges: string[] = [];
  let frontmatter = parsed.frontmatter;

  if (!frontmatterHasField(frontmatter, "types")) {
    frontmatter = appendFrontmatterField(frontmatter, [
      "types:",
      '  - "[[Brief]]"',
    ]);
    appliedChanges.push("Added `types` list value `[[Brief]]`.");
  }

  if (!frontmatterHasField(frontmatter, "areas")) {
    frontmatter = appendFrontmatterField(frontmatter, [
      "areas:",
      '  - "[[Personal]]"',
    ]);
    appliedChanges.push("Added `areas` list value `[[Personal]]`.");
  }

  if (appliedChanges.length === 0) {
    return { status: "not_applicable", appliedChanges: ["Skipped because the expected frontmatter fields are already present."] };
  }

  fs.writeFileSync(filePath, `---\n${frontmatter}\n---${parsed.body}`, "utf8");
  return { status: "applied", appliedChanges };
}

function isGeneratedMorningBrief(content: string): boolean {
  const parsed = splitFrontmatter(content);
  if (!parsed) return false;
  return /^type:\s*morning-brief\s*$/mu.test(parsed.frontmatter)
    || /^# Morning Brief\b/mu.test(parsed.body)
    || /^# Morning Brief\b/mu.test(content);
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return null;
  const bodyStart = end + "\n---".length;
  return {
    frontmatter: content.slice(4, end).replace(/\n+$/u, ""),
    body: content.slice(bodyStart),
  };
}

function frontmatterHasField(frontmatter: string, field: string): boolean {
  return new RegExp(`^${escapeRegExp(field)}:\\s*`, "mu").test(frontmatter);
}

function appendFrontmatterField(frontmatter: string, lines: string[]): string {
  const clean = frontmatter.replace(/\n+$/u, "");
  return `${clean}\n${lines.join("\n")}`;
}

function renderPlan(plan: CleanupPlan): string {
  const lines: string[] = [];
  lines.push(`# Vault Cleanup Plan - ${plan.generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push(`Generated: ${plan.generatedAt}`);
  lines.push(`Audit report: ${plan.auditReportPath ? `\`${plan.auditReportPath}\`` : "none"}`);
  lines.push(`Safe auto-fix mode: ${plan.applySafe ? "applied" : "plan only"}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Tier | Count |");
  lines.push("| --- | ---: |");
  lines.push(`| Safe auto-fix | ${plan.counts.safeAutoFix} |`);
  lines.push(`| Safe fixes applied | ${plan.counts.safeApplied} |`);
  lines.push(`| Agent review | ${plan.counts.agentReview} |`);
  lines.push(`| Human judgment | ${plan.counts.humanJudgment} |`);
  lines.push("");

  appendPlanSection(lines, "Safe Auto-Fixes", plan.items.filter((item) => item.tier === "safe_auto_fix"));
  appendPlanSection(lines, "Agent Review Work Order", plan.items.filter((item) => item.tier === "agent_review"));
  appendPlanSection(lines, "Human Judgment", plan.items.filter((item) => item.tier === "human_judgment"));

  if (plan.agentWorkOrder.items.length > 0) {
    lines.push("## Agent Instructions");
    lines.push("");
    for (const instruction of plan.agentWorkOrder.instructions) {
      lines.push(`- ${instruction}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function appendPlanSection(lines: string[], heading: string, items: CleanupPlanItem[]): void {
  lines.push(`## ${heading}`);
  lines.push("");
  if (items.length === 0) {
    lines.push("None.");
    lines.push("");
    return;
  }

  for (const item of items) {
    const location = item.relativePath ? ` — \`${item.relativePath}\`` : "";
    lines.push(`### ${item.title}${location}`);
    lines.push("");
    lines.push(`- Status: ${item.status}`);
    lines.push(`- Reason: ${item.reason}`);
    lines.push(`- Recommended action: ${item.recommendedAction}`);
    if (item.appliedChanges && item.appliedChanges.length > 0) {
      lines.push(`- Applied: ${item.appliedChanges.join(" ")}`);
    }
    lines.push(`- Findings: ${item.findingMessages.join(" / ")}`);
    if (item.findingDetails && item.findingDetails.length > 0) {
      lines.push("- Details:");
      for (const detail of item.findingDetails) {
        for (const line of detail.split(/\r?\n/u).filter((value) => value.trim().length > 0)) {
          lines.push(`  - ${line}`);
        }
      }
    }
    lines.push("");
  }
}

function stableItemId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function findingKey(finding: AuditFinding): string {
  return [
    finding.code,
    finding.relativePath ?? finding.filePath ?? "",
    finding.message,
    finding.detail ?? "",
  ].join("\0");
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function printUsage(): void {
  console.log(`
Usage:
  node --import tsx ./scripts/vault-cleanup-plan.ts [options]

Options:
  --vault-path <path>       Obsidian vault path (default: $TANGO_OBSIDIAN_VAULT)
  --summary-json <path>     Vault audit JSON summary path
  --output-json <path>      Cleanup plan JSON path
  --output-path <path>      Cleanup plan Markdown path
  --apply-safe              Apply deterministic safe fixes
  --stdout                  Print Markdown plan instead of writing report
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
