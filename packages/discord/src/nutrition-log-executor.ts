import { DatabaseSync } from "node:sqlite";
import { resolveCurrentTurnTimeZone } from "@tango/core";

export interface NutritionLogItemInput {
  /** Display name; also the fallback for recipe/product name matching. */
  name: string;
  quantity: string;
  /**
   * Identity-addressed rows (the Food UI "Log it" button knows exactly which
   * recipe row the user adjusted, so it must not go through name matching).
   * product_id logs that product at `quantity`; sub_recipe_id expands that
   * component recipe, which requires a gram quantity. They are mutually
   * exclusive. recipe_id is the top-level recipe the entries are linked to
   * (defaults to sub_recipe_id for a component logged on its own).
   */
  product_id?: number;
  sub_recipe_id?: number;
  recipe_id?: number;
}

export interface NutritionLogItemsInput {
  items: NutritionLogItemInput[];
  meal: string;
  date?: string;
  strict?: boolean;
}

export interface NutritionLogItemsDeps {
  wellnessDbPath: string;
  fatsecretCall(method: string, params: Record<string, unknown>): Promise<unknown>;
  fatsecretBatchCall?(
    calls: Array<{ method: string; params?: Record<string, unknown> }>,
  ): Promise<Array<{ ok: boolean; result?: unknown; error?: string }>>;
  /** Injectable delay for transient-error retries (tests pass a no-op). */
  sleep?(ms: number): Promise<void>;
}

interface ProductRow {
  name?: string;
  brand?: string;
  id: number;
  fatsecret_food_id?: number | string | null;
  fatsecret_serving_id?: number | string | null;
  serving_size?: string | null;
  grams_per_serving?: number | string | null;
  calories?: number | string | null;
  protein_g?: number | string | null;
  carbs_g?: number | string | null;
  fat_g?: number | string | null;
  fiber_g?: number | string | null;
  shorthand?: string | null;
}

interface PlannedProductLogEntry {
  input: NutritionLogItemInput;
  row: ProductRow;
  writeUnits: number;
  macroMultiplier: number;
  recipeId?: number;
  foodId: string;
  servingId: string;
  foodEntryName: string;
}

interface UnresolvedNutritionLogItem {
  item: string;
  quantity: string;
  grams?: number;
  reason: string;
  resolution?: string;
  wellnessdb_match?: {
    name: string;
    food_id: string;
    serving_id: string;
    calories?: number;
    grams_per_serving?: number;
  };
}

const NUMBER_WORD_VALUES: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

// FatSecret rejects bursts of concurrent writes with "Error 1: An unknown
// error occurred: please try again later" (seen live 2026-09-04 logging an
// 11-entry day at concurrency 4: two of six breakfast writes bounced). Keep the
// burst small and retry the transient failures ourselves so a recipe log lands
// whole — a model-driven retry re-logs the items as bare products and loses
// the recipe link rows.
const FATSECRET_WRITE_CONCURRENCY = 2;
const FATSECRET_TRANSIENT_RETRY_DELAYS_MS = [800, 1600];
const FATSECRET_TRANSIENT_ERROR_RE =
  /please try again later|an unknown error occurred|\bError 1\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|rate limit|\b(?:429|500|502|503|504)\b/iu;

export function isTransientFatSecretError(detail: string): boolean {
  return FATSECRET_TRANSIENT_ERROR_RE.test(detail);
}

async function fatsecretCallWithTransientRetry(
  deps: NutritionLogItemsDeps,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  while (true) {
    try {
      return await deps.fatsecretCall(method, params);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const delay = FATSECRET_TRANSIENT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientFatSecretError(detail)) {
        throw error;
      }
      attempt += 1;
      await sleep(delay);
    }
  }
}
const PRODUCT_PACKAGE_FALLBACK_UNITS = new Set(["bag", "pack", "package", "packet", "pouch"]);

// FatSecret's diary has no "snack" meal; its snack slot is "other".
function normalizeDiaryMeal(meal: string): string {
  const normalized = meal.trim().toLowerCase();
  return normalized === "snack" ? "other" : normalized;
}

export async function executeNutritionLogItems(
  input: NutritionLogItemsInput,
  deps: NutritionLogItemsDeps,
): Promise<Record<string, unknown>> {
  const meal = normalizeDiaryMeal(input.meal);
  const date = normalizeLogDate(input.date);
  const strict = input.strict === true;
  const items: NutritionLogItemInput[] = input.items
    .map((item) => ({
      name: typeof item.name === "string" ? item.name.trim() : "",
      quantity: typeof item.quantity === "string" ? item.quantity.trim() : "",
      product_id: readOptionalId(item.product_id),
      sub_recipe_id: readOptionalId(item.sub_recipe_id),
      recipe_id: readOptionalId(item.recipe_id),
    }))
    .filter((item) => item.name.length > 0 && item.quantity.length > 0);

  if (items.length === 0) {
    return {
      action: "nutrition_log_items",
      status: "needs_clarification",
      date,
      meal,
      logged: [],
      unresolved: [{ item: "", quantity: "", reason: "No valid items were provided." }],
      totals: null,
      errors: [],
    };
  }

  const db = new DatabaseSync(deps.wellnessDbPath, { readOnly: true });
  try {
    const plannedEntries: PlannedProductLogEntry[] = [];
    const unresolved: UnresolvedNutritionLogItem[] = [];

    const skipped: Array<{ item: string; grams?: number; reason: string }> = [];
    let zeroCalorieSkips = 0;
    const planProduct = (item: NutritionLogItemInput, row: ProductRow, recipeId?: number, grams?: number): void => {
      const foodId = stringifyId(row.fatsecret_food_id);
      const servingId = stringifyId(row.fatsecret_serving_id);
      if (recipeId !== undefined && (row.calories == null || Number(row.calories) === 0)
        && (!foodId || !servingId)) {
        skipped.push({ item: item.name, grams,
          reason: "zero-calorie product with no FatSecret mapping — nothing to log" });
        zeroCalorieSkips += 1;
        return;
      }
      const recipeGrams = grams === undefined ? {} : { grams };
      if (!foodId || !servingId || !deriveWellnessDbGramsPerServing(row)) {
        unresolved.push({ item: item.name, quantity: item.quantity, ...recipeGrams,
          reason: `Product ${row.name} is missing fatsecret_food_id, fatsecret_serving_id, or positive grams_per_serving. Use fatsecret_api food_get to repair the serving mapping.` });
        return;
      }
      const derived = deriveWellnessDbWriteUnits(item.quantity, row);
      if (!derived) {
        const match = buildWellnessDbMatchSummary(row, foodId, servingId);
        unresolved.push({ item: item.name, quantity: item.quantity, ...recipeGrams,
          resolution: formatWellnessDbResolutionSummary(match), wellnessdb_match: match,
          reason: buildWellnessDbUnitConversionFallbackReason(item.quantity, match) });
        return;
      }
      plannedEntries.push({ input: item, row, ...derived, recipeId, foodId, servingId,
        foodEntryName: selectWellnessDbEntryName(row) });
    };

    // A row addressed by id (Food UI "Log it") bypasses name matching entirely:
    // the name is display-only and may not match any product or recipe.
    const planIdentifiedRow = (item: NutritionLogItemInput): void => {
      if (item.product_id !== undefined && item.sub_recipe_id !== undefined) {
        unresolved.push({ item: item.name, quantity: item.quantity,
          reason: `${item.name}: product_id ${item.product_id} and sub_recipe_id ${item.sub_recipe_id} were both given; a row is one or the other.` });
        return;
      }
      if (item.product_id !== undefined) {
        const row = findActiveProductById(db, item.product_id);
        if (!row) {
          unresolved.push({ item: item.name, quantity: item.quantity,
            reason: `Product ${item.product_id} (${item.name}) is missing or discontinued.` });
          return;
        }
        const grams = parseGramsFromAmountText(item.quantity);
        planProduct(item, row, item.recipe_id, grams ?? undefined);
        return;
      }
      const subRecipeId = item.sub_recipe_id!;
      const start = plannedEntries.length;
      try {
        const grams = parseRecipeGrams(item.quantity);
        if (grams === null || !(grams > 0) || !Number.isFinite(grams)) {
          throw new Error(`Component ${item.name}: quantity must be positive grams (for example "100 g"), got "${item.quantity}".`);
        }
        const sub = findActiveRecipeById(db, subRecipeId);
        if (!sub || !sub.yield_g || sub.yield_g <= 0) {
          throw new Error(`Component ${item.name} is missing, archived, or lacks a positive yield_g.`);
        }
        const linkId = item.recipe_id ?? sub.id;
        expandRecipe(db, sub, grams / sub.yield_g, [], (row, rowGrams) => {
          planProduct({ name: row.name ?? item.name, quantity: `${rowGrams} g` }, row, linkId, rowGrams);
        }, skipped);
      } catch (error) {
        // Never write an incomplete traversal after a cycle or depth failure.
        plannedEntries.length = start;
        unresolved.push({ item: item.name, quantity: item.quantity,
          reason: error instanceof Error ? error.message : String(error) });
      }
    };

    for (const item of items) {
      if (item.product_id !== undefined || item.sub_recipe_id !== undefined) {
        planIdentifiedRow(item);
        continue;
      }
      const recipe = findRecipe(db, item.name);
      if (recipe) {
        const start = plannedEntries.length;
        try {
          const grams = parseRecipeGrams(item.quantity);
          const servings = parseLeadingQuantityToken(item.quantity);
          const divisor = grams !== null ? recipe.yield_g : recipe.servings;
          const amount = grams ?? servings;
          if (!amount || amount <= 0 || !Number.isFinite(amount) || !divisor || divisor <= 0) {
            throw new Error(`Recipe ${recipe.name}: quantity requires positive servings, or grams with a positive yield_g.`);
          }
          expandRecipe(db, recipe, amount / divisor, [], (row, grams) => {
            planProduct({ name: row.name ?? item.name, quantity: `${grams} g` }, row, recipe.id, grams);
          }, skipped);
        } catch (error) {
          // Never write an incomplete traversal after a cycle or depth failure.
          plannedEntries.length = start;
          unresolved.push({ item: item.name, quantity: item.quantity,
            reason: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      const row = findBestWellnessDbMatchForItem(db, item.name);
      if (row) planProduct(item, row);
      else unresolved.push({ item: item.name, quantity: item.quantity,
        reason: "No active wellness.db product or recipe match found. Use low-level FatSecret search for this item." });
    }

    if (strict && (unresolved.length > 0 || skipped.length > zeroCalorieSkips)) {
      return {
        action: "nutrition_log_items",
        status: "needs_clarification",
        date,
        meal,
        logged: [],
        unresolved,
        skipped,
        totals: null,
        errors: [],
      };
    }

    const { logged, errors, diaryEntries } = await writeEntriesAndRefreshDiary(
      plannedEntries,
      {
        meal,
        date,
      },
      deps,
    );

    const linkWarnings = recordRecipeLinks(deps.wellnessDbPath, logged, date, meal);

    const status =
      logged.length === 0
        ? unresolved.length > 0 || skipped.length > 0
          ? "needs_clarification"
          : "blocked"
        : unresolved.length > 0 || skipped.length > 0 || errors.length > 0
          ? "partial_success"
          : "confirmed";

    return {
      action: "nutrition_log_items",
      status,
      date,
      meal,
      logged,
      unresolved,
      skipped,
      link_warnings: linkWarnings,
      totals: buildNutritionTotals(logged),
      diary_entries: diaryEntries,
      errors,
    };
  } finally {
    db.close();
  }
}

interface RecipeRow {
  id: number;
  name: string;
  servings: number | null;
  yield_g: number | null;
}

/**
 * "egg and fries hash" must find "Egg & Fries Hash": compare names with '&'
 * spelled out, punctuation dropped, and whitespace collapsed. Exact
 * (normalized) matches only — fuzzy product matching stays the fallback.
 */
export function normalizeRecipeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/gu, " and ")
    .replace(/\+/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function findRecipe(db: DatabaseSync, name: string): RecipeRow | undefined {
  const wanted = normalizeRecipeName(name);
  if (!wanted) return undefined;
  const rows = db.prepare(`SELECT r.id, r.name, r.servings, r.yield_g, r.shorthand,
      (SELECT group_concat(a.alias, '\u001f') FROM recipe_aliases a WHERE a.recipe_id = r.id) AS aliases
    FROM recipes r WHERE r.archived_at IS NULL ORDER BY r.id`).all() as unknown as Array<RecipeRow & {
      shorthand: string | null; aliases: string | null;
    }>;
  for (const row of rows) {
    const candidates = [row.name, row.shorthand ?? "", ...(row.aliases ? row.aliases.split("\u001f") : [])];
    if (candidates.some((c) => c && normalizeRecipeName(c) === wanted)) {
      return { id: row.id, name: row.name, servings: row.servings, yield_g: row.yield_g };
    }
  }
  return undefined;
}

// Ids arrive from JSON; only a finite number is trusted, anything else is
// treated as absent so the item falls back to name matching.
function readOptionalId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function findActiveRecipeById(db: DatabaseSync, id: number): RecipeRow | undefined {
  return db.prepare(`SELECT id, name, servings, yield_g FROM recipes
    WHERE id = ? AND archived_at IS NULL`).get(id) as unknown as RecipeRow | undefined;
}

function findActiveProductById(db: DatabaseSync, id: number): ProductRow | undefined {
  return db.prepare(`SELECT * FROM products WHERE id = ? AND discontinued_date IS NULL`)
    .get(id) as unknown as ProductRow | undefined;
}

function parseRecipeGrams(quantity: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(?:g|grams?)$/iu.exec(quantity.trim());
  if (match) return Number(match[1]);
  // A gram quantity must not accidentally become a serving count.
  if (/\b(?:g|grams?)\b/iu.test(quantity) || /\d[gG]/u.test(quantity)) {
    throw new Error(`Unsupported recipe gram quantity: ${quantity}`);
  }
  return null;
}

function expandRecipe(
  db: DatabaseSync,
  recipe: RecipeRow,
  scale: number,
  ancestors: number[],
  product: (row: ProductRow, grams: number) => void,
  skipped: Array<{ item: string; reason: string }>,
): void {
  if (ancestors.includes(recipe.id)) throw new Error(`Recipe cycle detected at ${recipe.name}.`);
  if (ancestors.length >= 6) throw new Error(`Recipe nesting depth limit 6 exceeded at ${recipe.name}.`);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`Invalid quantity for recipe ${recipe.name}.`);
  // v9: effective grams at the recipe's saved portion (scale_lock + step
  // snapping applied in SQL), so a logged recipe matches the table and the
  // shopping list. NULL/non-positive grams still surface as skipped rows.
  // v10: removed rows (drained whey, discarded fat) are not part of the meal —
  // nobody eats them — so they are neither logged nor reported as skipped.
  const rows = db.prepare(`SELECT ingredient_name, product_id, sub_recipe_id, effective_g AS quantity_g
    FROM recipe_effective_rows WHERE recipe_id = ? AND removed = 0 ORDER BY id`).all(recipe.id) as unknown as Array<{
      ingredient_name: string; product_id: number | null; sub_recipe_id: number | null; quantity_g: number | null;
    }>;
  if (rows.length === 0) throw new Error(`Recipe ${recipe.name} has no ingredient rows.`);
  // FatSecret cannot hold a negative entry, so a batch that loses mass (drained
  // whey) is logged by shrinking every kept row in proportion to the calories
  // the removed rows took away: kept calories × factor = the batch's net
  // calories. Protein/fat ratios are approximate (whey is mostly lactose), but
  // the total matches what the recipe page shows instead of overstating it.
  const balance = db.prepare(`SELECT
      SUM(CASE WHEN removed = 0 THEN eff_calories ELSE 0 END) AS kept,
      SUM(eff_calories) AS net,
      SUM(removed) AS removed_rows
    FROM recipe_effective_rows WHERE recipe_id = ?`).get(recipe.id) as unknown as {
      kept: number | null; net: number | null; removed_rows: number | null;
    };
  let rowScale = scale;
  if ((balance.removed_rows ?? 0) > 0) {
    const kept = balance.kept ?? 0;
    const net = balance.net ?? 0;
    if (!(net > 0) || !(kept > 0)) {
      throw new Error(`Recipe ${recipe.name} removes more than it contains; check its removed rows.`);
    }
    rowScale = scale * (net / kept);
  }
  for (const row of rows) {
    if (row.quantity_g === null || !Number.isFinite(row.quantity_g) || row.quantity_g <= 0
      || (row.product_id === null && row.sub_recipe_id === null)) {
      skipped.push({ item: row.ingredient_name,
        reason: row.quantity_g === null ? "Missing quantity_g; grams cannot be guessed."
          : row.quantity_g <= 0 || !Number.isFinite(row.quantity_g) ? "quantity_g must be positive and finite."
            : "Missing product_id and sub_recipe_id." });
      continue;
    }
    if (row.product_id !== null && row.sub_recipe_id !== null) {
      throw new Error(`Recipe ingredient ${row.ingredient_name} has both product_id and sub_recipe_id.`);
    }
    const grams = row.quantity_g * rowScale;
    if (!Number.isFinite(grams)) throw new Error(`Invalid grams for ${row.ingredient_name}.`);
    if (row.sub_recipe_id !== null) {
      const sub = findActiveRecipeById(db, row.sub_recipe_id);
      if (!sub || !sub.yield_g || sub.yield_g <= 0) {
        throw new Error(`Component ${row.ingredient_name} is missing, archived, or lacks a positive yield_g.`);
      }
      expandRecipe(db, sub, grams / sub.yield_g, [...ancestors, recipe.id], product, skipped);
    } else {
      const match = findActiveProductById(db, row.product_id!);
      if (!match) throw new Error(`Product ${row.ingredient_name} is missing or discontinued.`);
      product(match, grams);
    }
  }
}

function recordRecipeLinks(
  dbPath: string, logged: Record<string, unknown>[], date: string, meal: string,
): string[] {
  const entries = logged.filter((entry) => entry.recipe_id !== undefined);
  if (entries.length === 0) return [];
  const warnings: string[] = [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 1000");
    const insert = db.prepare(`INSERT INTO fatsecret_entry_links (date, meal, recipe_id, food_entry_id)
      VALUES (?, ?, ?, ?)`);
    for (const entry of entries) {
      try {
        const id = stringifyId(entry.food_entry_id);
        if (!id) throw new Error("FatSecret returned no food_entry_id");
        insert.run(date, meal, Number(entry.recipe_id), id);
      } catch (error) {
        warnings.push(`Diary entry ${entry.food_entry_id ?? entry.item} logged, but recipe link failed: ${String(error)}`);
      }
    }
  } catch (error) {
    warnings.push(`Diary entries logged, but recipe links failed: ${String(error)}`);
  } finally {
    db?.close();
  }
  return warnings;
}

async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await fn(items[currentIndex]!);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function writeEntriesAndRefreshDiary(
  plannedEntries: PlannedProductLogEntry[],
  context: { meal: string; date: string },
  deps: NutritionLogItemsDeps,
): Promise<{
  logged: Record<string, unknown>[];
  errors: string[];
  diaryEntries: unknown;
}> {
  if (plannedEntries.length === 0) {
    return {
      logged: [],
      errors: [],
      diaryEntries: null,
    };
  }

  if (deps.fatsecretBatchCall) {
    try {
      return await writeEntriesViaBatch(plannedEntries, context, deps);
    } catch (error) {
      return writeEntriesViaIndividualCalls(plannedEntries, context, deps);
    }
  }

  return writeEntriesViaIndividualCalls(plannedEntries, context, deps);
}

async function writeEntriesViaBatch(
  plannedEntries: PlannedProductLogEntry[],
  context: { meal: string; date: string },
  deps: NutritionLogItemsDeps,
): Promise<{
  logged: Record<string, unknown>[];
  errors: string[];
  diaryEntries: unknown;
}> {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = plannedEntries.map((plannedEntry) => ({
    method: "food_entry_create",
    params: {
      food_id: plannedEntry.foodId,
      food_entry_name: plannedEntry.foodEntryName,
      serving_id: plannedEntry.servingId,
      number_of_units: plannedEntry.writeUnits,
      meal: context.meal,
      date: context.date,
    },
  }));
  calls.push({
    method: "food_entries_get",
    params: { date: context.date },
  });

  const batchResults = await deps.fatsecretBatchCall!(calls);
  const logged: Record<string, unknown>[] = [];
  const errors: string[] = [];

  for (const [index, plannedEntry] of plannedEntries.entries()) {
    const result = batchResults[index];
    if (!result?.ok) {
      errors.push(
        `FatSecret write for ${plannedEntry.input.name} failed: ${result?.error ?? "Unknown batch failure."}`,
      );
      continue;
    }
    const outputRecord = asRecord(result.result);
    const success = Boolean(outputRecord?.success);
    if (!success) {
      errors.push(`FatSecret write for ${plannedEntry.input.name} returned a non-success response.`);
      continue;
    }
    logged.push(buildLoggedEntry(plannedEntry, outputRecord?.food_entry_id ?? null));
  }

  const diaryResult = batchResults[plannedEntries.length];
  let diaryEntries: unknown = null;
  if (logged.length > 0) {
    if (diaryResult?.ok) {
      diaryEntries = diaryResult.result ?? null;
    } else {
      errors.push(`FatSecret diary refresh failed: ${diaryResult?.error ?? "Unknown batch failure."}`);
    }
  }

  return {
    logged: attachDiaryMacros(logged, diaryEntries),
    errors,
    diaryEntries,
  };
}

async function writeEntriesViaIndividualCalls(
  plannedEntries: PlannedProductLogEntry[],
  context: { meal: string; date: string },
  deps: NutritionLogItemsDeps,
): Promise<{
  logged: Record<string, unknown>[];
  errors: string[];
  diaryEntries: unknown;
}> {
  const logged: Record<string, unknown>[] = [];
  const errors: string[] = [];

  const writeResults = await mapWithConcurrencyLimit(
    plannedEntries,
    FATSECRET_WRITE_CONCURRENCY,
    async (plannedEntry) => {
      try {
        const output = await fatsecretCallWithTransientRetry(deps, "food_entry_create", {
          food_id: plannedEntry.foodId,
          food_entry_name: plannedEntry.foodEntryName,
          serving_id: plannedEntry.servingId,
          number_of_units: plannedEntry.writeUnits,
          meal: context.meal,
          date: context.date,
        });
        const outputRecord = asRecord(output);
        const success = Boolean(outputRecord?.success);
        if (!success) {
          return {
            error: `FatSecret write for ${plannedEntry.input.name} returned a non-success response.`,
          };
        }
        return {
          logged: buildLoggedEntry(plannedEntry, outputRecord?.food_entry_id ?? null),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          error: `FatSecret write for ${plannedEntry.input.name} failed: ${detail}`,
        };
      }
    },
  );

  for (const result of writeResults) {
    if (result?.logged) {
      logged.push(result.logged);
    }
    if (result?.error) {
      errors.push(result.error);
    }
  }

  let diaryEntries: unknown = null;
  if (logged.length > 0) {
    try {
      diaryEntries = await deps.fatsecretCall("food_entries_get", { date: context.date });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`FatSecret diary refresh failed: ${detail}`);
    }
  }

  return {
    logged: attachDiaryMacros(logged, diaryEntries),
    errors,
    diaryEntries,
  };
}

function buildLoggedEntry(
  plannedEntry: PlannedProductLogEntry,
  foodEntryId: unknown,
): Record<string, unknown> {
  return {
    item: plannedEntry.input.name,
    quantity: plannedEntry.input.quantity,
    food_entry_name: plannedEntry.foodEntryName,
    food_entry_id: foodEntryId,
    food_id: plannedEntry.foodId,
    serving_id: plannedEntry.servingId,
    number_of_units: plannedEntry.writeUnits,
    source: "wellnessdb",
    ...(plannedEntry.recipeId !== undefined ? { recipe_id: plannedEntry.recipeId } : {}),
    estimated_macros: estimateMacrosFromWellnessDb(plannedEntry.row, plannedEntry.macroMultiplier),
  };
}

function normalizeLogDate(value: string | undefined): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.trim())) {
    return value.trim();
  }
  return formatLocalIsoDate(new Date(), resolveCurrentTurnTimeZone());
}

function formatLocalIsoDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const partMap = new Map(parts.map((part) => [part.type, part.value]));
  const year = partMap.get("year");
  const month = partMap.get("month");
  const day = partMap.get("day");
  if (!year || !month || !day) {
    throw new Error(`Unable to format nutrition log date for timezone ${timeZone}.`);
  }
  return `${year}-${month}-${day}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringifyId(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function formatWellnessDbDisplayNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : String(Number.parseFloat(value.toFixed(2)));
}

function singularizeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 3) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function normalizeFoodLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*g\b/gu, " ")
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .map((token) => singularizeToken(token))
    .join(" ")
    .trim();
}

function stripParentheticalSegments(value: string): string {
  return value.replace(/\([^)]*\)/gu, " ");
}

function buildNormalizedItemVariants(value: string): string[] {
  return [...new Set(
    [
      normalizeFoodLabel(value),
      normalizeFoodLabel(stripParentheticalSegments(value)),
    ].filter((variant) => variant.length > 0),
  )];
}

function parseWellnessDbAliasList(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map((alias) => alias.trim()).filter(Boolean) : [];
}

function deriveWellnessDbGramsPerServing(row: ProductRow): number | null {
  const grams = parseFiniteNumber(row.grams_per_serving);
  return grams !== null && grams > 0 ? grams : null;
}

// FatSecret gram-unit servings (measurement_description === "g", e.g. serving
// "100 g") interpret number_of_units as a RAW GRAM COUNT, not a multiple of the
// serving. Logging 140 g of such a serving must send number_of_units = 140, not
// 1.4 — FatSecret reads 1.4 as 1.4 grams (~1 cal). Detect these by the serving's
// UNIT, which wellness.db stores in serving_size ("100 g", "110g", or bare "g").
//
// grams_per_serving is NOT a fallback signal: it holds the gram WEIGHT, which
// every serving has regardless of its unit. Reading a weight as a gram unit
// sends the gram amount as a serving count — a ~100x overlog (220 g of chicken
// thighs logged as 220 servings = 28,600 cal). When serving_size is missing or
// unparseable the unit is unknown, so assume the safe serving-count interpretation.
const GRAM_UNIT_SERVING_RE = /^\d*\.?\d*\s*(?:g|gram|grams)$/iu;
function isRawGramUnitsServing(row: ProductRow): boolean {
  return GRAM_UNIT_SERVING_RE.test((row.serving_size ?? "").trim());
}

function buildWellnessDbMatchSummary(
  row: ProductRow,
  foodId: string,
  servingId: string,
): {
  name: string;
  food_id: string;
  serving_id: string;
  calories?: number;
  grams_per_serving?: number;
} {
  const calories = parseFiniteNumber(row.calories);
  const gramsPerServing = deriveWellnessDbGramsPerServing(row);
  return {
    name: selectWellnessDbEntryName(row),
    food_id: foodId,
    serving_id: servingId,
    ...(calories !== null ? { calories } : {}),
    ...(gramsPerServing !== null ? { grams_per_serving: gramsPerServing } : {}),
  };
}

function formatWellnessDbResolutionSummary(
  wellnessdbMatch: {
    name: string;
    food_id: string;
    serving_id: string;
    grams_per_serving?: number;
  },
): string {
  const details = [
    `food_id ${wellnessdbMatch.food_id}`,
    `serving_id ${wellnessdbMatch.serving_id}`,
    ...(typeof wellnessdbMatch.grams_per_serving === "number"
      ? [`grams_per_serving ${formatWellnessDbDisplayNumber(wellnessdbMatch.grams_per_serving)}`]
      : []),
  ];
  return `Wellness DB match found: ${wellnessdbMatch.name} (${details.join(", ")})`;
}

function buildWellnessDbUnitConversionFallbackReason(
  quantity: string,
  wellnessdbMatch: {
    name: string;
    food_id: string;
    calories?: number;
  },
): string {
  const caloriesText = typeof wellnessdbMatch.calories === "number"
    ? ` Wellness DB calories are ${formatWellnessDbDisplayNumber(wellnessdbMatch.calories)} per product serving.`
    : "";
  return [
    `Wellness DB matched ${wellnessdbMatch.name} (food_id ${wellnessdbMatch.food_id}).${caloriesText}`,
    `The deterministic layer could not convert "${quantity}" from the product serving definition.`,
    `Use fatsecret_api food_get with food_id ${wellnessdbMatch.food_id} to inspect serving options and choose the one that matches the requested quantity (for example tbsp or cup).`,
  ].join(" ");
}

function scoreWellnessDbRowForItem(itemLabel: string, row: ProductRow): number {
  const normalizedItemVariants = buildNormalizedItemVariants(itemLabel);
  if (normalizedItemVariants.length === 0) {
    return 0;
  }
  const aliases = parseWellnessDbAliasList(row.shorthand);
  const haystacks = [
    row.name ?? "",
    row.brand ?? "",
    ...aliases,
  ];
  const normalizedHaystacks = [...new Set(
    haystacks
      .map((value) => normalizeFoodLabel(value))
      .filter((value) => value.length > 0),
  )];
  const itemWords = [...new Set(
    normalizedItemVariants
      .flatMap((variant) => variant.split(" "))
      .filter((word) => word.length > 1),
  )];
  const matchedWords = new Set<string>();
  let score = 0;
  for (const haystack of normalizedHaystacks) {
    for (const normalizedItem of normalizedItemVariants) {
      if (haystack === normalizedItem) {
        score += 100;
      } else if (haystack.includes(normalizedItem) || normalizedItem.includes(haystack)) {
        score += 50;
      }
    }
    for (const word of itemWords) {
      if (haystack.includes(word)) {
        matchedWords.add(word);
      }
    }
  }
  score += matchedWords.size * 5;
  return score;
}

function findBestWellnessDbMatchForItem(db: DatabaseSync, itemLabel: string): ProductRow | null {
  const rows = db.prepare(`SELECT id, name, brand, shorthand, serving_size, grams_per_serving,
    calories, protein_g, carbs_g, fat_g, fiber_g, fatsecret_food_id, fatsecret_serving_id
    FROM products WHERE discontinued_date IS NULL ORDER BY id`).all() as unknown as ProductRow[];
  const scoredRows = rows.map((row) => ({
    row,
    score: scoreWellnessDbRowForItem(itemLabel, row),
  }));
  let bestRow: ProductRow | null = null;
  let bestScore = 0;
  for (const { row, score } of scoredRows) {
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }
  return bestScore >= 10 ? bestRow : null;
}

function parseGramsFromAmountText(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const directMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:g|grams?)$/iu);
  const parsed = directMatch?.[1] ? Number.parseFloat(directMatch[1]) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractCountFromAmountText(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const directMatch = normalized.match(/^(\d+(?:\.\d+)?)\b/u);
  if (directMatch?.[1]) {
    const parsed = Number.parseFloat(directMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const words = Object.keys(NUMBER_WORD_VALUES).join("|");
  const wordMatch = normalized.match(new RegExp(`^(${words})\\b`, "iu"));
  if (wordMatch?.[1]) {
    return NUMBER_WORD_VALUES[wordMatch[1].toLowerCase()] ?? null;
  }
  return null;
}

function parseLeadingQuantityToken(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (/^half(?:\s|$)/iu.test(normalized)) return 0.5;
  const mixedFractionMatch = normalized.match(/^(\d+)\s+(\d+)\/(\d+)\b/u);
  if (mixedFractionMatch?.[1] && mixedFractionMatch[2] && mixedFractionMatch[3]) {
    const whole = Number.parseFloat(mixedFractionMatch[1]);
    const numerator = Number.parseFloat(mixedFractionMatch[2]);
    const denominator = Number.parseFloat(mixedFractionMatch[3]);
    if (Number.isFinite(whole) && Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return whole + (numerator / denominator);
    }
    return null;
  }
  const fractionMatch = normalized.match(/^(\d+)\/(\d+)\b/u);
  if (fractionMatch?.[1] && fractionMatch[2]) {
    const numerator = Number.parseFloat(fractionMatch[1]);
    const denominator = Number.parseFloat(fractionMatch[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator;
    }
    return null;
  }
  return extractCountFromAmountText(normalized);
}

function extractAmountUnitHint(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const withoutLeadingCount = normalized
    .replace(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|half|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/iu, "")
    .replace(/^\s+/u, "");
  const match = withoutLeadingCount.match(/^([a-z]+(?:\s+[a-z]+){0,2})/iu);
  return match?.[1] ? normalizeFoodLabel(match[1]) : null;
}

function extractServingUnitCount(row: ProductRow): number | null {
  const candidates = [
    typeof row.serving_size === "string" ? row.serving_size.trim() : "",
  ];
  for (const candidate of candidates) {
    const parsed = parseLeadingQuantityToken(candidate);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function wellnessdbRowHasNamedServingUnit(row: ProductRow): boolean {
  return normalizeFoodLabel(`${row.serving_size ?? ""}`).length > 0;
}

function shouldUseWellnessDbPackageFallback(row: ProductRow, amountUnit: string | null): boolean {
  if (!amountUnit || !PRODUCT_PACKAGE_FALLBACK_UNITS.has(amountUnit)) {
    return false;
  }
  if (wellnessdbRowHasNamedServingUnit(row)) {
    return false;
  }
  if (!deriveWellnessDbGramsPerServing(row)) {
    return false;
  }
  return Boolean(row.brand?.trim());
}

function servingMatchesAmountUnit(row: ProductRow, amountUnit: string | null): boolean {
  if (!amountUnit) {
    return false;
  }
  const haystack = normalizeFoodLabel(`${row.serving_size ?? ""}`);
  if (!haystack) {
    return false;
  }
  if (haystack.includes(amountUnit)) {
    return true;
  }
  const tokens = amountUnit
    .split(/\s+/u)
    .map((token) => normalizeFoodLabel(token))
    .filter((token) => token.length >= 3);
  return tokens.some((token) => haystack.includes(token));
}

function deriveWellnessDbWriteUnits(
  amountText: string,
  row: ProductRow,
): { writeUnits: number; macroMultiplier: number } | null {
  const gramsPerServing = deriveWellnessDbGramsPerServing(row);
  if (!gramsPerServing) return null;
  const fromGrams = (grams: number) => {
    const macroMultiplier = grams / gramsPerServing;
    // Macros always scale by weight, independently of FatSecret's write unit.
    const units = isRawGramUnitsServing(row) ? grams : macroMultiplier;
    const writeUnits = Number.parseFloat(units.toFixed(6));
    return Number.isFinite(writeUnits) && writeUnits > 0 && Number.isFinite(macroMultiplier)
      ? { writeUnits, macroMultiplier } : null;
  };
  const grams = parseGramsFromAmountText(amountText);
  if (grams !== null) return fromGrams(grams);

  const count = parseLeadingQuantityToken(amountText);
  if (!count || count <= 0) return null;
  const amountUnit = extractAmountUnitHint(amountText);
  if (!amountUnit || amountUnit === "serving" || shouldUseWellnessDbPackageFallback(row, amountUnit)) {
    return fromGrams(count * gramsPerServing);
  }
  if (!servingMatchesAmountUnit(row, amountUnit)) return null;
  const servingUnitCount = extractServingUnitCount(row) ?? 1;
  return fromGrams(count / servingUnitCount * gramsPerServing);
}

function selectWellnessDbEntryName(row: ProductRow): string {
  return row.name?.trim() || "Logged Food";
}

// The diary refresh carries FatSecret's own macros for the entries we just
// wrote, and those — not the product's stored columns — are what the day actually
// totals to. Product rows can drift from the FatSecret food they point at (different
// cut, stale label, rounding), so reporting product estimates tells the user a
// number their diary does not contain. Index the refreshed diary by
// food_entry_id so each write can be reconciled against what FatSecret stored.
//
// Shape-tolerant on purpose: food_entries_get returns a flat array on some
// paths and a meal-keyed object on others, so walk the structure and take any
// record carrying a food_entry_id.
function indexDiaryEntriesById(diaryEntries: unknown): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    const entryId = record.food_entry_id;
    if (typeof entryId === "string" || typeof entryId === "number") {
      const key = String(entryId).trim();
      if (key && !index.has(key)) {
        index.set(key, record);
      }
    }
    for (const child of Object.values(record)) {
      visit(child, depth + 1);
    }
  };
  visit(diaryEntries, 0);
  return index;
}

// FatSecret names the carb field "carbohydrate" and returns every macro as a
// string; anything missing stays null so it can fall back to the estimate
// rather than silently counting as zero.
function extractDiaryMacros(entry: Record<string, unknown>): Record<string, number | null> | null {
  const calories = parseFiniteNumber(entry.calories);
  if (calories === null) {
    return null;
  }
  const round = (value: unknown, digits = 1): number | null => {
    const parsed = parseFiniteNumber(value);
    return parsed === null ? null : Number.parseFloat(parsed.toFixed(digits));
  };
  return {
    calories: Math.round(calories),
    protein: round(entry.protein),
    carbs: round(entry.carbohydrate),
    fat: round(entry.fat),
    fiber: round(entry.fiber),
  };
}

function attachDiaryMacros(
  logged: readonly Record<string, unknown>[],
  diaryEntries: unknown,
): Record<string, unknown>[] {
  const index = indexDiaryEntriesById(diaryEntries);
  if (index.size === 0) {
    return [...logged];
  }
  return logged.map((entry) => {
    const entryId = entry.food_entry_id;
    if (typeof entryId !== "string" && typeof entryId !== "number") {
      return entry;
    }
    const match = index.get(String(entryId).trim());
    if (!match) {
      return entry;
    }
    const macros = extractDiaryMacros(match);
    return macros ? { ...entry, logged_macros: macros } : entry;
  });
}

function estimateMacrosFromWellnessDb(row: ProductRow, multiplier: number): Record<string, number | null> {
  const calories = parseFiniteNumber(row.calories);
  const protein = parseFiniteNumber(row.protein_g);
  const carbs = parseFiniteNumber(row.carbs_g);
  const fat = parseFiniteNumber(row.fat_g);
  const fiber = parseFiniteNumber(row.fiber_g);
  const scale = (value: number | null, digits = 1): number | null =>
    value === null ? null : Number.parseFloat((value * multiplier).toFixed(digits));
  return {
    calories: calories === null ? null : Math.round(calories * multiplier),
    protein: scale(protein),
    carbs: scale(carbs),
    fat: scale(fat),
    fiber: scale(fiber),
  };
}

// Totals follow the diary: per entry, FatSecret's stored macros win and the
// Wellness DB estimate is only a fallback for writes the refresh could not confirm.
// totals_source records which, so a caller can tell a verified total from an
// estimated one instead of presenting both with equal confidence.
function buildNutritionTotals(
  logged: readonly Record<string, unknown>[],
): Record<string, number | string> | null {
  if (logged.length === 0) {
    return null;
  }
  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let fiber = 0;
  let fromDiary = 0;
  let fromEstimate = 0;
  for (const entry of logged) {
    const diaryMacros = asRecord(entry.logged_macros);
    const macros = diaryMacros ?? asRecord(entry.estimated_macros);
    if (diaryMacros) {
      fromDiary += 1;
    } else {
      fromEstimate += 1;
    }
    calories += parseFiniteNumber(macros?.calories) ?? 0;
    protein += parseFiniteNumber(macros?.protein) ?? 0;
    carbs += parseFiniteNumber(macros?.carbs) ?? 0;
    fat += parseFiniteNumber(macros?.fat) ?? 0;
    fiber += parseFiniteNumber(macros?.fiber) ?? 0;
  }
  return {
    calories: Math.round(calories),
    protein: Number.parseFloat(protein.toFixed(1)),
    carbs: Number.parseFloat(carbs.toFixed(1)),
    fat: Number.parseFloat(fat.toFixed(1)),
    fiber: Number.parseFloat(fiber.toFixed(1)),
    totals_source:
      fromEstimate === 0 ? "fatsecret" : fromDiary === 0 ? "wellnessdb_estimate" : "mixed",
  };
}
