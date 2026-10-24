/**
 * Wellness Wellness DB Tools -- structured MCP access to the configured wellness db.
 *
 * Workers call these tools instead of raw SQL. Database path comes from
 * WELLNESS_DB_PATH (falls back to the default profile wellness db).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  readProfileConfigStringList,
  resolveConfiguredPath,
  resolveTangoProfileDir,
  type AgentTool,
} from "@tango/core";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEALS = new Set(["breakfast", "lunch", "dinner", "snack", "supplement"]);
const ACTIVITY_TYPES = new Set([
  "walk",
  "weights",
  "yoga",
  "stretching",
  "rebounder",
  "meditation",
  "journaling",
  "other",
]);
const SUPPLEMENT_BATCH_CONFIG_PATH = "wellness/supplement-batches.txt";
const READ_ONLY_WELLNESSDB_TOOLS = new Set([
  "wellnessdb_search_product",
  "wellnessdb_search_supplement",
  "wellnessdb_search_recipe",
  "wellnessdb_get_recipe_detail",
  "wellnessdb_day_summary",
  "wellnessdb_day_range",
  "wellnessdb_recent_meals",
  "wellnessdb_active_supplements",
  "wellnessdb_active_products",
]);

export interface WellnessDbToolOptions {
  dbPath?: string;
  supplementBatchShortcuts?: Record<string, string[]>;
}

interface ProductRow {
  id: number;
  name: string;
  shorthand: string | null;
  brand: string | null;
  category: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  grams_per_serving: number | null;
  serving_size: string | null;
  serving_unit: string | null;
  discontinued_date: string | null;
}

interface SupplementRow {
  id: number;
  name: string;
  shorthand: string | null;
  brand: string | null;
  dosage: string | null;
  timing: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  stopped_date: string | null;
}

interface RecipeSummaryRow {
  id: number;
  name: string;
  shorthand: string | null;
  servings: number | null;
  /** v9: saved portion multiplier (×1.0 = the stored base recipe). */
  portion: number;
  per_serving_cal: number | null;
  per_serving_prot: number | null;
  per_serving_carb: number | null;
  per_serving_fat: number | null;
  total_calories: number | null;
  total_protein_g: number | null;
  total_carbs_g: number | null;
  total_fat_g: number | null;
  total_fiber_g: number | null;
  yield_g: number | null;
  batch_units: number | null;
  scale_step_label: string | null;
  unit_label: string | null;
  archived_at: string | null;
  instructions: string | null;
  notes: string | null;
}

function defaultWellnessDbPath(): string {
  return path.join(resolveTangoProfileDir(), "wellness", "wellness.db");
}

export function resolveWellnessDbPath(override?: string): string {
  // JULES_WELLNESS_DB_PATH is the canonical env var; WELLNESS_DB_PATH is
  // honored as a fallback so existing .env files and cod-e's config keep
  // working across the wellness→Jules transition.
  const configured = override?.trim()
    || process.env.JULES_WELLNESS_DB_PATH?.trim()
    || process.env.WELLNESS_DB_PATH?.trim();
  if (configured) {
    return resolveConfiguredPath(configured);
  }
  return defaultWellnessDbPath();
}

function assertDate(date: string, field = "date"): string {
  const normalized = String(date).trim();
  if (!DATE_RE.test(normalized)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  return normalized;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function openDb(dbPath: string, readOnly: boolean): DatabaseSync {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Wellness database not found: ${resolved.replace(os.homedir(), "~")}`);
  }
  return new DatabaseSync(resolved, { readOnly });
}

function normalizeSearchTerm(value: string): string {
  return value.trim().toLowerCase();
}

function shorthandMatchSql(column: string): string {
  return `(',' || TRIM(REPLACE(${column}, ', ', ',')) || ',') LIKE ? COLLATE NOCASE`;
}

function shorthandLikePattern(term: string): string {
  return `%,${term},%`;
}

function queryAll<T>(db: DatabaseSync, sql: string, params: Array<string | number | null> = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function queryOne<T>(db: DatabaseSync, sql: string, params: Array<string | number | null> = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

function findProduct(db: DatabaseSync, query: string, activeOnly = false): ProductRow | undefined {
  const term = normalizeSearchTerm(query);
  const activeClause = activeOnly ? " AND discontinued_date IS NULL" : "";
  const byShorthand = queryOne<ProductRow>(
    db,
    `SELECT id, name, shorthand, brand, category, calories, protein_g, carbs_g, fat_g,
            fiber_g, grams_per_serving, serving_size, serving_unit, discontinued_date
     FROM products
     WHERE ${shorthandMatchSql("shorthand")}${activeClause}
     LIMIT 1`,
    [shorthandLikePattern(term)],
  );
  if (byShorthand) return byShorthand;

  return queryOne<ProductRow>(
    db,
    `SELECT id, name, shorthand, brand, category, calories, protein_g, carbs_g, fat_g,
            fiber_g, grams_per_serving, serving_size, serving_unit, discontinued_date
     FROM products
     WHERE lower(name) LIKE ?${activeClause}
     LIMIT 1`,
    [`%${term}%`],
  );
}

function searchProducts(db: DatabaseSync, query: string, activeOnly = false): ProductRow[] {
  const term = normalizeSearchTerm(query);
  const activeClause = activeOnly ? " AND discontinued_date IS NULL" : "";
  return queryAll<ProductRow>(
    db,
    `SELECT id, name, shorthand, brand, category, calories, protein_g, carbs_g, fat_g,
            fiber_g, grams_per_serving, serving_size, serving_unit, discontinued_date
     FROM products
     WHERE (${shorthandMatchSql("shorthand")} OR lower(name) LIKE ?)${activeClause}
     ORDER BY name
     LIMIT 25`,
    [shorthandLikePattern(term), `%${term}%`],
  );
}

function findSupplement(db: DatabaseSync, query: string, activeOnly = false): SupplementRow | undefined {
  const term = normalizeSearchTerm(query);
  const activeClause = activeOnly ? " AND stopped_date IS NULL" : "";
  const byShorthand = queryOne<SupplementRow>(
    db,
    `SELECT id, name, shorthand, brand, dosage, timing, calories, protein_g, carbs_g, fat_g, stopped_date
     FROM supplements
     WHERE ${shorthandMatchSql("shorthand")}${activeClause}
     LIMIT 1`,
    [shorthandLikePattern(term)],
  );
  if (byShorthand) return byShorthand;

  return queryOne<SupplementRow>(
    db,
    `SELECT id, name, shorthand, brand, dosage, timing, calories, protein_g, carbs_g, fat_g, stopped_date
     FROM supplements
     WHERE lower(name) LIKE ?${activeClause}
     LIMIT 1`,
    [`%${term}%`],
  );
}

function searchSupplements(db: DatabaseSync, query: string, activeOnly = false): SupplementRow[] {
  const term = normalizeSearchTerm(query);
  const activeClause = activeOnly ? " AND stopped_date IS NULL" : "";
  return queryAll<SupplementRow>(
    db,
    `SELECT id, name, shorthand, brand, dosage, timing, calories, protein_g, carbs_g, fat_g, stopped_date
     FROM supplements
     WHERE (${shorthandMatchSql("shorthand")} OR lower(name) LIKE ?)${activeClause}
     ORDER BY name
     LIMIT 25`,
    [shorthandLikePattern(term), `%${term}%`],
  );
}

const RECIPE_SUMMARY_SELECT = `SELECT rs.*, r.yield_g, r.batch_units, r.scale_step_label, r.scale_step_label AS unit_label, r.archived_at, (r.pinned_at IS NOT NULL) AS pinned,
  CASE WHEN r.yield_g > 0 THEN ROUND(r.total_calories * 100.0 / r.yield_g) END AS per_100g_cal,
  CASE WHEN r.yield_g > 0 THEN ROUND(r.total_protein_g * 100.0 / r.yield_g, 1) END AS per_100g_prot,
  CASE WHEN r.yield_g > 0 THEN ROUND(r.total_carbs_g * 100.0 / r.yield_g, 1) END AS per_100g_carb,
  CASE WHEN r.yield_g > 0 THEN ROUND(r.total_fat_g * 100.0 / r.yield_g, 1) END AS per_100g_fat,
  CASE WHEN r.yield_g > 0 THEN ROUND(r.total_fiber_g * 100.0 / r.yield_g, 1) END AS per_100g_fiber
  FROM recipe_summary rs JOIN recipes r ON r.id = rs.id`;

function findRecipeSummary(db: DatabaseSync, query: string): RecipeSummaryRow | undefined {
  const term = normalizeSearchTerm(query);
  if (/^\d+$/u.test(term)) {
    return queryOne<RecipeSummaryRow>(db, `${RECIPE_SUMMARY_SELECT} WHERE rs.id = ?`, [Number(term)]);
  }
  return queryOne<RecipeSummaryRow>(db, `${RECIPE_SUMMARY_SELECT}
    WHERE lower(rs.shorthand) = ? OR lower(rs.name) LIKE ?
      OR EXISTS (SELECT 1 FROM recipe_aliases ra WHERE ra.recipe_id = rs.id AND lower(ra.alias) = ?)
    ORDER BY (lower(rs.shorthand) = ?) DESC,
      EXISTS (SELECT 1 FROM recipe_aliases ra WHERE ra.recipe_id = rs.id AND lower(ra.alias) = ?) DESC,
      (lower(rs.name) = ?) DESC, rs.id LIMIT 1`,
    [term, `%${term}%`, term, term, term, term]);
}

function searchRecipes(db: DatabaseSync, query: string, includeArchived = false): RecipeSummaryRow[] {
  const term = `%${normalizeSearchTerm(query)}%`;
  return queryAll<RecipeSummaryRow>(db, `${RECIPE_SUMMARY_SELECT}
    WHERE (? OR r.archived_at IS NULL) AND (lower(rs.shorthand) LIKE ? OR lower(rs.name) LIKE ?
      OR EXISTS (SELECT 1 FROM recipe_aliases ra WHERE ra.recipe_id = rs.id AND lower(ra.alias) LIKE ?))
    ORDER BY (r.pinned_at IS NOT NULL) DESC, rs.name LIMIT 25`, [includeArchived ? 1 : 0, term, term, term]);
}

function parseSupplementBatchShortcut(line: string): [string, string[]] | null {
  const match = /^([^:=]+)\s*[:=]\s*(.+)$/u.exec(line);
  if (!match) {
    return null;
  }
  const shortcut = match[1]?.trim().toLowerCase();
  const expanded = match[2]
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0) ?? [];
  return shortcut && expanded.length > 0 ? [shortcut, expanded] : null;
}

function loadSupplementBatchShortcuts(
  overrides: Record<string, string[]> = {},
): Map<string, string[]> {
  const shortcuts = new Map<string, string[]>();
  for (const [shortcut, expanded] of Object.entries(overrides)) {
    if (shortcut.trim() && expanded.length > 0) {
      shortcuts.set(shortcut.trim().toLowerCase(), expanded);
    }
  }
  for (const line of readProfileConfigStringList({
    relativePath: SUPPLEMENT_BATCH_CONFIG_PATH,
    envPathVar: "TANGO_WELLNESS_SUPPLEMENT_BATCHES_FILE",
    envValueVar: "TANGO_WELLNESS_SUPPLEMENT_BATCHES",
  })) {
    const parsed = parseSupplementBatchShortcut(line);
    if (parsed) {
      shortcuts.set(parsed[0], parsed[1]);
    }
  }
  return shortcuts;
}

function expandSupplementQueries(
  input: string | string[],
  batchShortcuts: Map<string, string[]>,
): string[] {
  const rawItems = Array.isArray(input)
    ? input.flatMap((value) => String(value).split(","))
    : String(input).split(",");
  const expanded: string[] = [];
  for (const item of rawItems) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const batch = batchShortcuts.get(trimmed.toLowerCase());
    if (batch) {
      expanded.push(...batch);
      continue;
    }
    expanded.push(trimmed);
  }
  return expanded;
}

function scaleMacro(value: number | null | undefined, servings: number): number {
  return Number(((value ?? 0) * servings).toFixed(1));
}

function scaleIntMacro(value: number | null | undefined, servings: number): number {
  return Math.round((value ?? 0) * servings);
}

/** "200 g" / "200g" / "200 grams" → 200; anything else → null. */
function parseGramQuantity(quantity: string | null | undefined): number | null {
  if (!quantity) return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:g|gram|grams)\s*$/iu.exec(String(quantity));
  if (!match) return null;
  const grams = Number(match[1]);
  return Number.isFinite(grams) && grams > 0 ? grams : null;
}

type RecipeIngredientInput = {
  product?: unknown;
  sub_recipe?: unknown;
  ingredient_name?: unknown;
  quantity?: unknown;
  quantity_g?: unknown;
  servings?: unknown;
  removed?: unknown;
  scale_lock?: unknown;
};

type PreparedRow = {
  productId: number | null;
  subRecipeId: number | null;
  ingredientName: string;
  quantity: string | null;
  quantityG: number | null;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  removed: number;
  scaleLock: string;
};

function prepareRecipeIngredientRow(db: DatabaseSync, recipeId: number, raw: unknown): PreparedRow | { error: string } {
  const ingredient = (raw ?? {}) as RecipeIngredientInput;
  const productQuery = String(ingredient.product ?? "").trim();
  const subRecipeQuery = String(ingredient.sub_recipe ?? "").trim();
  if (!productQuery && !subRecipeQuery) return { error: "Each ingredient requires product or sub_recipe" };
  if (productQuery && subRecipeQuery) return { error: "An ingredient names either product or sub_recipe, not both" };
  const quantity = ingredient.quantity ? String(ingredient.quantity) : null;
  const explicitGrams = Number(ingredient.quantity_g);
  const grams = Number.isFinite(explicitGrams) && explicitGrams > 0 ? explicitGrams : parseGramQuantity(quantity);
  const label = ingredient.ingredient_name ? String(ingredient.ingredient_name) : null;
  const scaleLock = ingredient.scale_lock ?? "none";
  if (!["none", "serving", "batch"].includes(String(scaleLock))) return { error: "scale_lock must be none, serving, or batch" };
  if (ingredient.removed !== undefined && typeof ingredient.removed !== "boolean") return { error: "removed must be boolean" };
  if (ingredient.quantity_g !== undefined && (typeof ingredient.quantity_g !== "number" || !Number.isFinite(ingredient.quantity_g) || ingredient.quantity_g <= 0)) return { error: "quantity_g must be positive" };
  const removed = ingredient.removed === true ? 1 : 0;

  if (subRecipeQuery) {
    const component = findRecipeSummary(db, subRecipeQuery);
    if (!component) return { error: `Ingredient sub_recipe not found: ${subRecipeQuery}` };
    if (component.id === recipeId) return { error: `A recipe cannot contain itself: ${component.name}` };
    if (!(component.yield_g && component.yield_g > 0)) {
      return { error: `Component recipe has no yield_g, so grams cannot be converted: ${component.name}` };
    }
    if (grams === null) {
      return { error: `Component ingredient requires quantity_g (or a gram quantity): ${component.name}` };
    }
    const factor = grams / component.yield_g;
    // Stored row macros are the component's BASE batch totals scaled by
    // grams ÷ yield_g (yield_g is a base-batch figure). recipe_summary's
    // totals are at the component's own saved portion since v9, so read the
    // base rollups from recipes directly, as this path always has.
    const base = queryOne<{
      total_calories: number | null; total_protein_g: number | null; total_carbs_g: number | null;
      total_fat_g: number | null; total_fiber_g: number | null;
    }>(db, `SELECT total_calories, total_protein_g, total_carbs_g, total_fat_g, total_fiber_g
            FROM recipes WHERE id = ?`, [component.id]);
    return {
      productId: null,
      subRecipeId: component.id,
      ingredientName: label ?? component.name,
      quantity: quantity ?? `${grams} g`,
      quantityG: grams,
      calories: scaleIntMacro(base?.total_calories ?? null, factor),
      protein: scaleMacro(base?.total_protein_g ?? null, factor),
      carbs: scaleMacro(base?.total_carbs_g ?? null, factor),
      fat: scaleMacro(base?.total_fat_g ?? null, factor),
      fiber: scaleMacro(base?.total_fiber_g ?? null, factor),
      removed,
      scaleLock: String(scaleLock),
    };
  }

  const product = findProduct(db, productQuery, false);
  if (!product) return { error: `Ingredient product not found: ${productQuery}` };
  const servingsMultiplier = Number(ingredient.servings ?? 1) || 1;
  const gramsPerServing = product.grams_per_serving && product.grams_per_serving > 0 ? product.grams_per_serving : null;
  const factor = grams !== null && gramsPerServing ? grams / gramsPerServing : servingsMultiplier;
  return {
    productId: product.id,
    subRecipeId: null,
    ingredientName: label ?? product.name,
    quantity,
    quantityG: grams,
    calories: scaleIntMacro(product.calories, factor),
    protein: scaleMacro(product.protein_g, factor),
    carbs: scaleMacro(product.carbs_g, factor),
    fat: scaleMacro(product.fat_g, factor),
    fiber: product.fiber_g == null ? null : scaleMacro(product.fiber_g, factor),
    removed,
    scaleLock: String(scaleLock),
  };
}

function insertRecipeIngredientRow(db: DatabaseSync, recipeId: number, row: PreparedRow): number {
  const insert = db.prepare(
    `INSERT INTO recipe_ingredients (recipe_id, product_id, sub_recipe_id, ingredient_name, quantity, quantity_g,
                                     calories, protein_g, carbs_g, fat_g, fiber_g, removed, scale_lock)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return Number(insert.run(
    recipeId,
    row.productId,
    row.subRecipeId,
    row.ingredientName,
    row.quantity,
    row.quantityG,
    row.calories,
    row.protein,
    row.carbs,
    row.fat,
    row.fiber,
    row.removed,
    row.scaleLock,
  ).lastInsertRowid);
}

/**
 * Replace a recipe's ingredient rows. Each item names either a `product` or a
 * component `sub_recipe`. Grams (`quantity_g`, or a gram-style `quantity`
 * string) are the canonical measure: when present they are stored as
 * `quantity_g` and per-row macros are derived from the product's
 * grams-per-serving or the component's batch yield. Without grams a product
 * row falls back to the legacy `servings` multiplier and a component row is
 * rejected, so nested recipes never lose the numbers the logger relies on.
 * `removed: true` (v10) flags a discarded portion — drained whey, poured-off
 * fat — whose macros subtract from the batch; the row's stored macros stay
 * positive and the views apply the sign.
 */
function replaceRecipeIngredientRows(db: DatabaseSync, recipeId: number, ingredients: unknown[]): { error: string } | undefined {
  const prepared: PreparedRow[] = [];
  for (const ingredient of ingredients) {
    const row = prepareRecipeIngredientRow(db, recipeId, ingredient);
    if ("error" in row) return row;
    prepared.push(row);
  }
  db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipeId);
  for (const row of prepared) insertRecipeIngredientRow(db, recipeId, row);
  return undefined;
}

const RECIPE_INGREDIENT_INPUT_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      product: { type: "string", description: "Product shorthand or name (omit when sub_recipe is set)" },
      sub_recipe: { type: "string", description: "Component recipe name/shorthand/alias (needs quantity_g)" },
      ingredient_name: { type: "string", description: "Override ingredient label" },
      quantity: { type: "string", description: "Display quantity, e.g. '200 g' or '1 cup'" },
      quantity_g: { type: "number", description: "Canonical grams; macros derive from grams when set" },
      servings: { type: "number", description: "Legacy multiplier against product macros when grams are unknown" },
      scale_lock: { type: "string", enum: ["none", "serving", "batch"], description: "Default none; serving ignores portion, batch stays fixed per batch" },
      removed: { type: "boolean", description: "true subtracts a discarded portion such as drained whey (never costed, shopped, or logged)" },
    },
  },
} as const;

function refreshRowMacros(db: DatabaseSync, rowId: number): void {
  const derived = queryOne<{ calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null; fiber_g: number | null; quantity_g: number | null; basis: number | null }>(db,
    `
    SELECT ri.quantity_g,
           CASE WHEN ri.product_id IS NOT NULL THEN NULLIF(p.grams_per_serving, 0) ELSE NULLIF(sr.yield_g, 0) END AS basis,
           ROUND(ri.quantity_g * COALESCE(p.calories * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_calories * 1.0 / NULLIF(sr.yield_g, 0))) AS calories,
           ROUND(ri.quantity_g * COALESCE(p.protein_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_protein_g * 1.0 / NULLIF(sr.yield_g, 0)), 1) AS protein_g,
           ROUND(ri.quantity_g * COALESCE(p.carbs_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_carbs_g * 1.0 / NULLIF(sr.yield_g, 0)), 1) AS carbs_g,
           ROUND(ri.quantity_g * COALESCE(p.fat_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_fat_g * 1.0 / NULLIF(sr.yield_g, 0)), 1) AS fat_g,
           ROUND(ri.quantity_g * COALESCE(p.fiber_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_fiber_g * 1.0 / NULLIF(sr.yield_g, 0)), 1) AS fiber_g
    FROM recipe_ingredients ri
    LEFT JOIN products p ON p.id = ri.product_id
    LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
    WHERE ri.id = ?
  `,
    [rowId],
  );
  // No grams, or no basis to scale by (product without grams_per_serving,
  // component without yield): leave whatever was stored alone.
  if (!derived || derived.quantity_g == null || derived.basis == null) return;
  db.prepare(
    'UPDATE recipe_ingredients SET calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ? WHERE id = ?',
  ).run(derived.calories, derived.protein_g, derived.carbs_g, derived.fat_g, derived.fiber_g, rowId);
}

function cascadeComponentChange(db: DatabaseSync, recipeId: number): void {
  const rows = queryAll<{ id: number; recipe_id: number }>(db,
    "SELECT id, recipe_id FROM recipe_ingredients WHERE sub_recipe_id = ? AND recipe_id != ?", [recipeId, recipeId]);
  for (const row of rows) refreshRowMacros(db, row.id);
  for (const parentId of new Set(rows.map((row) => row.recipe_id))) recalculateRecipeTotals(db, parentId);
}

function recalculateRecipeTotals(db: DatabaseSync, recipeId: number): void {
  // Stored per-row macros win; rows that only carry grams derive from the
  // product's grams-per-serving or the component's batch yield, matching the
  // read side (get_recipe_detail and the food UI). v10: a removed row
  // subtracts, so the stored base totals agree with recipe_summary at portion 1.
  const totals = queryOne<{
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
  }>(
    db,
    `SELECT
       COALESCE(SUM((CASE WHEN ri.removed THEN -1 ELSE 1 END) * COALESCE(ri.calories, ri.quantity_g * p.calories * 1.0 / NULLIF(p.grams_per_serving, 0),
         ri.quantity_g * sr.total_calories * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS calories,
       COALESCE(SUM((CASE WHEN ri.removed THEN -1 ELSE 1 END) * COALESCE(ri.protein_g, ri.quantity_g * p.protein_g * 1.0 / NULLIF(p.grams_per_serving, 0),
         ri.quantity_g * sr.total_protein_g * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS protein_g,
       COALESCE(SUM((CASE WHEN ri.removed THEN -1 ELSE 1 END) * COALESCE(ri.carbs_g, ri.quantity_g * p.carbs_g * 1.0 / NULLIF(p.grams_per_serving, 0),
         ri.quantity_g * sr.total_carbs_g * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS carbs_g,
       COALESCE(SUM((CASE WHEN ri.removed THEN -1 ELSE 1 END) * COALESCE(ri.fat_g, ri.quantity_g * p.fat_g * 1.0 / NULLIF(p.grams_per_serving, 0),
         ri.quantity_g * sr.total_fat_g * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS fat_g,
       COALESCE(SUM((CASE WHEN ri.removed THEN -1 ELSE 1 END) * COALESCE(ri.fiber_g, ri.quantity_g * p.fiber_g * 1.0 / NULLIF(p.grams_per_serving, 0),
         ri.quantity_g * sr.total_fiber_g * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS fiber_g
     FROM recipe_ingredients ri
     LEFT JOIN products p ON p.id = ri.product_id
     LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
     WHERE ri.recipe_id = ?`,
    [recipeId],
  );
  db.prepare(
    `UPDATE recipes
     SET total_calories = ?, total_protein_g = ?, total_carbs_g = ?, total_fat_g = ?,
         total_fiber_g = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    Math.round(totals?.calories ?? 0),
    Math.round((totals?.protein_g ?? 0) * 10) / 10,
    Math.round((totals?.carbs_g ?? 0) * 10) / 10,
    Math.round((totals?.fat_g ?? 0) * 10) / 10,
    Math.round((totals?.fiber_g ?? 0) * 10) / 10,
    recipeId,
  );
}

function recipeWrite(dbPath: string, write: (db: DatabaseSync) => unknown): unknown {
  const db = openDb(dbPath, false);
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = write(db);
    db.exec(result && typeof result === "object" && "error" in result ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

const RECIPE_SCALING_SCHEMA = {
  portion: { type: "number", exclusiveMinimum: 0, maximum: 5, description: "Saved serving size multiplier, rounded to 2 decimals; base is 1" },
  pinned: { type: "boolean", description: "Star the recipe so it stays at the top of lists; false unpins" },
  batch_units: { type: ["number", "null"], description: "Positive units made by the base batch, or null" },
  unit_label: { type: ["string", "null"], description: "Component unit name, stored as scale_step_label" },
} as const;

function validateRecipeScaling(input: Record<string, unknown>): { error: string } | undefined {
  if (input.portion !== undefined && (typeof input.portion !== "number" || !Number.isFinite(input.portion)
      || input.portion <= 0 || input.portion > 5 || Math.round(input.portion * 100) === 0)) {
    return { error: "portion must be positive after rounding to 2 decimals and at most 5" };
  }
  if (input.batch_units !== undefined && input.batch_units !== null
      && (typeof input.batch_units !== "number" || !Number.isFinite(input.batch_units) || input.batch_units <= 0)) {
    return { error: "batch_units must be positive or null" };
  }
  if (input.unit_label !== undefined && input.unit_label !== null && typeof input.unit_label !== "string") {
    return { error: "unit_label must be a string or null" };
  }
  return undefined;
}

function applyRecipeScaling(db: DatabaseSync, recipeId: number, input: Record<string, unknown>): void {
  if (input.portion !== undefined) db.prepare("UPDATE recipes SET portion = ? WHERE id = ?").run(Math.round(Number(input.portion) * 100) / 100, recipeId);
  if (typeof input.pinned === "boolean") {
    db.prepare("UPDATE recipes SET pinned_at = CASE WHEN ? THEN COALESCE(pinned_at, datetime('now')) ELSE NULL END WHERE id = ?").run(input.pinned ? 1 : 0, recipeId);
  }
  if (input.batch_units !== undefined) db.prepare("UPDATE recipes SET batch_units = ? WHERE id = ?").run(input.batch_units === null ? null : Number(input.batch_units), recipeId);
  if (input.unit_label !== undefined) db.prepare("UPDATE recipes SET scale_step_label = ? WHERE id = ?").run(input.unit_label == null ? null : String(input.unit_label).trim() || null, recipeId);
}

type StoredIngredientRow = {
  id: number; ingredient_name: string; product_id: number | null; sub_recipe_id: number | null;
  quantity_g: number | null; scale_lock: string; removed: number;
  product_name: string | null; sub_recipe_name: string | null;
};

function storedIngredientRows(db: DatabaseSync, recipeId: number): StoredIngredientRow[] {
  return queryAll<StoredIngredientRow>(db, `SELECT ri.*, p.name AS product_name, sr.name AS sub_recipe_name
    FROM recipe_ingredients ri LEFT JOIN products p ON p.id = ri.product_id
    LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id WHERE ri.recipe_id = ? ORDER BY ri.id`, [recipeId]);
}

function selectIngredient(db: DatabaseSync, recipeId: number, selector: unknown): StoredIngredientRow | { error: string } {
  const term = String(selector ?? "").trim().toLowerCase();
  if (!term) return { error: "ingredient is required (row id or exact name)" };
  const rows = storedIngredientRows(db, recipeId);
  let matches = /^\d+$/.test(term) ? rows.filter((row) => row.id === Number(term))
    : rows.filter((row) => row.ingredient_name.toLowerCase() === term);
  if (!matches.length && !/^\d+$/.test(term)) {
    matches = rows.filter((row) => row.product_name?.toLowerCase() === term || row.sub_recipe_name?.toLowerCase() === term);
  }
  if (!matches.length && !/^\d+$/.test(term)) {
    // "beans" for "Black Beans (1 can)": a substring is fine when it is unique.
    matches = rows.filter((row) => [row.ingredient_name, row.product_name ?? "", row.sub_recipe_name ?? ""]
      .some((label) => label.toLowerCase().includes(term)));
  }
  if (!matches.length) return { error: `Ingredient not found: ${term}` };
  if (matches.length > 1) return { error: `Ambiguous ingredient: ${term}. Use a row id: ${matches.map((row) => `${row.id}: ${row.ingredient_name} (${row.quantity_g} g)`).join(", ")}` };
  return matches[0]!;
}

function recipeAdminTools(dbPath: string): AgentTool[] {
  const { servings: _legacyServings, ...ingredientProperties } = RECIPE_INGREDIENT_INPUT_SCHEMA.items.properties;
  const querySchema = { query: { type: "string", description: "Recipe id, shorthand, alias, or name" } };
  const selectorSchema = { ...querySchema, ingredient: { type: ["string", "number"], description: "Row id, or exact case-insensitive ingredient label, then linked product/component name; ambiguous names require an id" } };
  const rowChanges = {
    quantity_g: RECIPE_INGREDIENT_INPUT_SCHEMA.items.properties.quantity_g,
    scale_lock: RECIPE_INGREDIENT_INPUT_SCHEMA.items.properties.scale_lock,
    removed: RECIPE_INGREDIENT_INPUT_SCHEMA.items.properties.removed,
    ingredient_name: RECIPE_INGREDIENT_INPUT_SCHEMA.items.properties.ingredient_name,
  };
  const withRecipe = (input: Record<string, unknown>, write: (db: DatabaseSync, recipe: RecipeSummaryRow) => unknown) => recipeWrite(dbPath, (db) => {
    const query = String(input.query ?? "").trim();
    if (!query) return { error: "query is required" };
    const recipe = findRecipeSummary(db, query);
    return recipe ? write(db, recipe) : { error: `Recipe not found: ${query}` };
  });
  const finishRow = (db: DatabaseSync, recipeId: number, rowId: number) => {
    recalculateRecipeTotals(db, recipeId);
    cascadeComponentChange(db, recipeId);
    return { row: storedIngredientRows(db, recipeId).find((row) => row.id === rowId), recipe: findRecipeSummary(db, String(recipeId)) };
  };
  return [
    {
      name: "wellnessdb_add_recipe_ingredient",
      description: "Add one product or component ingredient in base grams without replacing other rows. Returns the stored row and portion-aware recipe summary.",
      inputSchema: { type: "object", properties: { ...querySchema, ...ingredientProperties }, required: ["query"] },
      handler: async (input) => withRecipe(input, (db, recipe) => {
        if (input.quantity_g === undefined && parseGramQuantity(input.quantity == null ? null : String(input.quantity)) === null) return { error: "quantity_g or a gram quantity is required" };
        const row = prepareRecipeIngredientRow(db, recipe.id, input);
        if ("error" in row) return row;
        const rowId = insertRecipeIngredientRow(db, recipe.id, row);
        return finishRow(db, recipe.id, rowId);
      }),
    },
    {
      name: "wellnessdb_update_recipe_ingredient",
      description: "Edit one ingredient's base grams, scaling lock, removed flag, or label. Grams changes refresh macros. Other rows stay intact.",
      inputSchema: { type: "object", properties: { ...selectorSchema, ...rowChanges }, required: ["query", "ingredient"] },
      handler: async (input) => withRecipe(input, (db, recipe) => {
        const row = selectIngredient(db, recipe.id, input.ingredient);
        if ("error" in row) return row;
        if (!Object.keys(rowChanges).some((key) => input[key] !== undefined)) return { error: "At least one change is required" };
        if (input.quantity_g !== undefined && (typeof input.quantity_g !== "number" || !Number.isFinite(input.quantity_g) || input.quantity_g <= 0)) return { error: "quantity_g must be positive" };
        if (input.scale_lock !== undefined && !["none", "serving", "batch"].includes(String(input.scale_lock))) return { error: "scale_lock must be none, serving, or batch" };
        if (input.removed !== undefined && typeof input.removed !== "boolean") return { error: "removed must be boolean" };
        if (input.ingredient_name !== undefined && (typeof input.ingredient_name !== "string" || !input.ingredient_name.trim())) return { error: "ingredient_name must be a nonempty string" };
        if (input.scale_lock !== undefined) db.prepare("UPDATE recipe_ingredients SET scale_lock = ? WHERE id = ?").run(String(input.scale_lock), row.id);
        if (input.removed !== undefined) db.prepare("UPDATE recipe_ingredients SET removed = ? WHERE id = ?").run(input.removed ? 1 : 0, row.id);
        if (input.ingredient_name !== undefined) db.prepare("UPDATE recipe_ingredients SET ingredient_name = ? WHERE id = ?").run(String(input.ingredient_name).trim(), row.id);
        if (input.quantity_g !== undefined) {
          db.prepare("UPDATE recipe_ingredients SET quantity_g = ?, quantity = ? WHERE id = ?").run(Number(input.quantity_g), `${input.quantity_g} g`, row.id);
          refreshRowMacros(db, row.id);
        }
        return finishRow(db, recipe.id, row.id);
      }),
    },
    {
      name: "wellnessdb_remove_recipe_ingredient",
      description: "Delete one ingredient row and recalculate the recipe. Returns the deleted stored row so it can be re-added.",
      inputSchema: { type: "object", properties: selectorSchema, required: ["query", "ingredient"] },
      handler: async (input) => withRecipe(input, (db, recipe) => {
        const row = selectIngredient(db, recipe.id, input.ingredient);
        if ("error" in row) return row;
        db.prepare("DELETE FROM recipe_ingredients WHERE id = ?").run(row.id);
        const result = finishRow(db, recipe.id, row.id);
        return { ...result, row };
      }),
    },
    {
      name: "wellnessdb_archive_recipe",
      description: "Archive a recipe (default true), or restore it with archived false. Archived recipes remain readable but are excluded from search and nutrition matching.",
      inputSchema: { type: "object", properties: { ...querySchema, archived: { type: "boolean", default: true } }, required: ["query"] },
      handler: async (input) => withRecipe(input, (db, recipe) => {
        if (input.archived !== undefined && typeof input.archived !== "boolean") return { error: "archived must be boolean" };
        db.prepare("UPDATE recipes SET archived_at = CASE WHEN ? THEN datetime('now') ELSE NULL END, updated_at = datetime('now') WHERE id = ?").run(input.archived === false ? 0 : 1, recipe.id);
        cascadeComponentChange(db, recipe.id);
        return findRecipeSummary(db, String(recipe.id));
      }),
    },
    {
      name: "wellnessdb_duplicate_recipe",
      description: "Copy a recipe and all stored rows, locks, removed flags, portion, and unit metadata as a variant. Does not copy shorthand or aliases; the new name must be unused by active recipes.",
      inputSchema: { type: "object", properties: { ...querySchema, name: { type: "string" } }, required: ["query"] },
      handler: async (input) => withRecipe(input, (db, recipe) => {
        const name = String(input.name ?? "").trim() || `${recipe.name} (copy)`;
        if (queryOne(db, "SELECT id FROM recipes WHERE lower(name) = lower(?) AND archived_at IS NULL", [name])) return { error: "A recipe with that name already exists", status: 400 };
        const result = db.prepare(`INSERT INTO recipes (name, servings, yield_g, instructions, notes, portion, batch_units, scale_step_label)
          SELECT ?, servings, yield_g, instructions, notes, portion, batch_units, scale_step_label FROM recipes WHERE id = ?`).run(name, recipe.id);
        const id = Number(result.lastInsertRowid);
        db.prepare(`INSERT INTO recipe_ingredients (recipe_id, product_id, sub_recipe_id, ingredient_name, quantity, quantity_g,
          calories, protein_g, carbs_g, fat_g, fiber_g, scale_lock, removed)
          SELECT ?, product_id, sub_recipe_id, ingredient_name, quantity, quantity_g, calories, protein_g, carbs_g, fat_g, fiber_g, scale_lock, removed
          FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id`).run(id, recipe.id);
        recalculateRecipeTotals(db, id);
        cascadeComponentChange(db, id);
        return findRecipeSummary(db, String(id));
      }),
    },
  ];
}

export function createWellnessDbSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      shorthand TEXT,
      brand TEXT,
      category TEXT,
      serving_size TEXT,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      notes TEXT,
      source TEXT,
      verified_date TEXT,
      serving_unit TEXT DEFAULT 'per_item',
      started_date TEXT,
      discontinued_date TEXT,
      discontinued_reason TEXT
    );

    CREATE TABLE supplements (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      dosage TEXT,
      timing TEXT,
      calories INTEGER DEFAULT 0,
      protein_g REAL DEFAULT 0,
      carbs_g REAL DEFAULT 0,
      fat_g REAL DEFAULT 0,
      notes TEXT,
      source TEXT,
      verified_date TEXT,
      shorthand TEXT,
      started_date TEXT,
      stopped_date TEXT,
      stop_reason TEXT
    );

    CREATE TABLE recipes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      instructions TEXT,
      total_calories INTEGER,
      total_protein_g REAL,
      total_carbs_g REAL,
      total_fat_g REAL,
      notes TEXT,
      shorthand TEXT,
      servings REAL DEFAULT 1.0
    );

    CREATE TABLE recipe_ingredients (
      id INTEGER PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id),
      product_id INTEGER REFERENCES products(id),
      ingredient_name TEXT NOT NULL,
      quantity TEXT,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL
    );

    CREATE TABLE recipe_aliases (
      recipe_id INTEGER NOT NULL REFERENCES recipes(id),
      alias TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (recipe_id, alias)
    );

    CREATE TABLE meal_log (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      meal TEXT NOT NULL CHECK(meal IN ('breakfast','lunch','snack','dinner','supplement')),
      product_id INTEGER REFERENCES products(id),
      recipe_id INTEGER REFERENCES recipes(id),
      supplement_id INTEGER REFERENCES supplements(id),
      description TEXT,
      servings REAL DEFAULT 1.0,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      notes TEXT,
      meal_time TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE day_notes (
      date TEXT PRIMARY KEY,
      note TEXT NOT NULL
    );

    CREATE TABLE weight_log (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      weight_lbs REAL NOT NULL,
      notes TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      duration_min INTEGER,
      distance_miles REAL,
      notes TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE hydration_log (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      oz REAL,
      notes TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE presence_checks (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      mental TEXT,
      physical TEXT,
      emotional TEXT,
      energetic TEXT,
      spiritual TEXT,
      care_action TEXT,
      notes TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIEW recipe_summary AS
    SELECT
      r.id,
      r.name,
      r.shorthand,
      r.servings,
      r.total_calories,
      r.total_protein_g,
      r.total_carbs_g,
      r.total_fat_g,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_calories * 1.0 / r.servings) ELSE r.total_calories END AS per_serving_cal,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_protein_g / r.servings, 1) ELSE r.total_protein_g END AS per_serving_prot,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_carbs_g / r.servings, 1) ELSE r.total_carbs_g END AS per_serving_carb,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_fat_g / r.servings, 1) ELSE r.total_fat_g END AS per_serving_fat,
      r.instructions,
      r.notes
    FROM recipes r;

    CREATE VIEW daily_wellness AS
    SELECT
      d.date,
      SUM(CASE WHEN m.meal != 'supplement' THEN m.calories ELSE 0 END) AS total_cal,
      SUM(CASE WHEN m.meal != 'supplement' THEN m.protein_g ELSE 0 END) AS total_protein,
      SUM(CASE WHEN m.meal = 'supplement' THEN 1 ELSE 0 END) AS supplements_taken,
      COUNT(CASE WHEN m.meal = 'breakfast' THEN 1 END) AS had_breakfast,
      w.weight_lbs,
      a.total_duration_min,
      a.total_distance_miles,
      h.total_oz,
      CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END AS did_presence_check
    FROM (
      SELECT DISTINCT date FROM meal_log
      UNION SELECT DISTINCT date FROM weight_log
      UNION SELECT DISTINCT date FROM activity_log
      UNION SELECT DISTINCT date FROM hydration_log
      UNION SELECT DISTINCT date FROM presence_checks
    ) d
    LEFT JOIN meal_log m ON m.date = d.date
    LEFT JOIN (
      SELECT date, weight_lbs FROM weight_log GROUP BY date HAVING max(logged_at)
    ) w ON w.date = d.date
    LEFT JOIN (
      SELECT date, SUM(duration_min) AS total_duration_min, SUM(distance_miles) AS total_distance_miles
      FROM activity_log GROUP BY date
    ) a ON a.date = d.date
    LEFT JOIN (
      SELECT date, SUM(oz) AS total_oz FROM hydration_log GROUP BY date
    ) h ON h.date = d.date
    LEFT JOIN (
      SELECT date, id FROM presence_checks GROUP BY date HAVING max(logged_at)
    ) p ON p.date = d.date
    GROUP BY d.date;
  `);
}

export function wellnessDbToolLooksReadOnly(name: string): boolean {
  return READ_ONLY_WELLNESSDB_TOOLS.has(name);
}

export function createWellnessDbTools(options?: WellnessDbToolOptions): AgentTool[] {
  const dbPath = resolveWellnessDbPath(options?.dbPath);
  const supplementBatchShortcuts = loadSupplementBatchShortcuts(options?.supplementBatchShortcuts);

  return [
    ...recipeAdminTools(dbPath),
    {
      name: "wellnessdb_search_product",
      description: "Search products in wellness.db by name or shorthand. Returns matching products with macros.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product name or shorthand to search for" },
          active_only: { type: "boolean", description: "If true, exclude discontinued products" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const db = openDb(dbPath, true);
        const products = searchProducts(db, query, Boolean(input.active_only));
        return { query, count: products.length, products };
      },
    },
    {
      name: "wellnessdb_search_supplement",
      description: "Search supplements in wellness.db by name or shorthand. Returns dosage and timing.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Supplement name or shorthand to search for" },
          active_only: { type: "boolean", description: "If true, exclude stopped supplements" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const db = openDb(dbPath, true);
        const supplements = searchSupplements(db, query, Boolean(input.active_only));
        return { query, count: supplements.length, supplements };
      },
    },
    {
      name: "wellnessdb_search_recipe",
      description: "Search recipes by name, shorthand, or alias. Returns per-serving macros. Excludes archived recipes by default.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Recipe name, shorthand, or alias" },
          include_archived: { type: "boolean", description: "Include archived recipes (default false)" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const db = openDb(dbPath, true);
        const recipes = searchRecipes(db, query, input.include_archived === true);
        return { query, count: recipes.length, recipes };
      },
    },
    {
      name: "wellnessdb_get_recipe_detail",
      description: "Get a recipe with full ingredient list and per-ingredient macros (removed: true rows subtract).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Recipe name, shorthand, alias, or numeric id" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const db = openDb(dbPath, true);
        const recipe = /^\d+$/.test(query)
          ? queryOne<RecipeSummaryRow>(
            db,
            `${RECIPE_SUMMARY_SELECT} WHERE rs.id = ?`,
            [Number(query)],
          )
          : findRecipeSummary(db, query);
        if (!recipe) return { error: `Recipe not found: ${query}` };

        // v9: rows come from recipe_effective_rows, so quantity_g and the
        // macros are at the recipe's saved portion; base_quantity_g is the
        // stored amount (what wellnessdb_update_recipe reads and writes).
        // v10: removed rows carry negative macros (they subtract from totals).
        const ingredientRows = queryAll<Record<string, unknown> & { removed: number }>(
          db,
          `SELECT ri.id, ri.ingredient_name, ri.quantity,
                  ri.effective_g AS quantity_g, ri.quantity_g AS base_quantity_g,
                  ri.scale_lock, ri.step_g, ri.removed,
                  ri.eff_calories AS calories, ri.eff_protein_g AS protein_g, ri.eff_carbs_g AS carbs_g,
                  ri.eff_fat_g AS fat_g, ri.eff_fiber_g AS fiber_g,
                  ri.product_id, p.name AS product_name, p.shorthand AS product_shorthand,
                  ri.sub_recipe_id, sr.name AS sub_recipe_name,
                  p.fatsecret_food_id, p.fatsecret_serving_id, p.grams_per_serving
           FROM recipe_effective_rows ri
           LEFT JOIN products p ON p.id = ri.product_id
           LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
           WHERE ri.recipe_id = ?
           ORDER BY ri.id`,
          [recipe.id],
        );
        const ingredients = ingredientRows.map((row) => ({ ...row, removed: row.removed === 1 }));
        const aliases = queryAll<{ alias: string }>(
          db,
          "SELECT alias FROM recipe_aliases WHERE recipe_id = ? ORDER BY alias",
          [recipe.id],
        );
        return { recipe, ingredients, aliases: aliases.map((row) => row.alias) };
      },
    },
    {
      name: "wellnessdb_day_summary",
      description: "Get the date\u2019s wellness.db meal_log rows, daily_wellness aggregates, note, and recipes_logged: which recipes were logged to FatSecret that day (via nutrition_log_items or the Food UI), per meal, with their diary entry ids. The FatSecret diary itself comes from fatsecret_api food_entries_get.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to today)" },
        },
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const db = openDb(dbPath, true);
        const meals = queryAll(
          db,
          `SELECT id, date, meal, product_id, recipe_id, supplement_id, description, servings,
                  calories, protein_g, carbs_g, fat_g, notes, meal_time, logged_at
           FROM meal_log
           WHERE date = ?
           ORDER BY CASE meal
             WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'snack' THEN 3
             WHEN 'dinner' THEN 4 WHEN 'supplement' THEN 5 END,
             COALESCE(meal_time, logged_at)`,
          [date],
        );
        const summary = queryOne(db, "SELECT * FROM daily_wellness WHERE date = ?", [date]);
        const note = queryOne<{ note: string }>(db, "SELECT note FROM day_notes WHERE date = ?", [date]);
        const foodTotals = queryOne<{ calories: number; protein_g: number }>(
          db,
          `SELECT COALESCE(SUM(calories), 0) AS calories, COALESCE(SUM(protein_g), 0) AS protein_g
           FROM meal_log WHERE date = ? AND meal != 'supplement'`,
          [date],
        );
        // Recipes logged to FatSecret for the day (by Malibu's nutrition_log_items
        // or the Food UI's Log it), grouped per meal with the diary entry ids they
        // produced. The diary itself lives in FatSecret (food_entries_get); this
        // says which recipe each group of entries came from.
        const recipesLogged = queryAll<{
          meal: string; recipe_id: number; recipe: string; entries: number; food_entry_ids: string; first_logged_at: string;
        }>(
          db,
          `SELECT l.meal, l.recipe_id, r.name AS recipe, COUNT(*) AS entries,
                  group_concat(l.food_entry_id) AS food_entry_ids, MIN(l.created_at) AS first_logged_at
           FROM fatsecret_entry_links l JOIN recipes r ON r.id = l.recipe_id
           WHERE l.date = ?
           GROUP BY l.meal, l.recipe_id
           ORDER BY MIN(l.created_at)`,
          [date],
        ).map((row) => ({ ...row, food_entry_ids: String(row.food_entry_ids ?? "").split(",").filter(Boolean) }));
        return { date, meals, summary, note: note?.note ?? null, food_totals: foodTotals, recipes_logged: recipesLogged };
      },
    },
    {
      name: "wellnessdb_day_range",
      description: "Get daily_wellness view rows for a date range (inclusive).",
      inputSchema: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Start date YYYY-MM-DD" },
          end_date: { type: "string", description: "End date YYYY-MM-DD" },
        },
        required: ["start_date", "end_date"],
      },
      handler: async (input) => {
        const startDate = assertDate(String(input.start_date), "start_date");
        const endDate = assertDate(String(input.end_date), "end_date");
        const db = openDb(dbPath, true);
        const days = queryAll(
          db,
          "SELECT * FROM daily_wellness WHERE date >= ? AND date <= ? ORDER BY date",
          [startDate, endDate],
        );
        return { start_date: startDate, end_date: endDate, count: days.length, days };
      },
    },
    {
      name: "wellnessdb_recent_meals",
      description: "Get the most recent meal_log entries.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of entries to return (default 10, max 50)" },
        },
      },
      handler: async (input) => {
        const limit = Math.min(Math.max(Number(input.limit ?? 10) || 10, 1), 50);
        const db = openDb(dbPath, true);
        const meals = queryAll(
          db,
          `SELECT id, date, meal, description, servings, calories, protein_g, carbs_g, fat_g, notes, meal_time, logged_at
           FROM meal_log
           ORDER BY date DESC, COALESCE(meal_time, logged_at) DESC, id DESC
           LIMIT ?`,
          [limit],
        );
        return { limit, count: meals.length, meals };
      },
    },
    {
      name: "wellnessdb_active_supplements",
      description: "List supplements where stopped_date IS NULL.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const db = openDb(dbPath, true);
        const supplements = queryAll<SupplementRow>(
          db,
          `SELECT id, name, shorthand, brand, dosage, timing, calories, protein_g, carbs_g, fat_g, stopped_date
           FROM supplements
           WHERE stopped_date IS NULL
           ORDER BY name`,
        );
        return { count: supplements.length, supplements };
      },
    },
    {
      name: "wellnessdb_active_products",
      description: "List products where discontinued_date IS NULL.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const db = openDb(dbPath, true);
        const products = queryAll<ProductRow>(
          db,
          `SELECT id, name, shorthand, brand, category, calories, protein_g, carbs_g, fat_g,
                  serving_size, serving_unit, discontinued_date
           FROM products
           WHERE discontinued_date IS NULL
           ORDER BY name`,
        );
        return { count: products.length, products };
      },
    },
    {
      name: "wellnessdb_log_meal",
      description: "Log a meal entry for a product or recipe. Resolves item by shorthand or name.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date YYYY-MM-DD (defaults to today)" },
          meal: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
          item_type: { type: "string", enum: ["product", "recipe"] },
          item: { type: "string", description: "Product or recipe shorthand/name" },
          servings: { type: "number", description: "Number of servings (default 1)" },
          notes: { type: "string" },
          meal_time: { type: "string", description: "Time as HH:MM" },
        },
        required: ["meal", "item_type", "item"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const meal = String(input.meal ?? "").trim().toLowerCase();
        const itemType = String(input.item_type ?? "").trim().toLowerCase();
        const item = String(input.item ?? "").trim();
        const servings = Number(input.servings ?? 1) || 1;
        if (!MEALS.has(meal) || meal === "supplement") {
          return { error: "meal must be breakfast, lunch, dinner, or snack" };
        }
        if (itemType !== "product" && itemType !== "recipe") {
          return { error: "item_type must be product or recipe" };
        }
        if (!item) return { error: "item is required" };

        const db = openDb(dbPath, false);
        if (itemType === "product") {
          const product = findProduct(db, item, true);
          if (!product) return { error: `Product not found: ${item}` };
          const result = db.prepare(
            `INSERT INTO meal_log (date, meal, product_id, description, servings, calories, protein_g, carbs_g, fat_g, notes, meal_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            date,
            meal,
            product.id,
            product.name,
            servings,
            scaleIntMacro(product.calories, servings),
            scaleMacro(product.protein_g, servings),
            scaleMacro(product.carbs_g, servings),
            scaleMacro(product.fat_g, servings),
            input.notes ? String(input.notes) : null,
            input.meal_time ? String(input.meal_time) : null,
          );
          return {
            id: Number(result.lastInsertRowid),
            date,
            meal,
            item_type: "product",
            item: product.name,
            servings,
            calories: scaleIntMacro(product.calories, servings),
            protein_g: scaleMacro(product.protein_g, servings),
          };
        }

        const recipe = findRecipeSummary(db, item);
        if (!recipe) return { error: `Recipe not found: ${item}` };
        const result = db.prepare(
          `INSERT INTO meal_log (date, meal, recipe_id, description, servings, calories, protein_g, carbs_g, fat_g, notes, meal_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          date,
          meal,
          recipe.id,
          recipe.name,
          servings,
          scaleIntMacro(recipe.per_serving_cal, servings),
          scaleMacro(recipe.per_serving_prot, servings),
          scaleMacro(recipe.per_serving_carb, servings),
          scaleMacro(recipe.per_serving_fat, servings),
          input.notes ? String(input.notes) : null,
          input.meal_time ? String(input.meal_time) : null,
        );
        return {
          id: Number(result.lastInsertRowid),
          date,
          meal,
          item_type: "recipe",
          item: recipe.name,
          servings,
          calories: scaleIntMacro(recipe.per_serving_cal, servings),
          protein_g: scaleMacro(recipe.per_serving_prot, servings),
        };
      },
    },
    {
      name: "wellnessdb_log_supplement",
      description: "Log one or more supplements taken. Supports comma-separated names and profile-configured batch expansion.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date YYYY-MM-DD (defaults to today)" },
          supplements: {
            oneOf: [
              { type: "string", description: "Comma-separated supplement shorthands/names, or configured batch shortcut" },
              { type: "array", items: { type: "string" } },
            ],
          },
          notes: { type: "string", description: "Timing note such as AM or PM" },
          meal_time: { type: "string", description: "Time as HH:MM" },
        },
        required: ["supplements"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const queries = expandSupplementQueries(
          input.supplements as string | string[],
          supplementBatchShortcuts,
        );
        if (queries.length === 0) return { error: "supplements is required" };

        const db = openDb(dbPath, false);
        const logged: Array<Record<string, unknown>> = [];
        const errors: string[] = [];

        for (const query of queries) {
          const supplement = findSupplement(db, query, true);
          if (!supplement) {
            errors.push(`Supplement not found: ${query}`);
            continue;
          }
          const result = db.prepare(
            `INSERT INTO meal_log (date, meal, supplement_id, description, servings, calories, protein_g, carbs_g, fat_g, notes, meal_time)
             VALUES (?, 'supplement', ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          ).run(
            date,
            supplement.id,
            supplement.name,
            supplement.calories ?? 0,
            supplement.protein_g ?? 0,
            supplement.carbs_g ?? 0,
            supplement.fat_g ?? 0,
            input.notes ? String(input.notes) : null,
            input.meal_time ? String(input.meal_time) : null,
          );
          logged.push({
            id: Number(result.lastInsertRowid),
            supplement: supplement.name,
            query,
          });
        }

        if (logged.length === 0) {
          return { error: errors.join("; ") };
        }
        return { date, logged, errors: errors.length > 0 ? errors : undefined };
      },
    },
    {
      name: "wellnessdb_log_weight",
      description: "Log weight for a date.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          weight_lbs: { type: "number" },
          notes: { type: "string" },
        },
        required: ["weight_lbs"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const weight = Number(input.weight_lbs);
        if (!Number.isFinite(weight) || weight <= 0) {
          return { error: "weight_lbs must be a positive number" };
        }
        const db = openDb(dbPath, false);
        const result = db.prepare(
          "INSERT INTO weight_log (date, weight_lbs, notes) VALUES (?, ?, ?)",
        ).run(date, weight, input.notes ? String(input.notes) : null);
        return { id: Number(result.lastInsertRowid), date, weight_lbs: weight };
      },
    },
    {
      name: "wellnessdb_log_activity",
      description: "Log movement or activity.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          activity_type: {
            type: "string",
            enum: ["walk", "weights", "yoga", "stretching", "rebounder", "meditation", "journaling", "other"],
          },
          duration_min: { type: "number" },
          distance_miles: { type: "number" },
          notes: { type: "string" },
        },
        required: ["activity_type"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const activityType = String(input.activity_type ?? "").trim().toLowerCase();
        if (!ACTIVITY_TYPES.has(activityType)) {
          return { error: "activity_type is invalid" };
        }
        const db = openDb(dbPath, false);
        const result = db.prepare(
          `INSERT INTO activity_log (date, activity_type, duration_min, distance_miles, notes)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          date,
          activityType,
          input.duration_min != null ? Number(input.duration_min) : null,
          input.distance_miles != null ? Number(input.distance_miles) : null,
          input.notes ? String(input.notes) : null,
        );
        return {
          id: Number(result.lastInsertRowid),
          date,
          activity_type: activityType,
          duration_min: input.duration_min != null ? Number(input.duration_min) : null,
          distance_miles: input.distance_miles != null ? Number(input.distance_miles) : null,
        };
      },
    },
    {
      name: "wellnessdb_log_hydration",
      description: "Log water intake in ounces.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          oz: { type: "number", description: "Ounces of water" },
          notes: { type: "string" },
        },
        required: ["oz"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const oz = Number(input.oz);
        if (!Number.isFinite(oz) || oz <= 0) {
          return { error: "oz must be a positive number" };
        }
        const db = openDb(dbPath, false);
        const result = db.prepare(
          "INSERT INTO hydration_log (date, oz, notes) VALUES (?, ?, ?)",
        ).run(date, oz, input.notes ? String(input.notes) : null);
        return { id: Number(result.lastInsertRowid), date, oz };
      },
    },
    {
      name: "wellnessdb_log_presence",
      description: "Record a five-body presence check.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          mental: { type: "string" },
          physical: { type: "string" },
          emotional: { type: "string" },
          energetic: { type: "string" },
          spiritual: { type: "string" },
          care_action: { type: "string" },
          notes: { type: "string" },
        },
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const db = openDb(dbPath, false);
        const result = db.prepare(
          `INSERT INTO presence_checks (date, mental, physical, emotional, energetic, spiritual, care_action, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          date,
          input.mental ? String(input.mental) : null,
          input.physical ? String(input.physical) : null,
          input.emotional ? String(input.emotional) : null,
          input.energetic ? String(input.energetic) : null,
          input.spiritual ? String(input.spiritual) : null,
          input.care_action ? String(input.care_action) : null,
          input.notes ? String(input.notes) : null,
        );
        return { id: Number(result.lastInsertRowid), date };
      },
    },
    {
      name: "wellnessdb_add_product",
      description: "Add a product (a purchasable ingredient). Give serving_size + grams_per_serving and label macros; map fatsecret_food_id + fatsecret_serving_id (verify with fatsecret_api food_get) so it can be logged; set scale_step_g/scale_step_label when it comes in units (eggs, bags). Prices and store listings are added in the Food UI, not here.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          shorthand: { type: "string" },
          brand: { type: "string" },
          category: { type: "string" },
          serving_size: { type: "string" },
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          fiber_g: { type: "number" },
          grams_per_serving: { type: "number" },
          fatsecret_food_id: { type: "string" },
          fatsecret_serving_id: { type: "string" },
          scale_step_g: { type: "number" },
          scale_step_label: { type: "string" },
          source: { type: "string" },
          notes: { type: "string" },
        },
        required: ["name"],
      },
      handler: async (input) => {
        const name = String(input.name ?? "").trim();
        if (!name) return { error: "name is required" };
        const db = openDb(dbPath, false);
        const result = db.prepare(
          `INSERT INTO products (name, shorthand, brand, category, serving_size, grams_per_serving, calories, protein_g, carbs_g, fat_g, fiber_g,
                                 fatsecret_food_id, fatsecret_serving_id, scale_step_g, scale_step_label, source, notes, started_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'))`,
        ).run(
          name,
          input.shorthand ? String(input.shorthand) : null,
          input.brand ? String(input.brand) : null,
          input.category ? String(input.category) : null,
          input.serving_size ? String(input.serving_size) : null,
          input.grams_per_serving != null && Number(input.grams_per_serving) > 0 ? Number(input.grams_per_serving) : null,
          input.calories != null ? Number(input.calories) : null,
          input.protein_g != null ? Number(input.protein_g) : null,
          input.carbs_g != null ? Number(input.carbs_g) : null,
          input.fat_g != null ? Number(input.fat_g) : null,
          input.fiber_g != null ? Number(input.fiber_g) : null,
          input.fatsecret_food_id ? String(input.fatsecret_food_id) : null,
          input.fatsecret_serving_id ? String(input.fatsecret_serving_id) : null,
          input.scale_step_g != null && Number(input.scale_step_g) > 0 ? Number(input.scale_step_g) : null,
          input.scale_step_label ? String(input.scale_step_label) : null,
          input.source ? String(input.source) : null,
          input.notes ? String(input.notes) : null,
        );
        return { id: Number(result.lastInsertRowid), name };
      },
    },
    {
      name: "wellnessdb_update_product",
      description: "Update a product by id: name, shorthand, brand, category, serving_size, grams_per_serving, calories, protein_g, carbs_g, fat_g, fiber_g, fatsecret_food_id + fatsecret_serving_id (verify with fatsecret_api food_get first), scale_step_g + scale_step_label (the unit the ingredient comes apart in: ½ bag = 140, 1 egg = 50; null = continuous), source, notes, and discontinued (true retires it, false restores). Quote before/after numbers to the user.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "products row id" },
          name: { type: "string" },
          shorthand: { type: "string" },
          brand: { type: "string" },
          category: { type: "string" },
          serving_size: { type: "string" },
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          fiber_g: { type: "number" },
          grams_per_serving: { type: "number", description: "Grams in one serving_size; required for gram-based logging" },
          fatsecret_food_id: { type: "string" },
          fatsecret_serving_id: { type: "string" },
          scale_step_g: { type: ["number", "null"], description: "Unit step in grams for recipe scaling; null clears" },
          scale_step_label: { type: ["string", "null"], description: "Label for one step, e.g. '½ bag', '1 egg'" },
          source: { type: "string", description: "Where the numbers came from: label, usda, fatsecret" },
          discontinued: { type: "boolean", description: "true retires the product (archive), false restores it" },
          notes: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne<Record<string, unknown>>(
          db,
          `SELECT id, name, shorthand, brand, category, serving_size, grams_per_serving, calories, protein_g, carbs_g, fat_g, fiber_g, fatsecret_food_id, fatsecret_serving_id, scale_step_g, scale_step_label, source, discontinued_date, notes
           FROM products
           WHERE id = ?`,
          [id],
        );
        if (!existing) return { error: `Product not found: ${id}` };

        const updates: string[] = [];
        const values: Array<string | number | null> = [];
        const applyString = (field: string, value: unknown): void => {
          updates.push(`${field} = ?`);
          values.push(value == null ? null : String(value).trim());
        };
        const applyNumber = (field: string, value: unknown): void => {
          const numeric = Number(value);
          updates.push(`${field} = ?`);
          values.push(Number.isFinite(numeric) ? numeric : null);
        };

        if (input.name !== undefined) applyString("name", input.name);
        if (input.shorthand !== undefined) applyString("shorthand", input.shorthand);
        if (input.brand !== undefined) applyString("brand", input.brand);
        if (input.category !== undefined) applyString("category", input.category);
        if (input.serving_size !== undefined) applyString("serving_size", input.serving_size);
        if (input.calories !== undefined) applyNumber("calories", input.calories);
        if (input.protein_g !== undefined) applyNumber("protein_g", input.protein_g);
        if (input.carbs_g !== undefined) applyNumber("carbs_g", input.carbs_g);
        if (input.fat_g !== undefined) applyNumber("fat_g", input.fat_g);
        if (input.fiber_g !== undefined) applyNumber("fiber_g", input.fiber_g);
        if (input.grams_per_serving !== undefined) {
          const g = Number(input.grams_per_serving);
          if (!(g > 0)) return { error: "grams_per_serving must be positive" };
          applyNumber("grams_per_serving", g);
        }
        if (input.fatsecret_food_id !== undefined) applyString("fatsecret_food_id", input.fatsecret_food_id);
        if (input.fatsecret_serving_id !== undefined) applyString("fatsecret_serving_id", input.fatsecret_serving_id);
        if (input.scale_step_g !== undefined) {
          if (input.scale_step_g === null || input.scale_step_g === "") {
            updates.push("scale_step_g = NULL", "scale_step_label = NULL");
          } else {
            const step = Number(input.scale_step_g);
            if (!(step > 0)) return { error: "scale_step_g must be positive or null" };
            applyNumber("scale_step_g", step);
          }
        }
        if (input.scale_step_label !== undefined && input.scale_step_g !== null) applyString("scale_step_label", input.scale_step_label);
        if (input.source !== undefined) applyString("source", input.source);
        if (input.discontinued !== undefined) {
          updates.push(input.discontinued ? "discontinued_date = date('now')" : "discontinued_date = NULL");
        }
        if (input.notes !== undefined) applyString("notes", input.notes);

        if (updates.length === 0) {
          return { error: "At least one update field is required" };
        }

        db.prepare(`UPDATE products SET ${updates.join(", ")} WHERE id = ?`).run(...values, id);
        const product = queryOne<Record<string, unknown>>(
          db,
          `SELECT id, name, shorthand, brand, category, serving_size, grams_per_serving, calories, protein_g, carbs_g, fat_g, fiber_g, fatsecret_food_id, fatsecret_serving_id, scale_step_g, scale_step_label, source, discontinued_date, notes
           FROM products
           WHERE id = ?`,
          [id],
        );
        return { updated: true, before: existing, product };
      },
    },
    {
      name: "wellnessdb_add_recipe",
      description:
        "Create a recipe with ingredients (products by grams, or component recipes by grams). "
        + "Totals are calculated from the ingredient rows. Set yield_g for a component recipe. "
        + "An ingredient with removed: true subtracts a discarded portion such as drained whey.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          shorthand: { type: "string" },
          servings: { type: "number" },
          ...RECIPE_SCALING_SCHEMA,
          yield_g: { type: "number", description: "Cooked batch weight in grams for component recipes" },
          instructions: { type: "string" },
          notes: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          ingredients: RECIPE_INGREDIENT_INPUT_SCHEMA,
        },
        required: ["name", "ingredients"],
      },
      handler: async (input) => {
        const name = String(input.name ?? "").trim();
        if (!name) return { error: "name is required" };
        const ingredients = Array.isArray(input.ingredients) ? input.ingredients : [];
        if (ingredients.length === 0) return { error: "ingredients is required" };

        const scalingError = validateRecipeScaling(input);
        if (scalingError) return scalingError;
        return recipeWrite(dbPath, (db) => {
          const servings = Number(input.servings ?? 1) || 1;
          const yieldG = Number(input.yield_g);
          const recipeResult = db.prepare(
            `INSERT INTO recipes (name, shorthand, servings, yield_g, instructions, notes)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            name,
            input.shorthand ? String(input.shorthand) : null,
            servings,
            Number.isFinite(yieldG) && yieldG > 0 ? yieldG : null,
            input.instructions ? String(input.instructions) : null,
            input.notes ? String(input.notes) : null,
          );
          const recipeId = Number(recipeResult.lastInsertRowid);

          const failure = replaceRecipeIngredientRows(db, recipeId, ingredients);
          if (failure) return failure;

          for (const alias of Array.isArray(input.aliases) ? input.aliases : []) {
            const aliasText = String(alias).trim();
            if (!aliasText) continue;
            db.prepare("INSERT OR IGNORE INTO recipe_aliases (recipe_id, alias) VALUES (?, ?)").run(recipeId, aliasText);
          }

          applyRecipeScaling(db, recipeId, input);
          recalculateRecipeTotals(db, recipeId);
          cascadeComponentChange(db, recipeId);
          const recipe = findRecipeSummary(db, String(recipeId));
          return { id: recipeId, recipe };
        });
      },
    },
    {
      name: "wellnessdb_update_recipe",
      description:
        "Update a recipe. Omit `ingredients` to change only servings, yield_g, portion, batch_units, unit_label, instructions, notes, or aliases "
        + "(existing ingredient rows are kept as-is). Pass `ingredients` only to replace the FULL ingredient list — "
        + "include every row from get_recipe_detail, products and sub_recipes alike, using base_quantity_g as quantity_g and preserving scale_lock "
        + "(removed: true subtracts a discarded portion such as drained whey).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Recipe id, shorthand, alias, or name" },
          servings: { type: "number" },
          ...RECIPE_SCALING_SCHEMA,
          yield_g: { type: "number", description: "Cooked batch weight in grams for component recipes" },
          instructions: { type: "string" },
          notes: { type: "string" },
          aliases: { type: "array", items: { type: "string" }, description: "Aliases to add (existing ones stay)" },
          ingredients: RECIPE_INGREDIENT_INPUT_SCHEMA,
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const ingredients = Array.isArray(input.ingredients) ? input.ingredients : null;
        if (ingredients && ingredients.length === 0) {
          return { error: "ingredients must list every ingredient row; omit it to keep the current rows" };
        }
        const aliases = (Array.isArray(input.aliases) ? input.aliases : [])
          .map((alias) => String(alias).trim())
          .filter((alias) => alias.length > 0);
        const yieldG = input.yield_g == null ? null : Number(input.yield_g);
        const hasMetadataChange = input.servings != null || yieldG != null
          || input.instructions != null || input.notes != null
          || input.portion !== undefined || input.batch_units !== undefined || input.unit_label !== undefined || typeof input.pinned === "boolean";
        if (!ingredients && !hasMetadataChange && aliases.length === 0) {
          return { error: "Nothing to update: pass servings, yield_g, portion, batch_units, unit_label, instructions, notes, aliases, or ingredients" };
        }
        if (yieldG != null && !(Number.isFinite(yieldG) && yieldG > 0)) {
          return { error: "yield_g must be a positive number of grams" };
        }

        const scalingError = validateRecipeScaling(input);
        if (scalingError) return scalingError;
        return recipeWrite(dbPath, (db) => {
          const recipe = findRecipeSummary(db, query);
          if (!recipe) return { error: `Recipe not found: ${query}` };

          applyRecipeScaling(db, recipe.id, input);
          if (input.servings != null) {
            db.prepare("UPDATE recipes SET servings = ? WHERE id = ?").run(Number(input.servings), recipe.id);
          }
          if (yieldG != null) {
            db.prepare("UPDATE recipes SET yield_g = ? WHERE id = ?").run(yieldG, recipe.id);
          }
          if (input.instructions != null) {
            db.prepare("UPDATE recipes SET instructions = ? WHERE id = ?").run(String(input.instructions), recipe.id);
          }
          if (input.notes != null) {
            db.prepare("UPDATE recipes SET notes = ? WHERE id = ?").run(String(input.notes), recipe.id);
          }
          for (const alias of aliases) {
            db.prepare("INSERT OR IGNORE INTO recipe_aliases (recipe_id, alias) VALUES (?, ?)").run(recipe.id, alias);
          }

          if (ingredients) {
            const failure = replaceRecipeIngredientRows(db, recipe.id, ingredients);
            if (failure) return failure;
            recalculateRecipeTotals(db, recipe.id);
          } else {
            db.prepare("UPDATE recipes SET updated_at = datetime('now') WHERE id = ?").run(recipe.id);
          }
          cascadeComponentChange(db, recipe.id);
          return {
            id: recipe.id,
            ingredients_replaced: Boolean(ingredients),
            recipe: findRecipeSummary(db, String(recipe.id)),
          };
        });
      },
    },
    {
      name: "wellnessdb_add_day_note",
      description: "Add or append a note for a date.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          note: { type: "string" },
        },
        required: ["note"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const note = String(input.note ?? "").trim();
        if (!note) return { error: "note is required" };
        const db = openDb(dbPath, false);
        const existing = queryOne<{ note: string }>(db, "SELECT note FROM day_notes WHERE date = ?", [date]);
        const nextNote = existing?.note ? `${existing.note}\n${note}` : note;
        db.prepare("INSERT OR REPLACE INTO day_notes (date, note) VALUES (?, ?)").run(date, nextNote);
        return { date, note: nextNote, appended: Boolean(existing) };
      },
    },
    {
      name: "wellnessdb_update_supplement",
      description: "Update an existing supplement by id. Supports name, shorthand, dosage, and notes.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "supplements row id" },
          name: { type: "string" },
          shorthand: { type: "string" },
          dosage: { type: "string" },
          notes: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne<Record<string, unknown>>(
          db,
          `SELECT id, name, shorthand, dosage, notes
           FROM supplements
           WHERE id = ?`,
          [id],
        );
        if (!existing) return { error: `Supplement not found: ${id}` };

        const updates: string[] = [];
        const values: Array<string | null> = [];
        const applyString = (field: string, value: unknown): void => {
          updates.push(`${field} = ?`);
          values.push(value == null ? null : String(value).trim());
        };

        if (input.name !== undefined) applyString("name", input.name);
        if (input.shorthand !== undefined) applyString("shorthand", input.shorthand);
        if (input.dosage !== undefined) applyString("dosage", input.dosage);
        if (input.notes !== undefined) applyString("notes", input.notes);

        if (updates.length === 0) {
          return { error: "At least one update field is required" };
        }

        db.prepare(`UPDATE supplements SET ${updates.join(", ")} WHERE id = ?`).run(...values, id);
        const supplement = queryOne<Record<string, unknown>>(
          db,
          `SELECT id, name, shorthand, dosage, notes
           FROM supplements
           WHERE id = ?`,
          [id],
        );
        return { updated: true, supplement };
      },
    },
    {
      name: "wellnessdb_delete_meal_entry",
      description: "Delete a specific meal_log entry by id (for corrections only).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "meal_log row id" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne(db, "SELECT id, date, meal, description FROM meal_log WHERE id = ?", [id]);
        if (!existing) return { error: `Meal entry not found: ${id}` };
        db.prepare("DELETE FROM meal_log WHERE id = ?").run(id);
        return { deleted: true, entry: existing };
      },
    },
    {
      name: "wellnessdb_delete_product",
      description: "Delete a product by id (for duplicate/incorrect entries only).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "products row id" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne(db, "SELECT id, name, shorthand FROM products WHERE id = ?", [id]);
        if (!existing) return { error: `Product not found: ${id}` };
        db.prepare("DELETE FROM products WHERE id = ?").run(id);
        return { deleted: true, product: existing };
      },
    },
    {
      name: "wellnessdb_delete_supplement",
      description: "Delete a supplement by id (for duplicate/incorrect entries only).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "supplements row id" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne(db, "SELECT id, name, shorthand FROM supplements WHERE id = ?", [id]);
        if (!existing) return { error: `Supplement not found: ${id}` };
        db.prepare("DELETE FROM supplements WHERE id = ?").run(id);
        return { deleted: true, supplement: existing };
      },
    },
  ];
}
