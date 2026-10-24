/**
 * Wellness DB materialization + versioned migrations.
 *
 * The wellness schema (createWellnessDbSchema) was historically only applied
 * by hand, and openDb() throws when the file is absent — so on profiles where
 * the DB was never materialized, every wellnessdb_* tool fails. ensureWellnessDb()
 * closes that gap: it creates the file on first use and upgrades existing DBs
 * in place using PRAGMA user_version.
 *
 * Version history:
 *   1 — base schema (createWellnessDbSchema)
 *   2 — food tracker (docs/specs/food-tracker.md §3): fiber + FatSecret IDs +
 *       grams_per_serving on products, canonical gram quantities on recipe
 *       ingredients, product_listings / price_history / meal_plans /
 *       meal_plan_entries / fatsecret_entry_links, and cost-aware views.
 *   3 — product_listings.retailer accepts 'costco' and 'other' (table rebuild)
 *   4 — recipes.archived_at: retire recipes without deleting (products use
 *       discontinued_date for the same purpose)
 *   5 — recipe_cost rolls one level of sub-recipe cost into the parent
 *       (component batch cost ÷ yield_g × grams used)
 *   6 — recipe scaling: products.scale_step_g / scale_step_label (an
 *   7 — recipes.batch_units: a component batch makes N units (Taco Base = 1 taco);
 *       the per-unit weight is yield_g / batch_units, so it follows the recipe.
 *       ingredient's natural increment), recipe_ingredients.scale_lock
 *       ('none' | 'serving' | 'batch'), and the goal_phases table (per-phase
 *       multipliers, exactly one current). Views unchanged — per-serving and
 *       per-100g math is scale-invariant; scaling is computed at read time.
 *   8 — recipe_cost and shopping_list walk the full component tree (depth ≤ 6),
 *       not one level: a base built on another component costs and shops fully.
 *   9 — saved portion: recipes.portion (×1.0 = the stored base) plus the
 *       recipe_effective_rows view, which applies portion + scale_lock + step
 *       snapping per ingredient row. recipe_summary, recipe_base_cost,
 *       recipe_cost and shopping_list now read effective grams, so the table,
 *       cost views, shopping list and the logger all see the same amounts.
 *  10 — removed rows: recipe_ingredients.removed. A row flagged removed
 *       subtracts its macros from the batch (drained whey, discarded fat);
 *       never costed, never shopped, never logged.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createWellnessDbSchema, resolveWellnessDbPath } from "./wellness-db-tools.js";

export const WELLNESS_DB_VERSION = 11;

export interface EnsureWellnessDbReport {
  path: string;
  created: boolean;
  fromVersion: number;
  toVersion: number;
}

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version ?? 0);
}

function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(name) !== undefined
  );
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, decl: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function applyFoodTrackerMigration(db: DatabaseSync): void {
  // Existing tables. Column checks (not bare ALTERs) so a DB that predates
  // versioning but already carries some of these columns upgrades cleanly.
  addColumnIfMissing(db, "products", "fiber_g", "REAL");
  addColumnIfMissing(db, "products", "fatsecret_food_id", "TEXT");
  addColumnIfMissing(db, "products", "fatsecret_serving_id", "TEXT");
  addColumnIfMissing(db, "products", "grams_per_serving", "REAL");
  addColumnIfMissing(db, "recipes", "total_fiber_g", "REAL");
  // recalculateRecipeTotals writes recipes.updated_at, which the base schema
  // never created — every recipe write on a freshly materialized DB threw.
  addColumnIfMissing(db, "recipes", "updated_at", "TEXT");
  // yield_g: batch output in grams; set on component recipes (e.g. a sauce)
  // so other recipes can use them by the gram — per-gram macros/cost are
  // batch totals / yield_g.
  addColumnIfMissing(db, "recipes", "yield_g", "REAL");
  addColumnIfMissing(db, "recipe_ingredients", "quantity_g", "REAL");
  addColumnIfMissing(db, "recipe_ingredients", "fiber_g", "REAL");
  // sub_recipe_id: nested recipes — an ingredient row may reference another
  // recipe instead of a product. Rollups recurse in application code
  // (recalculateRecipeTotals and the UI), which must reject cycles at write
  // time; the SQL views treat sub-recipe rows like any other macro/cost row.
  addColumnIfMissing(db, "recipe_ingredients", "sub_recipe_id", "INTEGER REFERENCES recipes(id)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS product_listings (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      retailer TEXT NOT NULL CHECK(retailer IN ('walmart','amazon')),
      retailer_item_id TEXT,
      url TEXT,
      package_description TEXT,
      package_grams REAL,
      servings_per_container REAL,
      active INTEGER NOT NULL DEFAULT 1,
      preferred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES product_listings(id),
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      price REAL NOT NULL,
      unit_price TEXT,
      in_stock INTEGER,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_listing
      ON price_history(listing_id, observed_at);

    CREATE TABLE IF NOT EXISTS meal_plans (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      start_date TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meal_plan_entries (
      id INTEGER PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES meal_plans(id),
      day_index INTEGER NOT NULL DEFAULT 0,
      meal TEXT NOT NULL CHECK(meal IN ('breakfast','lunch','snack','dinner')),
      recipe_id INTEGER REFERENCES recipes(id),
      product_id INTEGER REFERENCES products(id),
      -- total portions eaten at this meal (per-meal, not per-week: e.g.
      -- dinner ×2 while a school-day lunch is ×1)
      servings REAL NOT NULL DEFAULT 1.0,
      CHECK (recipe_id IS NOT NULL OR product_id IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS fatsecret_entry_links (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      meal TEXT,
      recipe_id INTEGER REFERENCES recipes(id),
      food_entry_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fatsecret_entry_links_date
      ON fatsecret_entry_links(date);
  `);
}

/**
 * Views. Dropped and recreated wholesale, once, after every schema step has
 * run (ensureWellnessDb): the current definitions reference columns added as
 * late as v10 (scale_lock, scale_step_g, batch_units, portion, removed), and SQLite
 * resolves a view's columns at CREATE VIEW time, so they cannot be built
 * mid-upgrade.
 */
function createFoodTrackerViews(db: DatabaseSync): void {
  db.exec(`
    DROP VIEW IF EXISTS product_current_price;
    CREATE VIEW product_current_price AS
    SELECT
      pl.product_id,
      pl.id AS listing_id,
      pl.retailer,
      pl.retailer_item_id,
      pl.package_description,
      pl.package_grams,
      pl.servings_per_container,
      ph.price,
      ph.observed_at,
      ph.in_stock,
      CASE WHEN pl.servings_per_container > 0
           THEN ph.price / pl.servings_per_container END AS price_per_serving,
      CASE WHEN pl.package_grams > 0
           THEN ph.price / pl.package_grams END AS price_per_gram
    FROM product_listings pl
    JOIN price_history ph ON ph.id = (
      SELECT ph2.id FROM price_history ph2
      WHERE ph2.listing_id = pl.id
      ORDER BY ph2.observed_at DESC, ph2.id DESC
      LIMIT 1
    )
    WHERE pl.active = 1;

    DROP VIEW IF EXISTS product_price;
    CREATE VIEW product_price AS
    SELECT pcp.* FROM product_current_price pcp
    WHERE pcp.listing_id = (
      SELECT pl.id FROM product_listings pl
      WHERE pl.product_id = pcp.product_id AND pl.active = 1
      ORDER BY pl.preferred DESC, (pl.retailer = 'walmart') DESC, pl.id
      LIMIT 1
    );

    DROP VIEW IF EXISTS recipe_effective_rows;
    CREATE VIEW recipe_effective_rows AS
    -- v9: one row per recipe_ingredients row at the recipe's saved portion
    -- (people = 1). Mirrors apps/food-ui/src/scaling.ts scaledGrams():
    --   quantity_g NULL          → NULL (nothing to scale; eff_* fall back to
    --                              the row's stored macros)
    --   lock serving/batch, or portion = 1, or quantity_g ≤ 0 → base grams
    --   else quantity_g × portion, snapped to the row's step when it has one
    --        (MAX(step, ROUND(scaled / step) × step)); a row at its own base
    --        amount is never snapped.
    -- step_g: the product's scale_step_g, or a component's unit weight
    -- (yield_g / batch_units, v7). Per-gram macros follow the existing
    -- COALESCE convention: stored row macros win, then the product's
    -- grams_per_serving, then the component's batch yield.
    -- v10: a removed row (drained whey, discarded fat) keeps a positive
    -- effective_g — it scales with the batch like any other row unless
    -- locked — but its eff_* macros are NEGATIVE, so summing the view gives
    -- the mass-balance total (inputs minus what was taken out).
    SELECT
      x.id, x.recipe_id, x.product_id, x.sub_recipe_id, x.ingredient_name,
      x.quantity, x.quantity_g, x.scale_lock, x.portion, x.step_g, x.effective_g,
      x.removed,
      x.sign * (CASE WHEN x.quantity_g IS NULL THEN x.row_calories
           ELSE ROUND(x.pg_calories * x.effective_g) END) AS eff_calories,
      x.sign * (CASE WHEN x.quantity_g IS NULL THEN x.row_protein_g
           ELSE ROUND(x.pg_protein_g * x.effective_g, 1) END) AS eff_protein_g,
      x.sign * (CASE WHEN x.quantity_g IS NULL THEN x.row_carbs_g
           ELSE ROUND(x.pg_carbs_g * x.effective_g, 1) END) AS eff_carbs_g,
      x.sign * (CASE WHEN x.quantity_g IS NULL THEN x.row_fat_g
           ELSE ROUND(x.pg_fat_g * x.effective_g, 1) END) AS eff_fat_g,
      x.sign * (CASE WHEN x.quantity_g IS NULL THEN x.row_fiber_g
           ELSE ROUND(x.pg_fiber_g * x.effective_g, 1) END) AS eff_fiber_g
    FROM (
      SELECT
        y.*,
        CASE WHEN y.removed THEN -1 ELSE 1 END AS sign,
        CASE
          WHEN y.quantity_g IS NULL THEN NULL
          WHEN y.quantity_g <= 0 THEN y.quantity_g
          WHEN y.scale_lock IN ('serving', 'batch') OR y.portion = 1 THEN y.quantity_g
          WHEN y.step_g > 0 THEN ROUND(MAX(y.step_g, ROUND(y.quantity_g * y.portion / y.step_g) * y.step_g), 1)
          ELSE ROUND(y.quantity_g * y.portion, 1)
        END AS effective_g
      FROM (
        SELECT
          ri.id, ri.recipe_id, ri.product_id, ri.sub_recipe_id, ri.ingredient_name,
          ri.quantity, ri.quantity_g, ri.scale_lock, ri.removed,
          r.portion,
          COALESCE(p.scale_step_g,
                   CASE WHEN sr.batch_units > 0 AND sr.yield_g > 0 THEN sr.yield_g * 1.0 / sr.batch_units END) AS step_g,
          ri.calories AS row_calories, ri.protein_g AS row_protein_g, ri.carbs_g AS row_carbs_g,
          ri.fat_g AS row_fat_g, ri.fiber_g AS row_fiber_g,
          COALESCE(ri.calories * 1.0 / NULLIF(ri.quantity_g, 0), p.calories * 1.0 / NULLIF(p.grams_per_serving, 0),
                   sr.total_calories * 1.0 / NULLIF(sr.yield_g, 0)) AS pg_calories,
          COALESCE(ri.protein_g * 1.0 / NULLIF(ri.quantity_g, 0), p.protein_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                   sr.total_protein_g * 1.0 / NULLIF(sr.yield_g, 0)) AS pg_protein_g,
          COALESCE(ri.carbs_g * 1.0 / NULLIF(ri.quantity_g, 0), p.carbs_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                   sr.total_carbs_g * 1.0 / NULLIF(sr.yield_g, 0)) AS pg_carbs_g,
          COALESCE(ri.fat_g * 1.0 / NULLIF(ri.quantity_g, 0), p.fat_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                   sr.total_fat_g * 1.0 / NULLIF(sr.yield_g, 0)) AS pg_fat_g,
          COALESCE(ri.fiber_g * 1.0 / NULLIF(ri.quantity_g, 0), p.fiber_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                   sr.total_fiber_g * 1.0 / NULLIF(sr.yield_g, 0)) AS pg_fiber_g
        FROM recipe_ingredients ri
        JOIN recipes r ON r.id = ri.recipe_id
        LEFT JOIN products p ON p.id = ri.product_id
        LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
      ) y
    ) x;

    DROP VIEW IF EXISTS recipe_base_cost;
    CREATE VIEW recipe_base_cost AS
    SELECT
      r.id AS recipe_id,
      r.servings,
      r.yield_g,
      SUM(ri.effective_g * pp.price_per_gram) AS product_cost,
      -- base (portion ×1) cost: what parents see when they use this as a component
      SUM(ri.quantity_g * pp.price_per_gram) AS base_product_cost,
      SUM(CASE WHEN ri.id IS NOT NULL AND ri.sub_recipe_id IS NULL AND (ri.effective_g IS NULL OR pp.price_per_gram IS NULL)
               THEN 1 ELSE 0 END) AS unpriced_products
    FROM recipes r
    -- v9: effective grams at the recipe's saved portion
    -- v10: removed rows are never costed (nothing was bought to discard)
    LEFT JOIN recipe_effective_rows ri ON ri.recipe_id = r.id AND ri.sub_recipe_id IS NULL AND ri.removed = 0
    LEFT JOIN product_price pp ON pp.product_id = ri.product_id
    GROUP BY r.id;

    DROP VIEW IF EXISTS recipe_cost;
    CREATE VIEW recipe_cost AS
    -- Full nesting (v8): walk each recipe's component tree (depth ≤ 6) and
    -- apply every component's product cost scaled by grams used ÷ its
    -- yield_g at each hop, so a base built on another component still costs.
    WITH RECURSIVE contrib(root_id, recipe_id, factor, depth) AS (
      SELECT id, id, 1.0, 0 FROM recipes
      UNION ALL
      SELECT c.root_id, ri.sub_recipe_id,
             -- a component's OWN portion never reaches its parents: only the root
             -- recipe's rows are taken at their effective grams
             c.factor * (CASE WHEN c.depth = 0 THEN ri.effective_g ELSE ri.quantity_g END) / NULLIF(sr.yield_g, 0),
             c.depth + 1
      FROM contrib c
      JOIN recipe_effective_rows ri ON ri.recipe_id = c.recipe_id AND ri.sub_recipe_id IS NOT NULL AND ri.removed = 0
      JOIN recipes sr ON sr.id = ri.sub_recipe_id
      WHERE c.depth < 6
    )
    SELECT
      r.id AS recipe_id,
      SUM(CASE WHEN c.factor IS NOT NULL THEN c.factor * COALESCE(CASE WHEN c.depth = 0 THEN b.product_cost ELSE b.base_product_cost END, 0) ELSE 0 END) AS total_cost,
      CASE WHEN r.servings > 0
           THEN SUM(CASE WHEN c.factor IS NOT NULL THEN c.factor * COALESCE(CASE WHEN c.depth = 0 THEN b.product_cost ELSE b.base_product_cost END, 0) ELSE 0 END) / r.servings END AS cost_per_serving,
      SUM(CASE WHEN c.factor IS NOT NULL THEN COALESCE(b.unpriced_products, 0) ELSE 0 END)
        + SUM(CASE WHEN c.depth > 0 AND c.factor IS NULL THEN 1 ELSE 0 END) AS unpriced_ingredients
    FROM recipes r
    JOIN contrib c ON c.root_id = r.id
    LEFT JOIN recipe_base_cost b ON b.recipe_id = c.recipe_id
    GROUP BY r.id;

    DROP VIEW IF EXISTS recipe_summary;
    CREATE VIEW recipe_summary AS
    -- v9: totals are the sum of recipe_effective_rows at the saved portion,
    -- not the stored recipes.total_* rollups (which stay at the base amounts
    -- and are what recalculateRecipeTotals writes).
    -- v10: eff_* are signed, so a removed row subtracts here. Nothing is
    -- clamped — removing more than went in goes negative, which is the signal.
    WITH eff AS (
      SELECT recipe_id,
             CAST(ROUND(SUM(eff_calories)) AS INTEGER) AS total_calories,
             ROUND(SUM(eff_protein_g), 1) AS total_protein_g,
             ROUND(SUM(eff_carbs_g), 1) AS total_carbs_g,
             ROUND(SUM(eff_fat_g), 1) AS total_fat_g,
             ROUND(SUM(eff_fiber_g), 1) AS total_fiber_g
      FROM recipe_effective_rows
      GROUP BY recipe_id
    )
    SELECT
      r.id,
      r.name,
      r.shorthand,
      r.servings,
      r.portion,
      COALESCE(e.total_calories, 0) AS total_calories,
      COALESCE(e.total_protein_g, 0) AS total_protein_g,
      COALESCE(e.total_carbs_g, 0) AS total_carbs_g,
      COALESCE(e.total_fat_g, 0) AS total_fat_g,
      COALESCE(e.total_fiber_g, 0) AS total_fiber_g,
      CASE WHEN r.servings > 0 THEN ROUND(COALESCE(e.total_calories, 0) * 1.0 / r.servings) ELSE COALESCE(e.total_calories, 0) END AS per_serving_cal,
      CASE WHEN r.servings > 0 THEN ROUND(COALESCE(e.total_protein_g, 0) / r.servings, 1) ELSE COALESCE(e.total_protein_g, 0) END AS per_serving_prot,
      CASE WHEN r.servings > 0 THEN ROUND(COALESCE(e.total_carbs_g, 0) / r.servings, 1) ELSE COALESCE(e.total_carbs_g, 0) END AS per_serving_carb,
      CASE WHEN r.servings > 0 THEN ROUND(COALESCE(e.total_fat_g, 0) / r.servings, 1) ELSE COALESCE(e.total_fat_g, 0) END AS per_serving_fat,
      CASE WHEN r.servings > 0 THEN ROUND(COALESCE(e.total_fiber_g, 0) / r.servings, 1) ELSE COALESCE(e.total_fiber_g, 0) END AS per_serving_fiber,
      ROUND(rc.cost_per_serving, 2) AS per_serving_cost,
      rc.unpriced_ingredients,
      r.instructions,
      r.notes
    FROM recipes r
    LEFT JOIN eff e ON e.recipe_id = r.id
    LEFT JOIN recipe_cost rc ON rc.recipe_id = r.id;

    DROP VIEW IF EXISTS plan_summary;
    CREATE VIEW plan_summary AS
    SELECT
      mp.id AS plan_id,
      mp.name,
      e.day_index,
      ROUND(SUM(e.servings)) AS servings,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_cal, p.calories, 0))) AS calories,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_prot, p.protein_g, 0)), 1) AS protein_g,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_fiber, p.fiber_g, 0)), 1) AS fiber_g,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_fat, p.fat_g, 0)), 1) AS fat_g,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_cost, pp.price_per_serving)), 2) AS cost_total
    FROM meal_plans mp
    JOIN meal_plan_entries e ON e.plan_id = mp.id
    LEFT JOIN recipe_summary rs ON rs.id = e.recipe_id
    LEFT JOIN products p ON p.id = e.product_id
    LEFT JOIN product_price pp ON pp.product_id = e.product_id
    GROUP BY mp.id, e.day_index;

    DROP VIEW IF EXISTS shopping_list;
    CREATE VIEW shopping_list AS
    WITH RECURSIVE expand(plan_id, recipe_id, factor, depth) AS (
      -- v8: planned recipes expand through their components (depth ≤ 6) so a
      -- bowl built on shredded chicken puts raw thighs on the list.
      SELECT e.plan_id, e.recipe_id, e.servings * 1.0 / NULLIF(r.servings, 0), 0
      FROM meal_plan_entries e
      JOIN recipes r ON r.id = e.recipe_id
      WHERE e.recipe_id IS NOT NULL
      UNION ALL
      SELECT x.plan_id, ri.sub_recipe_id,
             x.factor * (CASE WHEN x.depth = 0 THEN ri.effective_g ELSE ri.quantity_g END) / NULLIF(sr.yield_g, 0),
             x.depth + 1
      FROM expand x
      JOIN recipe_effective_rows ri ON ri.recipe_id = x.recipe_id AND ri.sub_recipe_id IS NOT NULL AND ri.removed = 0
      JOIN recipes sr ON sr.id = ri.sub_recipe_id
      WHERE x.depth < 6
    ),
    needs AS (
      -- v9: effective grams at each recipe's saved portion
      -- v10: removed rows are never shopped
      SELECT x.plan_id, ri.product_id, (CASE WHEN x.depth = 0 THEN ri.effective_g ELSE ri.quantity_g END) * x.factor AS grams
      FROM expand x
      JOIN recipe_effective_rows ri ON ri.recipe_id = x.recipe_id AND ri.product_id IS NOT NULL AND ri.removed = 0
      UNION ALL
      SELECT e.plan_id, e.product_id,
             p.grams_per_serving * e.servings AS grams
      FROM meal_plan_entries e
      JOIN products p ON p.id = e.product_id
      WHERE e.product_id IS NOT NULL
    ),
    totals AS (
      SELECT n.plan_id, n.product_id, SUM(n.grams) AS grams_needed
      FROM needs n
      GROUP BY n.plan_id, n.product_id
    )
    SELECT
      t.plan_id,
      t.product_id,
      pr.name AS product_name,
      ROUND(t.grams_needed, 1) AS grams_needed,
      pp.package_grams,
      CASE WHEN pp.package_grams > 0 THEN
        CAST(t.grams_needed / pp.package_grams AS INTEGER)
          + (t.grams_needed > CAST(t.grams_needed / pp.package_grams AS INTEGER) * pp.package_grams)
      END AS containers_to_buy,
      CASE WHEN pp.package_grams > 0 THEN
        ROUND((CAST(t.grams_needed / pp.package_grams AS INTEGER)
          + (t.grams_needed > CAST(t.grams_needed / pp.package_grams AS INTEGER) * pp.package_grams)) * pp.price, 2)
      END AS est_cost
    FROM totals t
    JOIN products pr ON pr.id = t.product_id
    LEFT JOIN product_price pp ON pp.product_id = t.product_id;
  `);
}

function applyRetailerMigration(db: DatabaseSync): void {
  // SQLite can't alter a CHECK constraint: rebuild product_listings with the
  // widened retailer set, preserving ids (price_history references them).
  // price_history's FK would fail the DROP while rows exist; ensureWellnessDb
  // disables foreign_keys around the migration transaction (SQLite's
  // documented rebuild procedure) and runs foreign_key_check before COMMIT.
  for (const view of ['shopping_list', 'plan_summary', 'recipe_summary', 'recipe_cost', 'recipe_base_cost', 'recipe_effective_rows', 'product_price', 'product_current_price']) {
    db.exec(`DROP VIEW IF EXISTS ${view}`);
  }
  db.exec(`
    CREATE TABLE product_listings_v3 (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      retailer TEXT NOT NULL CHECK(retailer IN ('walmart','amazon','costco','other')),
      retailer_item_id TEXT,
      url TEXT,
      package_description TEXT,
      package_grams REAL,
      servings_per_container REAL,
      active INTEGER NOT NULL DEFAULT 1,
      preferred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO product_listings_v3 SELECT id, product_id, retailer, retailer_item_id, url, package_description,
      package_grams, servings_per_container, active, preferred, created_at FROM product_listings;
    DROP TABLE product_listings;
    ALTER TABLE product_listings_v3 RENAME TO product_listings;
  `);
}

function applyRecipeScalingMigration(db: DatabaseSync): void {
  // Two-dimension scaling model (docs/specs/food-tracker.md §3, "v6 — scaling"):
  // the ingredient's natural increment lives on the product, the scaling rule
  // lives on the recipe row, and goal phases are multipliers applied to rows
  // whose lock is 'none'. Views need no change — per-serving and per-100g
  // figures are scale-invariant, so grams for N people at phase P are computed
  // at read time (UI now, logger later).
  addColumnIfMissing(db, "products", "scale_step_g", "REAL");
  addColumnIfMissing(db, "products", "scale_step_label", "TEXT");
  // Component recipes come apart in units too ("one taco base per taco"), so
  // the same step lives on recipes; a parent row snaps to whichever it links.
  addColumnIfMissing(db, "recipes", "scale_step_g", "REAL");
  addColumnIfMissing(db, "recipes", "scale_step_label", "TEXT");
  // SQLite accepts a CHECK constraint on ADD COLUMN (only PRIMARY KEY/UNIQUE
  // are disallowed, and NOT NULL needs a non-NULL default, which we have), and
  // the default satisfies the constraint for every existing row — so this is a
  // plain column add rather than a trigger pair. Verified on node:sqlite 3.53.
  addColumnIfMissing(
    db,
    "recipe_ingredients",
    "scale_lock",
    "TEXT NOT NULL DEFAULT 'none' CHECK (scale_lock IN ('none','serving','batch'))",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_phases (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      multiplier REAL NOT NULL CHECK (multiplier > 0),
      is_current INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    -- At most one current phase: the partial index only covers is_current = 1
    -- rows, so any number of rows may be 0.
    CREATE UNIQUE INDEX IF NOT EXISTS goal_phases_current
      ON goal_phases(is_current) WHERE is_current = 1;
    INSERT OR IGNORE INTO goal_phases (key, name, multiplier, is_current, sort_order) VALUES
      ('weight_loss', 'Weight loss', 1.0, 1, 0),
      ('maintenance', 'Maintenance', 1.3, 0, 1),
      ('bulk', 'Bulk', 1.6, 0, 2);
  `);
}

/**
 * v7 — component recipes count in units, not a frozen gram step. A component's
 * "step" used to be a stored gram figure (v6 `recipes.scale_step_g`) that
 * drifted whenever the recipe changed; now a batch declares how many units it
 * makes and the unit weight is derived (`yield_g / batch_units`). Existing
 * gram steps are converted; the old column is left in place, unused.
 */
function applyBatchUnitsMigration(db: DatabaseSync): void {
  addColumnIfMissing(db, "recipes", "batch_units", "REAL");
  db.exec(`
    UPDATE recipes
       SET batch_units = ROUND(yield_g * 1.0 / scale_step_g, 2)
     WHERE batch_units IS NULL AND scale_step_g > 0 AND yield_g > 0;
  `);
}

/**
 * Materialize the wellness DB if absent and bring it to WELLNESS_DB_VERSION.
 * Safe to call from multiple processes (bot startup, food-ui server, scripts):
 * WAL + busy_timeout + a version check inside the write transaction make the
 * upgrade race-free and idempotent.
 */
export function ensureWellnessDb(dbPathOverride?: string): EnsureWellnessDbReport {
  const dbPath = resolveWellnessDbPath(dbPathOverride);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const existed = fs.existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    // Table rebuilds (v3) need FKs off; the pragma is a no-op inside a
    // transaction, so it has to be set here. foreign_key_check runs before
    // COMMIT so a bad rebuild can never land.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      let version = getUserVersion(db);
      if (!tableExists(db, "products")) {
        createWellnessDbSchema(db);
        version = 1;
      } else if (version === 0) {
        // A hand-applied schema that predates versioning.
        version = 1;
      }
      const fromVersion = existed ? getUserVersion(db) : 0;
      const startVersion = version;
      if (version < 2) {
        applyFoodTrackerMigration(db);
        version = 2;
      }
      if (version < 3) {
        applyRetailerMigration(db);
        version = 3;
      }
      if (version < 4) {
        addColumnIfMissing(db, "recipes", "archived_at", "TEXT");
        version = 4;
      }
      if (version < 5) {
        // Views only (component cost rolled into the parent); rebuilt below.
        version = 5;
      }
      if (version < 6) {
        applyRecipeScalingMigration(db);
        version = 6;
      }
      if (version < 7) {
        applyBatchUnitsMigration(db);
        version = 7;
      }
      if (version < 8) {
        // Views only: recursive component cost + recursive shopping expansion; rebuilt below.
        version = 8;
      }
      if (version < 9) {
        // Saved portion (docs/specs/food-tracker.md §3, "v9 — saved portion"):
        // ×1.0 keeps every existing recipe at its stored base, so the rebuilt
        // views reproduce the v8 figures until a portion is changed.
        addColumnIfMissing(db, "recipes", "portion", "REAL NOT NULL DEFAULT 1.0 CHECK (portion > 0)");
        version = 9;
      }
      if (version < 10) {
        // Removed rows (docs/specs/food-tracker.md §3, "v10 — removed rows"):
        // default 0 keeps every existing row additive, so the rebuilt views
        // reproduce the v9 figures until a row is flagged.
        addColumnIfMissing(db, "recipe_ingredients", "removed", "INTEGER NOT NULL DEFAULT 0 CHECK (removed IN (0, 1))");
        version = 10;
      }
      if (version < 11) {
        // Pinned (starred) recipes: the ones used constantly stay at the top of
        // the table and search. Timestamp so the order among pins is stable.
        addColumnIfMissing(db, "recipes", "pinned_at", "TEXT");
        version = 11;
      }
      if (version !== startVersion) {
        // Every view depends on the final column set; one rebuild covers all steps.
        createFoodTrackerViews(db);
      }
      setUserVersion(db, version);
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(`wellness.db migration left ${violations.length} foreign key violation(s)`);
      }
      db.exec("COMMIT");
      return { path: dbPath, created: !existed, fromVersion, toVersion: version };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    db.close();
  }
}
