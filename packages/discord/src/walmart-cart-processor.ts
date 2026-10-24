/**
 * Walmart Cart Queue & Preferences — Manages the shopping queue and product
 * preference tracking. Pure data CRUD, no browser automation.
 *
 * Browser interaction is handled by the universal `browser` tool — agents
 * navigate Walmart.com, search, and add items to cart themselves.
 */

import * as fs from "fs";
import * as path from "path";
import { resolveConfiguredPath, resolveLegacyDataDir, resolveTangoDataDir } from "@tango/core";

export function resolveWalmartDataDir(): string {
  const configured = process.env.TANGO_WALMART_DATA_DIR?.trim();
  if (configured && configured.length > 0) {
    return resolveConfiguredPath(configured);
  }
  if (process.env.TANGO_DATA_DIR?.trim()) {
    return resolveTangoDataDir(process.env.TANGO_DATA_DIR);
  }
  const legacyDir = resolveLegacyDataDir();
  if (fs.existsSync(legacyDir)) {
    return legacyDir;
  }
  return resolveTangoDataDir(process.env.TANGO_DATA_DIR);
}

function queuePath(): string {
  return path.join(resolveWalmartDataDir(), "walmart-queue.json");
}

function prefsPath(): string {
  return path.join(resolveWalmartDataDir(), "walmart-preferences.json");
}

function ensureDataDir(): void {
  fs.mkdirSync(resolveWalmartDataDir(), { recursive: true });
}

export interface CartQueueItem {
  query: string;
  addedAt: string;
  status: "pending" | "added" | "needs_selection" | "error";
  note?: string;
}

export interface CartPreference {
  query: string;
  selectedItemName: string;
  selectedItemId: string;
  timesSelected: number;
  lastSelected: string;
}

export interface CartQueueData {
  items: CartQueueItem[];
}

export interface PreferencesData {
  preferences: CartPreference[];
}

export interface PreferenceSummary {
  total: number;
  preferences: Array<{
    query: string;
    selected_item: string;
    item_id: string;
    times_selected: number;
    last_selected: string;
    auto_add_eligible: boolean;
  }>;
}

// --- Queue management ---

export function loadQueue(): CartQueueData {
  const filePath = queuePath();
  if (!fs.existsSync(filePath)) return { items: [] };
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return { items: [] };
  }
}

export function saveQueue(data: CartQueueData): void {
  ensureDataDir();
  fs.writeFileSync(queuePath(), JSON.stringify(data, null, 2));
}

export function loadPreferences(): PreferencesData {
  const filePath = prefsPath();
  if (!fs.existsSync(filePath)) return { preferences: [] };
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return { preferences: [] };
  }
}

export function savePreferences(data: PreferencesData): void {
  ensureDataDir();
  fs.writeFileSync(prefsPath(), JSON.stringify(data, null, 2));
}

export function summarizePreferences(data: PreferencesData = loadPreferences()): PreferenceSummary {
  return {
    total: data.preferences.length,
    preferences: data.preferences.map((p) => ({
      query: p.query,
      selected_item: p.selectedItemName,
      item_id: p.selectedItemId,
      times_selected: p.timesSelected,
      last_selected: p.lastSelected,
      auto_add_eligible: p.timesSelected >= 3,
    })),
  };
}

export function addToQueue(query: string, note?: string): CartQueueItem {
  const queue = loadQueue();
  const item: CartQueueItem = {
    query,
    addedAt: new Date().toISOString(),
    status: "pending",
    note,
  };
  queue.items.push(item);
  saveQueue(queue);
  return item;
}

export function listQueue(): CartQueueItem[] {
  return loadQueue().items;
}

export function clearQueue(): void {
  saveQueue({ items: [] });
}

export function removeFromQueue(index: number): CartQueueItem | null {
  const queue = loadQueue();
  if (index < 0 || index >= queue.items.length) return null;
  const [removed] = queue.items.splice(index, 1);
  saveQueue(queue);
  return removed ?? null;
}

export function recordPreference(
  query: string,
  itemName: string,
  itemId: string,
): void {
  const data = loadPreferences();
  const existing = data.preferences.find(
    (p) =>
      p.query.toLowerCase() === query.toLowerCase() &&
      p.selectedItemId === itemId,
  );
  if (existing) {
    existing.timesSelected++;
    existing.lastSelected = new Date().toISOString();
  } else {
    data.preferences.push({
      query,
      selectedItemName: itemName,
      selectedItemId: itemId,
      timesSelected: 1,
      lastSelected: new Date().toISOString(),
    });
  }
  savePreferences(data);
}
