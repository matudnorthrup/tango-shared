import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/browser-manager.js", () => ({ getBrowserManager: () => ({}) }));
vi.mock("../src/site-session.js", () => ({ ensureSiteSession: vi.fn(), getSiteDescriptor: vi.fn() }));

import {
  BankPreSubmitError,
  createBankTransferTools,
  parseBankAccountOption,
  validateTransfers,
  verifyOwnerApproval,
  type BankAccount,
  type BankTransferDriver,
  type BankTransferRules,
  type ApprovalMessage,
} from "../src/bank-transfer-tools.js";

const OWNER = "100000000000000001";

const RULES: BankTransferRules = {
  transferUrl: "https://bank.example/transfers",
  origin: "https://bank.example",
  sourceMasks: ["1111", "2222"],
  destinationMasks: ["9999"],
  maxPerTransferCents: 100_000,
  maxPerPlanCents: 150_000,
  approverDiscordUserIds: [OWNER],
  planTtlHours: 72,
};

const ACCOUNTS: BankAccount[] = [
  { name: "House Fund", mask: "1111", balanceCents: 80_000 },
  { name: "Car Fund", mask: "2222", balanceCents: 30_000 },
  { name: "Staging", mask: "9999", balanceCents: 500_000 },
  { name: "Checking", mask: "3333", balanceCents: 900_000 },
  { name: "Other Bank", mask: "4444", balanceCents: null },
];

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(
  overrides: { transfer?: BankTransferDriver["transfer"]; now?: () => Date; accounts?: () => BankAccount[] } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-transfer-"));
  tempDirs.push(dir);
  const messages = new Map<string, ApprovalMessage>();
  const transfer = vi.fn(
    overrides.transfer
      ?? (async (_item: unknown, onSubmitting: () => void) => {
        onSubmitting();
        return { reference: `REF${transfer.mock.calls.length}` };
      }),
  );
  const driver: BankTransferDriver = { listAccounts: async () => overrides.accounts?.() ?? ACCOUNTS, transfer };
  const [tool] = createBankTransferTools({
    rules: RULES,
    driver,
    storePath: path.join(dir, "transfers.json"),
    lookupMessage: (id) => messages.get(id) ?? null,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  const ownerSays = (id: string, content: string, createdAt = new Date(Date.now() + 1000).toISOString()) =>
    messages.set(id, { direction: "inbound", source: "discord", discordUserId: OWNER, content, createdAt });
  return { tool, transfer, messages, ownerSays };
}

describe("parseBankAccountOption", () => {
  it("reads name, mask, and balance from an Bank account option", () => {
    expect(parseBankAccountOption("Car Fund ••1234 $1,250.40")).toEqual({
      name: "Car Fund",
      mask: "1234",
      balanceCents: 125_040,
    });
  });

  it("marks linked external accounts by their missing balance", () => {
    expect(parseBankAccountOption("Example Bank, N.A. ••5678 Linked")).toEqual({
      name: "Example Bank, N.A.",
      mask: "5678",
      balanceCents: null,
    });
    expect(parseBankAccountOption("Select an Account")).toBeNull();
  });
});

describe("validateTransfers", () => {
  it("accepts allowlisted transfers within caps and balances", () => {
    const result = validateTransfers(
      [{ from: "••1111", to: "9999", amountCents: 20_000, memo: "repair" }],
      ACCOUNTS,
      RULES,
    );
    expect(result).toMatchObject({ ok: true, items: [{ fromName: "House Fund", toName: "Staging", amountCents: 20_000 }] });
  });

  it("rejects disallowed sources and destinations, externals, caps, and overdraws", () => {
    const result = validateTransfers(
      [
        { from: "3333", to: "9999", amountCents: 100 },
        { from: "1111", to: "3333", amountCents: 100 },
        { from: "1111", to: "4444", amountCents: 100 },
        { from: "2222", to: "9999", amountCents: 100_001 },
        { from: "2222", to: "9999", amountCents: 30_000 },
      ],
      ACCOUNTS,
      RULES,
    );
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors.join("\n");
    expect(errors).toContain("Checking ••3333 is not an allowed source");
    expect(errors).toContain("Checking ••3333 is not an allowed destination");
    expect(errors).toContain("linked external account");
    expect(errors).toContain("over the per-transfer cap");
    expect(errors).toContain("less than the");
  });

  it("rejects a plan whose total is over the per-plan cap", () => {
    const result = validateTransfers(
      [
        { from: "1111", to: "9999", amountCents: 60_000 },
        { from: "2222", to: "9999", amountCents: 30_000 },
      ],
      ACCOUNTS,
      { ...RULES, maxPerPlanCents: 80_000 },
    );
    expect(result.ok ? "" : result.errors.join("\n")).toContain("over the per-plan cap of $800.00");
  });
});

describe("verifyOwnerApproval", () => {
  const plan = { code: "BANK-AB12", createdAt: "2026-10-10T17:00:00.500Z" };
  const message = (patch: Partial<ApprovalMessage>): ApprovalMessage => ({
    direction: "inbound",
    source: "discord",
    discordUserId: OWNER,
    content: "approve BANK-AB12",
    createdAt: "2026-10-10 17:00:05",
    ...patch,
  });

  it("accepts the owner's later message naming the plan code (SQLite UTC timestamps)", () => {
    expect(verifyOwnerApproval(plan, message({ content: "Approve bank-ab12." }), [OWNER])).toEqual({ ok: true });
    expect(verifyOwnerApproval(plan, message({ content: "<@123456> approve BANK-AB12" }), [OWNER])).toEqual({ ok: true });
    expect(verifyOwnerApproval(plan, message({ content: "Foxtrot, approve BANK-AB12!" }), [OWNER])).toEqual({ ok: true });
    expect(verifyOwnerApproval(plan, message({ content: "Approve bank AB12." }), [OWNER])).toEqual({ ok: true });
    expect(verifyOwnerApproval(plan, message({ createdAt: "2026-10-10 17:00:00" }), [OWNER])).toEqual({ ok: true });
  });

  it.each([
    ["no message", null, "not started by a stored Discord message"],
    ["someone else", message({ discordUserId: "200" }), "not from a configured approver"],
    ["a bot relay", message({ discordUserId: "intake-webhook:screen-input:scene" }), "not from a configured approver"],
    ["an older message", message({ createdAt: "2026-10-10 16:59:59" }), "older than the plan"],
    ["no code", message({ content: "approve" }), 'does not say "approve BANK-AB12"'],
    ["code without approve", message({ content: "what is BANK-AB12?" }), 'does not say "approve BANK-AB12"'],
    ["a negation", message({ content: "do not approve BANK-AB12" }), 'does not say "approve BANK-AB12"'],
    ["a question", message({ content: "can I approve BANK-AB12?" }), 'does not say "approve BANK-AB12"'],
    ["approval with conditions", message({ content: "approve BANK-AB12 but only the first one" }), 'does not say "approve BANK-AB12"'],
    ["a different code", message({ content: "approve BANK-AB123" }), 'does not say "approve BANK-AB12"'],
  ])("rejects %s", (_label, candidate, reason) => {
    const result = verifyOwnerApproval(plan, candidate, [OWNER]);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain(reason);
  });
});

describe("bank_transfer tool", () => {
  it("plans without moving money, refuses unapproved execution, then executes on the owner's reply", async () => {
    const { tool, transfer, ownerSays } = setup();
    const plan = (await tool.handler({
      action: "plan",
      transfers: [
        { from: "1111", to: "9999", amount: "200.00", memo: "repair" },
        { from: "2222", to: "9999", amount: "$50.10" },
      ],
      reason: "weekly review",
    })) as Record<string, any>;
    expect(plan.status).toBe("pending");
    expect(plan.total).toBe("$250.10");
    expect(transfer).not.toHaveBeenCalled();

    const unapproved = (await tool.handler({ action: "execute", plan_id: plan.plan_id })) as Record<string, any>;
    expect(unapproved.error).toBe("Not approved.");

    ownerSays("m-other", "approve BANK-ZZZZ");
    const wrongCode = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m-other" })) as Record<string, any>;
    expect(wrongCode.error).toBe("Not approved.");
    expect(transfer).not.toHaveBeenCalled();

    ownerSays("m-ok", `approve ${plan.code}`);
    const done = (await tool.handler({ action: "execute", plan_id: plan.code, _message_id: "m-ok" })) as Record<string, any>;
    expect(done.status).toBe("done");
    expect(done.transfers.map((item: any) => [item.status, item.reference])).toEqual([
      ["done", "REF1"],
      ["done", "REF2"],
    ]);
    expect(done.approval).toMatchObject({ messageId: "m-ok", discordUserId: OWNER });
    expect(transfer).toHaveBeenCalledTimes(2);

    const again = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m-ok" })) as Record<string, any>;
    expect(again.error).toContain("is done and cannot be executed");
    expect(transfer).toHaveBeenCalledTimes(2);
  });

  it("never retries a transfer whose submit was not confirmed", async () => {
    const { tool, transfer, ownerSays } = setup({
      transfer: async (_item, onSubmitting) => {
        onSubmitting();
        throw new Error("Submitted, but Bank did not show a confirmation");
      },
    });
    const plan = (await tool.handler({
      action: "plan",
      transfers: [
        { from: "1111", to: "9999", amount: "10" },
        { from: "2222", to: "9999", amount: "10" },
      ],
    })) as Record<string, any>;
    ownerSays("m1", `approve ${plan.code}`);
    const result = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m1" })) as Record<string, any>;
    expect(result.status).toBe("needs_review");
    expect(result.transfers.map((item: any) => item.status)).toEqual(["unknown", "pending"]);
    expect(transfer).toHaveBeenCalledTimes(1);

    ownerSays("m2", `approve ${plan.code}`);
    const retry = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m2" })) as Record<string, any>;
    expect(retry.error).toContain("needs_review");
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it("retries only the item that failed before submit, on a fresh approval", async () => {
    let failFirst = true;
    const { tool, transfer, ownerSays } = setup({
      transfer: async (item, onSubmitting) => {
        if (item.fromMask === "2222" && failFirst) {
          failFirst = false;
          throw new BankPreSubmitError("The review screen did not match the plan");
        }
        onSubmitting();
        return { reference: `REF-${item.fromMask}` };
      },
    });
    const plan = (await tool.handler({
      action: "plan",
      transfers: [
        { from: "1111", to: "9999", amount: "10" },
        { from: "2222", to: "9999", amount: "20" },
      ],
    })) as Record<string, any>;
    ownerSays("m1", `approve ${plan.code}`);
    const first = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m1" })) as Record<string, any>;
    expect(first.status).toBe("partial");
    expect(first.transfers.map((item: any) => item.status)).toEqual(["done", "failed"]);

    const reused = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m1" })) as Record<string, any>;
    expect(reused.detail).toContain("already used");
    expect(transfer).toHaveBeenCalledTimes(2);

    ownerSays("m2", `approve ${plan.code}`);
    const second = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m2" })) as Record<string, any>;
    expect(second.status).toBe("done");
    expect(transfer.mock.calls.map(([item]) => item.fromMask)).toEqual(["1111", "2222", "2222"]);
  });

  it("refuses an expired plan and a plan outside the rules", async () => {
    let clock = new Date("2026-10-10T17:00:00Z");
    const { tool, transfer, ownerSays } = setup({ now: () => clock });
    const plan = (await tool.handler({ action: "plan", transfers: [{ from: "1111", to: "9999", amount: "10" }] })) as Record<string, any>;
    clock = new Date("2026-10-14T17:00:00Z");
    ownerSays("m1", `approve ${plan.code}`, "2026-10-14 16:00:00");
    const expired = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m1" })) as Record<string, any>;
    expect(expired.error).toContain("expired");

    const rejected = (await tool.handler({ action: "plan", transfers: [{ from: "3333", to: "9999", amount: "10" }] })) as Record<string, any>;
    expect(rejected.error).toBe("The plan was not created.");
    expect(transfer).not.toHaveBeenCalled();
  });

  it("re-checks the per-plan cap at execute time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bank-transfer-cap-"));
    tempDirs.push(dir);
    const storePath = path.join(dir, "transfers.json");
    const transfer = vi.fn();
    const messages = new Map<string, ApprovalMessage>();
    const make = (rules: BankTransferRules) =>
      createBankTransferTools({
        rules,
        driver: { listAccounts: async () => ACCOUNTS, transfer },
        storePath,
        lookupMessage: (id) => messages.get(id) ?? null,
      })[0]!;
    const plan = (await make(RULES).handler({
      action: "plan",
      transfers: [
        { from: "1111", to: "9999", amount: "500" },
        { from: "2222", to: "9999", amount: "200" },
      ],
    })) as Record<string, any>;
    messages.set("m1", {
      direction: "inbound",
      source: "discord",
      discordUserId: OWNER,
      content: `approve ${plan.code}`,
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    const result = (await make({ ...RULES, maxPerPlanCents: 50_000 }).handler({
      action: "execute",
      plan_id: plan.plan_id,
      _message_id: "m1",
    })) as Record<string, any>;
    expect(result.error).toContain("over the current per-plan cap of $500.00");
    expect(transfer).not.toHaveBeenCalled();
  });

  it("refuses a plan outside the rules", async () => {
    const { tool, transfer } = setup();
    const rejected = (await tool.handler({ action: "plan", transfers: [{ from: "3333", to: "9999", amount: "10" }] })) as Record<string, any>;
    expect(rejected.error).toBe("The plan was not created.");
    expect(transfer).not.toHaveBeenCalled();
  });

  it("re-checks live balances before submitting anything", async () => {
    let accounts = ACCOUNTS;
    const { tool, transfer, ownerSays } = setup({ accounts: () => accounts });
    const plan = (await tool.handler({ action: "plan", transfers: [{ from: "2222", to: "9999", amount: "250" }] })) as Record<string, any>;
    accounts = ACCOUNTS.map((account) => (account.mask === "2222" ? { ...account, balanceCents: 10_000 } : account));
    ownerSays("m1", `approve ${plan.code}`);
    const result = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m1" })) as Record<string, any>;
    expect(result.error).toContain("••2222 now has $100.00, less than the $250.00");
    expect(transfer).not.toHaveBeenCalled();
  });

  it("never reuses a plan code that is still in the store", async () => {
    const { tool } = setup();
    const codes = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const plan = (await tool.handler({ action: "plan", transfers: [{ from: "1111", to: "9999", amount: "1" }] })) as Record<string, any>;
      codes.add(plan.code);
    }
    expect(codes.size).toBe(25);
  });

  it("recovers a plan interrupted mid-execution: submitting becomes unknown, unsent items stay retryable", async () => {
    const { tool, transfer, ownerSays } = setup();
    const plan = (await tool.handler({
      action: "plan",
      transfers: [
        { from: "1111", to: "9999", amount: "10" },
        { from: "2222", to: "9999", amount: "20" },
      ],
    })) as Record<string, any>;
    // Simulate a restart between the submit click and its confirmation.
    const storeFile = path.join(tempDirs[tempDirs.length - 1]!, "transfers.json");
    const stored = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    stored.plans[0].status = "executing";
    stored.plans[0].items[0].status = "submitting";
    fs.writeFileSync(storeFile, JSON.stringify(stored));

    const history = (await tool.handler({ action: "history" })) as Record<string, any>;
    expect(history.plans[0].status).toBe("needs_review");
    expect(history.plans[0].transfers.map((item: any) => item.status)).toEqual(["unknown", "pending"]);

    ownerSays("m1", `approve ${plan.code}`);
    const retry = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m1" })) as Record<string, any>;
    expect(retry.error).toContain("needs_review");
    expect(transfer).not.toHaveBeenCalled();
  });

  it("lets an interrupted plan with nothing in flight resume on a fresh approval", async () => {
    const { tool, transfer, ownerSays } = setup();
    const plan = (await tool.handler({ action: "plan", transfers: [{ from: "1111", to: "9999", amount: "10" }] })) as Record<string, any>;
    const storeFile = path.join(tempDirs[tempDirs.length - 1]!, "transfers.json");
    const stored = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    stored.plans[0].status = "executing";
    fs.writeFileSync(storeFile, JSON.stringify(stored));

    ownerSays("m1", `approve ${plan.code}`);
    const result = (await tool.handler({ action: "execute", plan_id: plan.plan_id, _message_id: "m1" })) as Record<string, any>;
    expect(result.status).toBe("done");
    expect(transfer).toHaveBeenCalledTimes(1);
  });
});
