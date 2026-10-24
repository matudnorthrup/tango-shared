#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Severity = "info" | "review" | "warning";

interface CliOptions {
  vaultPath: string;
  dbPath?: string;
  reportPath: string;
  summaryJsonPath: string;
  cleanupPlanPath: string;
  cleanupPlanJsonPath: string;
  statePath: string;
  maxExamples: number;
  skipIndex: boolean;
  cleanupPlan: boolean;
  applySafeCleanup: boolean;
  writeLog: boolean;
  json: boolean;
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
  notesScanned: number;
  findings: {
    total: number;
    warnings: number;
    review: number;
    info: number;
    byCode: Record<string, number>;
    items: AuditFinding[];
  };
  atlas: {
    staleIndexRows: number;
    missingIndexFiles: number;
    missingMemorySourceFiles: number;
  };
}

interface DailyCheckState {
  lastRunAt?: string;
  lastFindingFingerprints?: string[];
  lastSummary?: {
    total: number;
    warnings: number;
    review: number;
    info: number;
  };
}

interface DailyCheckResult {
  status: "ok";
  summary: string;
  reportPath: string | null;
  cleanupPlanPath: string | null;
  logPath: string | null;
  firstRun: boolean;
  counts: {
    findings: number;
    warnings: number;
    review: number;
    info: number;
    flagged: number;
    newReview: number;
    knownReview: number;
  };
  cleanup: CleanupPlanSummary | null;
}

interface CleanupPlanSummary {
  counts: {
    total: number;
    safeAutoFix: number;
    safeApplied: number;
    agentReview: number;
    humanJudgment: number;
  };
}

const DEFAULT_VAULT_PATH = process.env.TANGO_OBSIDIAN_VAULT ?? "";
const DEFAULT_DB_PATH = "~/.tango/profiles/default/data/tango.sqlite";
const DEFAULT_OUTPUT_DIR = "data/reports";
const DEFAULT_STATE_PATH = "data/state/vault-daily-check.json";
const TIMEZONE = "America/Los_Angeles";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const now = new Date();
  const stamp = getZonedTimestamp(now);

  // Fail fast when no vault path is configured. Without this guard an empty
  // path (TANGO_OBSIDIAN_VAULT unset and no --vault-path) silently resolves to
  // process.cwd(), causing the audit and the Records/Jobs/Vault/*.md job log to
  // be written into the current working directory (e.g. a repo worktree)
  // instead of the Obsidian vault.
  const configuredVaultPath = options.vaultPath.trim();
  if (!configuredVaultPath) {
    throw new Error(
      "No Obsidian vault path configured: set TANGO_OBSIDIAN_VAULT or pass " +
        "--vault-path. Refusing to run so the audit/job log is never written " +
        "to the current working directory.",
    );
  }
  const vaultPath = path.resolve(expandHome(configuredVaultPath));
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    throw new Error(
      `Configured Obsidian vault path does not exist or is not a directory: ${vaultPath}. ` +
        "Check TANGO_OBSIDIAN_VAULT / --vault-path.",
    );
  }
  const dbPath = path.resolve(expandHome(options.dbPath ?? DEFAULT_DB_PATH));
  const reportPath = path.resolve(options.reportPath);
  const summaryJsonPath = path.resolve(options.summaryJsonPath);
  const cleanupPlanPath = path.resolve(options.cleanupPlanPath);
  const cleanupPlanJsonPath = path.resolve(options.cleanupPlanJsonPath);
  const statePath = path.resolve(options.statePath);
  const logPath = options.writeLog
    ? path.join(vaultPath, "Records", "Jobs", "Vault", `${stamp.month}.md`)
    : null;

  if (logPath) {
    ensureVaultJobLog(logPath, stamp);
  }

  if (!options.skipIndex) {
    runNpmScript("memory:index:obsidian", ["--db-path", dbPath]);
  }

  runNpmScript("vault:audit", [
    "--vault-path",
    vaultPath,
    "--db-path",
    dbPath,
    "--output-path",
    reportPath,
    "--summary-json",
    summaryJsonPath,
    "--max-examples",
    String(options.maxExamples),
  ]);

  let cleanupPlan: CleanupPlanSummary | null = null;
  if (options.cleanupPlan) {
    runCleanupPlan({
      vaultPath,
      summaryJsonPath,
      cleanupPlanPath,
      cleanupPlanJsonPath,
      applySafe: options.applySafeCleanup,
    });
    cleanupPlan = summarizeCleanupPlan(readJson<CleanupPlanSummary>(cleanupPlanJsonPath));

    if (cleanupPlan.counts.safeApplied > 0) {
      if (!options.skipIndex) {
        runNpmScript("memory:index:obsidian", ["--db-path", dbPath]);
      }
      runNpmScript("vault:audit", [
        "--vault-path",
        vaultPath,
        "--db-path",
        dbPath,
        "--output-path",
        reportPath,
        "--summary-json",
        summaryJsonPath,
        "--max-examples",
        String(options.maxExamples),
      ]);
    }
  }

  const auditSummary = readJson<AuditSummary>(summaryJsonPath);
  const previousState = readJsonIfExists<DailyCheckState>(statePath);
  const firstRun = !previousState?.lastFindingFingerprints;
  const previousFingerprints = new Set(previousState?.lastFindingFingerprints ?? []);
  const fingerprinted = auditSummary.findings.items.map((finding) => ({
    finding,
    fingerprint: fingerprintFinding(finding),
  }));
  const newFindings = firstRun
    ? []
    : fingerprinted
        .filter((item) => !previousFingerprints.has(item.fingerprint))
        .map((item) => item.finding);

  const warningFindings = auditSummary.findings.items
    .filter((finding) => finding.severity === "warning");
  const newReviewFindings = newFindings
    .filter((finding) => finding.severity === "review");
  const flaggedFindings = uniqueFindings([...warningFindings, ...newReviewFindings]);
  const knownReviewCount = Math.max(0, auditSummary.findings.review - newReviewFindings.length);
  const summary = summarizeRun({
    auditSummary,
    firstRun,
    flaggedCount: flaggedFindings.length,
    newReviewCount: newReviewFindings.length,
    knownReviewCount,
  });

  if (logPath) {
    appendVaultJobLog({
      logPath,
      stamp,
      auditSummary,
      reportPath,
      flaggedFindings,
      newReviewCount: newReviewFindings.length,
      knownReviewCount,
      summary,
      cleanupPlan,
      cleanupPlanPath: options.cleanupPlan ? cleanupPlanPath : null,
    });
  }

  writeJson(statePath, {
    lastRunAt: now.toISOString(),
    lastFindingFingerprints: fingerprinted.map((item) => item.fingerprint),
    lastSummary: {
      total: auditSummary.findings.total,
      warnings: auditSummary.findings.warnings,
      review: auditSummary.findings.review,
      info: auditSummary.findings.info,
    },
  });

  if (!options.skipIndex && logPath) {
    runNpmScript("memory:index:obsidian", ["--db-path", dbPath]);
  }

  const result: DailyCheckResult = {
    status: "ok",
    summary,
    reportPath: auditSummary.reportPath,
    cleanupPlanPath: options.cleanupPlan ? cleanupPlanPath : null,
    logPath,
    firstRun,
    counts: {
      findings: auditSummary.findings.total,
      warnings: auditSummary.findings.warnings,
      review: auditSummary.findings.review,
      info: auditSummary.findings.info,
      flagged: flaggedFindings.length,
      newReview: newReviewFindings.length,
      knownReview: knownReviewCount,
    },
    cleanup: cleanupPlan,
  };

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(summary);
    if (logPath) console.log(`Vault job log: ${logPath}`);
    if (auditSummary.reportPath) console.log(`Vault audit report: ${auditSummary.reportPath}`);
    if (options.cleanupPlan) console.log(`Vault cleanup plan: ${cleanupPlanPath}`);
  }
}

function parseArgs(args: string[]): CliOptions {
  const today = getZonedTimestamp(new Date()).date;
  const options: CliOptions = {
    vaultPath: DEFAULT_VAULT_PATH,
    dbPath: process.env.TANGO_DB_PATH,
    reportPath: path.join(DEFAULT_OUTPUT_DIR, `vault-audit-${today}.md`),
    summaryJsonPath: path.join(DEFAULT_OUTPUT_DIR, `vault-audit-${today}.json`),
    cleanupPlanPath: path.join(DEFAULT_OUTPUT_DIR, `vault-cleanup-plan-${today}.md`),
    cleanupPlanJsonPath: path.join(DEFAULT_OUTPUT_DIR, `vault-cleanup-plan-${today}.json`),
    statePath: DEFAULT_STATE_PATH,
    maxExamples: 25,
    skipIndex: false,
    cleanupPlan: true,
    applySafeCleanup: false,
    writeLog: true,
    json: false,
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
      case "--report":
      case "--report-path":
      case "--output":
      case "--output-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.reportPath = next;
        index += 1;
        break;
      case "--summary-json":
      case "--summary-json-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.summaryJsonPath = next;
        index += 1;
        break;
      case "--cleanup-plan":
      case "--cleanup-plan-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.cleanupPlanPath = next;
        index += 1;
        break;
      case "--cleanup-plan-json":
      case "--cleanup-plan-json-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.cleanupPlanJsonPath = next;
        index += 1;
        break;
      case "--state":
      case "--state-path":
        if (!next) throw new Error(`${arg} requires a value`);
        options.statePath = next;
        index += 1;
        break;
      case "--max-examples":
        if (!next) throw new Error("--max-examples requires a value");
        options.maxExamples = parsePositiveInteger(next, "--max-examples");
        index += 1;
        break;
      case "--skip-index":
        options.skipIndex = true;
        break;
      case "--no-cleanup-plan":
        options.cleanupPlan = false;
        break;
      case "--apply-safe":
      case "--apply-safe-cleanup":
        options.applySafeCleanup = true;
        break;
      case "--no-apply-safe-cleanup":
        options.applySafeCleanup = false;
        break;
      case "--no-log":
      case "--no-write-log":
        options.writeLog = false;
        break;
      case "--json":
        options.json = true;
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

function ensureVaultJobLog(filePath: string, stamp: ZonedTimestamp): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const titleDate = new Date(`${stamp.month}-01T12:00:00`);
  const title = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    month: "long",
    year: "numeric",
  }).format(titleDate);

  const content = [
    "---",
    `date: ${stamp.month}-01`,
    "types:",
    '  - "[[Record]]"',
    "areas:",
    '  - "[[Personal]]"',
    '  - "[[Tango]]"',
    "source_kind: log",
    "---",
    "",
    `# Vault Jobs — ${title}`,
    "",
  ].join("\n");
  fs.writeFileSync(filePath, content, "utf8");
}

function appendVaultJobLog(input: {
  logPath: string;
  stamp: ZonedTimestamp;
  auditSummary: AuditSummary;
  reportPath: string;
  flaggedFindings: AuditFinding[];
  newReviewCount: number;
  knownReviewCount: number;
  summary: string;
  cleanupPlan: CleanupPlanSummary | null;
  cleanupPlanPath: string | null;
}): void {
  const lines = [
    "",
    `## ${input.stamp.date} ${input.stamp.time} — Vault Audit`,
    "",
    `**Status:** ${statusLine(input.auditSummary, input.flaggedFindings.length, input.newReviewCount)}`,
    `**Report:** \`${input.reportPath}\``,
    `**Summary:** ${input.summary}`,
    ...formatCleanupPlanSummary(input.cleanupPlan, input.cleanupPlanPath),
    "",
    "**Flagged:**",
    ...formatFlaggedLines(input.flaggedFindings, input.stamp.date),
    "",
    "**Known Review:**",
    ...formatKnownReviewLines(input.auditSummary.findings.items, input.knownReviewCount),
    "",
  ];

  fs.appendFileSync(input.logPath, `${lines.join("\n")}\n`, "utf8");
}

function statusLine(
  auditSummary: AuditSummary,
  flaggedCount: number,
  newReviewCount: number,
): string {
  if (auditSummary.findings.warnings > 0) {
    return `Done — ${auditSummary.findings.warnings} warning(s), ${newReviewCount} new review item(s)`;
  }
  if (flaggedCount > 0) return `Done — ${flaggedCount} new flagged item(s)`;
  if (auditSummary.findings.total === 0) return "Done — clean";
  return `Done — no new flags (${auditSummary.findings.review} review item(s), ${auditSummary.findings.info} info item(s))`;
}

function summarizeRun(input: {
  auditSummary: AuditSummary;
  firstRun: boolean;
  flaggedCount: number;
  newReviewCount: number;
  knownReviewCount: number;
}): string {
  const { auditSummary } = input;
  if (auditSummary.findings.warnings > 0) {
    return `Vault audit found ${auditSummary.findings.warnings} warning(s) and ${input.newReviewCount} new review item(s).`;
  }
  if (input.flaggedCount > 0) {
    return `Vault audit found ${input.flaggedCount} new flagged item(s).`;
  }
  if (auditSummary.findings.total === 0) {
    return "Vault audit clean; no findings.";
  }
  if (input.firstRun) {
    return `Vault audit baseline recorded with ${auditSummary.findings.review} review item(s) and no warnings.`;
  }
  return `Vault audit found no new flags; ${input.knownReviewCount} known review item(s) remain.`;
}

function formatFlaggedLines(findings: AuditFinding[], date: string): string[] {
  if (findings.length === 0) return ["No flagged items."];
  return findings.map((finding) => {
    const location = finding.relativePath ? ` in \`${finding.relativePath}\`` : "";
    return `- [ ] Review vault audit ${finding.severity}: ${finding.message}${location} — ${date}`;
  });
}

function formatCleanupPlanSummary(
  cleanupPlan: CleanupPlanSummary | null,
  cleanupPlanPath: string | null,
): string[] {
  if (!cleanupPlan || !cleanupPlanPath) return [];
  return [
    `**Cleanup Plan:** \`${cleanupPlanPath}\``,
    `**Cleanup Summary:** ${cleanupPlan.counts.safeApplied} safe fix(es) applied; ` +
      `${cleanupPlan.counts.agentReview} agent review item(s); ` +
      `${cleanupPlan.counts.humanJudgment} human judgment item(s).`,
  ];
}

function formatKnownReviewLines(findings: AuditFinding[], knownReviewCount: number): string[] {
  if (knownReviewCount === 0) return ["None."];
  const reviewFindings = findings.filter((finding) => finding.severity === "review");
  return [
    `${knownReviewCount} known review item(s) remain; not flagged for daily planning unless they change.`,
    ...reviewFindings.slice(0, 5).map((finding) => {
      const location = finding.relativePath ? ` — ${finding.relativePath}` : "";
      return `- ${finding.code}: ${finding.message}${location}`;
    }),
  ];
}

function uniqueFindings(findings: AuditFinding[]): AuditFinding[] {
  const seen = new Set<string>();
  const unique: AuditFinding[] = [];
  for (const finding of findings) {
    const fingerprint = fingerprintFinding(finding);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(finding);
  }
  return unique;
}

function fingerprintFinding(finding: AuditFinding): string {
  return createHash("sha256")
    .update([
      finding.code,
      finding.severity,
      finding.relativePath ?? finding.filePath ?? "",
      finding.message,
      finding.detail ?? "",
    ].join("\0"))
    .digest("hex");
}

function runNpmScript(script: string, scriptArgs: string[]): void {
  try {
    execFileSync("npm", ["run", "-s", script, "--", ...scriptArgs], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      const stdout = String((error as { stdout?: unknown }).stdout ?? "").trim();
      throw new Error(
        [`npm run ${script} failed`, stdout, stderr].filter(Boolean).join("\n"),
      );
    }
    throw error;
  }
}

function runCleanupPlan(input: {
  vaultPath: string;
  summaryJsonPath: string;
  cleanupPlanPath: string;
  cleanupPlanJsonPath: string;
  applySafe: boolean;
}): void {
  runNpmScript("vault:cleanup-plan", [
    "--vault-path",
    input.vaultPath,
    "--summary-json",
    input.summaryJsonPath,
    "--output-path",
    input.cleanupPlanPath,
    "--output-json",
    input.cleanupPlanJsonPath,
    ...(input.applySafe ? ["--apply-safe"] : []),
  ]);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function summarizeCleanupPlan(plan: CleanupPlanSummary): CleanupPlanSummary {
  return {
    counts: plan.counts,
  };
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return readJson<T>(filePath);
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface ZonedTimestamp {
  date: string;
  month: string;
  time: string;
}

function getZonedTimestamp(date: Date): ZonedTimestamp {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = `${values.year}-${values.month}-${values.day}`;
  return {
    date: day,
    month: `${values.year}-${values.month}`,
    time: `${values.hour}:${values.minute}`,
  };
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

function printUsage(): void {
  console.log(`
Usage:
  node --import tsx ./scripts/vault-daily-check.ts [options]

Options:
  --vault-path <path>      Obsidian vault path (default: $TANGO_OBSIDIAN_VAULT)
  --db-path <path>         Tango SQLite path (default: active Tango profile DB)
  --report-path <path>     Markdown audit report path
  --summary-json <path>    JSON audit summary path
  --cleanup-plan <path>    Markdown cleanup plan path
  --cleanup-plan-json <p>  JSON cleanup plan path
  --state-path <path>      Daily novelty state path (default: data/state/vault-daily-check.json)
  --max-examples <n>       Max examples per finding section (default: 25)
  --skip-index             Do not refresh Atlas before/after the audit
  --no-cleanup-plan        Do not classify audit findings into a cleanup plan
  --apply-safe-cleanup     Apply deterministic safe fixes from the cleanup plan
  --no-apply-safe-cleanup  Keep cleanup plan in report-only mode (default)
  --no-write-log           Do not append Records/Jobs/Vault/YYYY-MM.md
  --json                   Print machine-readable result JSON
`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
