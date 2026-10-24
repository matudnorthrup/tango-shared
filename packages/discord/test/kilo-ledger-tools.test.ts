import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKiloLedgerTools, kiloLedgerToolLooksReadOnly } from "../src/kilo-ledger-tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempLedgerPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-kilo-tool-"));
  tempDirs.push(dir);
  return path.join(dir, "ledger.json");
}

function createTool(input: { filePath?: string; reportSender?: (content: string) => Promise<{ ok: boolean; detail?: string }> } = {}) {
  const tool = createKiloLedgerTools(input).find((entry) => entry.name === "kilo_ledger");
  if (!tool) throw new Error("kilo_ledger tool missing");
  return tool;
}

describe("kilo_ledger tool", () => {
  it("initializes and summarizes an isolated ledger", async () => {
    const filePath = createTempLedgerPath();
    const tool = createTool({ filePath });

    const initialized = await tool.handler({ operation: "initialize" }) as Record<string, unknown>;
    const summaryResult = await tool.handler({ operation: "summary" }) as Record<string, unknown>;
    const summary = summaryResult.summary as { total: string; buckets: Array<{ id: string }> };

    expect(initialized).toMatchObject({
      ledgerPath: filePath,
      summary: expect.objectContaining({ total: "$0.00" }),
    });
    expect(summary.buckets.map((bucket) => bucket.id)).toContain("recreation");
  });

  it("reports movement summaries to Foxtrot when writes happen", async () => {
    const filePath = createTempLedgerPath();
    const reportSender = vi.fn(async () => ({ ok: true, detail: "sent" }));
    const tool = createTool({ filePath, reportSender });

    await tool.handler({ operation: "initialize" });
    const funded = await tool.handler({
      operation: "apply_monthly_funding",
      actor: "owner",
      external_id: "bank:kilo:2026-07",
    }) as Record<string, unknown>;

    expect(funded).toMatchObject({
      summary: expect.objectContaining({ total: "$80.00" }),
      report: { ok: true, detail: "sent" },
    });
    expect(reportSender).toHaveBeenCalledWith(expect.stringContaining("funded $80.00"));
    expect(reportSender).toHaveBeenCalledWith(expect.stringContaining("Unallocated $48.00"));
  });

  it("blocks protected-bucket transfers", async () => {
    const filePath = createTempLedgerPath();
    const tool = createTool({ filePath, reportSender: vi.fn() });

    await tool.handler({ operation: "initialize" });
    await tool.handler({ operation: "apply_monthly_funding", actor: "owner" });

    await expect(tool.handler({
      operation: "transfer",
      from_bucket_id: "savings",
      to_bucket_id: "recreation",
      amount: "1",
    })).rejects.toThrow("Savings is protected");
  });

  it("records drift without preventing later writes", async () => {
    const filePath = createTempLedgerPath();
    const tool = createTool({ filePath, reportSender: vi.fn(async () => ({ ok: true })) });

    await tool.handler({ operation: "initialize" });
    await tool.handler({ operation: "apply_monthly_funding", actor: "owner" });
    const drift = await tool.handler({
      operation: "reconcile",
      external_balance: "79",
      source: "LunchMoney Kilo Ledger Account",
    }) as Record<string, unknown>;
    const transfer = await tool.handler({
      operation: "transfer",
      from_bucket_id: "to-allocate",
      to_bucket_id: "gifts",
      amount: "1",
    }) as Record<string, unknown>;

    expect(drift).toMatchObject({
      reconciliation: expect.objectContaining({ status: "drift" }),
    });
    expect(transfer).toMatchObject({
      summary: expect.objectContaining({
        latestReconciliation: expect.objectContaining({ status: "drift" }),
      }),
    });
  });

  it("logs historical spending without changing total", async () => {
    const filePath = createTempLedgerPath();
    const reportSender = vi.fn(async () => ({ ok: true }));
    const tool = createTool({ filePath, reportSender });

    await tool.handler({ operation: "initialize" });
    await tool.handler({ operation: "apply_monthly_funding", actor: "owner" });
    const historical = await tool.handler({
      operation: "record_historical_spend",
      actor: "owner",
      occurred_on: "2025-09-22",
      payee: "Amazon",
      bucket_id: "clothing",
      amount: "12.99",
      description: "Socks",
      external_id: "historical-kilo-spend:2025-09-22:amazon:1299",
    }) as Record<string, unknown>;

    expect(historical).toMatchObject({
      summary: expect.objectContaining({ total: "$80.00" }),
      movement: expect.objectContaining({
        type: "historical_spend",
        amountCents: 1_299,
        occurredOn: "2025-09-22",
        payee: "Amazon",
      }),
    });
    expect(reportSender).toHaveBeenCalledWith(expect.stringContaining("balances unchanged"));
  });

  it("records approved spend and later settlement without double-debiting", async () => {
    const filePath = createTempLedgerPath();
    const reportSender = vi.fn(async () => ({ ok: true }));
    const tool = createTool({ filePath, reportSender });

    await tool.handler({ operation: "initialize" });
    await tool.handler({ operation: "apply_monthly_funding", actor: "owner" });
    await tool.handler({
      operation: "transfer",
      actor: "child",
      from_bucket_id: "to-allocate",
      to_bucket_id: "recreation",
      amount: "20",
    });
    const spend = await tool.handler({
      operation: "record_spend",
      actor: "foxtrot",
      bucket_id: "recreation",
      amount: "14.99",
      external_id: "lm:purchase:123",
    }) as Record<string, unknown>;
    const duplicateSpend = await tool.handler({
      operation: "record_spend",
      actor: "foxtrot",
      bucket_id: "recreation",
      amount: "14.99",
      external_id: "lm:purchase:123",
    }) as Record<string, unknown>;
    const settled = await tool.handler({
      operation: "settle_spending",
      actor: "owner",
      amount: "14.99",
      external_id: "lm:settlement:999",
    }) as Record<string, unknown>;

    expect(spend).toMatchObject({
      summary: expect.objectContaining({
        total: "$65.01",
        pendingSettlement: "$14.99",
        expectedExternalBalance: "$80.00",
      }),
      movement: expect.objectContaining({ type: "spend" }),
    });
    expect(duplicateSpend).toMatchObject({
      idempotent: true,
      summary: expect.objectContaining({ total: "$65.01" }),
    });
    expect(settled).toMatchObject({
      summary: expect.objectContaining({
        total: "$65.01",
        pendingSettlement: "$0.00",
      }),
      movement: expect.objectContaining({ type: "settlement" }),
    });
    expect(reportSender).toHaveBeenCalledWith(expect.stringContaining("pending bank settlement"));
    expect(reportSender).toHaveBeenCalledWith(expect.stringContaining("balances unchanged"));
  });

  it("marks only summary as read-only", () => {
    expect(kiloLedgerToolLooksReadOnly("summary")).toBe(true);
    expect(kiloLedgerToolLooksReadOnly("transfer")).toBe(false);
    expect(kiloLedgerToolLooksReadOnly("reconcile")).toBe(false);
  });
});
