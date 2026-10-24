import {
  applyFunding,
  applyMonthlyFunding,
  createDiscretionaryBucket,
  deleteDiscretionaryBucket,
  formatCents,
  KiloLedgerStore,
  parseDollarAmountToCents,
  reconcileKiloLedger,
  recordKiloHistoricalSpend,
  recordKiloSpend,
  settleKiloSpending,
  summarizeKiloLedger,
  transferBetweenBuckets,
  type KiloActor,
  type KiloLedgerAccount,
  type KiloLedgerMutationResult,
  type KiloMovement,
  type KiloMovementAllocation,
  type KiloReconciliationSnapshot,
  type AgentTool,
  resolveTangoProfileConfigDir,
} from "@tango/core";
import fs from "node:fs";
import path from "node:path";

export interface KiloLedgerToolOptions {
  filePath?: string;
  discordToken?: string;
  reportChannelId?: string;
  lunchMoneyAccessToken?: string;
  reportSender?: (content: string) => Promise<{ ok: boolean; detail?: string }>;
}

type KiloLedgerOperation =
  | "summary"
  | "initialize"
  | "create_bucket"
  | "delete_bucket"
  | "transfer"
  | "apply_monthly_funding"
  | "apply_weekly_funding"
  | "fund"
  | "record_historical_spend"
  | "record_spend"
  | "settle_spending"
  | "reconcile"
  | "fetch_and_reconcile";

interface LunchMoneyKiloAccount {
  id?: string;
  name?: string;
  displayName?: string;
  mask?: string;
  balanceCents: number;
  status?: string;
}

export function createKiloLedgerTools(options: KiloLedgerToolOptions = {}): AgentTool[] {
  const store = new KiloLedgerStore({ filePath: options.filePath });

  return [
    {
      name: "kilo_ledger",
      description: [
        "Kilo ledger operations for the configured child spending system.",
        "",
        "The ledger is the kid-facing source of truth for virtual buckets backed by one configured Lunch Money account.",
        "This tool is intentionally scoped: it cannot move real bank money and cannot access unrelated household accounts.",
        "",
        "Operations:",
        "  summary — Read balances, buckets, monthly split, pending settlement, recent movement history, and latest reconciliation.",
        "  initialize — Create the ledger file if missing; pass overwrite=true only for deliberate reset.",
        "  create_bucket — Create a discretionary bucket.",
        "  delete_bucket — Delete a discretionary bucket; provide transfer_to_bucket_id if it still has money.",
        "  transfer — Move money between buckets. Protected buckets cannot be transfer sources.",
        "  apply_monthly_funding — Owner/background only: apply the configured monthly split.",
        "  apply_weekly_funding — Legacy compatibility only; do not expose to the child.",
        "  fund — Apply custom funding allocations, for example setup funding to To Allocate.",
        "  record_spend — Record an approved internal ledger debit after Foxtrot review; bank transfer settlement happens later.",
        "  settle_spending — Mark already-recorded spends as covered by a later bank/Lunch Money transfer; balances unchanged.",
        "  record_historical_spend — Add old Kilo spending to history without changing current bucket balances.",
        "  reconcile — Record a provided external balance comparison.",
        "  fetch_and_reconcile — Fetch only the configured Kilo Lunch Money account and record drift status.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "summary",
              "initialize",
              "create_bucket",
              "delete_bucket",
              "transfer",
              "apply_monthly_funding",
              "apply_weekly_funding",
              "fund",
              "record_historical_spend",
              "record_spend",
              "settle_spending",
              "reconcile",
              "fetch_and_reconcile",
            ],
          },
          actor: {
            type: "string",
            enum: ["child", "owner", "foxtrot", "system"],
          },
          overwrite: { type: "boolean" },
          bucket_name: { type: "string" },
          bucket_id: { type: "string" },
          from_bucket_id: { type: "string" },
          to_bucket_id: { type: "string" },
          transfer_to_bucket_id: { type: "string" },
          amount: { type: "string", description: "Dollar amount such as 12.50 or $12.50" },
          amount_cents: { type: "number" },
          occurred_on: { type: "string", description: "Historical transaction date as YYYY-MM-DD" },
          payee: { type: "string" },
          allocations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                bucket_id: { type: "string" },
                amount: { type: "string" },
                amount_cents: { type: "number" },
              },
              required: ["bucket_id"],
            },
          },
          description: { type: "string" },
          source: { type: "string" },
          external_id: { type: "string" },
          spend_movement_ids: {
            type: "array",
            items: { type: "string" },
            description: "Optional exact Kilo spend movement ids covered by a settlement transfer.",
          },
          external_balance: { type: "string" },
          external_balance_cents: { type: "number" },
          note: { type: "string" },
        },
        required: ["operation"],
      },
      handler: async (input) => {
        const operation = normalizeOperation(input.operation);
        const actor = normalizeActor(input.actor);

        if (operation === "summary") {
          const ledger = store.read();
          return {
            ledgerPath: store.filePath,
            summary: summarizeKiloLedger(ledger),
          };
        }

        if (operation === "initialize") {
          const ledger = store.initialize({ overwrite: input.overwrite === true });
          return {
            ledgerPath: store.filePath,
            summary: summarizeKiloLedger(ledger),
          };
        }

        if (operation === "fetch_and_reconcile") {
          const current = store.read();
          const account = await fetchLunchMoneyKiloAccount(current.account, options);
          const result = store.mutate((ledger) => reconcileKiloLedger(ledger, {
            externalBalanceCents: account?.balanceCents ?? null,
            source: account
              ? `LunchMoney ${formatLunchMoneyAccount(account)}`
              : "LunchMoney unavailable",
            note: account
              ? `LunchMoney account id ${account.id ?? "unknown"} status ${account.status ?? "unknown"}`
              : "Could not fetch configured Kilo Lunch Money account.",
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "create_bucket") {
          const result = store.mutate((ledger) => createDiscretionaryBucket(ledger, {
            name: stringInput(input.bucket_name, "bucket_name"),
            actor,
            source: stringInput(input.source, "source", false),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "delete_bucket") {
          const result = store.mutate((ledger) => deleteDiscretionaryBucket(ledger, {
            bucketId: stringInput(input.bucket_id, "bucket_id"),
            actor,
            transferToBucketId: stringInput(input.transfer_to_bucket_id, "transfer_to_bucket_id", false),
            source: stringInput(input.source, "source", false),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "transfer") {
          const result = store.mutate((ledger) => transferBetweenBuckets(ledger, {
            fromBucketId: stringInput(input.from_bucket_id, "from_bucket_id"),
            toBucketId: stringInput(input.to_bucket_id, "to_bucket_id"),
            amountCents: centsInput(input),
            actor,
            description: stringInput(input.description, "description", false),
            source: stringInput(input.source, "source", false),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "apply_monthly_funding") {
          const result = store.mutate((ledger) => applyMonthlyFunding(ledger, {
            amountCents: centsInput(input, ledger.settings.monthlyContributionCents),
            actor,
            description: stringInput(input.description, "description", false) ?? "Applied Kilo monthly funding.",
            source: stringInput(input.source, "source", false) ?? "monthly-funding",
            externalId: stringInput(input.external_id, "external_id", false),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "apply_weekly_funding") {
          const result = store.mutate((ledger) => applyFunding(ledger, {
            amountCents: centsInput(input, ledger.settings.weeklyContributionCents),
            actor,
            description: stringInput(input.description, "description", false) ?? "Applied legacy Kilo weekly funding.",
            source: stringInput(input.source, "source", false) ?? "legacy-weekly-funding",
            externalId: stringInput(input.external_id, "external_id", false),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "fund") {
          const amountCents = centsInput(input);
          const result = store.mutate((ledger) => applyFunding(ledger, {
            amountCents,
            actor,
            allocations: allocationInput(input.allocations, amountCents),
            description: stringInput(input.description, "description", false),
            source: stringInput(input.source, "source", false),
            externalId: stringInput(input.external_id, "external_id", false),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "record_spend") {
          const result = store.mutate((ledger) => recordKiloSpend(ledger, {
            bucketId: stringInput(input.bucket_id, "bucket_id"),
            amountCents: centsInput(input),
            actor,
            description: stringInput(input.description, "description", false),
            source: stringInput(input.source, "source", false) ?? "foxtrot-review",
            externalId: stringInput(input.external_id, "external_id", false),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "settle_spending") {
          const result = store.mutate((ledger) => settleKiloSpending(ledger, {
            amountCents: centsInput(input),
            actor,
            description: stringInput(input.description, "description", false),
            source: stringInput(input.source, "source", false) ?? "bank-settlement",
            externalId: stringInput(input.external_id, "external_id", false),
            spendMovementIds: spendMovementIdsInput(input.spend_movement_ids),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "record_historical_spend") {
          const result = store.mutate((ledger) => recordKiloHistoricalSpend(ledger, {
            amountCents: centsInput(input),
            occurredOn: stringInput(input.occurred_on, "occurred_on"),
            payee: stringInput(input.payee, "payee"),
            bucketId: stringInput(input.bucket_id, "bucket_id", false),
            actor,
            description: stringInput(input.description, "description", false),
            source: stringInput(input.source, "source", false) ?? "historical-import",
            externalId: stringInput(input.external_id, "external_id", false),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        if (operation === "reconcile") {
          const current = store.read();
          const result = store.mutate((ledger) => reconcileKiloLedger(ledger, {
            externalBalanceCents: externalBalanceInput(input),
            source: stringInput(input.source, "source", false) ?? `Manual ${formatLedgerAccount(current.account)}`,
            note: stringInput(input.note, "note", false),
          }));
          return withReportResult(result, store.filePath, await reportIfNeeded(result, store.filePath, options));
        }

        throw new Error(`Unsupported Kilo ledger operation: ${operation}`);
      },
    },
  ];
}

export function kiloLedgerToolLooksReadOnly(operation: unknown): boolean {
  const normalized = typeof operation === "string" ? operation.trim() : "";
  return normalized === "summary";
}

async function fetchLunchMoneyKiloAccount(
  ledgerAccount: KiloLedgerAccount,
  options: KiloLedgerToolOptions,
): Promise<LunchMoneyKiloAccount | null> {
  const token = options.lunchMoneyAccessToken ?? process.env.LUNCH_MONEY_ACCESS_TOKEN;
  if (!token) {
    return null;
  }

  const response = await fetch("https://dev.lunchmoney.app/v1/plaid_accounts", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    return null;
  }
  const data = await response.json() as unknown;
  const accounts = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.plaid_accounts)
      ? data.plaid_accounts
      : isRecord(data) && Array.isArray(data.accounts)
        ? data.accounts
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

function withReportResult(
  result: KiloLedgerMutationResult,
  ledgerPath: string,
  report: { ok: boolean; detail?: string; skipped?: boolean },
): Record<string, unknown> {
  return {
    ledgerPath,
    summary: summarizeKiloLedger(result.ledger),
    movement: result.movement,
    movements: result.movements,
    reconciliation: result.reconciliation,
    idempotent: result.idempotent === true,
    report,
  };
}

async function reportIfNeeded(
  result: KiloLedgerMutationResult,
  ledgerPath: string,
  options: KiloLedgerToolOptions,
): Promise<{ ok: boolean; detail?: string; skipped?: boolean }> {
  if (result.idempotent) {
    return { ok: true, skipped: true, detail: "Idempotent duplicate; no report needed." };
  }
  const content = buildReportContent(result, ledgerPath);
  if (!content) {
    return { ok: true, skipped: true, detail: "No report needed." };
  }

  if (options.reportSender) {
    return options.reportSender(content);
  }

  const token = options.discordToken ?? process.env.DISCORD_TOKEN;
  const channelId =
    options.reportChannelId
    ?? process.env.KILO_REPORT_CHANNEL_ID
    ?? process.env.FOXTROT_CHANNEL_ID
    ?? process.env.TANGO_FOXTROT_CHANNEL_ID
    ?? resolveFoxtrotChannelIdFromProfile();
  if (!token || !channelId) {
    return { ok: false, skipped: true, detail: "Missing DISCORD_TOKEN or KILO_REPORT_CHANNEL_ID/FOXTROT_CHANNEL_ID." };
  }

  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, detail: `Discord HTTP ${response.status}: ${text}` };
  }
  return { ok: true, detail: `Reported to channel ${channelId}.` };
}

function buildReportContent(
  result: KiloLedgerMutationResult,
  ledgerPath: string,
): string | null {
  const movementLines = [...(result.movements ?? []), ...(result.movement ? [result.movement] : [])]
    .map((movement) => formatMovementLine(result, movement));
  const reconciliationLine = result.reconciliation ? formatReconciliationLine(result.reconciliation) : null;
  const lines = [...movementLines, reconciliationLine].filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return null;
  }

  return [
    "**Kilo ledger update**",
    ...lines.map((line) => `- ${line}`),
    `- Ledger total: ${formatCents(result.ledger.totalCents)}`,
    `- Ledger path: \`${ledgerPath}\``,
  ].join("\n");
}

function formatMovementLine(result: KiloLedgerMutationResult, movement: KiloMovement): string {
  const from = movement.fromBucketId ? bucketName(result, movement.fromBucketId) : null;
  const to = movement.toBucketId ? bucketName(result, movement.toBucketId) : null;
  const amount = formatCents(movement.amountCents);
  const actor = movement.actor[0]?.toUpperCase() + movement.actor.slice(1);

  if (movement.type === "transfer" && from && to) {
    return `${actor} moved ${amount} from ${from} to ${to}.`;
  }
  if (movement.type === "spend" && from) {
    return `${actor} recorded ${amount} spending from ${from}; pending bank settlement${movement.externalId ? ` (${movement.externalId})` : ""}.`;
  }
  if (movement.type === "settlement") {
    const count = movement.settledMovementIds?.length ?? 0;
    const suffix = count > 0 ? ` across ${count} spend${count === 1 ? "" : "s"}` : "";
    return `${actor} settled ${amount} of already-recorded Kilo spending${suffix}; balances unchanged.`;
  }
  if (movement.type === "historical_spend") {
    const payee = movement.payee ? ` at ${movement.payee}` : "";
    const bucket = from ? ` for ${from}` : "";
    const date = movement.occurredOn ? ` on ${movement.occurredOn}` : "";
    return `${actor} logged historical ${amount} spending${payee}${bucket}${date}; balances unchanged.`;
  }
  if (movement.type === "funding" && movement.allocations) {
    const allocations = movement.allocations
      .map((allocation) => `${bucketName(result, allocation.bucketId)} ${formatCents(allocation.amountCents)}`)
      .join(", ");
    return `${actor} funded ${amount}: ${allocations}.`;
  }
  if (movement.type === "bucket_create" && to) {
    return `${actor} created bucket ${to}.`;
  }
  if (movement.type === "bucket_delete" && from) {
    return `${actor} deleted bucket ${from}.`;
  }
  return `${actor} recorded ${movement.type} ${amount}.`;
}

function formatReconciliationLine(reconciliation: KiloReconciliationSnapshot): string | null {
  if (reconciliation.status === "match") {
    return `Reconciliation matched expected account balance ${formatCents(reconciliation.expectedExternalBalanceCents)} against ${reconciliation.source}.`;
  }
  if (reconciliation.status === "drift" && reconciliation.driftCents != null && reconciliation.externalBalanceCents != null) {
    return `Drift warning: ledger is ${formatCents(reconciliation.ledgerTotalCents)}, pending settlement is ${formatCents(reconciliation.pendingSettlementCents)}, expected account balance is ${formatCents(reconciliation.expectedExternalBalanceCents)}, ${reconciliation.source} is ${formatCents(reconciliation.externalBalanceCents)}, drift ${formatCents(reconciliation.driftCents)}. Writes remain allowed.`;
  }
  if (reconciliation.status === "unavailable") {
    return `Reconciliation unavailable from ${reconciliation.source}. Writes remain allowed.`;
  }
  return null;
}

function bucketName(result: KiloLedgerMutationResult, bucketId: string): string {
  return result.ledger.buckets.find((bucket) => bucket.id === bucketId)?.name ?? bucketId;
}

function resolveFoxtrotChannelIdFromProfile(): string | undefined {
  const channelsPath = path.join(resolveTangoProfileConfigDir(), "channels.yaml");
  if (!fs.existsSync(channelsPath)) {
    return undefined;
  }
  const lines = fs.readFileSync(channelsPath, "utf8").split(/\r?\n/u);
  const sections = ["agents", "topics"];
  let currentSection = "";
  const values = new Map<string, string>();
  for (const line of lines) {
    const sectionMatch = /^([a-zA-Z0-9_-]+):\s*$/u.exec(line);
    if (sectionMatch?.[1]) {
      currentSection = sectionMatch[1];
      continue;
    }
    if (!sections.includes(currentSection)) {
      continue;
    }
    const valueMatch = /^\s+([a-zA-Z0-9_-]+):\s*["']?([0-9]+)["']?\s*$/u.exec(line);
    if (valueMatch?.[1] && valueMatch[2]) {
      values.set(`${currentSection}.${valueMatch[1]}`, valueMatch[2]);
    }
  }
  return values.get("agents.foxtrot") ?? values.get("topics.finance");
}

function normalizeOperation(value: unknown): KiloLedgerOperation {
  const operation = typeof value === "string" ? value.trim() : "";
  const allowed = new Set<KiloLedgerOperation>([
    "summary",
    "initialize",
    "create_bucket",
    "delete_bucket",
    "transfer",
    "apply_monthly_funding",
    "apply_weekly_funding",
    "fund",
    "record_historical_spend",
    "record_spend",
    "settle_spending",
    "reconcile",
    "fetch_and_reconcile",
  ]);
  if (!allowed.has(operation as KiloLedgerOperation)) {
    throw new Error(`Invalid Kilo ledger operation: ${operation}`);
  }
  return operation as KiloLedgerOperation;
}

function normalizeActor(value: unknown): KiloActor {
  const actor = typeof value === "string" ? value.trim().toLowerCase() : "child";
  if (actor === "child" || actor === "owner" || actor === "foxtrot" || actor === "system") {
    return actor;
  }
  throw new Error(`Invalid Kilo actor: ${actor}`);
}

function stringInput(value: unknown, field: string): string;
function stringInput(value: unknown, field: string, required: false): string | undefined;
function stringInput(value: unknown, field: string, required = true): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (required) {
    throw new Error(`${field} is required.`);
  }
  return undefined;
}

function centsInput(input: Record<string, unknown>, fallback?: number): number {
  if (typeof input.amount_cents === "number") {
    return input.amount_cents;
  }
  if (typeof input.amount === "string" || typeof input.amount === "number") {
    return parseDollarAmountToCents(input.amount);
  }
  if (fallback != null) {
    return fallback;
  }
  throw new Error("amount or amount_cents is required.");
}

function externalBalanceInput(input: Record<string, unknown>): number | null {
  if (input.external_balance == null && input.external_balance_cents == null) {
    return null;
  }
  if (typeof input.external_balance_cents === "number") {
    return input.external_balance_cents;
  }
  if (typeof input.external_balance === "string" || typeof input.external_balance === "number") {
    return parseDollarAmountToCents(input.external_balance);
  }
  throw new Error("external_balance must be a dollar amount.");
}

function allocationInput(value: unknown, expectedTotalCents: number): KiloMovementAllocation[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("allocations must be an array.");
  }
  const allocations = value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error("Each allocation must be an object.");
    }
    return {
      bucketId: stringInput(entry.bucket_id, "allocation.bucket_id"),
      amountCents: typeof entry.amount_cents === "number"
        ? entry.amount_cents
        : parseDollarAmountToCents(stringInput(entry.amount, "allocation.amount")),
    };
  });
  const total = allocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
  if (total !== expectedTotalCents) {
    throw new Error(`Allocations total ${formatCents(total)} but expected ${formatCents(expectedTotalCents)}.`);
  }
  return allocations;
}

function spendMovementIdsInput(value: unknown): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("spend_movement_ids must be an array.");
  }
  return value.map((entry) => stringInput(entry, "spend_movement_ids[]"));
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
