import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  WELLNESS_DB_VERSION,
  ensureWellnessDb,
} from "../src/wellness-db-migrations.js";
import { createWellnessDbSchema } from "../src/wellness-db-tools.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wellness-mig-"));
  tempDirs.push(dir);
  return path.join(dir, "nested", "wellness.db");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The v10 views reference scale_lock / scale_step_g / batch_units / portion / removed, and
 * SQLite refuses DROP COLUMN while a view depends on the column — fixtures that
 * strip columns to fake an older version drop the views first (the upgrade
 * rebuilds them).
 */
function dropFoodTrackerViews(db: DatabaseSync): void {
  for (const view of ["shopping_list", "plan_summary", "recipe_summary", "recipe_cost", "recipe_base_cost",
    "recipe_effective_rows", "product_price", "product_current_price"]) {
    db.exec(`DROP VIEW IF EXISTS ${view}`);
  }
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("ensureWellnessDb", () => {
  it("materializes a fresh DB at the current version, creating directories", () => {
    const dbPath = tempDbPath();
    const report = ensureWellnessDb(dbPath);
    expect(report.created).toBe(true);
    expect(report.fromVersion).toBe(0);
    expect(report.toVersion).toBe(WELLNESS_DB_VERSION);

    const db = new DatabaseSync(dbPath);
    const names = tableNames(db);
    for (const expected of [
      "products",
      "recipes",
      "meal_log",
      "product_listings",
      "price_history",
      "meal_plans",
      "meal_plan_entries",
      "fatsecret_entry_links",
      "product_current_price",
      "product_price",
      "recipe_cost",
      "recipe_summary",
      "plan_summary",
      "shopping_list",
    ]) {
      expect(names).toContain(expected);
    }
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(WELLNESS_DB_VERSION);
    db.close();
  });

  it("upgrades a legacy v1 DB in place, preserving data", () => {
    const dbPath = tempDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    createWellnessDbSchema(legacy);
    legacy
      .prepare("INSERT INTO products (id, name, calories, protein_g) VALUES (1, 'Black Beans', 110, 7)")
      .run();
    legacy.close();

    const report = ensureWellnessDb(dbPath);
    expect(report.created).toBe(false);
    expect(report.toVersion).toBe(WELLNESS_DB_VERSION);

    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT name, calories, fiber_g, fatsecret_food_id FROM products WHERE id = 1")
      .get() as { name: string; calories: number; fiber_g: number | null };
    expect(row.name).toBe("Black Beans");
    expect(row.calories).toBe(110);
    expect(row.fiber_g).toBeNull();
    db.close();
  });

  it("is idempotent", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const second = ensureWellnessDb(dbPath);
    expect(second.created).toBe(false);
    expect(second.fromVersion).toBe(WELLNESS_DB_VERSION);
    expect(second.toVersion).toBe(WELLNESS_DB_VERSION);
  });

  it("computes price-per-serving, recipe cost, plan cost, and shopping list", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);

    // Black beans: $1.12/can, 3.5 servings of 130g each (455g net).
    db.prepare(
      `INSERT INTO products (id, name, calories, protein_g, carbs_g, fat_g, fiber_g, grams_per_serving)
       VALUES (1, 'Black Beans', 110, 7, 20, 0.5, 7, 130)`,
    ).run();
    db.prepare(
      `INSERT INTO product_listings (id, product_id, retailer, retailer_item_id, package_grams, servings_per_container, preferred)
       VALUES (10, 1, 'walmart', '10000001', 455, 3.5, 1)`,
    ).run();
    db.prepare(
      "INSERT INTO price_history (listing_id, price, observed_at) VALUES (10, 2.00, '2026-08-01T00:00:00')",
    ).run();
    db.prepare(
      "INSERT INTO price_history (listing_id, price, observed_at) VALUES (10, 1.12, '2026-09-01T00:00:00')",
    ).run();

    const price = db
      .prepare("SELECT price, price_per_serving, price_per_gram FROM product_price WHERE product_id = 1")
      .get() as { price: number; price_per_serving: number; price_per_gram: number };
    expect(price.price).toBe(1.12); // latest observation wins
    expect(price.price_per_serving).toBeCloseTo(0.32, 2);
    expect(price.price_per_gram).toBeCloseTo(1.12 / 455, 5);

    // Tacos: 4 servings, 260g of beans total (220 cal, 14 g fiber across the batch).
    db.prepare("INSERT INTO recipes (id, name, servings, total_calories, total_fiber_g) VALUES (1, 'Tacos', 4, 220, 14)").run();
    db.prepare(
      `INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity, quantity_g, calories, protein_g, fiber_g)
       VALUES (1, 1, 'Black Beans', '2 cups', 260, 220, 14, 14)`,
    ).run();

    const recipe = db
      .prepare("SELECT per_serving_cost, per_serving_fiber, unpriced_ingredients FROM recipe_summary WHERE id = 1")
      .get() as { per_serving_cost: number; per_serving_fiber: number; unpriced_ingredients: number };
    // 260g × ($1.12 / 455g) = $0.64 total → $0.16/serving
    expect(recipe.per_serving_cost).toBeCloseTo(0.16, 2);
    expect(recipe.per_serving_fiber).toBeCloseTo(3.5, 1);
    expect(recipe.unpriced_ingredients).toBe(0);

    // Plan: taco dinner, 4 total portions on day 0 (servings are per-meal).
    db.prepare("INSERT INTO meal_plans (id, name) VALUES (1, 'Test Week')").run();
    db.prepare(
      "INSERT INTO meal_plan_entries (plan_id, day_index, meal, recipe_id, servings) VALUES (1, 0, 'dinner', 1, 4)",
    ).run();

    const plan = db
      .prepare("SELECT servings, calories, cost_total FROM plan_summary WHERE plan_id = 1 AND day_index = 0")
      .get() as { servings: number; calories: number; cost_total: number };
    expect(plan.servings).toBe(4);
    expect(plan.calories).toBe(220); // 4 portions × 55 cal/serving (v9: totals come from the rows)
    expect(plan.cost_total).toBeCloseTo(0.64, 2);

    // Shopping list: 4 portions × 65g/recipe-serving = 260g → 1 can.
    const list = db
      .prepare("SELECT grams_needed, containers_to_buy, est_cost FROM shopping_list WHERE plan_id = 1 AND product_id = 1")
      .get() as { grams_needed: number; containers_to_buy: number; est_cost: number };
    expect(list.grams_needed).toBeCloseTo(260, 1);
    expect(list.containers_to_buy).toBe(1);
    expect(list.est_cost).toBeCloseTo(1.12, 2);
    db.close();
  });

  it("v3 accepts costco listings and preserves listing ids through the rebuild", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO products (id, name) VALUES (1, 'Olive Oil')").run();
    db.prepare("INSERT INTO product_listings (id, product_id, retailer, retailer_item_id) VALUES (7, 1, 'costco', 'kirkland-evoo')").run();
    db.prepare("INSERT INTO price_history (listing_id, price) VALUES (7, 24.99)").run();
    const row = db.prepare("SELECT retailer, price FROM product_price WHERE product_id = 1").get() as { retailer: string; price: number };
    expect(row.retailer).toBe("costco");
    expect(row.price).toBe(24.99);
    expect(() => db.prepare("INSERT INTO product_listings (product_id, retailer) VALUES (1, 'target')").run()).toThrow();
    db.close();
  });

  it("v2 → v3 rebuild succeeds with populated listings and price history", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO products (id, name) VALUES (1, 'Black Beans')").run();
    db.prepare("INSERT INTO product_listings (id, product_id, retailer, retailer_item_id) VALUES (3, 1, 'walmart', '10000002')").run();
    db.prepare("INSERT INTO price_history (listing_id, price) VALUES (3, 0.92)").run();
    db.exec("PRAGMA user_version = 2"); // pretend we're pre-v3 with real data
    db.close();

    const report = ensureWellnessDb(dbPath);
    expect(report.fromVersion).toBe(2);
    expect(report.toVersion).toBe(WELLNESS_DB_VERSION);
    const check = new DatabaseSync(dbPath);
    const row = check.prepare("SELECT price FROM product_price WHERE product_id = 1").get() as { price: number };
    expect(row.price).toBe(0.92);
    check.close();
  });

  it("rolls a component recipe's cost into the parent by grams used", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);
    // yogurt: $3.00 per 900g → $0.003333/g
    db.prepare("INSERT INTO products (id, name, grams_per_serving) VALUES (1, 'Yogurt', 150)").run();
    db.prepare("INSERT INTO product_listings (id, product_id, retailer, package_grams, servings_per_container, preferred) VALUES (1, 1, 'walmart', 900, 6, 1)").run();
    db.prepare("INSERT INTO price_history (listing_id, price) VALUES (1, 3.00)").run();
    // crema: 35g yogurt → 50g batch = $0.1167/batch → $0.002333/g
    db.prepare("INSERT INTO recipes (id, name, servings, yield_g) VALUES (10, 'Crema', 1, 50)").run();
    db.prepare("INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g) VALUES (10, 1, 'Yogurt', 35)").run();
    // salad: 100g yogurt directly + 50g of crema, 2 servings
    db.prepare("INSERT INTO recipes (id, name, servings) VALUES (20, 'Salad', 2)").run();
    db.prepare("INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g) VALUES (20, 1, 'Yogurt', 100)").run();
    db.prepare("INSERT INTO recipe_ingredients (recipe_id, sub_recipe_id, ingredient_name, quantity_g) VALUES (20, 10, 'Crema', 50)").run();
    const row = db.prepare("SELECT total_cost, cost_per_serving, unpriced_ingredients FROM recipe_cost WHERE recipe_id = 20").get() as { total_cost: number; cost_per_serving: number; unpriced_ingredients: number };
    // 100g × 0.003333 = 0.3333 ; crema 50g × (0.1167/50) = 0.1167 → 0.45 total, 0.225/srv
    expect(row.total_cost).toBeCloseTo(0.45, 3);
    expect(row.cost_per_serving).toBeCloseTo(0.225, 3);
    expect(row.unpriced_ingredients).toBe(0);
    // a component with no yield counts as unpriced rather than silently $0
    db.prepare("UPDATE recipes SET yield_g = NULL WHERE id = 10").run();
    const noYield = db.prepare("SELECT unpriced_ingredients FROM recipe_cost WHERE recipe_id = 20").get() as { unpriced_ingredients: number };
    expect(noYield.unpriced_ingredients).toBe(1);
    db.close();
  });

  it("recipe writes touch updated_at without error on a fresh DB", () => {
    // recalculateRecipeTotals writes recipes.updated_at, which the base v1
    // schema never created; v2 adds it. Guard against regression.
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);
    const cols = db.prepare("PRAGMA table_info(recipes)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("updated_at");
    expect(cols.map((c) => c.name)).toContain("total_fiber_g");
    expect(cols.map((c) => c.name)).toContain("yield_g");
    expect(cols.map((c) => c.name)).toContain("archived_at");
    const ricols = db.prepare("PRAGMA table_info(recipe_ingredients)").all() as Array<{ name: string }>;
    expect(ricols.map((c) => c.name)).toContain("sub_recipe_id");
    db.close();
  });

  describe("v6 recipe scaling", () => {
    /** Materialize at the current version, then strip the v6 bits and stamp v5. */
    function seedV5Db(dbPath: string): void {
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      db.prepare("INSERT INTO products (id, name, calories, grams_per_serving) VALUES (1, 'Egg', 70, 50)").run();
      db.prepare("INSERT INTO products (id, name, calories, grams_per_serving) VALUES (2, 'Frozen Veg', 30, 85)").run();
      db.prepare("INSERT INTO recipes (id, name, servings) VALUES (1, 'Scramble', 2)").run();
      db.prepare(
        "INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity, quantity_g) VALUES (1, 1, 'Egg', '2 eggs', 100)",
      ).run();
      db.prepare(
        "INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity, quantity_g) VALUES (1, 2, 'Frozen Veg', '½ bag', 140)",
      ).run();
      dropFoodTrackerViews(db);
      db.exec(`
        DROP INDEX IF EXISTS goal_phases_current;
        DROP TABLE IF EXISTS goal_phases;
        ALTER TABLE products DROP COLUMN scale_step_g;
        ALTER TABLE products DROP COLUMN scale_step_label;
        ALTER TABLE recipe_ingredients DROP COLUMN scale_lock;
        ALTER TABLE recipes DROP COLUMN scale_step_g;
        ALTER TABLE recipes DROP COLUMN scale_step_label;
        PRAGMA user_version = 5;
      `);
      db.close();
    }

    it("fresh DB is at v6 with the three seeded phases and weight_loss current", () => {
      const dbPath = tempDbPath();
      const report = ensureWellnessDb(dbPath);
      expect(report.toVersion).toBe(11);
      const db = new DatabaseSync(dbPath);
      const phases = db
        .prepare("SELECT key, name, multiplier, is_current, sort_order FROM goal_phases ORDER BY sort_order")
        .all() as Array<{ key: string; name: string; multiplier: number; is_current: number; sort_order: number }>;
      expect(phases).toEqual([
        { key: "weight_loss", name: "Weight loss", multiplier: 1.0, is_current: 1, sort_order: 0 },
        { key: "maintenance", name: "Maintenance", multiplier: 1.3, is_current: 0, sort_order: 1 },
        { key: "bulk", name: "Bulk", multiplier: 1.6, is_current: 0, sort_order: 2 },
      ]);
      const cols = (db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain("scale_step_g");
      expect(cols).toContain("scale_step_label");
      const ricols = (db.prepare("PRAGMA table_info(recipe_ingredients)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>);
      const lock = ricols.find((c) => c.name === "scale_lock");
      expect(lock?.notnull).toBe(1);
      expect(lock?.dflt_value).toBe("'none'");
      db.close();
    });

    it("upgrades a v5 DB in place: existing rows get scale_lock 'none', NULL step columns, data preserved", () => {
      const dbPath = tempDbPath();
      seedV5Db(dbPath);
      // sanity: the fixture really is v5-shaped
      const pre = new DatabaseSync(dbPath);
      expect((pre.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
      expect(tableNames(pre)).not.toContain("goal_phases");
      pre.close();

      const report = ensureWellnessDb(dbPath);
      expect(report.created).toBe(false);
      expect(report.fromVersion).toBe(5);
      expect(report.toVersion).toBe(11);

      const db = new DatabaseSync(dbPath);
      const locks = db
        .prepare("SELECT scale_lock, COUNT(*) AS n FROM recipe_ingredients GROUP BY scale_lock")
        .all() as Array<{ scale_lock: string; n: number }>;
      expect(locks).toEqual([{ scale_lock: "none", n: 2 }]);
      const ing = db
        .prepare("SELECT ingredient_name, quantity, quantity_g FROM recipe_ingredients ORDER BY id")
        .all() as Array<{ ingredient_name: string; quantity: string; quantity_g: number }>;
      expect(ing).toEqual([
        { ingredient_name: "Egg", quantity: "2 eggs", quantity_g: 100 },
        { ingredient_name: "Frozen Veg", quantity: "½ bag", quantity_g: 140 },
      ]);
      const products = db
        .prepare("SELECT name, calories, scale_step_g, scale_step_label FROM products ORDER BY id")
        .all() as Array<{ name: string; calories: number; scale_step_g: number | null; scale_step_label: string | null }>;
      expect(products).toEqual([
        { name: "Egg", calories: 70, scale_step_g: null, scale_step_label: null },
        { name: "Frozen Veg", calories: 30, scale_step_g: null, scale_step_label: null },
      ]);
      const current = db.prepare("SELECT key FROM goal_phases WHERE is_current = 1").all() as Array<{ key: string }>;
      expect(current).toEqual([{ key: "weight_loss" }]);
      // the new columns are writable with real values
      db.prepare("UPDATE products SET scale_step_g = 50, scale_step_label = '1 egg' WHERE id = 1").run();
      db.prepare("UPDATE recipe_ingredients SET scale_lock = 'batch' WHERE product_id = 2").run();
      const updated = db
        .prepare("SELECT scale_lock FROM recipe_ingredients WHERE product_id = 2")
        .get() as { scale_lock: string };
      expect(updated.scale_lock).toBe("batch");
      db.close();
    });

    it("rejects invalid scale_lock values on insert and update", () => {
      const dbPath = tempDbPath();
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      db.prepare("INSERT INTO products (id, name) VALUES (1, 'Egg')").run();
      db.prepare("INSERT INTO recipes (id, name, servings) VALUES (1, 'Scramble', 2)").run();
      for (const ok of ["none", "serving", "batch"]) {
        db.prepare(
          "INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g, scale_lock) VALUES (1, 1, 'Egg', 50, ?)",
        ).run(ok);
      }
      expect(() =>
        db
          .prepare(
            "INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g, scale_lock) VALUES (1, 1, 'Egg', 50, 'people')",
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare("UPDATE recipe_ingredients SET scale_lock = 'locked'").run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare("UPDATE recipe_ingredients SET scale_lock = NULL").run()).toThrow(/NOT NULL constraint failed/);
      const n = db.prepare("SELECT COUNT(*) AS n FROM recipe_ingredients").get() as { n: number };
      expect(n.n).toBe(3);
      db.close();
    });

    it("allows at most one current goal phase", () => {
      const dbPath = tempDbPath();
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      expect(() =>
        db.prepare("INSERT INTO goal_phases (key, name, multiplier, is_current, sort_order) VALUES ('cut', 'Cut', 0.9, 1, 3)").run(),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() => db.prepare("UPDATE goal_phases SET is_current = 1 WHERE key = 'bulk'").run()).toThrow(
        /UNIQUE constraint failed/,
      );
      expect(() => db.prepare("UPDATE goal_phases SET multiplier = 0 WHERE key = 'bulk'").run()).toThrow(
        /CHECK constraint failed/,
      );
      // switching phases works when done as a single statement (no transient second 1)
      db.prepare("UPDATE goal_phases SET is_current = CASE WHEN key = 'bulk' THEN 1 ELSE 0 END").run();
      const current = db.prepare("SELECT key FROM goal_phases WHERE is_current = 1").all() as Array<{ key: string }>;
      expect(current).toEqual([{ key: "bulk" }]);
      // any number of non-current rows is fine
      db.prepare("INSERT INTO goal_phases (key, name, multiplier, is_current, sort_order) VALUES ('cut', 'Cut', 0.9, 0, 3)").run();
      db.close();
    });

    it("re-running on a v6 DB is a no-op that stays at v6 and keeps user edits to goal_phases", () => {
      const dbPath = tempDbPath();
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE goal_phases SET multiplier = 1.35 WHERE key = 'maintenance'").run();
      db.close();
      const second = ensureWellnessDb(dbPath);
      expect(second.fromVersion).toBe(11);
      expect(second.toVersion).toBe(11);
      const check = new DatabaseSync(dbPath);
      const m = check.prepare("SELECT multiplier FROM goal_phases WHERE key = 'maintenance'").get() as { multiplier: number };
      expect(m.multiplier).toBe(1.35); // INSERT OR IGNORE did not clobber it
      const n = check.prepare("SELECT COUNT(*) AS n FROM goal_phases").get() as { n: number };
      expect(n.n).toBe(3);
      check.close();
    });
  });

    it("v7 converts a component's gram step into batch_units", () => {
      const dbPath = tempDbPath();
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec("INSERT INTO recipes (id, name, yield_g, scale_step_g, scale_step_label) VALUES (5, 'Taco Base', 98.8, 98.8, '1 taco')");
      dropFoodTrackerViews(db);
      db.exec("ALTER TABLE recipes DROP COLUMN batch_units; PRAGMA user_version = 6;");
      db.close();
      expect(ensureWellnessDb(dbPath)).toMatchObject({ fromVersion: 6, toVersion: 11 });
      const check = new DatabaseSync(dbPath);
      expect(check.prepare("SELECT batch_units FROM recipes WHERE id = 5").get()).toEqual({ batch_units: 1 });
      check.close();
    });

    it("gives component recipes a unit step (scale_step_g / scale_step_label)", () => {
      const dbPath = tempDbPath();
      ensureWellnessDb(dbPath);
      const check = new DatabaseSync(dbPath);
      const recipeCols = (check.prepare("PRAGMA table_info(recipes)").all() as Array<{ name: string }>).map((c) => c.name);
      expect(recipeCols).toEqual(expect.arrayContaining(["scale_step_g", "scale_step_label"]));
      check.close();
    });

  describe("v8 recursive views", () => {
    it("costs and shops through two levels of components", () => {
      const dbPath = tempDbPath();
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec(`
        INSERT INTO products (id, name, grams_per_serving, calories) VALUES (1, 'Raw Thighs', 100, 200), (2, 'Chili', 100, 100);
        INSERT INTO product_listings (id, product_id, retailer, retailer_item_id, package_grams, servings_per_container)
          VALUES (1, 1, 'walmart', 'a', 1000, 10), (2, 2, 'walmart', 'b', 400, 4);
        INSERT INTO price_history (listing_id, observed_at, price) VALUES (1, '2026-09-01T00:00:00', 10.0), (2, '2026-09-01T00:00:00', 2.0);
        -- shredded chicken: 1000 g raw → 700 g cooked
        INSERT INTO recipes (id, name, servings, yield_g) VALUES (10, 'Shredded Chicken', 1, 700);
        INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g) VALUES (10, 1, 'Raw Thighs', 1000);
        -- chili base: 350 g chicken + 400 g chili → 750 g
        INSERT INTO recipes (id, name, servings, yield_g) VALUES (11, 'Chili Base', 1, 750);
        INSERT INTO recipe_ingredients (recipe_id, sub_recipe_id, ingredient_name, quantity_g) VALUES (11, 10, 'Shredded Chicken', 350);
        INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g) VALUES (11, 2, 'Chili', 400);
        -- bowl: 375 g of base per serving, 2 servings
        INSERT INTO recipes (id, name, servings) VALUES (12, 'Chili Bowl', 2);
        INSERT INTO recipe_ingredients (recipe_id, sub_recipe_id, ingredient_name, quantity_g) VALUES (12, 11, 'Chili Base', 750);
        INSERT INTO meal_plans (id, name) VALUES (1, 'wk');
        INSERT INTO meal_plan_entries (plan_id, day_index, meal, recipe_id, servings) VALUES (1, 0, 'dinner', 12, 1);
      `);
      // chicken batch = $10 for 700 g → $5 for 350 g; chili 400 g = $2; base = $7 per 750 g
      const base = db.prepare("SELECT total_cost FROM recipe_cost WHERE recipe_id = 11").get() as { total_cost: number };
      expect(base.total_cost).toBeCloseTo(7, 2);
      // bowl uses a whole base batch across 2 servings: $7 total, $3.50 per serving
      const bowl = db.prepare("SELECT total_cost, cost_per_serving, unpriced_ingredients FROM recipe_cost WHERE recipe_id = 12").get() as {
        total_cost: number; cost_per_serving: number; unpriced_ingredients: number;
      };
      expect(bowl.total_cost).toBeCloseTo(7, 2);
      expect(bowl.cost_per_serving).toBeCloseTo(3.5, 2);
      expect(bowl.unpriced_ingredients).toBe(0);
      // one planned serving of the bowl → 375 g base → 175 g chicken → 250 g raw thighs, plus 200 g chili
      const rows = db.prepare("SELECT product_id, grams_needed FROM shopping_list WHERE plan_id = 1 ORDER BY product_id").all() as Array<{ product_id: number; grams_needed: number }>;
      expect(rows).toEqual([{ product_id: 1, grams_needed: 250 }, { product_id: 2, grams_needed: 200 }]);
      db.close();
    });
  });

  describe("v9 saved portion", () => {
    /**
     * Bowl at portion 1.2, servings 1:
     *   100 g Chicken   (lock none, no step)        → 120
     *   100 g Cabbage   (lock serving)              → 100
     *    50 g Egg       (scale_step_g 50)           → 60 snaps to 50 (MAX(50, ROUND(60/50)×50))
     *    30 g Taco Base (yield 300 / 3 units = 100) → 36 snaps to 100
     */
    function seedBowl(dbPath: string): DatabaseSync {
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec(`
        INSERT INTO products (id, name, grams_per_serving, calories, protein_g, scale_step_g) VALUES
          (1, 'Chicken', 100, 200, 30, NULL),
          (2, 'Cabbage', 100, 25, 1, NULL),
          (3, 'Egg', 50, 70, 6, 50),
          (4, 'Masa', 100, 300, 5, NULL);
        INSERT INTO product_listings (id, product_id, retailer, retailer_item_id, package_grams, servings_per_container) VALUES
          (1, 1, 'walmart', 'a', 1000, 10), (2, 2, 'walmart', 'b', 1000, 10), (3, 3, 'walmart', 'c', 600, 12), (4, 4, 'walmart', 'd', 1000, 10);
        INSERT INTO price_history (listing_id, observed_at, price) VALUES
          (1, '2026-09-01T00:00:00', 10.0), (2, '2026-09-01T00:00:00', 2.0), (3, '2026-09-01T00:00:00', 3.0), (4, '2026-09-01T00:00:00', 5.0);
        -- taco base: 300 g masa → 300 g batch of 3 tacos (unit step 100 g)
        INSERT INTO recipes (id, name, servings, yield_g, batch_units, total_calories, total_protein_g)
          VALUES (10, 'Taco Base', 1, 300, 3, 900, 15);
        INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g) VALUES (10, 4, 'Masa', 300);
        INSERT INTO recipes (id, name, servings, portion) VALUES (20, 'Bowl', 1, 1.2);
        INSERT INTO recipe_ingredients (id, recipe_id, product_id, sub_recipe_id, ingredient_name, quantity_g, scale_lock) VALUES
          (11, 20, 1, NULL, 'Chicken', 100, 'none'),
          (12, 20, 2, NULL, 'Cabbage', 100, 'serving'),
          (13, 20, 3, NULL, 'Egg', 50, 'none'),
          (14, 20, NULL, 10, 'Taco Base', 30, 'none');
        INSERT INTO meal_plans (id, name) VALUES (1, 'wk');
        INSERT INTO meal_plan_entries (plan_id, day_index, meal, recipe_id, servings) VALUES (1, 0, 'dinner', 20, 1);
      `);
      return db;
    }

    it("adds recipes.portion (default 1.0, must be positive) and the recipe_effective_rows view", () => {
      const dbPath = tempDbPath();
      const db = seedBowl(dbPath);
      const col = (db.prepare("PRAGMA table_info(recipes)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>)
        .find((c) => c.name === "portion");
      expect(col).toMatchObject({ notnull: 1, dflt_value: "1.0" });
      expect(db.prepare("SELECT portion FROM recipes WHERE id = 10").get()).toEqual({ portion: 1 });
      expect(() => db.exec("UPDATE recipes SET portion = 0 WHERE id = 20")).toThrow(/CHECK/);
      expect(tableNames(db)).toContain("recipe_effective_rows");
      db.close();
    });

    it("upgrades a v8 DB in place: portion 1.0 everywhere, views rebuilt", () => {
      const dbPath = tempDbPath();
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec("INSERT INTO recipes (id, name, servings) VALUES (1, 'Old', 2)");
      dropFoodTrackerViews(db);
      db.exec("ALTER TABLE recipes DROP COLUMN portion; PRAGMA user_version = 8;");
      db.close();
      expect(ensureWellnessDb(dbPath)).toMatchObject({ fromVersion: 8, toVersion: 11 });
      const check = new DatabaseSync(dbPath);
      expect(check.prepare("SELECT portion FROM recipe_summary WHERE id = 1").get()).toEqual({ portion: 1 });
      expect(tableNames(check)).toContain("recipe_effective_rows");
      check.close();
    });

    it("applies portion, scale_lock and step snapping per row", () => {
      const dbPath = tempDbPath();
      const db = seedBowl(dbPath);
      const rows = db.prepare(`SELECT id, quantity_g, scale_lock, portion, step_g, effective_g, eff_calories, eff_protein_g
        FROM recipe_effective_rows WHERE recipe_id = 20 ORDER BY id`).all();
      expect(rows).toEqual([
        { id: 11, quantity_g: 100, scale_lock: "none", portion: 1.2, step_g: null, effective_g: 120, eff_calories: 240, eff_protein_g: 36 },
        { id: 12, quantity_g: 100, scale_lock: "serving", portion: 1.2, step_g: null, effective_g: 100, eff_calories: 25, eff_protein_g: 1 },
        { id: 13, quantity_g: 50, scale_lock: "none", portion: 1.2, step_g: 50, effective_g: 50, eff_calories: 70, eff_protein_g: 6 },
        { id: 14, quantity_g: 30, scale_lock: "none", portion: 1.2, step_g: 100, effective_g: 100, eff_calories: 300, eff_protein_g: 5 },
      ]);
      db.close();
    });

    it("recipe_summary, recipe_cost and shopping_list use effective grams", () => {
      const dbPath = tempDbPath();
      const db = seedBowl(dbPath);
      // 240 + 25 + 70 + 300 = 635 cal; 36 + 1 + 6 + 5 = 48 g protein
      expect(db.prepare("SELECT portion, total_calories, per_serving_cal, per_serving_prot FROM recipe_summary WHERE id = 20").get())
        .toEqual({ portion: 1.2, total_calories: 635, per_serving_cal: 635, per_serving_prot: 48 });
      // cost: 120 g chicken @ $0.01 = 1.20; 100 g cabbage @ $0.002 = 0.20; 50 g egg @ $0.005 = 0.25;
      //       100 g taco base = 1/3 of a $1.50 batch (300 g masa @ $0.005) = 0.50 → $2.15
      const cost = db.prepare("SELECT total_cost, unpriced_ingredients FROM recipe_cost WHERE recipe_id = 20").get() as { total_cost: number; unpriced_ingredients: number };
      expect(cost.total_cost).toBeCloseTo(2.15, 2);
      expect(cost.unpriced_ingredients).toBe(0);
      expect(db.prepare("SELECT per_serving_cost FROM recipe_summary WHERE id = 20").get()).toEqual({ per_serving_cost: 2.15 });
      // one planned serving: 120 chicken, 100 cabbage, 50 egg, 100 g base → 100 g masa
      const list = db.prepare("SELECT product_id, grams_needed FROM shopping_list WHERE plan_id = 1 ORDER BY product_id").all();
      expect(list).toEqual([
        { product_id: 1, grams_needed: 120 }, { product_id: 2, grams_needed: 100 },
        { product_id: 3, grams_needed: 50 }, { product_id: 4, grams_needed: 100 },
      ]);
      // plan_summary reads recipe_summary, so the day is at the saved portion too
      expect(db.prepare("SELECT calories, cost_total FROM plan_summary WHERE plan_id = 1").get()).toEqual({ calories: 635, cost_total: 2.15 });
      db.close();
    });

    it("portion 1.0 leaves every row at its base amount, unsnapped", () => {
      const dbPath = tempDbPath();
      const db = seedBowl(dbPath);
      db.exec("UPDATE recipes SET portion = 1.0 WHERE id = 20");
      const rows = db.prepare("SELECT quantity_g, effective_g FROM recipe_effective_rows WHERE recipe_id = 20 ORDER BY id").all();
      // 30 g of a 100 g-step component stays 30 g: a row at its own base amount never snaps
      expect(rows).toEqual([
        { quantity_g: 100, effective_g: 100 }, { quantity_g: 100, effective_g: 100 },
        { quantity_g: 50, effective_g: 50 }, { quantity_g: 30, effective_g: 30 },
      ]);
      // 200 + 25 + 70 + 90 = 385
      expect(db.prepare("SELECT total_calories, per_serving_cal FROM recipe_summary WHERE id = 20").get())
        .toEqual({ total_calories: 385, per_serving_cal: 385 });
      const list = db.prepare("SELECT product_id, grams_needed FROM shopping_list WHERE plan_id = 1 ORDER BY product_id").all();
      expect(list).toEqual([
        { product_id: 1, grams_needed: 100 }, { product_id: 2, grams_needed: 100 },
        { product_id: 3, grams_needed: 50 }, { product_id: 4, grams_needed: 30 },
      ]);
      db.close();
    });

    it("keeps stored macros for rows without grams and reports NULL effective_g", () => {
      const dbPath = tempDbPath();
      const db = seedBowl(dbPath);
      db.exec(`INSERT INTO recipe_ingredients (id, recipe_id, product_id, ingredient_name, quantity, quantity_g, calories, protein_g)
        VALUES (15, 20, 1, 'Extra chicken', '1 serving', NULL, 200, 30)`);
      expect(db.prepare("SELECT effective_g, eff_calories, eff_protein_g FROM recipe_effective_rows WHERE id = 15").get())
        .toEqual({ effective_g: null, eff_calories: 200, eff_protein_g: 30 });
      expect(db.prepare("SELECT total_calories FROM recipe_summary WHERE id = 20").get()).toEqual({ total_calories: 835 });
      db.close();
    });
  });

  describe("v9 component portion isolation", () => {
    it("a component's own portion never changes what its parents cost or shop", () => {
      const dbPath = tempDbPath();
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec(`
        INSERT INTO products (id, name, grams_per_serving, calories) VALUES (1, 'Raw Thighs', 100, 200);
        INSERT INTO product_listings (id, product_id, retailer, retailer_item_id, package_grams, servings_per_container) VALUES (1, 1, 'walmart', 'a', 1000, 10);
        INSERT INTO price_history (listing_id, observed_at, price) VALUES (1, '2026-09-01T00:00:00', 10.0);
        INSERT INTO recipes (id, name, servings, yield_g) VALUES (10, 'Shredded Chicken', 1, 700);
        INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g) VALUES (10, 1, 'Raw Thighs', 1000);
        INSERT INTO recipes (id, name, servings) VALUES (12, 'Bowl', 1);
        INSERT INTO recipe_ingredients (recipe_id, sub_recipe_id, ingredient_name, quantity_g) VALUES (12, 10, 'Shredded Chicken', 350);
        INSERT INTO meal_plans (id, name) VALUES (1, 'wk');
        INSERT INTO meal_plan_entries (plan_id, day_index, meal, recipe_id, servings) VALUES (1, 0, 'dinner', 12, 1);
      `);
      const before = db.prepare("SELECT total_cost FROM recipe_cost WHERE recipe_id = 12").get() as { total_cost: number };
      const shopBefore = db.prepare("SELECT grams_needed FROM shopping_list WHERE plan_id = 1").get() as { grams_needed: number };
      db.prepare("UPDATE recipes SET portion = 2 WHERE id = 10").run();
      const after = db.prepare("SELECT total_cost FROM recipe_cost WHERE recipe_id = 12").get() as { total_cost: number };
      const shopAfter = db.prepare("SELECT grams_needed FROM shopping_list WHERE plan_id = 1").get() as { grams_needed: number };
      expect(before.total_cost).toBeCloseTo(5, 2); // 350 g of a $10 / 700 g batch
      expect(after.total_cost).toBeCloseTo(before.total_cost, 6);
      expect(shopBefore.grams_needed).toBe(500);
      expect(shopAfter.grams_needed).toBe(shopBefore.grams_needed);
      db.close();
    });
  });

  describe("v10 removed rows", () => {
    /**
     * Homemade Greek yogurt, yield 100 g:
     *   150 g Milk (10 cal / 100 g → 15 cal)
     *    50 g Whey (2 cal / 100 g → 1 cal), flagged removed (strained off)
     * Mass balance: 15 − 1 = 14 cal in the batch. A Bowl uses 50 g of it and a
     * plan has one bowl, so the shopping list wants 75 g milk and no whey.
     */
    function seedYogurt(dbPath: string): DatabaseSync {
      ensureWellnessDb(dbPath);
      const db = new DatabaseSync(dbPath);
      db.exec(`
        INSERT INTO products (id, name, grams_per_serving, calories, protein_g) VALUES
          (1, 'Milk', 100, 10, 1), (2, 'Whey', 100, 2, 0.5);
        INSERT INTO product_listings (id, product_id, retailer, retailer_item_id, package_grams, servings_per_container) VALUES
          (1, 1, 'walmart', 'a', 1000, 10), (2, 2, 'walmart', 'b', 1000, 10);
        INSERT INTO price_history (listing_id, observed_at, price) VALUES
          (1, '2026-09-01T00:00:00', 1.0), (2, '2026-09-01T00:00:00', 10.0);
        -- total_* are the base rollups recalculateRecipeTotals would store (15 − 1 cal)
        INSERT INTO recipes (id, name, servings, yield_g, total_calories, total_protein_g) VALUES (10, 'Yogurt', 1, 100, 14, 1.2);
        INSERT INTO recipe_ingredients (id, recipe_id, product_id, ingredient_name, quantity_g, removed) VALUES
          (11, 10, 1, 'Milk', 150, 0),
          (12, 10, 2, 'Whey', 50, 1);
        INSERT INTO recipes (id, name, servings) VALUES (20, 'Bowl', 1);
        INSERT INTO recipe_ingredients (id, recipe_id, sub_recipe_id, ingredient_name, quantity_g) VALUES (21, 20, 10, 'Yogurt', 50);
        INSERT INTO meal_plans (id, name) VALUES (1, 'wk');
        INSERT INTO meal_plan_entries (plan_id, day_index, meal, recipe_id, servings) VALUES (1, 0, 'breakfast', 20, 1);
      `);
      return db;
    }

    it("adds recipe_ingredients.removed (default 0, 0/1 only)", () => {
      const dbPath = tempDbPath();
      const db = seedYogurt(dbPath);
      const col = (db.prepare("PRAGMA table_info(recipe_ingredients)").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>)
        .find((c) => c.name === "removed");
      expect(col).toMatchObject({ notnull: 1, dflt_value: "0" });
      expect(db.prepare("SELECT removed FROM recipe_ingredients WHERE id = 21").get()).toEqual({ removed: 0 });
      expect(() => db.exec("UPDATE recipe_ingredients SET removed = 2 WHERE id = 12")).toThrow(/CHECK/);
      db.close();
    });

    it("upgrades a v9 DB in place: every existing row keeps removed = 0", () => {
      const dbPath = tempDbPath();
      const db = seedYogurt(dbPath);
      dropFoodTrackerViews(db);
      db.exec("ALTER TABLE recipe_ingredients DROP COLUMN removed; PRAGMA user_version = 9;");
      db.close();
      expect(ensureWellnessDb(dbPath)).toMatchObject({ fromVersion: 9, toVersion: 11 });
      const check = new DatabaseSync(dbPath);
      expect(check.prepare("SELECT id, removed FROM recipe_ingredients ORDER BY id").all())
        .toEqual([{ id: 11, removed: 0 }, { id: 12, removed: 0 }, { id: 21, removed: 0 }]);
      // with nothing removed the whey adds like any other row: 15 + 1
      expect(check.prepare("SELECT total_calories FROM recipe_summary WHERE id = 10").get()).toEqual({ total_calories: 16 });
      check.close();
    });

    it("a removed row keeps positive effective grams but negative macros, and scales with the batch", () => {
      const dbPath = tempDbPath();
      const db = seedYogurt(dbPath);
      expect(db.prepare("SELECT id, removed, effective_g, eff_calories, eff_protein_g FROM recipe_effective_rows WHERE recipe_id = 10 ORDER BY id").all())
        .toEqual([
          { id: 11, removed: 0, effective_g: 150, eff_calories: 15, eff_protein_g: 1.5 },
          { id: 12, removed: 1, effective_g: 50, eff_calories: -1, eff_protein_g: -0.3 },
        ]);
      db.exec("UPDATE recipes SET portion = 2 WHERE id = 10");
      expect(db.prepare("SELECT id, effective_g, eff_calories FROM recipe_effective_rows WHERE recipe_id = 10 ORDER BY id").all())
        .toEqual([{ id: 11, effective_g: 300, eff_calories: 30 }, { id: 12, effective_g: 100, eff_calories: -2 }]);
      db.exec("UPDATE recipe_ingredients SET scale_lock = 'serving' WHERE id = 12");
      expect(db.prepare("SELECT effective_g, eff_calories FROM recipe_effective_rows WHERE id = 12").get())
        .toEqual({ effective_g: 50, eff_calories: -1 });
      db.close();
    });

    it("recipe_summary subtracts removed rows and never clamps", () => {
      const dbPath = tempDbPath();
      const db = seedYogurt(dbPath);
      expect(db.prepare("SELECT total_calories, per_serving_cal, total_protein_g FROM recipe_summary WHERE id = 10").get())
        .toEqual({ total_calories: 14, per_serving_cal: 14, total_protein_g: 1.2 });
      // the bowl's 50 g of yogurt is half a 14 cal batch
      expect(db.prepare("SELECT total_calories FROM recipe_summary WHERE id = 20").get()).toEqual({ total_calories: 7 });
      // removing more than went in goes negative: that is the user's signal
      db.exec("UPDATE products SET calories = 100 WHERE id = 2");
      expect(db.prepare("SELECT total_calories FROM recipe_summary WHERE id = 10").get()).toEqual({ total_calories: -35 });
      db.close();
    });

    it("recipe_cost ignores removed rows even when the product is priced", () => {
      const dbPath = tempDbPath();
      const db = seedYogurt(dbPath);
      // 150 g milk @ $0.001/g = $0.15; the $0.50 of whey never counts
      const cost = db.prepare("SELECT total_cost, unpriced_ingredients FROM recipe_cost WHERE recipe_id = 10").get() as { total_cost: number; unpriced_ingredients: number };
      expect(cost.total_cost).toBeCloseTo(0.15, 4);
      expect(cost.unpriced_ingredients).toBe(0);
      expect(db.prepare("SELECT product_cost, base_product_cost, unpriced_products FROM recipe_base_cost WHERE recipe_id = 10").get())
        .toMatchObject({ product_cost: expect.closeTo(0.15, 4), base_product_cost: expect.closeTo(0.15, 4), unpriced_products: 0 });
      // an unpriced removed row is not "unpriced" either
      db.exec("DELETE FROM price_history WHERE listing_id = 2");
      expect(db.prepare("SELECT unpriced_ingredients FROM recipe_cost WHERE recipe_id = 10").get()).toEqual({ unpriced_ingredients: 0 });
      db.close();
    });

    it("shopping_list for a plan using the yogurt lists milk only", () => {
      const dbPath = tempDbPath();
      const db = seedYogurt(dbPath);
      // one bowl = 50 g of a 100 g batch → 75 g milk
      expect(db.prepare("SELECT product_id, product_name, grams_needed FROM shopping_list WHERE plan_id = 1 ORDER BY product_id").all())
        .toEqual([{ product_id: 1, product_name: "Milk", grams_needed: 75 }]);
      // a removed sub-recipe row is nonsensical, but it is excluded from the walk too
      db.exec("UPDATE recipe_ingredients SET removed = 1 WHERE id = 21");
      expect(db.prepare("SELECT product_id FROM shopping_list WHERE plan_id = 1").all()).toEqual([]);
      expect((db.prepare("SELECT total_cost FROM recipe_cost WHERE recipe_id = 20").get() as { total_cost: number }).total_cost).toBe(0);
      db.close();
    });
  });
});
