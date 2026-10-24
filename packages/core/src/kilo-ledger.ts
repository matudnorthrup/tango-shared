import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveTangoProfileDataDir } from "./runtime-paths.js";

export const KILO_LEDGER_SCHEMA_VERSION = 1;
export const KILO_LEDGER_DEFAULT_ACCOUNT_MASK = "0000";
export const KILO_LEDGER_DEFAULT_ACCOUNT_NAME = "Kilo Ledger Account";
export const KILO_LEDGER_DEFAULT_ACCOUNT_INSTITUTION = "Profile-configured bank";
export const KILO_LEDGER_MONTHLY_CONTRIBUTION_CENTS = 8_000;
export const KILO_LEDGER_MONTHLY_FUNDING_START_ON = "2026-07-01";

export type KiloActor = "child" | "owner" | "foxtrot" | "system";
export type KiloBucketRole = "protected" | "discretionary" | "holding";
export type KiloMovementType =
  | "bucket_create"
  | "bucket_delete"
  | "funding"
  | "historical_spend"
  | "settlement"
  | "spend"
  | "transfer";

export interface KiloBucket {
  id: string;
  name: string;
  role: KiloBucketRole;
  balanceCents: number;
  canDelete: boolean;
  canTransferOut: boolean;
  createdAt: string;
  updatedAt: string;
  sortOrder: number;
}

export interface KiloMovementAllocation {
  bucketId: string;
  amountCents: number;
}

export interface KiloMovement {
  id: string;
  type: KiloMovementType;
  actor: KiloActor;
  amountCents: number;
  createdAt: string;
  description?: string;
  fromBucketId?: string;
  toBucketId?: string;
  allocations?: KiloMovementAllocation[];
  occurredOn?: string;
  payee?: string;
  source?: string;
  externalId?: string;
  settledAt?: string;
  settledMovementIds?: string[];
  settlementExternalId?: string;
  settlementMovementId?: string;
}

export interface KiloSetupTarget {
  bucketId: string;
  amountCents: number;
  status: "funded" | "pending";
  note?: string;
}

export interface KiloWeeklyAllocationRule {
  bucketId: string;
  shareBps?: number;
  remainder?: boolean;
}

export type KiloFundingAllocationRule = KiloWeeklyAllocationRule;

export interface KiloReconciliationSnapshot {
  id: string;
  createdAt: string;
  source: string;
  externalBalanceCents: number | null;
  ledgerTotalCents: number;
  pendingSettlementCents: number;
  expectedExternalBalanceCents: number;
  driftCents: number | null;
  status: "match" | "drift" | "unavailable";
  note?: string;
}

export interface KiloLedgerAccount {
  institution: string;
  lunchMoneyName: string;
  mask: string;
  lunchMoneyPlaidAccountId?: string;
}

export interface KiloLedger {
  schemaVersion: typeof KILO_LEDGER_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  account: KiloLedgerAccount;
  totalCents: number;
  buckets: KiloBucket[];
  movements: KiloMovement[];
  reconciliations: KiloReconciliationSnapshot[];
  settings: {
    fundingCadence: "monthly";
    fundingStartOn: string;
    monthlyContributionCents: number;
    monthlyAllocation: KiloFundingAllocationRule[];
    weeklyContributionCents: number;
    weeklyAllocation: KiloWeeklyAllocationRule[];
    protectedBucketIds: string[];
    defaultRemainderBucketId: string;
    setupTargets: KiloSetupTarget[];
    driftPolicy: {
      warnOwner: true;
      blockWrites: false;
    };
  };
}

export interface KiloLedgerSummary {
  account: KiloLedger["account"];
  totalCents: number;
  total: string;
  buckets: Array<KiloBucket & { balance: string }>;
  fundingCadence: "monthly";
  fundingStartOn: string;
  monthlyContributionCents: number;
  monthlyContribution: string;
  monthlyAllocation: Array<KiloFundingAllocationRule & { amountCents?: number; amount?: string }>;
  weeklyContributionCents: number;
  weeklyContribution: string;
  weeklyAllocation: Array<KiloWeeklyAllocationRule & { amountCents?: number; amount?: string }>;
  pendingSettlementCents: number;
  pendingSettlement: string;
  expectedExternalBalanceCents: number;
  expectedExternalBalance: string;
  latestReconciliation?: KiloReconciliationSnapshot & {
    externalBalance?: string | null;
    ledgerTotal: string;
    pendingSettlement: string;
    expectedExternalBalance: string;
    drift?: string | null;
  };
  movements: KiloMovement[];
}

export interface KiloLedgerMutationResult {
  ledger: KiloLedger;
  movement?: KiloMovement;
  movements?: KiloMovement[];
  reconciliation?: KiloReconciliationSnapshot;
  idempotent?: boolean;
}

export function resolveKiloLedgerPath(input: { filePath?: string } = {}): string {
  const configured = input.filePath ?? process.env.KILO_LEDGER_PATH;
  if (configured?.trim()) {
    return path.resolve(configured.startsWith("~/")
      ? path.join(process.env.HOME ?? "", configured.slice(2))
      : configured);
  }
  return path.join(resolveTangoProfileDataDir(), "kilo", "ledger.json");
}

export function resolveKiloLedgerAccountConfig(
  input: Partial<KiloLedgerAccount> = {},
): KiloLedgerAccount {
  return {
    institution: optionalText(input.institution)
      ?? optionalText(process.env.KILO_LEDGER_ACCOUNT_INSTITUTION)
      ?? KILO_LEDGER_DEFAULT_ACCOUNT_INSTITUTION,
    lunchMoneyName: optionalText(input.lunchMoneyName)
      ?? optionalText(process.env.KILO_LEDGER_ACCOUNT_NAME)
      ?? KILO_LEDGER_DEFAULT_ACCOUNT_NAME,
    mask: optionalText(input.mask)
      ?? optionalText(process.env.KILO_LEDGER_ACCOUNT_MASK)
      ?? KILO_LEDGER_DEFAULT_ACCOUNT_MASK,
    lunchMoneyPlaidAccountId: optionalText(input.lunchMoneyPlaidAccountId)
      ?? optionalText(process.env.KILO_LEDGER_LUNCH_MONEY_PLAID_ACCOUNT_ID),
  };
}

export function parseDollarAmountToCents(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Amount must be finite.");
    }
    return Math.round(value * 100);
  }

  const normalized = value.trim().replace(/^\$/u, "");
  if (!/^-?\d+(?:\.\d{1,2})?$/u.test(normalized)) {
    throw new Error(`Invalid dollar amount: ${value}`);
  }

  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [dollars = "0", cents = ""] = unsigned.split(".");
  const parsed = Number.parseInt(dollars, 10) * 100 + Number.parseInt(cents.padEnd(2, "0") || "0", 10);
  return negative ? -parsed : parsed;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${remainder}`;
}

export function createDefaultKiloLedger(
  now = new Date().toISOString(),
  input: { account?: Partial<KiloLedgerAccount> } = {},
): KiloLedger {
  const buckets: KiloBucket[] = [
    createBucketRecord("giving", "Giving", "protected", 0, false, false, now, 10),
    createBucketRecord("clothing", "Clothing", "discretionary", 0, true, true, now, 20),
    createBucketRecord("entertainment", "Entertainment", "discretionary", 0, true, true, now, 30),
    createBucketRecord("food", "Food", "discretionary", 0, true, true, now, 40),
    createBucketRecord("recreation", "Recreation", "discretionary", 0, true, true, now, 50),
    createBucketRecord("gifts", "Gifts", "discretionary", 0, true, true, now, 60),
    createBucketRecord("savings", "Savings", "protected", 0, false, false, now, 70),
    createBucketRecord("to-allocate", "Unallocated", "holding", 0, false, true, now, 80),
  ];

  return normalizeLedger({
    schemaVersion: KILO_LEDGER_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    account: resolveKiloLedgerAccountConfig(input.account),
    totalCents: 0,
    buckets,
    movements: [],
    reconciliations: [],
    settings: {
      fundingCadence: "monthly",
      fundingStartOn: KILO_LEDGER_MONTHLY_FUNDING_START_ON,
      monthlyContributionCents: KILO_LEDGER_MONTHLY_CONTRIBUTION_CENTS,
      monthlyAllocation: defaultFundingAllocation(),
      weeklyContributionCents: 2_000,
      weeklyAllocation: defaultFundingAllocation(),
      protectedBucketIds: ["giving", "savings"],
      defaultRemainderBucketId: "to-allocate",
      setupTargets: [],
      driftPolicy: {
        warnOwner: true,
        blockWrites: false,
      },
    },
  });
}

export function summarizeKiloLedger(ledger: KiloLedger, movementLimit = 25): KiloLedgerSummary {
  const latestReconciliation = ledger.reconciliations.at(-1);
  const pendingSettlementCents = getKiloPendingSettlementCents(ledger);
  const expectedExternalBalanceCents = getKiloExpectedExternalBalanceCents(ledger);
  return {
    account: ledger.account,
    totalCents: ledger.totalCents,
    total: formatCents(ledger.totalCents),
    buckets: ledger.buckets
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
      .map((bucket) => ({
        ...bucket,
        balance: formatCents(bucket.balanceCents),
      })),
    fundingCadence: ledger.settings.fundingCadence,
    fundingStartOn: ledger.settings.fundingStartOn,
    monthlyContributionCents: ledger.settings.monthlyContributionCents,
    monthlyContribution: formatCents(ledger.settings.monthlyContributionCents),
    monthlyAllocation: previewFundingAllocation(ledger).map((allocation) => ({
      ...allocation.rule,
      amountCents: allocation.amountCents,
      amount: formatCents(allocation.amountCents),
    })),
    weeklyContributionCents: ledger.settings.weeklyContributionCents,
    weeklyContribution: formatCents(ledger.settings.weeklyContributionCents),
    weeklyAllocation: previewWeeklyAllocation(ledger).map((allocation) => ({
      ...allocation.rule,
      amountCents: allocation.amountCents,
      amount: formatCents(allocation.amountCents),
    })),
    pendingSettlementCents,
    pendingSettlement: formatCents(pendingSettlementCents),
    expectedExternalBalanceCents,
    expectedExternalBalance: formatCents(expectedExternalBalanceCents),
    latestReconciliation: latestReconciliation
      ? {
          ...latestReconciliation,
          externalBalance: latestReconciliation.externalBalanceCents == null
            ? null
            : formatCents(latestReconciliation.externalBalanceCents),
          ledgerTotal: formatCents(latestReconciliation.ledgerTotalCents),
          pendingSettlement: formatCents(latestReconciliation.pendingSettlementCents ?? 0),
          expectedExternalBalance: formatCents(
            latestReconciliation.expectedExternalBalanceCents ?? latestReconciliation.ledgerTotalCents,
          ),
          drift: latestReconciliation.driftCents == null ? null : formatCents(latestReconciliation.driftCents),
        }
      : undefined,
    movements: ledger.movements
      .map((movement, index) => ({ movement, index }))
      .sort((left, right) => {
        const dateDelta = Date.parse(right.movement.createdAt) - Date.parse(left.movement.createdAt);
        return dateDelta || right.index - left.index;
      })
      .slice(0, movementLimit)
      .map(({ movement }) => movement),
  };
}

export function getKiloPendingSettlementCents(ledger: KiloLedger): number {
  return ledger.movements
    .filter((movement) => movement.type === "spend" && !movement.settlementMovementId)
    .reduce((sum, movement) => sum + movement.amountCents, 0);
}

export function getKiloExpectedExternalBalanceCents(ledger: KiloLedger): number {
  return ledger.totalCents + getKiloPendingSettlementCents(ledger);
}

export class KiloLedgerStore {
  readonly filePath: string;

  constructor(input: { filePath?: string } = {}) {
    this.filePath = resolveKiloLedgerPath(input);
  }

  read(): KiloLedger {
    if (!fs.existsSync(this.filePath)) {
      return createDefaultKiloLedger();
    }
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as KiloLedger;
    return normalizeLedger(raw);
  }

  initialize(input: { overwrite?: boolean; now?: string } = {}): KiloLedger {
    if (fs.existsSync(this.filePath) && !input.overwrite) {
      return this.read();
    }
    const ledger = createDefaultKiloLedger(input.now ?? new Date().toISOString());
    this.write(ledger);
    return ledger;
  }

  write(ledger: KiloLedger): KiloLedger {
    const normalized = normalizeLedger(ledger);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.filePath);
    return normalized;
  }

  mutate(mutator: (ledger: KiloLedger) => KiloLedgerMutationResult): KiloLedgerMutationResult {
    const result = mutator(this.read());
    const ledger = this.write(result.ledger);
    return { ...result, ledger };
  }
}

export function createDiscretionaryBucket(
  ledger: KiloLedger,
  input: { name: string; actor?: KiloActor; now?: string; source?: string },
): KiloLedgerMutationResult {
  const now = input.now ?? new Date().toISOString();
  const name = normalizeBucketName(input.name);
  const id = uniqueBucketId(ledger, slugifyBucketName(name));
  const sortOrder = Math.max(0, ...ledger.buckets.map((bucket) => bucket.sortOrder)) + 10;
  const bucket = createBucketRecord(id, name, "discretionary", 0, true, true, now, sortOrder);
  const movement = createMovement({
    type: "bucket_create",
    actor: input.actor ?? "child",
    amountCents: 0,
    createdAt: now,
    toBucketId: id,
    description: `Created ${name} bucket.`,
    source: input.source,
  });
  return {
    ledger: normalizeLedger({
      ...ledger,
      updatedAt: now,
      buckets: [...ledger.buckets, bucket],
      movements: [...ledger.movements, movement],
    }),
    movement,
  };
}

export function deleteDiscretionaryBucket(
  ledger: KiloLedger,
  input: {
    bucketId: string;
    actor?: KiloActor;
    now?: string;
    transferToBucketId?: string;
    source?: string;
  },
): KiloLedgerMutationResult {
  const now = input.now ?? new Date().toISOString();
  const bucket = requireBucket(ledger, input.bucketId);
  if (!bucket.canDelete || bucket.role === "protected") {
    throw new Error(`${bucket.name} is protected and cannot be deleted.`);
  }

  let nextLedger = ledger;
  const movements: KiloMovement[] = [];
  if (bucket.balanceCents > 0) {
    if (!input.transferToBucketId) {
      throw new Error(`${bucket.name} has a balance. Transfer it before deleting, or provide transferToBucketId.`);
    }
    const transfer = transferBetweenBuckets(nextLedger, {
      fromBucketId: bucket.id,
      toBucketId: input.transferToBucketId,
      amountCents: bucket.balanceCents,
      actor: input.actor ?? "child",
      now,
      description: `Move remaining ${bucket.name} balance before deleting bucket.`,
      source: input.source,
    });
    nextLedger = transfer.ledger;
    if (transfer.movement) movements.push(transfer.movement);
  }

  const deleteMovement = createMovement({
    type: "bucket_delete",
    actor: input.actor ?? "child",
    amountCents: 0,
    createdAt: now,
    fromBucketId: bucket.id,
    description: `Deleted ${bucket.name} bucket.`,
    source: input.source,
  });
  movements.push(deleteMovement);

  return {
    ledger: normalizeLedger({
      ...nextLedger,
      updatedAt: now,
      buckets: nextLedger.buckets.filter((candidate) => candidate.id !== bucket.id),
      movements: [...nextLedger.movements, deleteMovement],
    }),
    movements,
  };
}

export function transferBetweenBuckets(
  ledger: KiloLedger,
  input: {
    fromBucketId: string;
    toBucketId: string;
    amountCents: number;
    actor?: KiloActor;
    now?: string;
    description?: string;
    source?: string;
  },
): KiloLedgerMutationResult {
  const now = input.now ?? new Date().toISOString();
  const amountCents = normalizePositiveCents(input.amountCents);
  const from = requireBucket(ledger, input.fromBucketId);
  const to = requireBucket(ledger, input.toBucketId);
  if (from.id === to.id) {
    throw new Error("Choose two different buckets.");
  }
  if (!from.canTransferOut) {
    throw new Error(`${from.name} is protected; money cannot move out of it.`);
  }
  if (from.balanceCents < amountCents) {
    throw new Error(`${from.name} only has ${formatCents(from.balanceCents)} available.`);
  }

  const movement = createMovement({
    type: "transfer",
    actor: input.actor ?? "child",
    amountCents,
    createdAt: now,
    fromBucketId: from.id,
    toBucketId: to.id,
    description: input.description ?? `Moved ${formatCents(amountCents)} from ${from.name} to ${to.name}.`,
    source: input.source,
  });

  return {
    ledger: applyBucketBalanceChanges(ledger, now, movement, [
      { bucketId: from.id, deltaCents: -amountCents },
      { bucketId: to.id, deltaCents: amountCents },
    ]),
    movement,
  };
}

export function applyFunding(
  ledger: KiloLedger,
  input: {
    amountCents: number;
    actor?: KiloActor;
    now?: string;
    allocations?: KiloMovementAllocation[];
    description?: string;
    source?: string;
    externalId?: string;
  },
): KiloLedgerMutationResult {
  const now = input.now ?? new Date().toISOString();
  const amountCents = normalizePositiveCents(input.amountCents);
  const allocations = input.allocations?.length
    ? normalizeAllocations(input.allocations, amountCents)
    : previewFundingAllocation(ledger, amountCents).map((entry) => ({
        bucketId: entry.rule.bucketId,
        amountCents: entry.amountCents,
      }));

  for (const allocation of allocations) {
    requireBucket(ledger, allocation.bucketId);
  }

  const existing = findExternalMovement(ledger, "funding", input.externalId);
  if (existing) {
    assertDuplicateFundingMatches(existing, amountCents, allocations);
    return { ledger, movement: existing, idempotent: true };
  }

  const movement = createMovement({
    type: "funding",
    actor: input.actor ?? "owner",
    amountCents,
    createdAt: now,
    allocations,
    description: input.description ?? `Funded Kilo ledger with ${formatCents(amountCents)}.`,
    source: input.source,
    externalId: input.externalId,
  });

  return {
    ledger: applyBucketBalanceChanges(
      ledger,
      now,
      movement,
      allocations.map((allocation) => ({
        bucketId: allocation.bucketId,
        deltaCents: allocation.amountCents,
      })),
    ),
    movement,
  };
}

export function applyMonthlyFunding(
  ledger: KiloLedger,
  input: {
    amountCents?: number;
    actor?: KiloActor;
    now?: string;
    allocations?: KiloMovementAllocation[];
    description?: string;
    source?: string;
    externalId?: string;
  } = {},
): KiloLedgerMutationResult {
  return applyFunding(ledger, {
    amountCents: input.amountCents ?? ledger.settings.monthlyContributionCents,
    actor: input.actor ?? "owner",
    now: input.now,
    allocations: input.allocations,
    description: input.description ?? "Applied Kilo monthly funding.",
    source: input.source ?? "monthly-funding",
    externalId: input.externalId,
  });
}

export function recordKiloSpend(
  ledger: KiloLedger,
  input: {
    bucketId: string;
    amountCents: number;
    actor?: KiloActor;
    now?: string;
    description?: string;
    source?: string;
    externalId?: string;
  },
): KiloLedgerMutationResult {
  const now = input.now ?? new Date().toISOString();
  const amountCents = normalizePositiveCents(input.amountCents);
  const bucket = requireBucket(ledger, input.bucketId);
  if (!bucket.canTransferOut) {
    throw new Error(`${bucket.name} is protected and cannot be debited for spending.`);
  }

  const existing = findExternalMovement(ledger, "spend", input.externalId);
  if (existing) {
    assertDuplicateSpendMatches(existing, amountCents, bucket.id);
    return { ledger, movement: existing, idempotent: true };
  }

  if (bucket.balanceCents < amountCents) {
    throw new Error(`${bucket.name} only has ${formatCents(bucket.balanceCents)} available.`);
  }

  const movement = createMovement({
    type: "spend",
    actor: input.actor ?? "foxtrot",
    amountCents,
    createdAt: now,
    fromBucketId: bucket.id,
    description: input.description ?? `Recorded ${formatCents(amountCents)} of Kilo spending from ${bucket.name}.`,
    source: input.source,
    externalId: input.externalId,
  });

  return {
    ledger: applyBucketBalanceChanges(ledger, now, movement, [
      { bucketId: bucket.id, deltaCents: -amountCents },
    ]),
    movement,
  };
}

export function settleKiloSpending(
  ledger: KiloLedger,
  input: {
    amountCents: number;
    actor?: KiloActor;
    now?: string;
    description?: string;
    source?: string;
    externalId?: string;
    spendMovementIds?: string[];
  },
): KiloLedgerMutationResult {
  const now = input.now ?? new Date().toISOString();
  const amountCents = normalizePositiveCents(input.amountCents);

  const existing = findExternalMovement(ledger, "settlement", input.externalId);
  if (existing) {
    if (existing.amountCents !== amountCents) {
      throw new Error(
        `External id ${input.externalId} already settled ${formatCents(existing.amountCents)}, not ${formatCents(amountCents)}.`,
      );
    }
    return { ledger, movement: existing, idempotent: true };
  }

  const selected = selectSpendMovementsForSettlement(ledger, amountCents, input.spendMovementIds);
  const selectedTotalCents = selected.reduce((sum, movement) => sum + movement.amountCents, 0);
  if (selectedTotalCents !== amountCents) {
    throw new Error(`Settlement selected ${formatCents(selectedTotalCents)} but expected ${formatCents(amountCents)}.`);
  }

  const movement = createMovement({
    type: "settlement",
    actor: input.actor ?? "owner",
    amountCents,
    createdAt: now,
    description: input.description ?? `Settled ${formatCents(amountCents)} of already-recorded Kilo spending.`,
    source: input.source,
    externalId: input.externalId,
    settledMovementIds: selected.map((spend) => spend.id),
  });
  const selectedIds = new Set(movement.settledMovementIds ?? []);
  const movements = ledger.movements.map((candidate) => {
    if (candidate.type !== "spend" || !selectedIds.has(candidate.id)) {
      return candidate;
    }
    return {
      ...candidate,
      settledAt: now,
      settlementExternalId: input.externalId,
      settlementMovementId: movement.id,
    };
  });

  return {
    ledger: normalizeLedger({
      ...ledger,
      updatedAt: now,
      movements: [...movements, movement],
    }),
    movement,
  };
}

export function recordKiloHistoricalSpend(
  ledger: KiloLedger,
  input: {
    amountCents: number;
    occurredOn: string;
    payee: string;
    actor?: KiloActor;
    bucketId?: string;
    description?: string;
    externalId?: string;
    now?: string;
    source?: string;
  },
): KiloLedgerMutationResult {
  const now = input.now ?? new Date().toISOString();
  const amountCents = normalizePositiveCents(input.amountCents);
  const occurredOn = normalizeIsoDate(input.occurredOn);
  const payee = normalizePayee(input.payee);
  const bucket = input.bucketId ? requireBucket(ledger, input.bucketId) : undefined;
  const movement = createMovement({
    type: "historical_spend",
    actor: input.actor ?? "owner",
    amountCents,
    createdAt: `${occurredOn}T12:00:00.000Z`,
    fromBucketId: bucket?.id,
    occurredOn,
    payee,
    description: input.description ?? `Historical Kilo spending at ${payee}.`,
    source: input.source,
    externalId: input.externalId,
  });

  return {
    ledger: normalizeLedger({
      ...ledger,
      updatedAt: now,
      movements: [...ledger.movements, movement],
    }),
    movement,
  };
}

export function reconcileKiloLedger(
  ledger: KiloLedger,
  input: {
    externalBalanceCents: number | null;
    source: string;
    now?: string;
    note?: string;
  },
): KiloLedgerMutationResult {
  const now = input.now ?? new Date().toISOString();
  const externalBalanceCents = input.externalBalanceCents == null
    ? null
    : normalizeIntegerCents(input.externalBalanceCents);
  const pendingSettlementCents = getKiloPendingSettlementCents(ledger);
  const expectedExternalBalanceCents = getKiloExpectedExternalBalanceCents(ledger);
  const driftCents = externalBalanceCents == null ? null : expectedExternalBalanceCents - externalBalanceCents;
  const reconciliation: KiloReconciliationSnapshot = {
    id: randomUUID(),
    createdAt: now,
    source: input.source,
    externalBalanceCents,
    ledgerTotalCents: ledger.totalCents,
    pendingSettlementCents,
    expectedExternalBalanceCents,
    driftCents,
    status: externalBalanceCents == null ? "unavailable" : driftCents === 0 ? "match" : "drift",
    note: input.note,
  };
  return {
    ledger: normalizeLedger({
      ...ledger,
      updatedAt: now,
      reconciliations: [...ledger.reconciliations, reconciliation],
    }),
    reconciliation,
  };
}

function createBucketRecord(
  id: string,
  name: string,
  role: KiloBucketRole,
  balanceCents: number,
  canDelete: boolean,
  canTransferOut: boolean,
  now: string,
  sortOrder: number,
): KiloBucket {
  return {
    id,
    name,
    role,
    balanceCents,
    canDelete,
    canTransferOut,
    createdAt: now,
    updatedAt: now,
    sortOrder,
  };
}

function createMovement(input: Omit<KiloMovement, "id">): KiloMovement {
  return {
    id: randomUUID(),
    ...input,
  };
}

function normalizeLedger(ledger: KiloLedger): KiloLedger {
  if (ledger.schemaVersion !== KILO_LEDGER_SCHEMA_VERSION) {
    throw new Error(`Unsupported Kilo ledger schema version: ${String(ledger.schemaVersion)}`);
  }
  const bucketIds = new Set<string>();
  const buckets = ledger.buckets.map((bucket) => {
    const id = normalizeBucketId(bucket.id);
    if (bucketIds.has(id)) {
      throw new Error(`Duplicate bucket id: ${id}`);
    }
    bucketIds.add(id);
    return {
      ...bucket,
      id,
      name: normalizeBucketName(bucket.name),
      balanceCents: normalizeNonNegativeCents(bucket.balanceCents),
      sortOrder: normalizeIntegerCents(bucket.sortOrder),
    };
  });

  const totalCents = buckets.reduce((sum, bucket) => sum + bucket.balanceCents, 0);
  const settings = normalizeLedgerSettings(ledger.settings);
  const reconciliations = ledger.reconciliations.map((reconciliation) => ({
    ...reconciliation,
    pendingSettlementCents: normalizeNonNegativeCents(reconciliation.pendingSettlementCents ?? 0),
    expectedExternalBalanceCents: normalizeNonNegativeCents(
      reconciliation.expectedExternalBalanceCents ?? reconciliation.ledgerTotalCents,
    ),
  }));
  return {
    ...ledger,
    account: normalizeLedgerAccount(ledger.account),
    buckets,
    totalCents,
    reconciliations,
    settings,
  };
}

function normalizeLedgerAccount(account: Partial<KiloLedgerAccount> | undefined): KiloLedgerAccount {
  const fallback = resolveKiloLedgerAccountConfig();
  return {
    institution: optionalText(account?.institution) ?? fallback.institution,
    lunchMoneyName: optionalText(account?.lunchMoneyName) ?? fallback.lunchMoneyName,
    mask: optionalText(account?.mask) ?? fallback.mask,
    lunchMoneyPlaidAccountId: optionalText(account?.lunchMoneyPlaidAccountId) ?? fallback.lunchMoneyPlaidAccountId,
  };
}

function findExternalMovement(
  ledger: KiloLedger,
  type: KiloMovementType,
  externalId: string | undefined,
): KiloMovement | undefined {
  if (!externalId?.trim()) {
    return undefined;
  }
  const normalizedExternalId = externalId.trim();
  return ledger.movements.find((movement) => (
    movement.type === type && movement.externalId === normalizedExternalId
  ));
}

function assertDuplicateFundingMatches(
  movement: KiloMovement,
  amountCents: number,
  allocations: KiloMovementAllocation[],
): void {
  if (movement.amountCents !== amountCents || !allocationsEqual(movement.allocations ?? [], allocations)) {
    throw new Error(
      `External id ${movement.externalId} already records funding with different details.`,
    );
  }
}

function assertDuplicateSpendMatches(
  movement: KiloMovement,
  amountCents: number,
  bucketId: string,
): void {
  if (movement.amountCents !== amountCents || movement.fromBucketId !== bucketId) {
    throw new Error(
      `External id ${movement.externalId} already records spending with different details.`,
    );
  }
}

function allocationsEqual(left: KiloMovementAllocation[], right: KiloMovementAllocation[]): boolean {
  const serialize = (allocations: KiloMovementAllocation[]) => allocations
    .map((allocation) => `${allocation.bucketId}:${allocation.amountCents}`)
    .sort()
    .join("|");
  return serialize(left) === serialize(right);
}

function selectSpendMovementsForSettlement(
  ledger: KiloLedger,
  amountCents: number,
  spendMovementIds: string[] | undefined,
): KiloMovement[] {
  const unsettled = ledger.movements
    .filter((movement) => movement.type === "spend" && !movement.settlementMovementId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  if (unsettled.length === 0) {
    throw new Error("No unsettled Kilo spending is available to settle.");
  }

  if (spendMovementIds?.length) {
    const requestedIds = new Set(spendMovementIds.map(normalizeMovementId));
    const selected = unsettled.filter((movement) => requestedIds.has(movement.id));
    if (selected.length !== requestedIds.size) {
      throw new Error("One or more requested spend movements are unknown or already settled.");
    }
    return selected;
  }

  const pendingTotalCents = unsettled.reduce((sum, movement) => sum + movement.amountCents, 0);
  if (pendingTotalCents === amountCents) {
    return unsettled;
  }

  let selectedTotalCents = 0;
  const selected: KiloMovement[] = [];
  for (const movement of unsettled) {
    if (selectedTotalCents + movement.amountCents > amountCents) {
      continue;
    }
    selected.push(movement);
    selectedTotalCents += movement.amountCents;
    if (selectedTotalCents === amountCents) {
      return selected;
    }
  }

  throw new Error(
    `Could not match ${formatCents(amountCents)} to unsettled Kilo spending. Pending settlement total is ${formatCents(pendingTotalCents)}.`,
  );
}

function applyBucketBalanceChanges(
  ledger: KiloLedger,
  now: string,
  movement: KiloMovement,
  changes: Array<{ bucketId: string; deltaCents: number }>,
): KiloLedger {
  const changeMap = new Map<string, number>();
  for (const change of changes) {
    changeMap.set(change.bucketId, (changeMap.get(change.bucketId) ?? 0) + change.deltaCents);
  }

  const buckets = ledger.buckets.map((bucket) => {
    const delta = changeMap.get(bucket.id) ?? 0;
    if (delta === 0) {
      return bucket;
    }
    const nextBalance = bucket.balanceCents + delta;
    if (nextBalance < 0) {
      throw new Error(`${bucket.name} cannot go below $0.00.`);
    }
    return {
      ...bucket,
      balanceCents: nextBalance,
      updatedAt: now,
    };
  });

  return normalizeLedger({
    ...ledger,
    buckets,
    movements: [...ledger.movements, movement],
    updatedAt: now,
  });
}

function previewWeeklyAllocation(
  ledger: KiloLedger,
  amountCents = ledger.settings.weeklyContributionCents,
): Array<{ rule: KiloWeeklyAllocationRule; amountCents: number }> {
  return previewFundingAllocation(ledger, amountCents, ledger.settings.weeklyAllocation);
}

function previewFundingAllocation(
  ledger: KiloLedger,
  amountCents = ledger.settings.monthlyContributionCents,
  rules = ledger.settings.monthlyAllocation,
): Array<{ rule: KiloFundingAllocationRule; amountCents: number }> {
  const amount = normalizePositiveCents(amountCents);
  let allocated = 0;
  const output: Array<{ rule: KiloFundingAllocationRule; amountCents: number }> = [];
  const remainderRules = rules.filter((rule) => rule.remainder);

  for (const rule of rules.filter((candidate) => !candidate.remainder)) {
    const ruleAmount = Math.floor((amount * (rule.shareBps ?? 0)) / 10_000);
    allocated += ruleAmount;
    output.push({ rule, amountCents: ruleAmount });
  }

  const remainderRule = remainderRules[0] ?? { bucketId: ledger.settings.defaultRemainderBucketId, remainder: true };
  output.push({ rule: remainderRule, amountCents: amount - allocated });
  return output.filter((entry) => entry.amountCents > 0);
}

function defaultFundingAllocation(): KiloFundingAllocationRule[] {
  return [
    { bucketId: "giving", shareBps: 1_000 },
    { bucketId: "savings", shareBps: 3_000 },
    { bucketId: "to-allocate", remainder: true },
  ];
}

function normalizeLedgerSettings(settings: Partial<KiloLedger["settings"]> | undefined): KiloLedger["settings"] {
  const defaultAllocation = defaultFundingAllocation();
  const weeklyAllocation = normalizeFundingRules(settings?.weeklyAllocation ?? defaultAllocation);
  const monthlyAllocation = normalizeFundingRules(settings?.monthlyAllocation ?? weeklyAllocation);
  return {
    fundingCadence: "monthly",
    fundingStartOn: normalizeIsoDate(settings?.fundingStartOn ?? KILO_LEDGER_MONTHLY_FUNDING_START_ON),
    monthlyContributionCents: settings?.monthlyContributionCents == null
      ? KILO_LEDGER_MONTHLY_CONTRIBUTION_CENTS
      : normalizePositiveCents(settings.monthlyContributionCents),
    monthlyAllocation,
    weeklyContributionCents: settings?.weeklyContributionCents == null
      ? 2_000
      : normalizePositiveCents(settings.weeklyContributionCents),
    weeklyAllocation,
    protectedBucketIds: (settings?.protectedBucketIds ?? ["giving", "savings"]).map(normalizeBucketId),
    defaultRemainderBucketId: normalizeBucketId(settings?.defaultRemainderBucketId ?? "to-allocate"),
    setupTargets: (settings?.setupTargets ?? []).map((target) => ({
      bucketId: normalizeBucketId(target.bucketId),
      amountCents: normalizeNonNegativeCents(target.amountCents),
      status: target.status === "pending" ? "pending" : "funded",
      note: target.note,
    })),
    driftPolicy: {
      warnOwner: true,
      blockWrites: false,
    },
  };
}

function normalizeFundingRules(rules: KiloFundingAllocationRule[]): KiloFundingAllocationRule[] {
  const normalized: KiloFundingAllocationRule[] = rules.map((rule) => ({
    bucketId: normalizeBucketId(rule.bucketId),
    shareBps: rule.shareBps == null ? undefined : normalizeShareBps(rule.shareBps),
    remainder: rule.remainder === true,
  }));
  if (!normalized.some((rule) => rule.remainder)) {
    normalized.push({ bucketId: "to-allocate", remainder: true });
  }
  return normalized;
}

function normalizeShareBps(value: number): number {
  const bps = normalizeIntegerCents(value);
  if (bps < 0 || bps > 10_000) {
    throw new Error(`Funding share must be between 0 and 10000 bps, received ${String(value)}.`);
  }
  return bps;
}

function normalizeAllocations(
  allocations: KiloMovementAllocation[],
  expectedTotalCents: number,
): KiloMovementAllocation[] {
  const normalized = allocations.map((allocation) => ({
    bucketId: normalizeBucketId(allocation.bucketId),
    amountCents: normalizeNonNegativeCents(allocation.amountCents),
  }));
  const total = normalized.reduce((sum, allocation) => sum + allocation.amountCents, 0);
  if (total !== expectedTotalCents) {
    throw new Error(`Allocations total ${formatCents(total)} but expected ${formatCents(expectedTotalCents)}.`);
  }
  return normalized.filter((allocation) => allocation.amountCents > 0);
}

function requireBucket(ledger: KiloLedger, bucketId: string): KiloBucket {
  const normalized = normalizeBucketId(bucketId);
  const bucket = ledger.buckets.find((candidate) => candidate.id === normalized);
  if (!bucket) {
    throw new Error(`Unknown Kilo bucket: ${bucketId}`);
  }
  return bucket;
}

function normalizeBucketName(name: string): string {
  const normalized = name.trim().replace(/\s+/gu, " ");
  if (normalized.length < 2 || normalized.length > 40) {
    throw new Error("Bucket name must be 2-40 characters.");
  }
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizePayee(payee: string): string {
  const normalized = payee.trim().replace(/\s+/gu, " ");
  if (normalized.length < 2 || normalized.length > 80) {
    throw new Error("Payee must be 2-80 characters.");
  }
  return normalized;
}

function normalizeIsoDate(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new Error(`Invalid date: ${value}`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`Invalid date: ${value}`);
  }
  return normalized;
}

function normalizeBucketId(bucketId: string): string {
  const normalized = bucketId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/u.test(normalized)) {
    throw new Error(`Invalid bucket id: ${bucketId}`);
  }
  return normalized;
}

function normalizeMovementId(movementId: string): string {
  const normalized = movementId.trim();
  if (normalized.length === 0) {
    throw new Error("Movement id is required.");
  }
  return normalized;
}

function slugifyBucketName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalizeBucketId(slug || "bucket");
}

function uniqueBucketId(ledger: KiloLedger, preferredId: string): string {
  const existing = new Set(ledger.buckets.map((bucket) => bucket.id));
  if (!existing.has(preferredId)) {
    return preferredId;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${preferredId}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not create a unique bucket id for ${preferredId}.`);
}

function normalizePositiveCents(value: number): number {
  const cents = normalizeIntegerCents(value);
  if (cents <= 0) {
    throw new Error("Amount must be greater than $0.00.");
  }
  return cents;
}

function normalizeNonNegativeCents(value: number): number {
  const cents = normalizeIntegerCents(value);
  if (cents < 0) {
    throw new Error("Amount cannot be negative.");
  }
  return cents;
}

function normalizeIntegerCents(value: number): number {
  if (!Number.isInteger(value) || !Number.isFinite(value)) {
    throw new Error(`Expected integer cents, received ${String(value)}.`);
  }
  return value;
}
