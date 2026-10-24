import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchLunchMoneyCategoryNames,
  formatValidCategories,
  findInvalidSuggestedCategories,
  formatInvalidCategoryDetails,
  parseLunchMoneyCategoryNames,
  suggestedCategoriesInNote,
} from "../src/receipt-categories.js";

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const categories = {
  categories: [
    { name: "Essentials", is_group: true },
    { name: "Groceries" },
    { name: "Auto Repair" },
    { name: "Home Improvement" },
    { name: "Old Bucket", archived: true },
    { name: "Salary", is_income: true },
  ],
};

function note(date: string, rows: string[]): string {
  return [
    "---",
    `date: ${date}`,
    "---",
    "",
    "## Non-Grocery Items",
    "",
    "| Item | Qty | Price | Suggested Category |",
    "|------|-----|-------|--------------------|",
    ...rows,
    "",
    "## Grocery Items (Summary)",
    "",
    "None.",
  ].join("\n");
}

describe("receipt categories", () => {
  it("keeps bookable leaf categories only", () => {
    expect(parseLunchMoneyCategoryNames(categories)).toEqual(["Auto Repair", "Groceries", "Home Improvement"]);
    expect(() => parseLunchMoneyCategoryNames({})).toThrow("no categories");
  });

  it("fetches categories from Lunch Money", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(categories))) as unknown as typeof fetch;
    await expect(fetchLunchMoneyCategoryNames("key", fetchImpl)).resolves.toEqual(["Auto Repair", "Groceries", "Home Improvement"]);
    const failing = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchLunchMoneyCategoryNames("key", failing)).rejects.toThrow("HTTP 401");
  });

  it("aborts a stalled category lookup", async () => {
    const stalled = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(fetchLunchMoneyCategoryNames("key", stalled, 20)).rejects.toBeDefined();
  });

  it("gives the worker a usable fallback when the list is unavailable", () => {
    expect(formatValidCategories(["Groceries", "Health"])).toBe("- Groceries\n- Health");
    expect(formatValidCategories([])).toContain("never invent one");
  });

  it("reads the suggested categories of the non-grocery table", () => {
    expect(suggestedCategoriesInNote(note("2026-10-10", ["| Oil filter | 1 | $9.99 | Auto Repair |", "| Tripod | 1 | $45.44 | One-off Expenses |"]))).toEqual(["Auto Repair", "One-off Expenses"]);
    expect(suggestedCategoriesInNote(note("2026-10-10", ["| None | | | |"]))).toEqual([]);
    expect(suggestedCategoriesInNote("no table here")).toEqual([]);
    // Any table with the column counts, whatever its heading.
    const itemsHeading = ["## Items", "", "| Item | Qty | Price | Suggested Category |", "|---|---|---|---|", "| Prime Video | 1 | $4.99 | Family Spending (rule: Prime) |", "", "## Grocery Items", "", "| Item | Qty | Price | Suggested Category |", "|---|---|---|---|", "| Drink mix | 1 | $4.97 | Groceries (drink mix) |", "", "## Notes", "", "| a | b |", "|---|---|", "| x | y |"].join("\n");
    expect(suggestedCategoriesInNote(itemsHeading)).toEqual(["Family Spending (rule: Prime)", "Groceries (drink mix)"]);
    // An escaped pipe in an item name is part of the cell, not a separator.
    expect(suggestedCategoriesInNote(note("2026-10-10", ["| Cable 6ft \\| 2-pack | 1 | $9.99 | One-off Expenses |"]))).toEqual(["One-off Expenses"]);
  });

  it("finds recent notes whose suggestions aren't real categories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-categories-"));
    cleanupDirs.push(root);
    fs.mkdirSync(path.join(root, "Amazon"));
    fs.writeFileSync(path.join(root, "Amazon", "good.md"), note("2026-10-10", ["| Oil filter | 1 | $9.99 | Auto Repair |"]));
    fs.writeFileSync(path.join(root, "Amazon", "bad.md"), note("2026-10-11", ["| Tripod | 1 | $45.44 | One-off Expenses |", "| Bulbs | 1 | $5.00 | Needs review — likely Home Improvement |"]));
    fs.writeFileSync(path.join(root, "Amazon", "old.md"), note("2026-01-01", ["| Thing | 1 | $1.00 | Work / Tech Gear |"]));
    const found = findInvalidSuggestedCategories({
      receiptsRoot: root,
      validNames: parseLunchMoneyCategoryNames(categories),
      since: "2026-10-01",
      until: "2026-10-15",
    });
    expect(found).toEqual([{ notePath: path.join("Amazon", "bad.md"), invalid: ["One-off Expenses", "Needs review — likely Home Improvement"] }]);
    expect(formatInvalidCategoryDetails(found)).toContain('not a Lunch Money category: "One-off Expenses"');
    expect(formatInvalidCategoryDetails([])).toBe("(none)");
  });
});
