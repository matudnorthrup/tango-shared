import fs from "node:fs";
import path from "node:path";

// Receipt notes suggest a Lunch Money category per non-grocery item, and the owner books
// transactions from those suggestions. A suggestion that isn't a real category ("One-off
// Expenses", "Needs review — likely Auto Repair") can't be booked as written, so the cataloger is
// given the live category list and recent notes are checked against it.

export interface LunchMoneyCategoryRecord {
  name?: string | null;
  is_group?: boolean | null;
  archived?: boolean | null;
  is_income?: boolean | null;
  exclude_from_budget?: boolean | null;
}

/** Bookable spending categories: leaf, not archived, not income. Sorted by name. */
export function parseLunchMoneyCategoryNames(payload: unknown): string[] {
  const categories = (payload as { categories?: LunchMoneyCategoryRecord[] } | null)?.categories;
  if (!Array.isArray(categories)) throw new Error("Lunch Money categories response has no categories");
  const names = categories
    .filter((category) => !category.is_group && !category.archived && !category.is_income)
    .map((category) => (category.name ?? "").trim())
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export async function fetchLunchMoneyCategoryNames(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<string[]> {
  // Bounded well inside the 30 s pre-check deadline: a stalled lookup is skipped, not fatal.
  const response = await fetchImpl("https://dev.lunchmoney.app/v1/categories", {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Lunch Money categories failed: HTTP ${response.status}: ${text.slice(0, 200)}`);
  return parseLunchMoneyCategoryNames(JSON.parse(text));
}

/** The categories block for the task; with no live list, a fallback the worker can follow. */
export function formatValidCategories(names: string[]): string {
  if (names.length) return names.map((name) => `- ${name}`).join("\n");
  return "(The live list is unavailable this run. Use only a category name that appears verbatim in the categorization rules above, copied exactly, and never invent one. The next run's check repairs any suggestion that isn't a live category.)";
}

/**
 * The "Suggested Category" cells of every table in a note that has that column. Notes put it under
 * different headings ("## Non-Grocery Items", "## Items", "## Grocery Items"), so the column
 * decides, not the heading.
 */
export function suggestedCategoriesInNote(text: string): string[] {
  // Cells split on unescaped pipes only: an item name may contain "\\|".
  const cellsOf = (line: string) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  const found: string[] = [];
  const lines = text.split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    if (!lines[start]!.trim().startsWith("|")) continue;
    let end = start;
    while (end < lines.length && lines[end]!.trim().startsWith("|")) end += 1;
    const table = lines.slice(start, end);
    start = end;
    if (table.length < 3) continue;
    const header = cellsOf(table[0]!).map((cell) => cell.toLowerCase());
    const column = header.indexOf("suggested category");
    if (column === -1) continue;
    for (const cells of table.slice(2).map(cellsOf)) {
      if (cells.length !== header.length || !cells[0] || /^none\.?$/i.test(cells[0])) continue;
      if (cells[column]) found.push(cells[column]!);
    }
  }
  return found;
}

export interface InvalidCategoryNote {
  /** Relative to the receipts root. */
  notePath: string;
  invalid: string[];
}

function walkNotes(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkNotes(full);
    return entry.isFile() && entry.name.endsWith(".md") ? [full] : [];
  });
}

/** Receipt notes dated within [since, until] whose suggested categories aren't bookable categories. */
export function findInvalidSuggestedCategories(input: {
  receiptsRoot: string;
  validNames: string[];
  since: string;
  until: string;
}): InvalidCategoryNote[] {
  const valid = new Set(input.validNames);
  const found: InvalidCategoryNote[] = [];
  for (const file of walkNotes(input.receiptsRoot)) {
    const text = fs.readFileSync(file, "utf8");
    const date = /^date:\s*"?(\d{4}-\d{2}-\d{2})/m.exec(text)?.[1];
    if (!date || date < input.since || date > input.until) continue;
    const invalid = [...new Set(suggestedCategoriesInNote(text).filter((name) => !valid.has(name)))];
    if (invalid.length) found.push({ notePath: path.relative(input.receiptsRoot, file), invalid });
  }
  return found.sort((a, b) => a.notePath.localeCompare(b.notePath));
}

export function formatInvalidCategoryDetails(notes: InvalidCategoryNote[]): string {
  if (notes.length === 0) return "(none)";
  return notes.map((note) => `- ${note.notePath} | not a Lunch Money category: ${note.invalid.map((name) => `"${name}"`).join(", ")}`).join("\n");
}
