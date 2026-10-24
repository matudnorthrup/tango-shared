import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FINANCE_CATEGORIZATION_RULES_PATH,
  findBudgetNeutralInternalTransfers,
  isBudgetNeutralInternalTransfer,
  readFinanceCategorizationRules,
} from "../src/finance-automation.js";

const tempDirs: string[] = [];

function createVault(): string {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-finance-rules-"));
  tempDirs.push(vaultRoot);
  return vaultRoot;
}

function plaidMetadata(input?: {
  primary?: string;
  detailed?: string;
  financialInstitution?: boolean;
}): string {
  return JSON.stringify({
    category: ["Transfer", "Credit"],
    personal_finance_category: {
      primary: input?.primary ?? "TRANSFER_IN",
      detailed: input?.detailed ?? "TRANSFER_IN_ACCOUNT_TRANSFER",
    },
    counterparties: input?.financialInstitution
      ? [{ name: "Example Bank", type: "financial_institution" }]
      : [],
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("finance automation rules", () => {
  it("reads the canonical vault-relative note with one markdown extension", () => {
    const vaultRoot = createVault();
    const notePath = path.join(vaultRoot, ...FINANCE_CATEGORIZATION_RULES_PATH.split("/"));
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, "# Rules\n\n- Example rule", "utf8");

    expect(readFinanceCategorizationRules({ vaultRoot })).toEqual({
      relativePath: "References/Finance/Lunch Money Rules.md",
      content: "# Rules\n\n- Example rule",
    });
    expect(fs.existsSync(`${notePath}.md`)).toBe(false);
  });

  it("fails closed when the rules note is missing", () => {
    const vaultRoot = createVault();

    expect(() => readFinanceCategorizationRules({ vaultRoot })).toThrow(
      "Finance automation blocked: unable to read required rules note 'References/Finance/Lunch Money Rules.md' (ENOENT).",
    );
  });

  it("fails closed when the rules note is unreadable", () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });

    expect(() => readFinanceCategorizationRules({
      vaultRoot: createVault(),
      readFile: () => { throw denied; },
    })).toThrow(
      "Finance automation blocked: unable to read required rules note 'References/Finance/Lunch Money Rules.md' (EACCES).",
    );
  });
});

describe("budget-neutral internal transfer detection", () => {
  it("classifies BANK and equivalent named account transfers", () => {
    const candidates = [
      {
        id: "bank-in",
        payee: "Requested transfer from BANK BANK Spending account XXXXXX0000",
        amount: "-80.00",
        plaid_metadata: plaidMetadata({ financialInstitution: true }),
      },
      {
        id: "generic-out",
        payee: "Internet transfer to Savings account XXXXXX1111",
        amount: "80.00",
        plaid_metadata: plaidMetadata({
          primary: "TRANSFER_OUT",
          detailed: "TRANSFER_OUT_SAVINGS",
        }),
      },
    ];

    expect(findBudgetNeutralInternalTransfers(candidates).map((transaction) => transaction.id))
      .toEqual(["bank-in", "generic-out"]);
  });

  it("does not treat merchant payments or non-transfer activity as internal transfers", () => {
    expect(isBudgetNeutralInternalTransfer({
      payee: "Venmo payment",
      plaid_metadata: plaidMetadata(),
    })).toBe(false);
    expect(isBudgetNeutralInternalTransfer({
      payee: "BANK BANK interest payment",
      plaid_metadata: JSON.stringify({
        personal_finance_category: {
          primary: "INCOME",
          detailed: "INCOME_INTEREST_EARNED",
        },
      }),
    })).toBe(false);
  });
});
