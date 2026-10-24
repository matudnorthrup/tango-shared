import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  buildReimbursementRetailerPattern,
  detectReimbursementGaps,
  loadAllReceiptRecords,
  resolveVendorConfig,
} from "./receipt-universal-registry.js";

export interface ReceiptCatalogTransactionRecord {
  id?: number | string | null;
  date?: string | null;
  payee?: string | null;
  original_name?: string | null;
  notes?: string | null;
  amount?: string | number | null;
  status?: string | null;
}

export interface ReceiptCatalogCandidate {
  id: string;
  date: string;
  payee: string;
  originalName: string;
  amount: string;
  status: string;
  /** Receipt note (relative to the receipts root) still marked `receipt_status: pending`. */
  pendingNote?: string;
}

export interface ReceiptLinkIndex {
  /** Transaction ids linked from a finished receipt note. */
  linked: Set<string>;
  /**
   * Transaction ids linked only from notes still marked `receipt_status: pending`
   * (for example a stub written when the retailer login failed), mapped to that note.
   * These are retried instead of being treated as cataloged.
   */
  pending: Map<string, string>;
}

export interface BuildMissingReceiptCandidatesOptions {
  /**
   * Transactions dated before this day are only kept while still uncleared, so an
   * unreceipted charge cannot silently age out of the short recovery window.
   */
  recentSince?: string;
  pendingNotes?: Map<string, string>;
}

export interface ReimbursementGapCandidate {
  type: "missing_tracking_section" | "stale_tracking" | "missing_recurring_receipt";
  vendorKey?: string;
  merchant?: string;
  month?: string;
  notePath?: string;
  noteName?: string;
  amount?: string;
  expectedAmount?: string;
  detail: string;
}

export interface BuildReimbursementGapCandidatesInput {
  receiptsRoot?: string;
  since?: string;
  until?: string;
  vendor?: string;
  lookbackMonths?: number;
}

export const RECEIPT_CATALOG_LOOKBACK_DAYS = 14;
/** Uncleared retailer charges stay candidates this long, past the 14-day window. */
export const RECEIPT_CATALOG_UNCLEARED_LOOKBACK_DAYS = 45;

const LINKED_TRANSACTION_ID_PATTERN = /\b(?:Lunch Money\s+)?TXN\s+(\d+)\b/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericTransactionId(value: unknown): string | undefined {
  const id = String(value ?? "").trim();
  return /^\d+$/u.test(id) ? id : undefined;
}

function parseReceiptFrontmatter(content: string): Record<string, unknown> | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1];
  if (!frontmatter) {
    return undefined;
  }

  try {
    const parsed = yaml.load(frontmatter, { schema: yaml.JSON_SCHEMA });
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function collectFrontmatterLinkedTransactionIds(content: string): string[] {
  const frontmatter = parseReceiptFrontmatter(content);
  if (!frontmatter) {
    return [];
  }

  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = numericTransactionId(value);
    if (id) {
      ids.add(id);
    }
  };

  for (const key of ["lunch_money_ids", "lunchMoneyIds", "lunch_money_txn"]) {
    for (const value of listFrontmatterIds(frontmatter[key])) {
      add(value);
    }
  }

  if (Array.isArray(frontmatter.lunch_money_transactions)) {
    for (const transaction of frontmatter.lunch_money_transactions) {
      if (isRecord(transaction)) {
        add(transaction.id);
      }
    }
  }

  return [...ids];
}
function listFrontmatterIds(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    // Notes written by hand sometimes quote the array: lunch_money_ids: '["123"]'
    const text = value.trim();
    if (text.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [text];
  }
  return typeof value === "number" ? [value] : [];
}

function isPendingReceiptNote(content: string): boolean {
  const status = parseReceiptFrontmatter(content)?.receipt_status;
  return typeof status === "string" && status.trim().toLowerCase() === "pending";
}

const REIMBURSEMENT_GAP_TYPE_ORDER: Record<ReimbursementGapCandidate["type"], number> = {
  missing_tracking_section: 0,
  stale_tracking: 1,
  missing_recurring_receipt: 2,
};

export function buildReceiptCatalogDateWindow(
  now: Date = new Date(),
  timeZone = "America/Los_Angeles",
  lookbackDays = RECEIPT_CATALOG_LOOKBACK_DAYS,
): { startDate: string; endDate: string; lookbackDays: number } {
  const endDate = formatDateInTimeZone(now, timeZone);
  const startDate = formatDateInTimeZone(
    new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000),
    timeZone,
  );
  return { startDate, endDate, lookbackDays };
}

export function collectLinkedReceiptTransactionIds(receiptsRoot: string): Set<string> {
  return collectReceiptLinkIndex(receiptsRoot).linked;
}

export function collectReceiptLinkIndex(receiptsRoot: string): ReceiptLinkIndex {
  const linkedIds = new Set<string>();
  const pendingNotes = new Map<string, string>();
  if (!fs.existsSync(receiptsRoot)) {
    return { linked: linkedIds, pending: pendingNotes };
  }

  const pending = [receiptsRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const content = fs.readFileSync(fullPath, "utf8");
      const frontmatterIds = collectFrontmatterLinkedTransactionIds(content);
      const bodyIds = [...content.matchAll(LINKED_TRANSACTION_ID_PATTERN)].map((match) => match[1]!);
      if (!isPendingReceiptNote(content)) {
        for (const id of [...frontmatterIds, ...bodyIds]) {
          linkedIds.add(id);
        }
        continue;
      }
      // A pending stub owns the transactions in its frontmatter. Other ids it only
      // mentions in prose (a same-day gas charge, a replaced pending id) keep the
      // usual linked treatment so they are not retried as itemization work.
      const pendingIds = frontmatterIds.length > 0 ? frontmatterIds : bodyIds;
      const notePath = path.relative(receiptsRoot, fullPath).replace(/\\/gu, "/");
      for (const id of pendingIds) {
        if (!pendingNotes.has(id)) {
          pendingNotes.set(id, notePath);
        }
      }
      for (const id of bodyIds) {
        if (!pendingIds.includes(id)) {
          linkedIds.add(id);
        }
      }
    }
  }

  for (const id of linkedIds) {
    pendingNotes.delete(id);
  }
  return { linked: linkedIds, pending: pendingNotes };
}

export function buildMissingReceiptCandidates(
  transactions: ReceiptCatalogTransactionRecord[],
  linkedTransactionIds: Set<string>,
  options: BuildMissingReceiptCandidatesOptions = {},
): ReceiptCatalogCandidate[] {
  const retailerPattern = buildReimbursementRetailerPattern();
  return transactions
    .map((transaction) => {
      const id = String(transaction.id ?? "").trim();
      if (!id || linkedTransactionIds.has(id)) {
        return null;
      }
      // Match the merchant only. User-written notes mention retailers in passing
      // ("paid back on Venmo") and must not turn a restaurant into a candidate.
      const haystack = [
        String(transaction.payee ?? ""),
        String(transaction.original_name ?? ""),
      ].join(" ");
      if (!retailerPattern.test(haystack)) {
        return null;
      }
      const date = String(transaction.date ?? "").trim() || "unknown-date";
      const status = String(transaction.status ?? "").trim() || "unknown";
      if (options.recentSince && date < options.recentSince && status !== "uncleared") {
        return null;
      }
      const pendingNote = options.pendingNotes?.get(id);
      return {
        id,
        date,
        payee: String(transaction.payee ?? "").trim() || "Unknown",
        originalName: String(transaction.original_name ?? "").trim(),
        amount: normalizeAmount(transaction.amount),
        status,
        ...(pendingNote ? { pendingNote } : {}),
      } satisfies ReceiptCatalogCandidate;
    })
    .filter((candidate): candidate is ReceiptCatalogCandidate => candidate !== null)
    .sort((left, right) => {
      // New receipts first; retries of pending stubs (often still blocked on a
      // retailer login) must not crowd fresh work out of the per-run cap.
      if (Boolean(left.pendingNote) !== Boolean(right.pendingNote)) {
        return left.pendingNote ? 1 : -1;
      }
      if (left.date !== right.date) {
        return left.date.localeCompare(right.date);
      }
      return left.id.localeCompare(right.id);
    });
}

export function buildReimbursementGapCandidates(
  input: BuildReimbursementGapCandidatesInput = {},
): ReimbursementGapCandidate[] {
  const candidates = new Map<string, ReimbursementGapCandidate>();
  const records = loadAllReceiptRecords(input.receiptsRoot)
    .filter((record) => Boolean(record.vendorKey))
    .filter((record) => recordMatchesGapFilters(record.date, record.vendorKey, input));

  for (const record of records) {
    if (!record.hasReimbursementSection) {
      addGapCandidate(candidates, {
        type: "missing_tracking_section",
        vendorKey: record.vendorKey,
        merchant: record.merchant,
        notePath: record.filePath,
        noteName: record.noteName,
        detail: "Configured reimbursement receipt is missing the reimbursement tracking block.",
      });
    }

    if (normalizeTrackingStatus(record.reimbursement.status) === "submitted" && !record.reimbursement.expenseReportId) {
      addGapCandidate(candidates, {
        type: "stale_tracking",
        vendorKey: record.vendorKey,
        merchant: record.merchant,
        notePath: record.filePath,
        noteName: record.noteName,
        amount: normalizeOptionalAmount(record.reimbursement.amount ?? record.reimbursableAmount),
        detail: "Receipt is marked submitted but is missing the ExpenseDesk report id.",
      });
    }
  }

  const detected = detectReimbursementGaps({
    since: input.since,
    until: input.until,
    vendor: input.vendor,
    lookbackMonths: input.lookbackMonths,
    rootDir: input.receiptsRoot,
  });

  for (const gap of detected.gaps) {
    if (
      gap.type !== "missing_tracking_section"
      && gap.type !== "stale_tracking"
      && gap.type !== "missing_recurring_receipt"
    ) {
      continue;
    }

    addGapCandidate(candidates, {
      type: gap.type,
      vendorKey: gap.vendorKey,
      merchant: gap.merchant,
      month: gap.month,
      notePath: gap.notePath,
      noteName: deriveNoteName(gap.notePath, input.receiptsRoot),
      amount: normalizeOptionalAmount(gap.amount),
      expectedAmount: normalizeOptionalAmount(gap.expectedAmount),
      detail: gap.detail,
    });
  }

  return [...candidates.values()].sort((left, right) => {
    const leftType = REIMBURSEMENT_GAP_TYPE_ORDER[left.type];
    const rightType = REIMBURSEMENT_GAP_TYPE_ORDER[right.type];
    if (leftType !== rightType) {
      return leftType - rightType;
    }

    const leftKey = [
      left.month ?? "",
      left.noteName ?? "",
      left.vendorKey ?? "",
      left.merchant ?? "",
    ].join("::");
    const rightKey = [
      right.month ?? "",
      right.noteName ?? "",
      right.vendorKey ?? "",
      right.merchant ?? "",
    ].join("::");
    return leftKey.localeCompare(rightKey);
  });
}

export function formatReceiptCatalogCandidateDetails(candidates: ReceiptCatalogCandidate[]): string {
  if (candidates.length === 0) {
    return "(none)";
  }

  return candidates
    .map((candidate) => {
      const extra = candidate.originalName ? ` — ${candidate.originalName}` : "";
      const retry = candidate.pendingNote
        ? ` | RETRY pending receipt note "${candidate.pendingNote}": itemize it in place, do not create a duplicate`
        : "";
      return `- TXN ${candidate.id} | ${candidate.date} | ${candidate.payee} | $${candidate.amount} | ${candidate.status}${extra}${retry}`;
    })
    .join("\n");
}

export function formatReimbursementGapCandidateDetails(
  candidates: ReimbursementGapCandidate[],
): string {
  if (candidates.length === 0) {
    return "(none)";
  }

  return candidates
    .map((candidate) => {
      const merchant = candidate.merchant ?? humanizeVendorKey(candidate.vendorKey);
      const target =
        candidate.noteName
        ?? candidate.month
        ?? candidate.notePath
        ?? "unknown-target";
      switch (candidate.type) {
        case "missing_tracking_section":
          return `- missing_tracking_section | ${merchant} | ${target} | add ## Reimbursement Tracking`;
        case "stale_tracking":
          return `- stale_tracking | ${merchant} | ${target} | status=submitted but no ExpenseDesk report id${candidate.amount ? ` | $${candidate.amount}` : ""}`;
        case "missing_recurring_receipt":
          return `- missing_recurring_receipt | ${merchant} | ${target}${candidate.expectedAmount ? ` | expected $${candidate.expectedAmount}` : ""}`;
        default:
          return `- ${candidate.type} | ${merchant} | ${target} | ${candidate.detail}`;
      }
    })
    .join("\n");
}

function addGapCandidate(
  candidates: Map<string, ReimbursementGapCandidate>,
  candidate: ReimbursementGapCandidate,
): void {
  const key = [
    candidate.type,
    candidate.vendorKey ?? "",
    candidate.month ?? "",
    candidate.notePath ?? "",
  ].join("::");
  if (!candidates.has(key)) {
    candidates.set(key, candidate);
  }
}

function deriveNoteName(notePath: string | undefined, receiptsRoot: string | undefined): string | undefined {
  if (!notePath) {
    return undefined;
  }
  if (receiptsRoot) {
    return path.relative(receiptsRoot, notePath).replace(/\\/gu, "/");
  }
  return path.basename(notePath);
}

function humanizeVendorKey(vendorKey: string | undefined): string {
  if (!vendorKey) {
    return "Unknown";
  }
  return vendorKey
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (segment) => segment.toUpperCase());
}

function normalizeTrackingStatus(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeAmount(value: string | number | null | undefined): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  const text = String(value ?? "").trim();
  if (!text) return "0.00";
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric.toFixed(2);
  }
  return text;
}

function normalizeOptionalAmount(value: string | number | null | undefined): string | undefined {
  const normalized = normalizeAmount(value);
  return normalized === "0.00" && (value == null || String(value).trim().length === 0)
    ? undefined
    : normalized;
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function recordMatchesGapFilters(
  date: string | undefined,
  vendorKey: string | undefined,
  input: BuildReimbursementGapCandidatesInput,
): boolean {
  if (input.vendor) {
    const resolved = resolveVendorConfig(input.vendor);
    const filterKey = resolved?.key ?? input.vendor;
    if (vendorKey !== filterKey) {
      return false;
    }
  }

  if (!date) {
    return input.since == null && input.until == null;
  }
  if (input.since && date < input.since) {
    return false;
  }
  if (input.until && date > input.until) {
    return false;
  }
  return true;
}
