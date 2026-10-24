import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfiguredPath, resolveTangoProfileDataDir } from "@tango/core";
import { loadReimbursementEvidenceRecord } from "./reimbursement-evidence.js";
import {
  CANONICAL_VAULT_RECEIPTS_ROOT,
  LEGACY_VAULT_RECEIPTS_ROOT,
  LEGACY_VAULT_ROOT,
  resolveDefaultReceiptRoot,
  resolveWalmartReceiptDir,
} from "./receipt-paths.js";

const REIMBURSEMENT_SECTION_HEADING = "## Reimbursement Tracking";
const WALMART_RECEIPTS_ENV = "TANGO_WALMART_RECEIPTS_DIR";
// Memo written on driver-tip reimbursement notes. Generic default; an
// installation can set TANGO_REIMBURSEMENT_TIP_MEMO to a program-specific memo.
// Keeps any employer/program-specific memo string out of the repo.
const TIP_REIMBURSEMENT_MEMO =
  process.env.TANGO_REIMBURSEMENT_TIP_MEMO?.trim() || "Reimbursable expense";

export interface ReceiptReimbursementState {
  status?: string;
  system?: string;
  reimbursableItem?: string;
  amount?: number;
  submitted?: string;
  note?: string;
  evidencePath?: string;
  evidenceSourcePath?: string;
  evidenceSha256?: string;
  evidenceImageWidth?: number;
  evidenceImageHeight?: number;
  evidenceCaptureMode?: string;
  evidenceDateVisible?: boolean;
  evidenceDateText?: string;
  expenseReportId?: string;
  expenseConfirmationPath?: string;
  lastUpdated?: string;
}

export interface WalmartReceiptRecord {
  filePath: string;
  noteName: string;
  orderId: string;
  date?: string;
  total?: number;
  cardCharge?: string;
  driverTip?: number;
  deliverySummary?: string;
  isDelivery: boolean;
  reimbursement: ReceiptReimbursementState;
}

export interface ExpenseReimbursementHistoryRecord {
  reviewUrl: string;
  expenseReportId?: string;
  user?: string;
  status?: string;
  receipt?: string;
  submittedDate?: string;
  transactionDate?: string;
  reviewedDate?: string;
  merchant?: string;
  amount?: number;
  statementAmount?: number;
  entity?: string;
  flags?: string;
  memo?: string;
  reviewer?: string;
  expectedPaymentDate?: string;
  deliveredPaymentDate?: string;
}

interface ScoredWalmartReceiptRecord extends WalmartReceiptRecord {
  fileSize: number;
}

export interface ListWalmartDeliveryCandidatesInput {
  since?: string;
  includeSubmitted?: boolean;
}

export interface UpsertWalmartReimbursementInput {
  notePath?: string;
  orderId?: string;
  status: string;
  system?: string;
  reimbursableItem?: string;
  amount?: number;
  submitted?: string;
  note?: string;
  evidencePath?: string;
  expenseReportId?: string | null;
}

export interface BackfillWalmartReceiptInput {
  orderId: string;
  date: string;
  total?: number;
  cardCharge?: string;
  itemsLine?: string;
  grocerySummary?: string;
  notes: string;
  driverTip?: number;
}

export interface ReconcileWalmartReimbursementsInput {
  history: ExpenseReimbursementHistoryRecord[];
  since?: string;
  until?: string;
  updateNotes?: boolean;
}

export interface WalmartExpenseDeskReconciliationMatch {
  orderId: string;
  notePath: string;
  noteName: string;
  amount?: number;
  transactionDate?: string;
  submittedDate?: string;
  noteStatusBefore?: string;
  noteStatusAfter: string;
  expenseStatus?: string;
  expenseReportId?: string;
  reviewUrl: string;
  memo?: string;
}

export interface ReconcileWalmartReimbursementsResult {
  records: WalmartReceiptRecord[];
  matched: WalmartExpenseDeskReconciliationMatch[];
  pending: WalmartReceiptRecord[];
  unverifiedSubmitted: WalmartReceiptRecord[];
  updated: WalmartReceiptRecord[];
  notesExamined: number;
  historyEntriesExamined: number;
}

function getWalmartReceiptDir(): string {
  const configured = process.env[WALMART_RECEIPTS_ENV]?.trim();
  return configured && configured.length > 0
    ? resolveConfiguredPath(configured)
    : resolveWalmartReceiptDir(resolveDefaultReceiptRoot());
}

function resolveNoteNameBaseDir(filePath: string): string {
  const normalizedPath = path.resolve(filePath);
  if (normalizedPath.startsWith(`${LEGACY_VAULT_ROOT}${path.sep}`)) {
    return LEGACY_VAULT_ROOT;
  }

  if (normalizedPath.startsWith(`${CANONICAL_VAULT_RECEIPTS_ROOT}${path.sep}`)) {
    return CANONICAL_VAULT_RECEIPTS_ROOT;
  }

  const walmartReceiptDir = getWalmartReceiptDir();
  if (normalizedPath.startsWith(`${walmartReceiptDir}${path.sep}`)) {
    return walmartReceiptDir;
  }

  const receiptRoot = resolveDefaultReceiptRoot();
  if (normalizedPath.startsWith(`${receiptRoot}${path.sep}`)) {
    return receiptRoot;
  }

  if (normalizedPath.startsWith(`${LEGACY_VAULT_RECEIPTS_ROOT}${path.sep}`)) {
    return LEGACY_VAULT_RECEIPTS_ROOT;
  }

  return path.dirname(normalizedPath);
}

function parseCurrency(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/[$,]/gu, "").trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function renderBackfilledWalmartReceipt(input: BackfillWalmartReceiptInput): string {
  const tip = input.driverTip ?? 0;
  const reimbursementStatus = tip > 0 ? "not_submitted" : "not_applicable";
  const reimbursementAmount = tip > 0 ? formatCurrency(tip) : "$0.00";
  const grocerySummary = input.grocerySummary?.trim()
    || (tip > 0
      ? "Walmart grocery delivery. Full item breakdown not yet backfilled into the note."
      : "Delivery from store order with no reimbursable driver tip shown.");

  const lines = [
    "---",
    `date: ${input.date}`,
    `created: ${input.date}`,
    "types:",
    '  - "[[Receipt]]"',
    "areas:",
    '  - "[[Finance]]"',
    `merchant: "Walmart (Delivery from Store)"`,
    `order_number: "${input.orderId}"`,
    `reimbursable: ${tip > 0 ? "true" : "false"}`,
    `amount: ${tip > 0 ? tip.toFixed(2) : "0.00"}`,
    "source_kind: record",
    "---",
    `# Walmart Order ${input.orderId}`,
    "",
    `- **Date:** ${input.date}`,
  ];
  if (input.total != null) {
    lines.push(`- **Total:** ${formatCurrency(input.total)}`);
  }
  if (input.cardCharge) {
    lines.push(`- **Card Charge:** ${input.cardCharge}`);
  }
  if (input.itemsLine) {
    lines.push(`- **Items:** ${input.itemsLine}`);
  }
  lines.push(
    "",
    "## Non-Grocery Items",
    "",
    "Unknown from current backfill pass.",
    "",
    "## Grocery Items (Summary)",
    "",
    grocerySummary,
    "",
    "## Linked Transactions",
    "",
    "Not yet backfilled.",
    "",
    "## Notes",
    "",
    input.notes.trim(),
    "",
    "## Reimbursement Tracking",
    "",
    `- Status: ${reimbursementStatus}`,
    "- System: ExpenseDesk",
    "- Reimbursable Item: Driver tip",
    `- Amount: ${reimbursementAmount}`,
  );
  if (tip > 0) {
    lines.push(`- Note: ${TIP_REIMBURSEMENT_MEMO}`);
  } else {
    lines.push("- Note: no driver tip on order detail");
  }
  return `${lines.join("\n")}\n`;
}

function parseFirstCurrencyFromRegex(markdown: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(markdown);
    const parsed = parseCurrency(match?.[1]);
    if (parsed != null) {
      return parsed;
    }
  }
  return undefined;
}

function formatCurrency(value: number | undefined): string | undefined {
  if (value == null || !Number.isFinite(value)) {
    return undefined;
  }
  return `$${value.toFixed(2)}`;
}

function normalizeStatus(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function hasCompletedReimbursementStatus(value: string | undefined): boolean {
  const normalized = normalizeStatus(value);
  return normalized === "submitted" || normalized === "reimbursed";
}

function amountsMatch(left: number | undefined, right: number | undefined): boolean {
  return left != null && right != null && Math.abs(left - right) < 0.01;
}

function buildReimbursementMatchKey(date: string | undefined, amount: number | undefined): string | null {
  if (!date || amount == null || !Number.isFinite(amount)) {
    return null;
  }
  return `${date}::${amount.toFixed(2)}`;
}

function deriveReceiptStatusFromExpenseDeskStatus(value: string | undefined): string {
  const normalized = normalizeStatus(value);
  if (normalized === "draft") {
    return "draft";
  }
  if (normalized === "paid") {
    return "reimbursed";
  }
  if (normalized === "rejected") {
    return "rejected";
  }
  if (normalized && normalized.length > 0) {
    return "submitted";
  }
  return "submitted";
}

function isWalmartExpenseDeskHistoryRecord(record: ExpenseReimbursementHistoryRecord): boolean {
  return /walmart/iu.test(record.merchant ?? "")
    && record.transactionDate != null
    && record.amount != null
    && Number.isFinite(record.amount);
}

function parseBooleanValue(value: string | undefined): boolean | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "yes" || trimmed === "true") {
    return true;
  }
  if (trimmed === "no" || trimmed === "false") {
    return false;
  }
  return undefined;
}

function parseDimensions(value: string | undefined): { width?: number; height?: number } {
  const match = /^(\d+)x(\d+)$/u.exec(value?.trim() ?? "");
  if (!match) {
    return {};
  }
  return {
    width: Number.parseInt(match[1]!, 10),
    height: Number.parseInt(match[2]!, 10),
  };
}

function parseKeyValueLines(block: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    const listMatch = /^-\s+(?:\*\*)?([^:*]+):(?:\*\*)?\s*(.+)\s*$/u.exec(line);
    if (listMatch) {
      const [, rawKey, rawValue] = listMatch;
      if (rawKey && rawValue) {
        result.set(rawKey.trim().toLowerCase(), rawValue.trim());
      }
      continue;
    }

    const tableMatch = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/u.exec(line);
    if (!tableMatch) {
      continue;
    }
    const rawKey = tableMatch[1]?.replace(/\*/gu, "").trim();
    const rawValue = tableMatch[2]?.replace(/\*/gu, "").trim();
    if (!rawKey || !rawValue) {
      continue;
    }
    if (/^-+$/.test(rawKey.replace(/:/gu, "")) || /^-+$/.test(rawValue.replace(/:/gu, ""))) {
      continue;
    }
    result.set(rawKey.trim().toLowerCase(), rawValue.trim());
  }
  return result;
}

function extractFrontmatterScalar(markdown: string, key: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(markdown)?.[1];
  if (!frontmatter) {
    return undefined;
  }
  const pattern = new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "imu");
  return pattern.exec(frontmatter)?.[1]?.trim();
}

function parseIsoDate(value: string | undefined): string | undefined {
  return /([0-9]{4}-[0-9]{2}-[0-9]{2})/u.exec(value ?? "")?.[1];
}

function extractReceiptDate(markdown: string): string | undefined {
  const fields = parseKeyValueLines(markdown);
  return parseIsoDate(extractFrontmatterScalar(markdown, "date"))
    ?? parseIsoDate(/^\s*-?\s*\*\*Date:\*\*\s+(.+)$/imu.exec(markdown)?.[1])
    ?? parseIsoDate(/^\s*-?\s*Date:\s+(.+)$/imu.exec(markdown)?.[1])
    ?? parseIsoDate(fields.get("date"));
}

function extractReimbursementSection(markdown: string): string | null {
  const match = new RegExp(
    `${REIMBURSEMENT_SECTION_HEADING}\\n\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "u",
  ).exec(markdown);
  return match?.[1]?.trim() ?? null;
}

function parseReimbursementState(markdown: string): ReceiptReimbursementState {
  const section = extractReimbursementSection(markdown);
  if (!section) {
    return {};
  }

  const fields = parseKeyValueLines(section);
  const dimensions = parseDimensions(fields.get("evidence dimensions"));
  return {
    status: normalizeStatus(fields.get("status")),
    system: fields.get("system"),
    reimbursableItem: fields.get("reimbursable item"),
    amount: parseCurrency(fields.get("amount")),
    submitted: fields.get("submitted"),
    note: fields.get("note"),
    evidencePath: fields.get("evidence"),
    evidenceSourcePath: fields.get("evidence source"),
    evidenceSha256: fields.get("evidence sha256"),
    evidenceImageWidth: dimensions.width,
    evidenceImageHeight: dimensions.height,
    evidenceCaptureMode: fields.get("evidence capture mode"),
    evidenceDateVisible: parseBooleanValue(fields.get("evidence date visible")),
    evidenceDateText: fields.get("evidence date text"),
    expenseReportId: fields.get("expensedesk report id"),
    expenseConfirmationPath: fields.get("expensedesk confirmation"),
    lastUpdated: fields.get("last updated"),
  };
}

export function parseWalmartReceiptMarkdown(filePath: string, markdown: string): WalmartReceiptRecord {
  const noteName = path
    .relative(resolveNoteNameBaseDir(filePath), filePath)
    .replace(/\\/gu, "/");
  const orderId =
    /^#\s+Walmart Order\s+(.+)$/mu.exec(markdown)?.[1]?.trim()
    ?? /-\s+\*\*Order\s*#:\*\*\s+(.+)$/imu.exec(markdown)?.[1]?.trim()
    ?? /-\s+Order\s*#:\s+(.+)$/imu.exec(markdown)?.[1]?.trim()
    ?? /Order\s+([^./]+)\.md$/u.exec(path.basename(filePath))?.[1]?.trim()
    ?? path.basename(filePath, ".md");
  const fields = parseKeyValueLines(markdown);
  const date = extractReceiptDate(markdown);
  const total = parseCurrency(
    extractFrontmatterScalar(markdown, "total")
    ?? /^\s*-?\s*\*\*Total:\*\*\s+(.+)$/imu.exec(markdown)?.[1]
    ?? fields.get("total"),
  );
  const cardCharge =
    /^\s*-?\s*\*\*Card Charge:\*\*\s+(.+)$/imu.exec(markdown)?.[1]?.trim()
    ?? fields.get("card charge");
  const driverTip = parseFirstCurrencyFromRegex(markdown, [
    /driver tips\s+\$([0-9.,]+)/iu,
    /includes?\s+\$([0-9.,]+)\s+driver tip/iu,
    /-\s+Driver tip:\s+\$([0-9.,]+)/iu,
    /driver tip:\s+\$([0-9.,]+)/iu,
    /\|\s*Driver tip\s*\|\s*\$([0-9.,]+)\s*\|/iu,
    /driver tip\s+\$([0-9.,]+)/iu,
  ]);
  const deliverySummary =
    /-\s+(Delivery[^\n]+)/iu.exec(markdown)?.[1]?.trim()
    ?? /(Walmart\+\s+grocery delivery[^\n]+)/iu.exec(markdown)?.[1]?.trim()
    ?? /(Delivery order[^\n]+)/iu.exec(markdown)?.[1]?.trim()
    ?? /(Delivered[^\n]+)/iu.exec(markdown)?.[1]?.trim();
  const reimbursement = parseReimbursementState(markdown);

  return {
    filePath,
    noteName,
    orderId,
    date,
    total,
    cardCharge,
    driverTip,
    deliverySummary,
    isDelivery: Boolean(deliverySummary ?? driverTip != null),
    reimbursement,
  };
}

function choosePreferredReceiptRecord(
  current: ScoredWalmartReceiptRecord | undefined,
  candidate: ScoredWalmartReceiptRecord,
): ScoredWalmartReceiptRecord {
  if (!current) {
    return candidate;
  }

  const currentScore =
    (current.reimbursement.status ? 1000 : 0)
    + (current.driverTip != null ? 100 : 0)
    + (current.deliverySummary ? 50 : 0)
    + current.fileSize;
  const candidateScore =
    (candidate.reimbursement.status ? 1000 : 0)
    + (candidate.driverTip != null ? 100 : 0)
    + (candidate.deliverySummary ? 50 : 0)
    + candidate.fileSize;

  if (candidateScore > currentScore) {
    return candidate;
  }
  if (candidateScore < currentScore) {
    return current;
  }

  return candidate.filePath < current.filePath ? candidate : current;
}

function loadWalmartReceiptRecords(): WalmartReceiptRecord[] {
  const receiptDir = getWalmartReceiptDir();
  if (!fs.existsSync(receiptDir)) {
    return [];
  }

  const deduped = new Map<string, ScoredWalmartReceiptRecord>();

  for (const entry of fs.readdirSync(receiptDir)
    .filter((entry) => entry.endsWith(".md"))
    .sort()) {
      const filePath = path.join(receiptDir, entry);
      const markdown = fs.readFileSync(filePath, "utf8");
      const parsed = parseWalmartReceiptMarkdown(filePath, markdown);
      const scored: ScoredWalmartReceiptRecord = {
        ...parsed,
        fileSize: markdown.length,
      };
      deduped.set(parsed.orderId, choosePreferredReceiptRecord(deduped.get(parsed.orderId), scored));
    }

  return [...deduped.values()]
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
    .map(({ fileSize: _fileSize, ...record }) => record);
}

export function findWalmartReceiptRecord(orderId: string): WalmartReceiptRecord | null {
  const normalized = orderId.trim();
  return loadWalmartReceiptRecords().find((record) => record.orderId === normalized) ?? null;
}

export function backfillWalmartReceiptNote(
  input: BackfillWalmartReceiptInput,
): WalmartReceiptRecord {
  const existing = findWalmartReceiptRecord(input.orderId);
  if (existing) {
    return existing;
  }

  const receiptDir = getWalmartReceiptDir();
  fs.mkdirSync(receiptDir, { recursive: true });
  const filePath = path.join(receiptDir, `${input.date} Order ${input.orderId}.md`);
  const markdown = renderBackfilledWalmartReceipt(input);
  fs.writeFileSync(filePath, markdown, "utf8");
  return parseWalmartReceiptMarkdown(filePath, markdown);
}

export function listWalmartDeliveryCandidates(
  input: ListWalmartDeliveryCandidatesInput = {},
): WalmartReceiptRecord[] {
  const includeSubmitted = input.includeSubmitted === true;
  const since = input.since?.trim();

  return loadWalmartReceiptRecords()
    .filter((record) => record.isDelivery && (record.driverTip ?? 0) > 0)
    .filter((record) => !since || !record.date || record.date >= since)
    .filter((record) => {
      if (includeSubmitted) {
        return true;
      }
      const status = normalizeStatus(record.reimbursement.status);
      return status !== "submitted" && status !== "reimbursed";
    });
}

function buildVerifiedWalmartReceiptRecord(
  record: WalmartReceiptRecord,
  historyRecord: ExpenseReimbursementHistoryRecord,
): WalmartReceiptRecord {
  const nextStatus = deriveReceiptStatusFromExpenseDeskStatus(historyRecord.status);
  return {
    ...record,
    reimbursement: {
      ...record.reimbursement,
      status: nextStatus,
      system: record.reimbursement.system ?? "ExpenseDesk",
      reimbursableItem: record.reimbursement.reimbursableItem ?? "Driver tip",
      amount: record.reimbursement.amount ?? record.driverTip ?? historyRecord.amount,
      submitted: historyRecord.submittedDate ?? record.reimbursement.submitted,
      note: historyRecord.memo ?? record.reimbursement.note,
      expenseReportId: historyRecord.expenseReportId ?? record.reimbursement.expenseReportId,
    },
  };
}

function reimbursementTrackingNeedsSync(
  current: WalmartReceiptRecord,
  verified: WalmartReceiptRecord,
): boolean {
  return normalizeStatus(current.reimbursement.status) !== normalizeStatus(verified.reimbursement.status)
    || current.reimbursement.system !== verified.reimbursement.system
    || current.reimbursement.reimbursableItem !== verified.reimbursement.reimbursableItem
    || !amountsMatch(current.reimbursement.amount, verified.reimbursement.amount)
    || current.reimbursement.submitted !== verified.reimbursement.submitted
    || current.reimbursement.note !== verified.reimbursement.note
    || current.reimbursement.expenseReportId !== verified.reimbursement.expenseReportId;
}

function clearStaleDraftTracking(record: WalmartReceiptRecord): WalmartReceiptRecord {
  if (normalizeStatus(record.reimbursement.status) !== "draft") {
    return record;
  }

  return {
    ...record,
    reimbursement: {
      ...record.reimbursement,
      status: "not_submitted",
      submitted: undefined,
      expenseReportId: undefined,
    },
  };
}

export function reconcileWalmartReimbursementsAgainstExpenseDesk(
  input: ReconcileWalmartReimbursementsInput,
): ReconcileWalmartReimbursementsResult {
  const since = input.since?.trim();
  const until = input.until?.trim();
  const candidates = loadWalmartReceiptRecords()
    .filter((record) => record.isDelivery && (record.driverTip ?? 0) > 0)
    .filter((record) => !since || !record.date || record.date >= since)
    .filter((record) => !until || !record.date || record.date <= until);

  const historyEntries = input.history
    .filter(isWalmartExpenseDeskHistoryRecord)
    .filter((record) => {
      if (since && record.transactionDate && record.transactionDate < since) {
        return false;
      }
      if (until && record.transactionDate && record.transactionDate > until) {
        return false;
      }
      return true;
    });

  const historyByKey = new Map<string, ExpenseReimbursementHistoryRecord[]>();
  for (const record of historyEntries) {
    const key = buildReimbursementMatchKey(record.transactionDate, record.amount);
    if (!key) {
      continue;
    }
    const existing = historyByKey.get(key) ?? [];
    existing.push(record);
    historyByKey.set(key, existing);
  }

  const records: WalmartReceiptRecord[] = [];
  const matched: WalmartExpenseDeskReconciliationMatch[] = [];
  const pending: WalmartReceiptRecord[] = [];
  const unverifiedSubmitted: WalmartReceiptRecord[] = [];
  const updated: WalmartReceiptRecord[] = [];

  for (const candidate of candidates) {
    const key = buildReimbursementMatchKey(candidate.date, candidate.driverTip);
    const matches = key ? historyByKey.get(key) : undefined;
    const historyRecord = matches?.shift();
    if (matches && matches.length === 0 && key) {
      historyByKey.delete(key);
    }

    if (!historyRecord) {
      const verifiedPending = clearStaleDraftTracking(candidate);
      const shouldSync = reimbursementTrackingNeedsSync(candidate, verifiedPending);
      const reconciled =
        input.updateNotes === true && shouldSync
          ? upsertWalmartReimbursementTracking({
              notePath: candidate.filePath,
              status: verifiedPending.reimbursement.status ?? "not_submitted",
              system: verifiedPending.reimbursement.system,
              reimbursableItem: verifiedPending.reimbursement.reimbursableItem,
              amount: verifiedPending.reimbursement.amount,
              submitted: verifiedPending.reimbursement.submitted,
              note: verifiedPending.reimbursement.note,
              expenseReportId: verifiedPending.reimbursement.expenseReportId ?? null,
            })
          : verifiedPending;

      records.push(reconciled);
      if (hasCompletedReimbursementStatus(candidate.reimbursement.status)) {
        unverifiedSubmitted.push(candidate);
      } else {
        pending.push(reconciled);
      }
      if (input.updateNotes === true && shouldSync) {
        updated.push(reconciled);
      }
      continue;
    }

    const verified = buildVerifiedWalmartReceiptRecord(candidate, historyRecord);
    const reconciled =
      input.updateNotes === true && reimbursementTrackingNeedsSync(candidate, verified)
        ? upsertWalmartReimbursementTracking({
            notePath: candidate.filePath,
            status: verified.reimbursement.status ?? "submitted",
            system: verified.reimbursement.system,
            reimbursableItem: verified.reimbursement.reimbursableItem,
            amount: verified.reimbursement.amount,
            submitted: verified.reimbursement.submitted,
            note: verified.reimbursement.note,
            expenseReportId: verified.reimbursement.expenseReportId,
          })
        : verified;

    records.push(reconciled);
    if (input.updateNotes === true && reimbursementTrackingNeedsSync(candidate, verified)) {
      updated.push(reconciled);
    }
    matched.push({
      orderId: candidate.orderId,
      notePath: candidate.filePath,
      noteName: candidate.noteName,
      amount: candidate.driverTip,
      transactionDate: historyRecord.transactionDate,
      submittedDate: historyRecord.submittedDate,
      noteStatusBefore: candidate.reimbursement.status,
      noteStatusAfter: reconciled.reimbursement.status ?? "submitted",
      expenseStatus: historyRecord.status,
      expenseReportId: historyRecord.expenseReportId,
      reviewUrl: historyRecord.reviewUrl,
      memo: historyRecord.memo,
    });
  }

  return {
    records,
    matched,
    pending,
    unverifiedSubmitted,
    updated,
    notesExamined: candidates.length,
    historyEntriesExamined: input.history.length,
  };
}

function renderReimbursementSection(state: ReceiptReimbursementState): string {
  const lines = [
    REIMBURSEMENT_SECTION_HEADING,
    "",
    `- Status: ${state.status ?? "not_submitted"}`,
  ];

  if (state.system) {
    lines.push(`- System: ${state.system}`);
  }
  if (state.reimbursableItem) {
    lines.push(`- Reimbursable Item: ${state.reimbursableItem}`);
  }
  if (state.amount != null) {
    lines.push(`- Amount: ${formatCurrency(state.amount)}`);
  }
  if (state.submitted) {
    lines.push(`- Submitted: ${state.submitted}`);
  }
  if (state.note) {
    lines.push(`- Note: ${state.note}`);
  }
  if (state.evidencePath) {
    lines.push(`- Evidence: ${state.evidencePath}`);
  }
  if (state.evidenceSourcePath) {
    lines.push(`- Evidence Source: ${state.evidenceSourcePath}`);
  }
  if (state.evidenceSha256) {
    lines.push(`- Evidence SHA256: ${state.evidenceSha256}`);
  }
  if (state.evidenceImageWidth != null && state.evidenceImageHeight != null) {
    lines.push(`- Evidence Dimensions: ${state.evidenceImageWidth}x${state.evidenceImageHeight}`);
  }
  if (state.evidenceCaptureMode) {
    lines.push(`- Evidence Capture Mode: ${state.evidenceCaptureMode}`);
  }
  if (state.evidenceDateVisible != null) {
    lines.push(`- Evidence Date Visible: ${state.evidenceDateVisible ? "yes" : "no"}`);
  }
  if (state.evidenceDateText) {
    lines.push(`- Evidence Date Text: ${state.evidenceDateText}`);
  }
  if (state.expenseReportId) {
    lines.push(`- ExpenseDesk Report ID: ${state.expenseReportId}`);
  }
  if (state.expenseConfirmationPath) {
    lines.push(`- ExpenseDesk Confirmation: ${state.expenseConfirmationPath}`);
  }
  if (state.lastUpdated) {
    lines.push(`- Last Updated: ${state.lastUpdated}`);
  }

  return `${lines.join("\n")}\n`;
}

function resolveReceiptPath(input: UpsertWalmartReimbursementInput): string {
  if (input.notePath?.trim()) {
    return path.resolve(input.notePath);
  }

  const orderId = input.orderId?.trim();
  if (!orderId) {
    throw new Error("upsert requires either notePath or orderId");
  }

  const match = loadWalmartReceiptRecords().find((record) => record.orderId === orderId);
  if (!match) {
    throw new Error(`No Walmart receipt found for order ${orderId}`);
  }
  return match.filePath;
}

export function upsertWalmartReimbursementTracking(
  input: UpsertWalmartReimbursementInput,
): WalmartReceiptRecord {
  const filePath = resolveReceiptPath(input);
  const current = fs.readFileSync(filePath, "utf8");
  const currentRecord = parseWalmartReceiptMarkdown(filePath, current);
  const resolvedEvidencePath = input.evidencePath ?? currentRecord.reimbursement.evidencePath;
  const evidenceRecord = resolvedEvidencePath
    ? loadReimbursementEvidenceRecord(resolvedEvidencePath)
    : null;
  const nextState: ReceiptReimbursementState = {
    ...currentRecord.reimbursement,
    status: normalizeStatus(input.status),
    system: input.system ?? currentRecord.reimbursement.system ?? "ExpenseDesk",
    reimbursableItem: input.reimbursableItem ?? currentRecord.reimbursement.reimbursableItem ?? "Driver tip",
    amount: input.amount ?? currentRecord.reimbursement.amount ?? currentRecord.driverTip,
    submitted: input.submitted ?? currentRecord.reimbursement.submitted,
    note: input.note ?? currentRecord.reimbursement.note,
    evidencePath: evidenceRecord?.archivedPath ?? resolvedEvidencePath,
    evidenceSourcePath: evidenceRecord?.sourcePath ?? currentRecord.reimbursement.evidenceSourcePath,
    evidenceSha256: evidenceRecord?.sha256 ?? currentRecord.reimbursement.evidenceSha256,
    evidenceImageWidth: evidenceRecord?.imageWidth ?? currentRecord.reimbursement.evidenceImageWidth,
    evidenceImageHeight: evidenceRecord?.imageHeight ?? currentRecord.reimbursement.evidenceImageHeight,
    evidenceCaptureMode: evidenceRecord?.captureMode ?? currentRecord.reimbursement.evidenceCaptureMode,
    evidenceDateVisible: evidenceRecord?.dateVisible ?? currentRecord.reimbursement.evidenceDateVisible,
    evidenceDateText: evidenceRecord?.visibleDateText?.join(", ") ?? currentRecord.reimbursement.evidenceDateText,
    expenseReportId: input.expenseReportId !== undefined
      ? input.expenseReportId ?? undefined
      : evidenceRecord?.expenseReportId ?? currentRecord.reimbursement.expenseReportId,
    expenseConfirmationPath: evidenceRecord?.expenseConfirmationPath ?? currentRecord.reimbursement.expenseConfirmationPath,
    lastUpdated: new Date().toISOString(),
  };

  const renderedSection = renderReimbursementSection(nextState);
  const sectionMatch = new RegExp(
    `${REIMBURSEMENT_SECTION_HEADING}\\n\\n[\\s\\S]*?(?=\\n##\\s|$)`,
    "u",
  );

  let updated = current;
  if (sectionMatch.test(current)) {
    updated = current.replace(sectionMatch, renderedSection.trimEnd());
  } else {
    updated = `${current.trimEnd()}\n\n${renderedSection}`;
  }

  fs.writeFileSync(filePath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
  return parseWalmartReceiptMarkdown(filePath, fs.readFileSync(filePath, "utf8"));
}
