/**
 * Walmart History Parser — Parses Walmart receipt markdown files to analyze
 * purchase patterns and generate restock recommendations.
 *
 * Receipts location: TANGO_WALMART_RECEIPTS_DIR or profile data receipts/walmart/
 *
 * Supported formats:
 *   Table: | Item | Qty | Price |
 *   List:  - Item × Qty — $Price
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfiguredOrDefaultReceiptDir, resolveWalmartReceiptDir } from "./receipt-paths.js";

export function resolveWalmartReceiptsPath(): string {
  return resolveConfiguredOrDefaultReceiptDir(
    "TANGO_WALMART_RECEIPTS_DIR",
    () => resolveWalmartReceiptDir(),
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PurchaseRecord {
  itemName: string;
  normalizedName: string;
  quantity: number;
  price: number;
  date: string;
  receiptFile: string;
}

export interface ItemStats {
  normalizedName: string;
  displayName: string;
  purchaseCount: number;
  totalQuantity: number;
  averagePrice: number;
  totalSpend: number;
  firstPurchase: string;
  lastPurchase: string;
  averageIntervalDays: number;
  nextExpectedDate?: string;
  daysUntilNext?: number;
  isStaple: boolean; // bought 3+ times
}

export interface RestockRecommendation {
  item: ItemStats;
  urgency: "overdue" | "soon" | "upcoming" | "stocked";
  daysOverdue?: number;
  daysUntilNeeded?: number;
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    // Remove brand prefixes
    .replace(/great value/gi, "gv")
    // Remove size/weight qualifiers
    .replace(/\b\d+\s*(?:oz|lb|g|kg|ml|l|fl oz|ct|pk|pack|count)\b/gi, "")
    // Remove common adjectives that don't change the item identity
    .replace(/\b(?:organic|fresh|frozen|large|small|medium|extra)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Date extraction from filenames
// ---------------------------------------------------------------------------

function parseDateFromFilename(filename: string): string | null {
  // Handles: "2025-03-15.md", "walmart-2025-03-15.md", "2025-03.md" (monthly)
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? (match[1] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Line parsers
// ---------------------------------------------------------------------------

interface ParsedItem {
  name: string;
  qty: number;
  price: number;
}

function parseTableLine(line: string): ParsedItem | null {
  // Format: | Item Name | 2 | $3.49 |
  const parts = line
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;

  const name = parts[0] ?? "";
  const qty = parseFloat(parts[1] ?? "") || 1;
  const priceStr = (parts[2] ?? "").replace(/[$,]/g, "");
  const price = parseFloat(priceStr);

  if (!name || isNaN(price) || price <= 0) return null;
  return { name, qty, price };
}

function parseListLine(line: string): ParsedItem | null {
  if (/^[-*]\s+\*\*[^*]+:\*\*/u.test(line)) {
    return null;
  }

  // Format: - Item × Qty — $Price  OR  - Item $Price
  const match = line.match(
    /^[-*]\s+(.+?)(?:\s+[×x]\s*(\d+(?:\.\d+)?))?(?:\s+[—\-]\s*\$?([\d.]+)|\s+\$?([\d.]+))$/,
  );
  if (!match) return null;

  const name = (match[1] ?? "").trim();
  const qty = parseFloat(match[2] ?? "1");
  const price = parseFloat(match[3] ?? match[4] ?? "0");

  if (!name || price <= 0) return null;
  return { name, qty, price };
}

function splitTopLevelCommaSeparated(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of text) {
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    parts.push(tail);
  }
  return parts;
}

function extractQuantityFromSummaryDetails(detailText: string): number {
  const explicitCountMatch = detailText.match(/(?:^|[^\d])(?:×|x)\s*(\d+(?:\.\d+)?)/iu);
  if (explicitCountMatch?.[1]) {
    return parseFloat(explicitCountMatch[1]);
  }

  const packCountMatch = detailText.match(/\b(\d+(?:\.\d+)?)\s+(?:family\s+packs?|packs?|boxes?|cans?|gallons?|tubs?|ct|count)\b/iu);
  if (packCountMatch?.[1]) {
    return parseFloat(packCountMatch[1]);
  }

  return 1;
}

function extractPriceFromSummaryDetails(detailText: string): number {
  const match = detailText.match(/\$([\d.]+)\s+total/iu);
  return match?.[1] ? parseFloat(match[1]) : 0;
}

function parseSummarySegment(segment: string): ParsedItem | null {
  const trimmed = segment.trim().replace(/\.+$/u, "");
  if (!trimmed) {
    return null;
  }

  const detailMatch = trimmed.match(/^(.*?)\s*\((.+)\)$/u);
  if (!detailMatch) {
    return {
      name: trimmed,
      qty: 1,
      price: 0,
    };
  }

  const name = detailMatch[1]?.trim() ?? "";
  const details = detailMatch[2]?.trim() ?? "";
  if (!name) {
    return null;
  }

  return {
    name,
    qty: extractQuantityFromSummaryDetails(details),
    price: extractPriceFromSummaryDetails(details),
  };
}

function parseSummaryLine(line: string): ParsedItem[] {
  const summaryMatch = line.match(/including:\s*(.+)$/iu);
  if (!summaryMatch?.[1]) {
    return [];
  }

  return splitTopLevelCommaSeparated(summaryMatch[1])
    .map(parseSummarySegment)
    .filter((item): item is ParsedItem => item !== null);
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

export function parseReceipts(daysBack = 365): PurchaseRecord[] {
  const receiptsPath = resolveWalmartReceiptsPath();
  if (!fs.existsSync(receiptsPath)) {
    return [];
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  const records: PurchaseRecord[] = [];

  const files = fs
    .readdirSync(receiptsPath)
    .filter((f) => f.endsWith(".md"))
    .sort(); // Chronological order

  for (const file of files) {
    const date = parseDateFromFilename(file);
    if (!date) continue;
    if (new Date(date) < cutoffDate) continue;

    let content: string;
    try {
      content = fs.readFileSync(path.join(receiptsPath, file), "utf-8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;

      let parsed: ParsedItem | null = null;
      let parsedItems: ParsedItem[] = [];

      if (/including:/iu.test(trimmed)) {
        parsedItems = parseSummaryLine(trimmed);
      } else if (trimmed.startsWith("|") && !trimmed.includes("---")) {
        parsed = parseTableLine(trimmed);
      } else if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
        parsed = parseListLine(trimmed);
      }

      if (parsedItems.length > 0) {
        for (const item of parsedItems) {
          records.push({
            itemName: item.name,
            normalizedName: normalizeName(item.name),
            quantity: item.qty,
            price: item.price,
            date,
            receiptFile: file,
          });
        }
        continue;
      }

      if (parsed) {
        records.push({
          itemName: parsed.name,
          normalizedName: normalizeName(parsed.name),
          quantity: parsed.qty,
          price: parsed.price,
          date,
          receiptFile: file,
        });
      }
    }
  }

  return records;
}

function scoreHistoryItemMatch(query: string, item: ItemStats): number {
  const normalizedQuery = normalizeName(query);
  const normalizedItem = item.normalizedName;
  if (!normalizedQuery || !normalizedItem) {
    return 0;
  }

  const queryTokens = normalizedQuery.split(/\s+/u).filter((token) =>
    token.length > 2 && !["usual", "regular", "default", "favorite", "favourite"].includes(token),
  );
  const itemTokens = new Set(normalizedItem.split(/\s+/u));

  let score = 0;
  if (normalizedItem.includes(normalizedQuery) || normalizedQuery.includes(normalizedItem)) {
    score += 25;
  }

  for (const token of queryTokens) {
    if (itemTokens.has(token)) {
      score += 6;
    }
  }

  if (/\bgreek\b/u.test(normalizedQuery) && /\bgreek\b/u.test(normalizedItem)) {
    score += 4;
  }
  if (/\bvanilla\b/u.test(normalizedQuery) && /\bvanilla\b/u.test(normalizedItem)) {
    score += 4;
  }
  if (/\byogurt\b/u.test(normalizedQuery) && /\byogurt\b/u.test(normalizedItem)) {
    score += 4;
  }

  if (item.isStaple) {
    score += 2;
  }

  return score;
}

export function findLikelyHistoryMatches(
  stats: readonly ItemStats[],
  query: string,
  limit = 5,
): ItemStats[] {
  return [...stats]
    .map((item) => ({ item, score: scoreHistoryItemMatch(query, item) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.item.purchaseCount !== left.item.purchaseCount) {
        return right.item.purchaseCount - left.item.purchaseCount;
      }
      return right.item.lastPurchase.localeCompare(left.item.lastPurchase);
    })
    .slice(0, Math.max(limit, 1))
    .map((candidate) => candidate.item);
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function analyzeHistory(records: PurchaseRecord[]): ItemStats[] {
  // Group by normalized name
  const grouped: Record<string, PurchaseRecord[]> = {};
  for (const r of records) {
    (grouped[r.normalizedName] ??= []).push(r);
  }

  const stats: ItemStats[] = [];

  for (const [normalizedName, purchases] of Object.entries(grouped)) {
    const sorted = [...purchases].sort((a, b) => a.date.localeCompare(b.date));
    // Use most recent name as the display name
    const lastItem = sorted[sorted.length - 1]!;
    const firstItem = sorted[0]!;
    const displayName = lastItem.itemName;

    const totalQuantity = purchases.reduce((s, p) => s + p.quantity, 0);
    const totalSpend = purchases.reduce((s, p) => s + p.price, 0);
    const avgPrice = totalSpend / purchases.length;

    // Calculate average interval between purchases
    let avgIntervalDays = 0;
    if (sorted.length > 1) {
      const intervals: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const curr = sorted[i]!;
        const prev = sorted[i - 1]!;
        const ms = new Date(curr.date).getTime() - new Date(prev.date).getTime();
        intervals.push(ms / (1000 * 60 * 60 * 24));
      }
      avgIntervalDays = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    }

    const lastPurchase = lastItem.date;
    let nextExpectedDate: string | undefined;
    let daysUntilNext: number | undefined;

    if (avgIntervalDays > 0) {
      const nextDate = new Date(lastPurchase);
      nextDate.setDate(nextDate.getDate() + Math.round(avgIntervalDays));
      nextExpectedDate = nextDate.toISOString().split("T")[0];
      daysUntilNext = Math.round((nextDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    }

    stats.push({
      normalizedName,
      displayName,
      purchaseCount: purchases.length,
      totalQuantity,
      averagePrice: Math.round(avgPrice * 100) / 100,
      totalSpend: Math.round(totalSpend * 100) / 100,
      firstPurchase: firstItem.date,
      lastPurchase,
      averageIntervalDays: Math.round(avgIntervalDays),
      nextExpectedDate,
      daysUntilNext,
      isStaple: purchases.length >= 3,
    });
  }

  return stats.sort((a, b) => b.purchaseCount - a.purchaseCount);
}

export function getRestockRecommendations(stats: ItemStats[]): RestockRecommendation[] {
  // Only staple items with known purchase intervals
  const staples = stats.filter(
    (s) => s.isStaple && s.averageIntervalDays > 0 && s.daysUntilNext !== undefined,
  );

  return staples
    .map((item): RestockRecommendation => {
      const days = item.daysUntilNext!;
      let urgency: RestockRecommendation["urgency"];

      if (days < 0) urgency = "overdue";
      else if (days <= 7) urgency = "soon";
      else if (days <= 14) urgency = "upcoming";
      else urgency = "stocked";

      return {
        item,
        urgency,
        daysOverdue: days < 0 ? Math.abs(days) : undefined,
        daysUntilNeeded: days >= 0 ? days : undefined,
      };
    })
    .filter((r) => r.urgency !== "stocked")
    .sort((a, b) => (a.item.daysUntilNext ?? 0) - (b.item.daysUntilNext ?? 0));
}
