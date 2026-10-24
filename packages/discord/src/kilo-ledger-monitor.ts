import {
  applyMonthlyFunding,
  formatCents,
  getKiloPendingSettlementCents,
  KiloLedgerStore,
  reconcileKiloLedger,
  settleKiloSpending,
  summarizeKiloLedger,
  type DeterministicHandler,
  type KiloLedgerAccount,
  type KiloLedger,
  type KiloMovement,
  type KiloReconciliationSnapshot,
} from "@tango/core";

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_FUNDING_LOOKBACK_MONTHS = 6;
const DEFAULT_FUNDING_GRACE_DAYS = 2;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface KiloLedgerMonitorOptions {
  filePath?: string;
  fetchImpl?: FetchLike;
  getLunchMoneyAccessToken?: () => Promise<string | undefined> | string | undefined;
  lunchMoneyAccessToken?: string;
  now?: Date;
  timeZone?: string;
  fundingLookbackMonths?: number;
  fundingGraceDays?: number;
}

interface LunchMoneyKiloAccount {
  id?: string;
  name?: string;
  displayName?: string;
  mask?: string;
  balanceCents: number;
  status?: string;
}

interface LunchMoneyTransaction {
  id?: string;
  date: string;
  payee?: string;
  notes?: string;
  categoryName?: string;
  accountId?: string;
  accountMask?: string;
  accountName?: string;
  amountCents: number;
  isPending: boolean;
  raw: Record<string, unknown>;
}

interface LunchMoneySnapshot {
  account: LunchMoneyKiloAccount | null;
  transactions: LunchMoneyTransaction[];
  warnings: string[];
}

export interface KiloLedgerMonitorReport {
  checkedAt: string;
  ledgerPath: string;
  accountFound: boolean;
  actionLines: string[];
  flaggedLines: string[];
  funding: {
    dueMonths: string[];
    checkedMonths: string[];
    appliedMonths: string[];
    alreadyLedgeredMonths: string[];
  };
  settlement: {
    pendingBeforeCents: number;
    pendingAfterCents: number;
    settledCents: number;
  };
  reconciliation?: KiloReconciliationSnapshot;
  summary: ReturnType<typeof summarizeKiloLedger>;
}

export function createKiloLedgerMonitorHandler(
  options: KiloLedgerMonitorOptions = {},
): DeterministicHandler {
  return async () => {
    const report = await runKiloLedgerMonitor(options);
    return {
      status: "ok",
      summary: formatKiloLedgerMonitorSummary(report),
      data: {
        accountFound: report.accountFound,
        actionCount: report.actionLines.length,
        flaggedCount: report.flaggedLines.length,
        funding: report.funding,
        settlement: report.settlement,
        reconciliation: report.reconciliation
          ? {
              status: report.reconciliation.status,
              driftCents: report.reconciliation.driftCents,
              externalBalanceCents: report.reconciliation.externalBalanceCents,
              expectedExternalBalanceCents: report.reconciliation.expectedExternalBalanceCents,
            }
          : undefined,
        ledgerTotalCents: report.summary.totalCents,
        pendingSettlementCents: report.summary.pendingSettlementCents,
        expectedExternalBalanceCents: report.summary.expectedExternalBalanceCents,
      },
    };
  };
}

export async function runKiloLedgerMonitor(
  options: KiloLedgerMonitorOptions = {},
): Promise<KiloLedgerMonitorReport> {
  const now = options.now ?? new Date();
  const checkedAt = now.toISOString();
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const today = formatDateInTimeZone(now, timeZone);
  const store = new KiloLedgerStore({ filePath: options.filePath });
  let ledger = store.read();
  const actionLines: string[] = [];
  const flaggedLines: string[] = [];

  const dueMonths = fundingDueMonths(ledger, today);
  const alreadyLedgeredMonths = dueMonths.filter((month) =>
    isMonthlyFundingLedgered(ledger, month, timeZone),
  );
  const unfundedDueMonths = dueMonths.filter((month) => !alreadyLedgeredMonths.includes(month));
  const fundingLookbackMonths = Math.max(
    1,
    Math.floor(options.fundingLookbackMonths ?? DEFAULT_FUNDING_LOOKBACK_MONTHS),
  );
  const checkedMonths = unfundedDueMonths.slice(-fundingLookbackMonths);
  const olderUncheckedMonths = unfundedDueMonths.slice(0, -fundingLookbackMonths);
  if (olderUncheckedMonths.length > 0) {
    flaggedLines.push(
      `Kilo monthly funding has older unledgered due months outside the monitor window: ${olderUncheckedMonths.join(", ")}.`,
    );
  }

  const pendingBeforeCents = getKiloPendingSettlementCents(ledger);
  const transactionStartDate = monitorTransactionStartDate({
    checkedMonths,
    ledger,
    pendingSettlementCents: pendingBeforeCents,
    timeZone,
    today,
  });
  const needsTransactions = checkedMonths.length > 0 || pendingBeforeCents > 0;
  const lunchMoney = await fetchLunchMoneySnapshot({
    ...options,
    ledgerAccount: ledger.account,
    startDate: transactionStartDate,
    endDate: today,
    needsTransactions,
  });

  for (const warning of lunchMoney.warnings) {
    flaggedLines.push(warning);
  }

  const appliedMonths: string[] = [];
  if (lunchMoney.account) {
    for (const month of checkedMonths) {
      const transaction = findMonthlyFundingTransaction(
        lunchMoney.transactions,
        lunchMoney.account,
        month,
        ledger.settings.monthlyContributionCents,
        ledger,
      );
      if (!transaction) {
        if (shouldFlagMissingFunding(month, today, options.fundingGraceDays ?? DEFAULT_FUNDING_GRACE_DAYS)) {
          flaggedLines.push(
            `Kilo monthly funding for ${month} is due, but no posted ${formatCents(ledger.settings.monthlyContributionCents)} transfer into ${formatLedgerAccount(ledger.account)} was found in Lunch Money.`,
          );
        } else {
          actionLines.push(
            `Watching for ${formatCents(ledger.settings.monthlyContributionCents)} Kilo monthly funding for ${month}; still inside the posting grace window.`,
          );
        }
        continue;
      }

      const externalId = buildTransactionExternalId("monthly-funding", transaction, month);
      try {
        const result = store.mutate((currentLedger) =>
          applyMonthlyFunding(currentLedger, {
            actor: "system",
            now: checkedAt,
            description: `Applied Kilo monthly funding for ${month} after Lunch Money transfer ${transaction.id ?? transaction.date} posted.`,
            source: "lunchmoney-monthly-funding",
            externalId,
          }),
        );
        ledger = result.ledger;
        appliedMonths.push(month);
        actionLines.push(
          result.idempotent
            ? `Kilo monthly funding for ${month} was already recorded from Lunch Money transfer ${transaction.id ?? "unknown"}.`
            : `Applied ${formatCents(result.movement?.amountCents ?? ledger.settings.monthlyContributionCents)} Kilo monthly funding for ${month}.`,
        );
      } catch (err) {
        flaggedLines.push(
          `Kilo monthly funding for ${month} could not be applied automatically: ${errorMessage(err)}.`,
        );
      }
    }
  } else if (checkedMonths.length > 0) {
    flaggedLines.push(
      `Kilo monthly funding could not be checked because Lunch Money account ${formatLedgerAccount(ledger.account)} was unavailable.`,
    );
  }

  let settledCents = 0;
  let pendingAfterCents = getKiloPendingSettlementCents(ledger);
  if (pendingAfterCents > 0 && lunchMoney.account) {
    const candidates = findSettlementCandidates(lunchMoney.transactions, lunchMoney.account, ledger, timeZone);
    if (candidates.length === 0) {
      flaggedLines.push(
        `Kilo has ${formatCents(pendingAfterCents)} of pending settlement, but no posted transfer out of ${formatLedgerAccount(ledger.account)} was found in Lunch Money.`,
      );
    }

    for (const transaction of candidates) {
      if (pendingAfterCents <= 0) {
        break;
      }
      const externalId = buildTransactionExternalId("settlement", transaction);
      try {
        const result = store.mutate((currentLedger) =>
          settleKiloSpending(currentLedger, {
            amountCents: transaction.amountCents,
            actor: "system",
            now: checkedAt,
            description: `Settled Kilo spending after Lunch Money transfer ${transaction.id ?? transaction.date} posted.`,
            source: "lunchmoney-settlement",
            externalId,
          }),
        );
        ledger = result.ledger;
        pendingAfterCents = getKiloPendingSettlementCents(ledger);
        if (!result.idempotent) {
          settledCents += result.movement?.amountCents ?? transaction.amountCents;
        }
        actionLines.push(
          result.idempotent
            ? `Kilo settlement transfer ${transaction.id ?? "unknown"} was already recorded.`
            : `Settled ${formatCents(transaction.amountCents)} of Kilo spending from posted transfer ${transaction.id ?? "unknown"}.`,
        );
      } catch (err) {
        flaggedLines.push(
          `Posted Kilo account transfer ${transaction.id ?? transaction.date} for ${formatCents(transaction.amountCents)} could not be auto-settled against pending Kilo spending: ${errorMessage(err)}.`,
        );
      }
    }

    if (pendingAfterCents > 0 && settledCents > 0) {
      flaggedLines.push(
        `Kilo still has ${formatCents(pendingAfterCents)} of pending settlement after applying posted settlement transfers.`,
      );
    }
  } else if (pendingAfterCents > 0) {
    flaggedLines.push(
      `Kilo has ${formatCents(pendingAfterCents)} of pending settlement, but Lunch Money transactions were unavailable.`,
    );
  }

  const reconciliationResult = store.mutate((currentLedger) =>
    reconcileKiloLedger(currentLedger, {
      externalBalanceCents: lunchMoney.account?.balanceCents ?? null,
      source: lunchMoney.account
        ? `Lunch Money ${formatLunchMoneyAccount(lunchMoney.account)}`
        : "Lunch Money unavailable",
      now: checkedAt,
      note: lunchMoney.account
        ? `Kilo ledger monitor; Lunch Money account id ${lunchMoney.account.id ?? "unknown"} status ${lunchMoney.account.status ?? "unknown"}.`
        : "Kilo ledger monitor could not fetch the configured Kilo account from Lunch Money.",
    }),
  );
  ledger = reconciliationResult.ledger;
  const reconciliation = reconciliationResult.reconciliation;
  if (reconciliation?.status === "drift" && reconciliation.driftCents != null) {
    flaggedLines.push(
      `Kilo external balance drift: expected ${formatCents(reconciliation.expectedExternalBalanceCents)}, Lunch Money shows ${formatCents(reconciliation.externalBalanceCents ?? 0)}, drift ${formatCents(reconciliation.driftCents)}. Writes remain allowed.`,
    );
  } else if (reconciliation?.status === "unavailable") {
    flaggedLines.push(
      `Kilo external balance could not be reconciled because Lunch Money account ${formatLedgerAccount(ledger.account)} was unavailable.`,
    );
  }

  return {
    checkedAt,
    ledgerPath: store.filePath,
    accountFound: lunchMoney.account != null,
    actionLines,
    flaggedLines: uniqueLines(flaggedLines),
    funding: {
      dueMonths,
      checkedMonths,
      appliedMonths,
      alreadyLedgeredMonths,
    },
    settlement: {
      pendingBeforeCents,
      pendingAfterCents,
      settledCents,
    },
    reconciliation,
    summary: summarizeKiloLedger(ledger),
  };
}

export function formatKiloLedgerMonitorSummary(report: KiloLedgerMonitorReport): string {
  const reconciliationLine = report.reconciliation
    ? formatReconciliationStatus(report.reconciliation)
    : "Reconciliation did not run.";
  const fundingLine = formatFundingStatus(report);
  const settlementLine = report.settlement.pendingAfterCents === 0
    ? report.settlement.settledCents > 0
      ? `settled ${formatCents(report.settlement.settledCents)}; no pending settlement remains`
      : "no pending settlement"
    : `${formatCents(report.settlement.pendingAfterCents)} pending settlement remains`;

  const lines = [
    `Kilo ledger monitor checked the configured Kilo account: ${fundingLine}; ${settlementLine}; ${reconciliationLine}.`,
  ];

  if (report.flaggedLines.length > 0) {
    lines.push(
      "",
      "**Flagged:**",
      ...report.flaggedLines.map((line) => `- ${line}`),
    );
  }

  if (report.actionLines.length > 0) {
    lines.push(
      "",
      "**Actions Taken:**",
      ...report.actionLines.map((line) => `- ${line}`),
    );
  }

  lines.push(
    "",
    "**Snapshot:**",
    `- Ledger total: ${report.summary.total}`,
    `- Pending settlement: ${report.summary.pendingSettlement}`,
    `- Expected external balance: ${report.summary.expectedExternalBalance}`,
  );

  return lines.join("\n");
}

async function fetchLunchMoneySnapshot(input: KiloLedgerMonitorOptions & {
  ledgerAccount: KiloLedgerAccount;
  startDate: string;
  endDate: string;
  needsTransactions: boolean;
}): Promise<LunchMoneySnapshot> {
  const warnings: string[] = [];
  const token = await resolveLunchMoneyAccessToken(input).catch((err: unknown) => {
    warnings.push(`Lunch Money token lookup failed for Kilo ledger monitor: ${errorMessage(err)}.`);
    return undefined;
  });
  if (!token) {
    warnings.push("Lunch Money token is unavailable for Kilo ledger monitor.");
    return { account: null, transactions: [], warnings };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const account = await fetchKiloAccount(fetchImpl, token, input.ledgerAccount).catch((err: unknown) => {
    warnings.push(`Lunch Money Kilo account fetch failed: ${errorMessage(err)}.`);
    return null;
  });
  if (!input.needsTransactions) {
    return { account, transactions: [], warnings };
  }

  const transactions = await fetchLunchMoneyTransactions(fetchImpl, token, input.startDate, input.endDate)
    .catch((err: unknown) => {
      warnings.push(`Lunch Money transaction fetch failed for Kilo ledger monitor: ${errorMessage(err)}.`);
      return [];
    });
  return { account, transactions, warnings };
}

async function resolveLunchMoneyAccessToken(
  options: KiloLedgerMonitorOptions,
): Promise<string | undefined> {
  if (options.lunchMoneyAccessToken?.trim()) {
    return options.lunchMoneyAccessToken.trim();
  }
  if (options.getLunchMoneyAccessToken) {
    const value = await options.getLunchMoneyAccessToken();
    return value?.trim() || undefined;
  }
  return process.env.LUNCH_MONEY_ACCESS_TOKEN?.trim() || undefined;
}

async function fetchKiloAccount(
  fetchImpl: FetchLike,
  token: string,
  ledgerAccount: KiloLedgerAccount,
): Promise<LunchMoneyKiloAccount | null> {
  const response = await fetchImpl("https://dev.lunchmoney.app/v1/plaid_accounts", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const parsed = JSON.parse(text) as unknown;
  const accounts = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.plaid_accounts)
      ? parsed.plaid_accounts
      : isRecord(parsed) && Array.isArray(parsed.accounts)
        ? parsed.accounts
        : [];
  const account = accounts
    .filter(isRecord)
    .find((candidate) => lunchMoneyAccountMatches(candidate, ledgerAccount));
  if (!account) {
    return null;
  }

  const balance = numericValue(
    account.balance
      ?? account.current_balance
      ?? account.currentBalance
      ?? account.to_base
      ?? account.toBase,
  );
  if (balance == null) {
    return null;
  }

  return {
    id: stringValue(account.id),
    name: stringValue(account.name),
    displayName: stringValue(account.display_name ?? account.displayName),
    mask: stringValue(account.mask),
    balanceCents: Math.round(balance * 100),
    status: stringValue(account.status),
  };
}

function lunchMoneyAccountMatches(
  candidate: Record<string, unknown>,
  ledgerAccount: KiloLedgerAccount,
): boolean {
  const id = stringValue(candidate.id);
  const mask = stringValue(candidate.mask);
  const displayName = stringValue(candidate.display_name ?? candidate.displayName ?? candidate.name);
  if (ledgerAccount.lunchMoneyPlaidAccountId && id === ledgerAccount.lunchMoneyPlaidAccountId) {
    return true;
  }
  if (ledgerAccount.mask !== "0000" && mask === ledgerAccount.mask) {
    return true;
  }
  return normalizeComparableText(displayName) === normalizeComparableText(ledgerAccount.lunchMoneyName);
}

function formatLedgerAccount(account: KiloLedgerAccount): string {
  return formatLunchMoneyAccount({
    displayName: account.lunchMoneyName,
    mask: account.mask === "0000" ? undefined : account.mask,
  });
}

function formatLunchMoneyAccount(account: Pick<LunchMoneyKiloAccount, "displayName" | "name" | "mask">): string {
  const name = account.displayName ?? account.name ?? "configured Kilo account";
  return account.mask ? `${name} ${account.mask}` : name;
}

async function fetchLunchMoneyTransactions(
  fetchImpl: FetchLike,
  token: string,
  startDate: string,
  endDate: string,
): Promise<LunchMoneyTransaction[]> {
  const url = new URL("https://dev.lunchmoney.app/v1/transactions");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);

  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  const parsed = JSON.parse(text) as unknown;
  const transactions = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.transactions)
      ? parsed.transactions
      : [];

  return transactions
    .filter(isRecord)
    .map(normalizeLunchMoneyTransaction)
    .filter((transaction): transaction is LunchMoneyTransaction => transaction !== null);
}

function normalizeLunchMoneyTransaction(raw: Record<string, unknown>): LunchMoneyTransaction | null {
  const date = stringValue(raw.date);
  const amount = numericValue(raw.to_base ?? raw.toBase ?? raw.amount);
  if (!date || amount == null) {
    return null;
  }

  return {
    id: stringValue(raw.id),
    date,
    payee: stringValue(raw.payee ?? raw.display_name ?? raw.displayName ?? raw.original_name),
    notes: stringValue(raw.notes ?? raw.display_notes ?? raw.displayNotes),
    categoryName: stringValue(raw.category_name ?? raw.categoryName),
    accountId: stringValue(raw.plaid_account_id ?? raw.plaidAccountId ?? raw.account_id ?? raw.asset_id),
    accountMask: stringValue(raw.plaid_account_mask ?? raw.plaidAccountMask),
    accountName: stringValue(
      raw.plaid_account_display_name
        ?? raw.plaidAccountDisplayName
        ?? raw.plaid_account_name
        ?? raw.account_display_name
        ?? raw.accountDisplayName
        ?? raw.asset_display_name
        ?? raw.account_name,
    ),
    amountCents: Math.round(amount * 100),
    isPending: raw.is_pending === true || String(raw.status ?? "").toLowerCase() === "pending",
    raw,
  };
}

function fundingDueMonths(ledger: KiloLedger, today: string): string[] {
  const startDate = ledger.settings.fundingStartOn;
  if (today < startDate) {
    return [];
  }
  return monthRange(startDate.slice(0, 7), today.slice(0, 7));
}

function isMonthlyFundingLedgered(ledger: KiloLedger, month: string, timeZone: string): boolean {
  return ledger.movements.some((movement) => {
    if (movement.type !== "funding" || movement.amountCents !== ledger.settings.monthlyContributionCents) {
      return false;
    }
    const movementMonth = movement.occurredOn?.slice(0, 7) ?? formatDateInTimeZone(new Date(movement.createdAt), timeZone).slice(0, 7);
    return (
      movement.externalId?.includes(month) === true
      || movement.description?.includes(month) === true
      || (
        (movement.source === "monthly-funding" || movement.source === "lunchmoney-monthly-funding")
        && movementMonth === month
      )
    );
  });
}

function monitorTransactionStartDate(input: {
  checkedMonths: string[];
  ledger: KiloLedger;
  pendingSettlementCents: number;
  timeZone: string;
  today: string;
}): string {
  const candidates: string[] = [];
  if (input.checkedMonths[0]) {
    candidates.push(`${input.checkedMonths[0]}-01`);
  }
  if (input.pendingSettlementCents > 0) {
    const earliest = earliestUnsettledSpendDate(input.ledger, input.timeZone);
    if (earliest) {
      candidates.push(earliest);
    }
  }
  return candidates.sort()[0] ?? input.today;
}

function earliestUnsettledSpendDate(ledger: KiloLedger, timeZone: string): string | undefined {
  return ledger.movements
    .filter((movement) => movement.type === "spend" && !movement.settlementMovementId)
    .map((movement) => formatDateInTimeZone(new Date(movement.createdAt), timeZone))
    .sort()[0];
}

function shouldFlagMissingFunding(month: string, today: string, graceDays: number): boolean {
  return today >= addDays(`${month}-01`, Math.max(0, Math.floor(graceDays)));
}

function findMonthlyFundingTransaction(
  transactions: LunchMoneyTransaction[],
  account: LunchMoneyKiloAccount,
  month: string,
  amountCents: number,
  ledger: KiloLedger,
): LunchMoneyTransaction | undefined {
  return transactions
    .filter((transaction) => {
      const externalId = buildTransactionExternalId("monthly-funding", transaction, month);
      return (
        isKiloAccountTransaction(transaction, account)
        && !transaction.isPending
        && transaction.date >= `${month}-01`
        && transaction.date <= monthEndDate(month)
        && transaction.amountCents === -amountCents
        && !hasMovementExternalId(ledger, "funding", externalId)
      );
    })
    .sort(compareTransactions)[0];
}

function findSettlementCandidates(
  transactions: LunchMoneyTransaction[],
  account: LunchMoneyKiloAccount,
  ledger: KiloLedger,
  timeZone: string,
): LunchMoneyTransaction[] {
  const earliestSpendDate = earliestUnsettledSpendDate(ledger, timeZone);
  const pendingSettlementCents = getKiloPendingSettlementCents(ledger);
  return transactions
    .filter((transaction) => {
      const externalId = buildTransactionExternalId("settlement", transaction);
      return (
        isKiloAccountTransaction(transaction, account)
        && !transaction.isPending
        && transaction.amountCents > 0
        && transaction.amountCents <= pendingSettlementCents
        && (!earliestSpendDate || transaction.date >= earliestSpendDate)
        && !hasMovementExternalId(ledger, "settlement", externalId)
      );
    })
    .sort(compareTransactions);
}

function isKiloAccountTransaction(
  transaction: LunchMoneyTransaction,
  account: LunchMoneyKiloAccount,
): boolean {
  if (account.id && transaction.accountId === account.id) {
    return true;
  }
  if (account.mask && transaction.accountMask === account.mask) {
    return true;
  }
  const accountName = normalizeComparableText(transaction.accountName);
  return Boolean(accountName && [
    account.displayName,
    account.name,
  ].some((candidate) => accountName === normalizeComparableText(candidate)));
}

function hasMovementExternalId(
  ledger: KiloLedger,
  type: KiloMovement["type"],
  externalId: string,
): boolean {
  return ledger.movements.some((movement) => movement.type === type && movement.externalId === externalId);
}

function buildTransactionExternalId(
  kind: "monthly-funding" | "settlement",
  transaction: LunchMoneyTransaction,
  month?: string,
): string {
  const stableId = transaction.id
    ?? `${transaction.date}:${transaction.amountCents}:${slug(transaction.payee ?? "unknown")}`;
  return ["lunchmoney", "kilo", kind, month, "txn", stableId].filter(Boolean).join(":");
}

function formatFundingStatus(report: KiloLedgerMonitorReport): string {
  if (report.funding.appliedMonths.length > 0) {
    return `applied monthly funding for ${report.funding.appliedMonths.join(", ")}`;
  }
  if (report.funding.checkedMonths.length > 0) {
    return `checked monthly funding for ${report.funding.checkedMonths.join(", ")}`;
  }
  if (report.funding.dueMonths.length > 0) {
    return "monthly funding already ledgered";
  }
  return "monthly funding not due";
}

function formatReconciliationStatus(reconciliation: KiloReconciliationSnapshot): string {
  if (reconciliation.status === "match") {
    return `reconciled to ${formatCents(reconciliation.expectedExternalBalanceCents)}`;
  }
  if (reconciliation.status === "drift" && reconciliation.driftCents != null) {
    return `drift ${formatCents(reconciliation.driftCents)}`;
  }
  return "reconciliation unavailable";
}

function compareTransactions(left: LunchMoneyTransaction, right: LunchMoneyTransaction): number {
  return left.date.localeCompare(right.date) || (left.id ?? "").localeCompare(right.id ?? "");
}

function monthRange(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  let cursor = startMonth;
  while (cursor <= endMonth) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}

function addMonths(month: string, amount: number): string {
  const [yearRaw, monthRaw] = month.split("-");
  const year = Number.parseInt(yearRaw ?? "0", 10);
  const monthIndex = Number.parseInt(monthRaw ?? "1", 10) - 1 + amount;
  const date = new Date(Date.UTC(year, monthIndex, 1, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthEndDate(month: string): string {
  const [yearRaw, monthRaw] = month.split("-");
  const year = Number.parseInt(yearRaw ?? "0", 10);
  const monthNumber = Number.parseInt(monthRaw ?? "1", 10);
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

function addDays(dateString: string, days: number): string {
  const [yearRaw, monthRaw, dayRaw] = dateString.split("-");
  const date = new Date(Date.UTC(
    Number.parseInt(yearRaw ?? "0", 10),
    Number.parseInt(monthRaw ?? "1", 10) - 1,
    Number.parseInt(dayRaw ?? "1", 10) + days,
    12,
  ));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function uniqueLines(lines: string[]): string[] {
  return [...new Set(lines)];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeComparableText(value: string | undefined): string {
  return (value ?? "").trim().replace(/\s+/gu, " ").toLowerCase();
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
