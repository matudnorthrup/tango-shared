import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultObsidianVaultPath } from "@tango/core";

export const FINANCE_CATEGORIZATION_RULES_PATH = "References/Finance/Lunch Money Rules.md";

export interface FinanceCategorizationRules {
  relativePath: typeof FINANCE_CATEGORIZATION_RULES_PATH;
  content: string;
}

export interface FinanceRulesReadOptions {
  vaultRoot?: string;
  readFile?: (filePath: string) => string;
}

/**
 * Resolve and read the finance rules before an automation worker can mutate
 * Lunch Money. Keeping this in the deterministic pre-check prevents workers
 * from interpreting a vault-relative path as repository-relative (TGO-829).
 */
export function readFinanceCategorizationRules(
  options: FinanceRulesReadOptions = {},
): FinanceCategorizationRules {
  const configuredRoot = options.vaultRoot ?? resolveDefaultObsidianVaultPath();
  const expandedRoot = configuredRoot === "~"
    ? os.homedir()
    : configuredRoot.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), configuredRoot.slice(2))
      : configuredRoot;
  const vaultRoot = path.resolve(expandedRoot);
  const rulesPath = path.resolve(vaultRoot, ...FINANCE_CATEGORIZATION_RULES_PATH.split("/"));
  const relativeFromVault = path.relative(vaultRoot, rulesPath);
  if (
    relativeFromVault === ".."
    || relativeFromVault.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeFromVault)
  ) {
    throw new Error(
      `Finance automation blocked: required rules note '${FINANCE_CATEGORIZATION_RULES_PATH}' escapes the configured vault.`,
    );
  }

  let content: string;
  try {
    content = (options.readFile ?? ((filePath) => fs.readFileSync(filePath, "utf8")))(rulesPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "read error")
      : "read error";
    throw new Error(
      `Finance automation blocked: unable to read required rules note '${FINANCE_CATEGORIZATION_RULES_PATH}' (${code}).`,
    );
  }

  if (content.trim().length === 0) {
    throw new Error(
      `Finance automation blocked: required rules note '${FINANCE_CATEGORIZATION_RULES_PATH}' is empty.`,
    );
  }

  return {
    relativePath: FINANCE_CATEGORIZATION_RULES_PATH,
    content,
  };
}

type TransactionRecord = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsePlaidMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return record(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Identify strong bank-account-transfer signals before ordinary payee rules.
 * Merchant transfers such as Venmo are deliberately excluded unless their
 * payee explicitly describes a transfer between named bank accounts.
 */
export function isBudgetNeutralInternalTransfer(transaction: TransactionRecord): boolean {
  const payee = String(transaction.payee ?? "").trim();
  const plaid = parsePlaidMetadata(transaction.plaid_metadata);
  if (!plaid) return false;

  const personalFinanceCategory = record(plaid.personal_finance_category);
  const primary = String(personalFinanceCategory?.primary ?? "").toUpperCase();
  const detailed = String(personalFinanceCategory?.detailed ?? "").toUpperCase();
  const legacyCategories = strings(plaid.category).map((entry) => entry.toUpperCase());
  const hasTransferMetadata = primary.startsWith("TRANSFER_")
    || legacyCategories.some((entry) => entry === "TRANSFER");
  const isAccountTransfer = /(?:ACCOUNT_TRANSFER|SAVINGS)$/u.test(detailed);
  if (!hasTransferMetadata || !isAccountTransfer) return false;

  const explicitlyNamesAccounts = /\btransfer\s+(?:to|from)\s+.+\b(?:account|checking|savings|spending|money market)\b/iu.test(payee);
  const counterparties = Array.isArray(plaid.counterparties) ? plaid.counterparties : [];
  const hasFinancialInstitution = counterparties.some((counterparty) => {
    const parsed = record(counterparty);
    return String(parsed?.type ?? "").toLowerCase() === "financial_institution";
  });

  return explicitlyNamesAccounts
    || (hasFinancialInstitution && /\btransfer\s+(?:to|from)\b/iu.test(payee));
}

export function findBudgetNeutralInternalTransfers(
  transactions: TransactionRecord[],
): TransactionRecord[] {
  return transactions.filter(isBudgetNeutralInternalTransfer);
}

export function formatBudgetNeutralTransferDetails(transactions: TransactionRecord[]): string {
  if (transactions.length === 0) return "(none)";
  return transactions.map((transaction) => {
    const id = String(transaction.id ?? "unknown");
    const payee = String(transaction.payee ?? "Unknown transfer");
    const amount = String(transaction.amount ?? "unknown");
    return `- transaction ${id}: ${payee} (${amount})`;
  }).join("\n");
}
