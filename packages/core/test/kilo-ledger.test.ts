import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFunding,
  applyMonthlyFunding,
  createDefaultKiloLedger,
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
} from "../src/kilo-ledger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-kilo-ledger-"));
  tempDirs.push(dir);
  return path.join(dir, "ledger.json");
}

describe("Kilo ledger", () => {
  it("creates the default buckets and monthly split", () => {
    const ledger = createDefaultKiloLedger("2026-06-07T12:00:00.000Z");
    const summary = summarizeKiloLedger(ledger);

    expect(summary.total).toBe("$0.00");
    expect(summary.buckets.map((bucket) => bucket.id)).toEqual([
      "giving",
      "clothing",
      "entertainment",
      "food",
      "recreation",
      "gifts",
      "savings",
      "to-allocate",
    ]);
    expect(summary.buckets.find((bucket) => bucket.id === "giving")).toMatchObject({
      role: "protected",
      canDelete: false,
      canTransferOut: false,
    });
    expect(ledger.settings.setupTargets).toEqual([]);
    expect(summary.fundingCadence).toBe("monthly");
    expect(summary.fundingStartOn).toBe("2026-07-01");
    expect(summary.monthlyContribution).toBe("$80.00");
    expect(summary.monthlyAllocation).toEqual([
      expect.objectContaining({ bucketId: "giving", amount: "$8.00" }),
      expect.objectContaining({ bucketId: "savings", amount: "$24.00" }),
      expect.objectContaining({ bucketId: "to-allocate", amount: "$48.00" }),
    ]);
  });

  it("applies monthly funding to Giving, Savings, and Unallocated by default", () => {
    const result = applyMonthlyFunding(createDefaultKiloLedger(), {
      now: "2026-07-01T12:00:00.000Z",
      source: "monthly-transfer",
      externalId: "bank:kilo:2026-07",
    });
    const summary = summarizeKiloLedger(result.ledger);

    expect(summary.total).toBe("$80.00");
    expect(summary.buckets.find((bucket) => bucket.id === "giving")?.balance).toBe("$8.00");
    expect(summary.buckets.find((bucket) => bucket.id === "savings")?.balance).toBe("$24.00");
    expect(summary.buckets.find((bucket) => bucket.id === "to-allocate")?.balance).toBe("$48.00");
    expect(result.movement).toMatchObject({
      type: "funding",
      amountCents: 8_000,
      externalId: "bank:kilo:2026-07",
      allocations: [
        { bucketId: "giving", amountCents: 800 },
        { bucketId: "savings", amountCents: 2_400 },
        { bucketId: "to-allocate", amountCents: 4_800 },
      ],
    });
  });

  it("makes monthly funding idempotent by external id", () => {
    const first = applyMonthlyFunding(createDefaultKiloLedger(), {
      externalId: "bank:kilo:2026-07",
    });
    const second = applyMonthlyFunding(first.ledger, {
      externalId: "bank:kilo:2026-07",
    });
    const summary = summarizeKiloLedger(second.ledger);

    expect(second.idempotent).toBe(true);
    expect(summary.total).toBe("$80.00");
    expect(summary.movements.filter((movement) => movement.type === "funding")).toHaveLength(1);
  });

  it("prevents money moving out of protected buckets", () => {
    const funded = applyMonthlyFunding(createDefaultKiloLedger()).ledger;

    expect(() => transferBetweenBuckets(funded, {
      fromBucketId: "savings",
      toBucketId: "recreation",
      amountCents: 100,
    })).toThrow("Savings is protected");
    expect(() => deleteDiscretionaryBucket(funded, { bucketId: "giving" })).toThrow("Giving is protected");
  });

  it("creates and deletes discretionary buckets while preserving the ledger total", () => {
    const funded = applyMonthlyFunding(createDefaultKiloLedger()).ledger;
    const created = createDiscretionaryBucket(funded, { name: "Books" }).ledger;
    const moved = transferBetweenBuckets(created, {
      fromBucketId: "to-allocate",
      toBucketId: "books",
      amountCents: parseDollarAmountToCents("5"),
    }).ledger;
    const deleted = deleteDiscretionaryBucket(moved, {
      bucketId: "books",
      transferToBucketId: "gifts",
    }).ledger;
    const summary = summarizeKiloLedger(deleted);

    expect(summary.total).toBe("$80.00");
    expect(summary.buckets.map((bucket) => bucket.id)).not.toContain("books");
    expect(summary.buckets.find((bucket) => bucket.id === "gifts")?.balance).toBe("$5.00");
  });

  it("records approved spending as internal ledger bookkeeping", () => {
    const funded = applyMonthlyFunding(createDefaultKiloLedger()).ledger;
    const allocated = transferBetweenBuckets(funded, {
      fromBucketId: "to-allocate",
      toBucketId: "recreation",
      amountCents: parseDollarAmountToCents("12"),
    }).ledger;
    const spent = recordKiloSpend(allocated, {
      bucketId: "recreation",
      amountCents: parseDollarAmountToCents("4.99"),
      actor: "foxtrot",
      description: "Xbox subscription approved in weekly review.",
      externalId: "lm:123",
    });
    const summary = summarizeKiloLedger(spent.ledger);

    expect(summary.buckets.find((bucket) => bucket.id === "recreation")?.balance).toBe("$7.01");
    expect(summary.total).toBe("$75.01");
    expect(summary.pendingSettlement).toBe("$4.99");
    expect(summary.expectedExternalBalance).toBe("$80.00");
    expect(spent.movement).toMatchObject({
      type: "spend",
      actor: "foxtrot",
      fromBucketId: "recreation",
      externalId: "lm:123",
    });
    expect(summary.movements[0]).toMatchObject({
      type: "spend",
      amountCents: 499,
    });
  });

  it("reconciles against expected external balance until approved spending is settled", () => {
    const funded = applyMonthlyFunding(createDefaultKiloLedger(), {
      now: "2026-07-01T12:00:00.000Z",
      externalId: "bank:kilo:2026-07",
    }).ledger;
    const allocated = transferBetweenBuckets(funded, {
      fromBucketId: "to-allocate",
      toBucketId: "recreation",
      amountCents: parseDollarAmountToCents("20"),
    }).ledger;
    const spent = recordKiloSpend(allocated, {
      bucketId: "recreation",
      amountCents: parseDollarAmountToCents("14.99"),
      externalId: "lm:purchase:123",
      now: "2026-07-05T12:00:00.000Z",
    }).ledger;
    const pendingReconciliation = reconcileKiloLedger(spent, {
      externalBalanceCents: parseDollarAmountToCents("80"),
      source: "LunchMoney Kilo Test SB 9999",
    });
    const settled = settleKiloSpending(pendingReconciliation.ledger, {
      amountCents: parseDollarAmountToCents("14.99"),
      externalId: "lm:settlement:999",
      now: "2026-07-08T12:00:00.000Z",
    });
    const finalReconciliation = reconcileKiloLedger(settled.ledger, {
      externalBalanceCents: parseDollarAmountToCents("65.01"),
      source: "LunchMoney Kilo Test SB 9999",
    });
    const summary = summarizeKiloLedger(finalReconciliation.ledger);

    expect(pendingReconciliation.reconciliation).toMatchObject({
      status: "match",
      ledgerTotalCents: 6_501,
      pendingSettlementCents: 1_499,
      expectedExternalBalanceCents: 8_000,
      driftCents: 0,
    });
    expect(settled.movement).toMatchObject({
      type: "settlement",
      amountCents: 1_499,
      externalId: "lm:settlement:999",
    });
    expect(summary.total).toBe("$65.01");
    expect(summary.pendingSettlement).toBe("$0.00");
    expect(summary.expectedExternalBalance).toBe("$65.01");
    expect(summary.latestReconciliation).toMatchObject({
      status: "match",
      expectedExternalBalance: "$65.01",
    });
  });

  it("makes approved spending and settlement idempotent by external id", () => {
    const funded = applyMonthlyFunding(createDefaultKiloLedger()).ledger;
    const allocated = transferBetweenBuckets(funded, {
      fromBucketId: "to-allocate",
      toBucketId: "recreation",
      amountCents: parseDollarAmountToCents("20"),
    }).ledger;
    const firstSpend = recordKiloSpend(allocated, {
      bucketId: "recreation",
      amountCents: parseDollarAmountToCents("10"),
      externalId: "lm:purchase:abc",
    });
    const duplicateSpend = recordKiloSpend(firstSpend.ledger, {
      bucketId: "recreation",
      amountCents: parseDollarAmountToCents("10"),
      externalId: "lm:purchase:abc",
    });
    const firstSettlement = settleKiloSpending(duplicateSpend.ledger, {
      amountCents: parseDollarAmountToCents("10"),
      externalId: "lm:settlement:abc",
    });
    const duplicateSettlement = settleKiloSpending(firstSettlement.ledger, {
      amountCents: parseDollarAmountToCents("10"),
      externalId: "lm:settlement:abc",
    });
    const summary = summarizeKiloLedger(duplicateSettlement.ledger);

    expect(duplicateSpend.idempotent).toBe(true);
    expect(duplicateSettlement.idempotent).toBe(true);
    expect(summary.total).toBe("$70.00");
    expect(summary.pendingSettlement).toBe("$0.00");
    expect(summary.movements.filter((movement) => movement.type === "spend")).toHaveLength(1);
    expect(summary.movements.filter((movement) => movement.type === "settlement")).toHaveLength(1);
  });

  it("records historical spending without changing current balances", () => {
    const funded = applyFunding(createDefaultKiloLedger(), {
      amountCents: parseDollarAmountToCents("20"),
      now: "2026-06-07T12:00:00.000Z",
    }).ledger;
    const historical = recordKiloHistoricalSpend(funded, {
      amountCents: parseDollarAmountToCents("12.99"),
      occurredOn: "2025-09-22",
      payee: "Amazon",
      bucketId: "clothing",
      actor: "owner",
      description: "Socks",
      externalId: "historical-kilo-spend:2025-09-22:amazon:1299",
      now: "2026-06-08T12:00:00.000Z",
    });
    const summary = summarizeKiloLedger(historical.ledger);

    expect(summary.total).toBe("$20.00");
    expect(summary.buckets.find((bucket) => bucket.id === "clothing")?.balance).toBe("$0.00");
    expect(summary.movements[0]).toMatchObject({
      type: "funding",
      amountCents: 2_000,
    });
    expect(summary.movements[1]).toMatchObject({
      type: "historical_spend",
      amountCents: 1_299,
      fromBucketId: "clothing",
      occurredOn: "2025-09-22",
      payee: "Amazon",
    });
  });

  it("warns on drift without blocking later writes", () => {
    const funded = applyMonthlyFunding(createDefaultKiloLedger()).ledger;
    const reconciled = reconcileKiloLedger(funded, {
      externalBalanceCents: parseDollarAmountToCents("79"),
      source: "LunchMoney Kilo Test SB 9999",
    }).ledger;
    const moved = transferBetweenBuckets(reconciled, {
      fromBucketId: "to-allocate",
      toBucketId: "gifts",
      amountCents: parseDollarAmountToCents("1"),
    }).ledger;
    const summary = summarizeKiloLedger(moved);

    expect(summary.latestReconciliation).toMatchObject({
      status: "drift",
      drift: "$1.00",
    });
    expect(summary.buckets.find((bucket) => bucket.id === "gifts")?.balance).toBe("$1.00");
  });

  it("persists ledger files atomically through the store", () => {
    const filePath = createTempPath();
    const store = new KiloLedgerStore({ filePath });

    store.initialize({ now: "2026-06-07T12:00:00.000Z" });
    const result = store.mutate((ledger) => applyMonthlyFunding(ledger, {
      now: "2026-07-01T12:01:00.000Z",
    }));

    expect(formatCents(result.ledger.totalCents)).toBe("$80.00");
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      totalCents: 8000,
    });
  });
});
