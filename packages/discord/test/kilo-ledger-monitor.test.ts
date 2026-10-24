import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFunding,
  KiloLedgerStore,
  recordKiloSpend,
} from "@tango/core";
import {
  formatKiloLedgerMonitorSummary,
  runKiloLedgerMonitor,
} from "../src/kilo-ledger-monitor.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createLedgerPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-kilo-monitor-"));
  tempDirs.push(dir);
  return path.join(dir, "ledger.json");
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createFetch(input: {
  balance?: string;
  transactions?: Array<Record<string, unknown>>;
}): typeof fetch {
  return async (request) => {
    const url = String(request);
    if (url.includes("/plaid_accounts")) {
      return jsonResponse({
        plaid_accounts: [
          {
            id: 100001,
            name: "Kilo Ledger Account",
            display_name: "Kilo Ledger Account",
            mask: "0000",
            balance: input.balance ?? "0.0000",
            status: "active",
          },
        ],
      });
    }
    if (url.includes("/transactions")) {
      return jsonResponse({ transactions: input.transactions ?? [] });
    }
    return new Response("not found", { status: 404 });
  };
}

describe("Kilo ledger monitor", () => {
  it("applies posted monthly funding and reconciles the external balance", async () => {
    const filePath = createLedgerPath();
    new KiloLedgerStore({ filePath }).initialize();

    const report = await runKiloLedgerMonitor({
      filePath,
      now: new Date("2026-07-03T12:00:00.000Z"),
      lunchMoneyAccessToken: "test-token",
      fetchImpl: createFetch({
        balance: "80.0000",
        transactions: [
          {
            id: 9001,
            date: "2026-07-01",
            payee: "Internet transfer from Savings account XXXXXX0000",
            amount: "-80.0000",
            to_base: -80,
            is_pending: false,
            status: "cleared",
            category_name: "Kilo Ledger Account",
            plaid_account_id: 100001,
            plaid_account_mask: "0000",
            plaid_account_display_name: "Kilo Ledger Account",
          },
        ],
      }),
    });

    expect(report.flaggedLines).toEqual([]);
    expect(report.funding.appliedMonths).toEqual(["2026-07"]);
    expect(report.summary.totalCents).toBe(8_000);
    expect(report.summary.pendingSettlementCents).toBe(0);
    expect(report.reconciliation?.status).toBe("match");

    const buckets = Object.fromEntries(report.summary.buckets.map((bucket) => [bucket.id, bucket.balanceCents]));
    expect(buckets.giving).toBe(800);
    expect(buckets.savings).toBe(2_400);
    expect(buckets["to-allocate"]).toBe(4_800);
  });

  it("flags missing monthly funding after the posting grace window", async () => {
    const filePath = createLedgerPath();
    new KiloLedgerStore({ filePath }).initialize();

    const report = await runKiloLedgerMonitor({
      filePath,
      now: new Date("2026-07-04T12:00:00.000Z"),
      lunchMoneyAccessToken: "test-token",
      fetchImpl: createFetch({
        balance: "0.0000",
        transactions: [],
      }),
    });

    expect(report.funding.checkedMonths).toEqual(["2026-07"]);
    expect(report.funding.appliedMonths).toEqual([]);
    expect(report.flaggedLines.join("\n")).toContain("Kilo monthly funding for 2026-07 is due");

    const summary = formatKiloLedgerMonitorSummary(report);
    expect(summary).toContain("**Flagged:**");
    expect(summary).toContain("Kilo monthly funding for 2026-07");
  });

  it("settles posted transfer-outs against pending Kilo spending", async () => {
    const filePath = createLedgerPath();
    const store = new KiloLedgerStore({ filePath });
    let ledger = store.initialize();
    ledger = applyFunding(ledger, {
      amountCents: 10_000,
      allocations: [{ bucketId: "recreation", amountCents: 10_000 }],
      now: "2026-06-27T12:00:00.000Z",
      source: "test",
      externalId: "test:seed",
    }).ledger;
    ledger = recordKiloSpend(ledger, {
      bucketId: "recreation",
      amountCents: 2_500,
      now: "2026-06-28T12:00:00.000Z",
      source: "test",
      externalId: "lunchmoney:spend:1",
    }).ledger;
    store.write(ledger);

    const report = await runKiloLedgerMonitor({
      filePath,
      now: new Date("2026-06-29T12:00:00.000Z"),
      lunchMoneyAccessToken: "test-token",
      fetchImpl: createFetch({
        balance: "75.0000",
        transactions: [
          {
            id: 9100,
            date: "2026-06-29",
            payee: "Internet transfer to Checking account XXXXXX1234",
            amount: "25.0000",
            to_base: 25,
            is_pending: false,
            status: "cleared",
            category_name: "Kilo Ledger Account",
            plaid_account_id: 100001,
            plaid_account_mask: "0000",
            plaid_account_display_name: "Kilo Ledger Account",
          },
        ],
      }),
    });

    expect(report.settlement).toMatchObject({
      pendingBeforeCents: 2_500,
      pendingAfterCents: 0,
      settledCents: 2_500,
    });
    expect(report.flaggedLines).toEqual([]);
    expect(report.reconciliation?.status).toBe("match");
  });
});
