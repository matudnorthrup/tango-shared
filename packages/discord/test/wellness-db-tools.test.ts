import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWellnessDbTools,
  wellnessDbToolLooksReadOnly,
} from "../src/wellness-db-tools.js";
import { ensureWellnessDb } from "../src/wellness-db-migrations.js";

const tempFiles: string[] = [];

function makeToolMap(dbPath: string): Map<string, (input: Record<string, unknown>) => Promise<unknown>> {
  const tools = createWellnessDbTools({
    dbPath,
    supplementBatchShortcuts: {
      combo: ["batch-a", "batch-b", "batch-c"],
    },
  });
  return new Map(tools.map((tool) => [tool.name, tool.handler]));
}

function seedTestDb(dbPath: string): void {
  ensureWellnessDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO products (id, name, shorthand, calories, protein_g, carbs_g, fat_g)
     VALUES (1, 'Core Power Chocolate', 'core power', 170, 26, 8, 3),
            (2, 'Discontinued Bar', 'old bar', 100, 5, 10, 2)`,
  ).run();
  db.prepare("UPDATE products SET discontinued_date = '2026-01-01' WHERE id = 2").run();

  db.prepare(
    `INSERT INTO supplements (id, name, shorthand, calories, protein_g, carbs_g, fat_g)
     VALUES (11, 'Daily Supplement', 'daily', 0, 0, 0, 0),
            (26, 'Batch Supplement A', 'batch-a', 0, 0, 0, 0),
            (27, 'Batch Supplement B', 'batch-b', 0, 0, 0, 0),
            (28, 'Batch Supplement C', 'batch-c', 0, 0, 0, 0),
            (99, 'Stopped Supplement', 'stopped', 0, 0, 0, 0)`,
  ).run();
  db.prepare("UPDATE supplements SET stopped_date = '2026-01-01' WHERE id = 99").run();

  db.prepare(
    `INSERT INTO recipes (id, name, shorthand, servings, total_calories, total_protein_g, total_carbs_g, total_fat_g)
     VALUES (1, 'Vegetarian Chili', 'chili', 4, 800, 40, 80, 20)`,
  ).run();
  db.prepare(
    `INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity, calories, protein_g, carbs_g, fat_g)
     VALUES (1, 1, 'Core Power Chocolate', '1 bottle', 170, 26, 8, 3)`,
  ).run();
  db.prepare("INSERT INTO recipe_aliases (recipe_id, alias) VALUES (1, 'veggie chili')").run();
}

describe("wellnessDbToolLooksReadOnly", () => {
  it("marks read tools as read-only", () => {
    expect(wellnessDbToolLooksReadOnly("wellnessdb_search_product")).toBe(true);
    expect(wellnessDbToolLooksReadOnly("wellnessdb_log_meal")).toBe(false);
  });
});

describe("createWellnessDbTools", () => {
  let dbPath: string;
  let tools: Map<string, (input: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `wellness-db-tools-${Date.now()}-${Math.random()}.db`);
    tempFiles.push(dbPath);
    seedTestDb(dbPath);
    tools = makeToolMap(dbPath);
  });

  afterEach(() => {
    while (tempFiles.length > 0) {
      const file = tempFiles.pop();
      if (file && fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
      }
    }
  });

  it("excludes archived recipe matches unless include_archived is true", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE recipes SET archived_at = '2026-09-01' WHERE id = 1");
    db.close();
    for (const query of ["Vegetarian", "chili", "veggie chili"]) {
      expect(await tools.get("wellnessdb_search_recipe")!({ query })).toMatchObject({ count: 0 });
      expect(await tools.get("wellnessdb_search_recipe")!({ query, include_archived: true }))
        .toMatchObject({ count: 1, recipes: [{ archived_at: "2026-09-01" }] });
    }
    // Detail is still available for inspecting a retired recipe.
    expect(await tools.get("wellnessdb_get_recipe_detail")!({ query: "1" }))
      .toMatchObject({ recipe: { archived_at: "2026-09-01" } });
  });

  it("returns canonical grams, product mappings, component names and per-100g macros", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE products SET grams_per_serving = 100, fiber_g = 4,
        fatsecret_food_id = '101', fatsecret_serving_id = '201' WHERE id = 1;
      UPDATE recipes SET yield_g = 400, total_fiber_g = 16 WHERE id = 1;
      UPDATE recipe_ingredients SET quantity_g = 50, calories = NULL, protein_g = NULL,
        carbs_g = NULL, fat_g = NULL WHERE recipe_id = 1;
      INSERT INTO recipes (id, name, yield_g, total_calories, total_protein_g, total_carbs_g, total_fat_g, total_fiber_g)
        VALUES (2, 'Component Sauce', 50, 100, 10, 8, 3, 2);
      INSERT INTO recipe_ingredients (recipe_id, ingredient_name, sub_recipe_id, quantity_g)
        VALUES (1, 'Sauce', 2, 25);`);
    db.close();
    for (const query of ["1", "chili", "veggie chili", "Vegetarian Chili"]) {
      expect(await tools.get("wellnessdb_get_recipe_detail")!({ query })).toMatchObject({
        recipe: { yield_g: 400, archived_at: null, per_100g_cal: 200, per_100g_prot: 10,
          per_100g_carb: 20, per_100g_fat: 5, per_100g_fiber: 4 },
        ingredients: [
          { quantity_g: 50, fiber_g: 2, calories: 85, protein_g: 13, carbs_g: 4, fat_g: 1.5,
            product_id: 1, product_name: "Core Power Chocolate", fatsecret_food_id: "101",
            fatsecret_serving_id: "201", grams_per_serving: 100, sub_recipe_id: null, sub_recipe_name: null },
          { quantity_g: 25, sub_recipe_id: 2, sub_recipe_name: "Component Sauce", product_id: null,
            calories: 50, protein_g: 5, carbs_g: 4, fat_g: 1.5, fiber_g: 1 },
        ],
      });
    }
  });

  it("searches products by shorthand and by name", async () => {
    const byShorthand = await tools.get("wellnessdb_search_product")!({ query: "core power" });
    expect(byShorthand).toMatchObject({
      count: 1,
      products: [expect.objectContaining({ name: "Core Power Chocolate" })],
    });

    const byName = await tools.get("wellnessdb_search_product")!({ query: "Chocolate" });
    expect(byName).toMatchObject({ count: 1 });
  });

  it("searches active supplements only when requested", async () => {
    const all = await tools.get("wellnessdb_search_supplement")!({ query: "stop" });
    expect(all).toMatchObject({ count: 1 });

    const activeOnly = await tools.get("wellnessdb_search_supplement")!({
      query: "stop",
      active_only: true,
    });
    expect(activeOnly).toMatchObject({ count: 0 });
  });

  it("searches recipes by alias", async () => {
    const result = await tools.get("wellnessdb_search_recipe")!({ query: "veggie chili" });
    expect(result).toMatchObject({
      count: 1,
      recipes: [expect.objectContaining({ name: "Vegetarian Chili" })],
    });
  });

  it("logs a meal and returns it in day_summary", async () => {
    const logged = await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-30",
      meal: "breakfast",
      item_type: "product",
      item: "core power",
      servings: 1,
    });
    expect(logged).toMatchObject({
      id: expect.any(Number),
      item: "Core Power Chocolate",
      calories: 170,
      protein_g: 26,
    });

    const summary = await tools.get("wellnessdb_day_summary")!({ date: "2026-05-30" });
    expect(summary).toMatchObject({
      date: "2026-05-30",
      meals: [expect.objectContaining({ description: "Core Power Chocolate" })],
      food_totals: { calories: 170, protein_g: 26 },
      recipes_logged: [],
    });
  });

  it("logs a configured batch shortcut as separate supplement rows", async () => {
    const result = await tools.get("wellnessdb_log_supplement")!({
      date: "2026-05-30",
      supplements: "combo",
    });
    expect(result).toMatchObject({
      logged: [
        expect.objectContaining({ supplement: "Batch Supplement A" }),
        expect.objectContaining({ supplement: "Batch Supplement B" }),
        expect.objectContaining({ supplement: "Batch Supplement C" }),
      ],
    });

    const summary = await tools.get("wellnessdb_day_summary")!({ date: "2026-05-30" });
    expect((summary as { meals: unknown[] }).meals).toHaveLength(3);
  });

  it("returns day range aggregates", async () => {
    await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-29",
      meal: "lunch",
      item_type: "product",
      item: "core power",
    });
    await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-30",
      meal: "dinner",
      item_type: "product",
      item: "core power",
      servings: 2,
    });

    const range = await tools.get("wellnessdb_day_range")!({
      start_date: "2026-05-29",
      end_date: "2026-05-30",
    });
    expect(range).toMatchObject({ count: 2 });
    expect((range as { days: Array<{ date: string; total_cal: number }> }).days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-05-29", total_cal: 170 }),
        expect.objectContaining({ date: "2026-05-30", total_cal: 340 }),
      ]),
    );
  });

  it("deletes only the requested meal entry", async () => {
    const first = await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-30",
      meal: "breakfast",
      item_type: "product",
      item: "core power",
    });
    await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-30",
      meal: "lunch",
      item_type: "product",
      item: "core power",
    });

    await tools.get("wellnessdb_delete_meal_entry")!({ id: (first as { id: number }).id });

    const summary = await tools.get("wellnessdb_day_summary")!({ date: "2026-05-30" });
    expect((summary as { meals: unknown[] }).meals).toHaveLength(1);
  });

  it("updates product fields by id", async () => {
    const updated = await tools.get("wellnessdb_update_product")!({
      id: 1,
      name: "Core Power Elite Chocolate",
      calories: 180,
      protein_g: 30,
      notes: "Updated from label",
    });

    expect(updated).toMatchObject({
      updated: true,
      before: expect.objectContaining({ id: 1, name: "Core Power Chocolate", calories: 170 }),
      product: expect.objectContaining({
        id: 1,
        name: "Core Power Elite Chocolate",
        calories: 180,
        protein_g: 30,
        notes: "Updated from label",
      }),
    });

    // product-admin fields: unit step, grams per serving, FatSecret mapping, retire/restore
    const stepped = await tools.get("wellnessdb_update_product")!({
      id: 1, scale_step_g: 140, scale_step_label: "½ bag", grams_per_serving: 140, fiber_g: 4,
      fatsecret_food_id: "999", fatsecret_serving_id: "888", source: "label", discontinued: true,
    });
    expect(stepped).toMatchObject({ product: expect.objectContaining({
      scale_step_g: 140, scale_step_label: "½ bag", grams_per_serving: 140, fiber_g: 4,
      fatsecret_food_id: "999", fatsecret_serving_id: "888", source: "label",
    }) });
    expect((stepped as { product: { discontinued_date: string | null } }).product.discontinued_date).not.toBeNull();
    const cleared = await tools.get("wellnessdb_update_product")!({ id: 1, scale_step_g: null, discontinued: false });
    expect((cleared as { product: Record<string, unknown> }).product).toMatchObject({ scale_step_g: null, scale_step_label: null, discontinued_date: null });
    await expect(tools.get("wellnessdb_update_product")!({ id: 1, grams_per_serving: 0 })).resolves.toEqual({ error: "grams_per_serving must be positive" });
  });

  it("updates supplement fields by id", async () => {
    const updated = await tools.get("wellnessdb_update_supplement")!({
      id: 11,
      dosage: "500mg, 1 capsule",
      notes: "Updated dosage format",
    });

    expect(updated).toMatchObject({
      updated: true,
      supplement: expect.objectContaining({
        id: 11,
        dosage: "500mg, 1 capsule",
        notes: "Updated dosage format",
      }),
    });
  });

  it("deletes a product by id", async () => {
    const deleted = await tools.get("wellnessdb_delete_product")!({ id: 2 });
    expect(deleted).toMatchObject({
      deleted: true,
      product: expect.objectContaining({ id: 2, name: "Discontinued Bar" }),
    });

    const search = await tools.get("wellnessdb_search_product")!({ query: "Discontinued Bar" });
    expect(search).toMatchObject({ count: 0 });
  });

  it("deletes a supplement by id", async () => {
    const deleted = await tools.get("wellnessdb_delete_supplement")!({ id: 99 });
    expect(deleted).toMatchObject({
      deleted: true,
      supplement: expect.objectContaining({ id: 99, name: "Stopped Supplement" }),
    });

    const search = await tools.get("wellnessdb_search_supplement")!({ query: "Stopped Supplement" });
    expect(search).toMatchObject({ count: 0 });
  });

  it("returns an error for unknown product names", async () => {
    await expect(
      tools.get("wellnessdb_log_meal")!({
        date: "2026-05-30",
        meal: "breakfast",
        item_type: "product",
        item: "nonexistent food",
      }),
    ).resolves.toEqual({ error: "Product not found: nonexistent food" });
  });

  it("updates recipe metadata and aliases without touching ingredient rows", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE products SET grams_per_serving = 100, fiber_g = 4 WHERE id = 1;
      UPDATE recipe_ingredients SET quantity_g = 50 WHERE recipe_id = 1;
      INSERT INTO recipes (id, name, yield_g, total_calories, total_protein_g, total_carbs_g, total_fat_g, total_fiber_g)
        VALUES (2, 'Component Sauce', 50, 100, 10, 8, 3, 2);
      INSERT INTO recipe_ingredients (recipe_id, ingredient_name, sub_recipe_id, quantity_g, calories, protein_g, carbs_g, fat_g, fiber_g)
        VALUES (1, 'Sauce', 2, 25, 50, 5, 4, 1.5, 1);`);
    db.close();

    await expect(tools.get("wellnessdb_update_recipe")!({ query: "chili" }))
      .resolves.toMatchObject({ error: expect.stringContaining("Nothing to update") });
    await expect(tools.get("wellnessdb_update_recipe")!({ query: "chili", ingredients: [] }))
      .resolves.toMatchObject({ error: expect.stringContaining("omit it to keep the current rows") });

    const updated = await tools.get("wellnessdb_update_recipe")!({
      query: "veggie chili",
      notes: "baseline\nsmoke marker",
      aliases: ["vc", " "],
    });
    expect(updated).toMatchObject({ id: 1, ingredients_replaced: false, recipe: { notes: "baseline\nsmoke marker" } });

    const detail = (await tools.get("wellnessdb_get_recipe_detail")!({ query: "vc" })) as {
      recipe: { total_calories: number };
      ingredients: Array<Record<string, unknown>>;
      aliases: string[];
    };
    expect(detail.ingredients).toHaveLength(2);
    expect(detail.ingredients).toEqual(expect.arrayContaining([
      expect.objectContaining({ product_id: 1, quantity_g: 50 }),
      expect.objectContaining({ sub_recipe_id: 2, quantity_g: 25 }),
    ]));
    expect(detail.aliases).toEqual(expect.arrayContaining(["veggie chili", "vc"]));
    // Totals were not recalculated (no ingredient change), so the seeded rollup
    // stands on the table; the detail's total is the v9 row-derived figure
    // (170 cal stored on the chili row + 50 on the sauce row).
    const check = new DatabaseSync(dbPath);
    expect(check.prepare("SELECT total_calories FROM recipes WHERE id = 1").get()).toEqual({ total_calories: 800 });
    check.close();
    expect(detail.recipe.total_calories).toBe(220);
  });

  it("get_recipe_detail reports effective grams at the saved portion alongside the base amount", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE products SET grams_per_serving = 100, fiber_g = 4 WHERE id = 1;
      UPDATE recipes SET portion = 1.5 WHERE id = 1;
      UPDATE recipe_ingredients SET quantity_g = 50, calories = NULL, protein_g = NULL, carbs_g = NULL, fat_g = NULL
        WHERE recipe_id = 1;
      INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g, scale_lock)
        VALUES (1, 1, 'Locked bottle', 100, 'serving');`);
    db.close();
    const detail = await tools.get("wellnessdb_get_recipe_detail")!({ query: "chili" });
    expect(detail).toMatchObject({
      recipe: { portion: 1.5, total_calories: 298, per_serving_cal: 75 },
      ingredients: [
        // 50 g × 1.5 = 75 g of a 170 cal / 100 g product
        { quantity_g: 75, base_quantity_g: 50, scale_lock: "none", calories: 128, protein_g: 19.5, fiber_g: 3 },
        // serving-locked rows ignore the portion
        { quantity_g: 100, base_quantity_g: 100, scale_lock: "serving", calories: 170, protein_g: 26 },
      ],
    });
    // update_recipe still writes and reads BASE grams; the portion is untouched
    await tools.get("wellnessdb_update_recipe")!({ query: "chili", notes: "still 1.5" });
    const after = await tools.get("wellnessdb_get_recipe_detail")!({ query: "chili" });
    expect(after).toMatchObject({ recipe: { portion: 1.5, notes: "still 1.5" },
      ingredients: [{ quantity_g: 75, base_quantity_g: 50 }, { quantity_g: 100, base_quantity_g: 100 }] });
  });

  it("writes gram quantities and component rows when replacing ingredients", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE products SET grams_per_serving = 100, fiber_g = 4 WHERE id = 1;
      INSERT INTO recipes (id, name, shorthand, yield_g, total_calories, total_protein_g, total_carbs_g, total_fat_g, total_fiber_g)
        VALUES (2, 'Component Sauce', 'sauce', 50, 100, 10, 8, 3, 2);`);
    db.close();

    // Component rows need grams; products without grams fall back to the servings multiplier.
    await expect(tools.get("wellnessdb_update_recipe")!({
      query: "chili",
      ingredients: [{ sub_recipe: "sauce" }],
    })).resolves.toMatchObject({ error: expect.stringContaining("requires quantity_g") });

    const updated = await tools.get("wellnessdb_update_recipe")!({
      query: "chili",
      servings: 2,
      ingredients: [
        { product: "core power", quantity: "50 g" },
        { product: "core power", ingredient_name: "Extra bottle", servings: 2 },
        { sub_recipe: "sauce", quantity_g: 25 },
      ],
    });
    // 50 g of a 100 g/170 cal product = 85; two servings = 340; half the 100 cal sauce = 50.
    expect(updated).toMatchObject({
      id: 1,
      ingredients_replaced: true,
      recipe: { servings: 2, total_calories: 475, total_protein_g: 70, total_fiber_g: 11 },
    });
    const detail = (await tools.get("wellnessdb_get_recipe_detail")!({ query: "1" })) as {
      ingredients: Array<Record<string, unknown>>;
    };
    expect(detail.ingredients).toEqual([
      expect.objectContaining({ product_id: 1, quantity_g: 50, calories: 85, protein_g: 13, fiber_g: 2 }),
      expect.objectContaining({ product_id: 1, ingredient_name: "Extra bottle", quantity_g: null, calories: 340 }),
      expect.objectContaining({ sub_recipe_id: 2, quantity_g: 25, calories: 50, protein_g: 5, fiber_g: 1 }),
    ]);
  });

  it("creates component recipes with yield_g and rolls back on bad ingredients", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE products SET grams_per_serving = 100, fiber_g = 4 WHERE id = 1;");
    db.close();

    await expect(tools.get("wellnessdb_add_recipe")!({
      name: "Broken",
      ingredients: [{ product: "no such product" }],
    })).resolves.toMatchObject({ error: "Ingredient product not found: no such product" });
    expect(await tools.get("wellnessdb_search_recipe")!({ query: "Broken" })).toMatchObject({ count: 0 });

    const created = (await tools.get("wellnessdb_add_recipe")!({
      name: "Crema",
      shorthand: "crema",
      yield_g: 200,
      ingredients: [{ product: "core power", quantity_g: 200 }],
    })) as { id: number; recipe: Record<string, unknown> };
    expect(created.recipe).toMatchObject({ yield_g: 200, total_calories: 340, per_100g_cal: 170, per_100g_fiber: 4 });

    const parent = await tools.get("wellnessdb_add_recipe")!({
      name: "Bowl",
      servings: 1,
      ingredients: [{ sub_recipe: "crema", quantity: "50 g" }],
    });
    expect(parent).toMatchObject({ recipe: { total_calories: 85, total_protein_g: 13, yield_g: null } });
  });

  it("add_recipe stores removed rows, subtracts them from totals, and get_recipe_detail reports them", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE products SET grams_per_serving = 100, fiber_g = 4 WHERE id = 1;
      INSERT INTO products (id, name, shorthand, grams_per_serving, calories, protein_g, carbs_g, fat_g, fiber_g)
        VALUES (3, 'Whey', 'whey', 100, 20, 1, 4, 0, 0);`);
    db.close();

    // 150 g core power = 255 cal / 39 g protein / 6 g fiber; 50 g whey (10 cal, 0.5 g protein) strained off
    const created = (await tools.get("wellnessdb_add_recipe")!({
      name: "Greek Yogurt",
      shorthand: "gy",
      yield_g: 100,
      ingredients: [
        { product: "core power", quantity_g: 150 },
        { product: "whey", quantity_g: 50, removed: true },
      ],
    })) as { id: number; recipe: Record<string, unknown> };
    expect(created.recipe).toMatchObject({ total_calories: 245, total_protein_g: 38.5, total_fiber_g: 6, per_100g_cal: 245 });

    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    // stored base totals (recalculateRecipeTotals) agree with the view at portion 1
    expect(db2.prepare("SELECT total_calories, total_protein_g FROM recipes WHERE id = ?").get(created.id))
      .toEqual({ total_calories: 245, total_protein_g: 38.5 });
    expect(db2.prepare("SELECT ingredient_name, removed FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id").all(created.id))
      .toEqual([{ ingredient_name: "Core Power Chocolate", removed: 0 }, { ingredient_name: "Whey", removed: 1 }]);
    db2.close();

    const detail = await tools.get("wellnessdb_get_recipe_detail")!({ query: "gy" });
    expect(detail).toMatchObject({
      recipe: { total_calories: 245, per_serving_cal: 245 },
      ingredients: [
        { product_id: 1, quantity_g: 150, removed: false, calories: 255, protein_g: 39 },
        { product_id: 3, quantity_g: 50, removed: true, calories: -10, protein_g: -0.5 },
      ],
    });

    // update_recipe round-trips the flag; omitting it means the row is kept
    const updated = await tools.get("wellnessdb_update_recipe")!({
      query: "gy",
      ingredients: [
        { product: "core power", quantity_g: 150 },
        { product: "whey", quantity_g: 50 },
      ],
    });
    expect(updated).toMatchObject({ recipe: { total_calories: 265 } });
    expect(await tools.get("wellnessdb_get_recipe_detail")!({ query: "gy" })).toMatchObject({
      ingredients: [{ removed: false }, { removed: false, calories: 10 }],
    });
  });

  describe("recipe administration", () => {
    beforeEach(() => {
      const db = new DatabaseSync(dbPath);
      db.exec("UPDATE products SET grams_per_serving = 100, fiber_g = 4 WHERE id = 1");
      db.close();
    });

    const adminTools = [
      "wellnessdb_add_recipe_ingredient", "wellnessdb_update_recipe_ingredient",
      "wellnessdb_remove_recipe_ingredient", "wellnessdb_archive_recipe", "wellnessdb_duplicate_recipe",
    ];

    it.each(adminTools)("classifies %s as a write", (name) => {
      expect(tools.has(name)).toBe(true);
      expect(wellnessDbToolLooksReadOnly(name)).toBe(false);
    });

    it("adds one gram-based row without replacing the existing rows", async () => {
      const added = await tools.get("wellnessdb_add_recipe_ingredient")!({
        query: "veggie chili", product: "core power", quantity: "50 g",
        ingredient_name: "Extra", scale_lock: "batch", removed: true,
      });
      expect(added).toMatchObject({
        row: { id: expect.any(Number), ingredient_name: "Extra", quantity_g: 50,
          scale_lock: "batch", removed: 1, calories: 85, protein_g: 13, fiber_g: 2 },
        recipe: { id: 1, total_calories: 85, total_protein_g: 13 },
      });
      const detail = await tools.get("wellnessdb_get_recipe_detail")!({ query: "chili" });
      expect(detail).toMatchObject({ ingredients: [
        { id: 1, ingredient_name: "Core Power Chocolate" },
        { ingredient_name: "Extra", removed: true, calories: -85 },
      ] });
    });

    it("adds a component row using base batch macros and rejects a self-reference", async () => {
      const component = await tools.get("wellnessdb_add_recipe")!({ name: "Sauce", yield_g: 200,
        portion: 2, ingredients: [{ product: "core power", quantity_g: 100 }],
      }) as { id: number };
      expect(await tools.get("wellnessdb_add_recipe_ingredient")!({ query: "chili",
        sub_recipe: "Sauce", quantity_g: 100, scale_lock: "serving",
      })).toMatchObject({ row: { sub_recipe_id: component.id, quantity_g: 100,
        scale_lock: "serving", calories: 85, protein_g: 13 }, recipe: { total_calories: 255 } });
      expect(await tools.get("wellnessdb_add_recipe_ingredient")!({ query: "Sauce",
        sub_recipe: "Sauce", quantity_g: 100,
      })).toMatchObject({ error: expect.stringContaining("cannot contain itself") });
      expect(await tools.get("wellnessdb_get_recipe_detail")!({ query: "Sauce" }))
        .toMatchObject({ ingredients: [{ product_id: 1 }] });
    });

    it("rolls back metadata and aliases when ingredient replacement is invalid", async () => {
      const before = await tools.get("wellnessdb_get_recipe_detail")!({ query: "chili" });
      expect(await tools.get("wellnessdb_update_recipe")!({ query: "chili", servings: 2,
        portion: 1.5, batch_units: 4, unit_label: "cup", notes: "must roll back", aliases: ["invalid variant"],
        ingredients: [{ product: "core power", quantity_g: 100 }, { product: "missing product", quantity_g: 50 }],
      })).toMatchObject({ error: expect.any(String) });
      expect(await tools.get("wellnessdb_get_recipe_detail")!({ query: "chili" })).toEqual(before);
      expect(await tools.get("wellnessdb_search_recipe")!({ query: "invalid variant" })).toMatchObject({ count: 0 });
      const db = new DatabaseSync(dbPath, { readOnly: true });
      expect(db.prepare("SELECT total_calories FROM recipes WHERE id = 1").get()).toEqual({ total_calories: 800 });
      db.close();
    });

    it("keeps stored macros when grams change on a product without a grams-per-serving basis", async () => {
      const db = new DatabaseSync(dbPath);
      db.exec("UPDATE products SET grams_per_serving = NULL WHERE id = 1");
      db.close();
      expect(await tools.get("wellnessdb_update_recipe_ingredient")!({ query: "chili", ingredient: 1,
        quantity_g: 50,
      })).toMatchObject({ row: { quantity_g: 50, calories: 170, protein_g: 26, carbs_g: 8, fat_g: 3 },
        recipe: { total_calories: 170 } });
    });

    it("updates grams, locks, removed status and label on only the selected row", async () => {
      const added = await tools.get("wellnessdb_add_recipe_ingredient")!({
        query: "chili", product: "core power", quantity_g: 100, ingredient_name: "Extra",
      }) as { row: { id: number } };
      expect(await tools.get("wellnessdb_update_recipe_ingredient")!({
        query: "1", ingredient: added.row.id, quantity_g: 50, scale_lock: "serving",
        removed: true, ingredient_name: "Drained",
      })).toMatchObject({ row: { id: added.row.id, quantity_g: 50, scale_lock: "serving",
        removed: 1, ingredient_name: "Drained", calories: 85, protein_g: 13 },
        recipe: { total_calories: 85 } });
      expect(await tools.get("wellnessdb_update_recipe_ingredient")!({
        query: "chili", ingredient: "DRAINED", removed: false, scale_lock: "none",
      })).toMatchObject({ row: { id: added.row.id, removed: 0, scale_lock: "none", calories: 85 },
        recipe: { total_calories: 255 } });
      expect(await tools.get("wellnessdb_update_recipe_ingredient")!({
        query: "chili", ingredient: added.row.id,
      })).toMatchObject({ error: expect.stringMatching(/nothing to update|at least one/i) });
    });

    it("prefers exact ingredient labels, falls back to linked names, and lists ambiguous candidates", async () => {
      const added = await tools.get("wellnessdb_add_recipe_ingredient")!({
        query: "chili", product: "core power", quantity_g: 50, ingredient_name: "Extra",
      }) as { row: { id: number } };
      // A label match wins even though both rows link to this product.
      expect(await tools.get("wellnessdb_update_recipe_ingredient")!({
        query: "chili", ingredient: "CORE POWER CHOCOLATE", ingredient_name: "Original",
      })).toMatchObject({ row: { id: 1, ingredient_name: "Original" } });
      const ambiguous = await tools.get("wellnessdb_update_recipe_ingredient")!({
        query: "chili", ingredient: "core power chocolate", quantity_g: 25,
      }) as { error: string };
      expect(ambiguous.error).toMatch(/ambiguous/i);
      expect(ambiguous.error).toContain("Original");
      expect(ambiguous.error).toContain("Extra");
      expect(ambiguous.error).toContain(String(added.row.id));
      expect(await tools.get("wellnessdb_remove_recipe_ingredient")!({
        query: "chili", ingredient: "no such row",
      })).toMatchObject({ error: expect.stringMatching(/not found|no .*match/i) });
      await tools.get("wellnessdb_remove_recipe_ingredient")!({ query: "chili", ingredient: added.row.id });
      expect(await tools.get("wellnessdb_update_recipe_ingredient")!({
        query: "chili", ingredient: "core power chocolate", quantity_g: 25,
      })).toMatchObject({ row: { id: 1, ingredient_name: "Original", calories: 43 } });
    });

    it("removes a row, returns its stored data, and scopes row ids to the selected recipe", async () => {
      const other = await tools.get("wellnessdb_add_recipe")!({ name: "Other", ingredients: [
        { product: "core power", quantity_g: 50 },
      ] }) as { id: number };
      expect(await tools.get("wellnessdb_remove_recipe_ingredient")!({
        query: String(other.id), ingredient: 1,
      })).toMatchObject({ error: expect.any(String) });
      const removed = await tools.get("wellnessdb_remove_recipe_ingredient")!({
        query: "Vegetarian Chili", ingredient: "Core Power Chocolate",
      });
      expect(removed).toMatchObject({ row: { id: 1, product_id: 1,
        ingredient_name: "Core Power Chocolate", calories: 170 } });
      expect(await tools.get("wellnessdb_get_recipe_detail")!({ query: "chili" }))
        .toMatchObject({ ingredients: [], recipe: { total_calories: 0 } });
    });

    it("rounds and validates portion and clears optional component unit metadata without replacing rows", async () => {
      expect(await tools.get("wellnessdb_update_recipe")!({
        query: "chili", portion: 1.236, batch_units: 4, unit_label: "taco",
      })).toMatchObject({ ingredients_replaced: false,
        recipe: { portion: 1.24, batch_units: 4, unit_label: "taco" } });
      for (const input of [{ portion: 0 }, { portion: 5.01 }, { portion: -1 }, { batch_units: 0 }]) {
        expect(await tools.get("wellnessdb_update_recipe")!({ query: "chili", ...input }))
          .toMatchObject({ error: expect.any(String) });
      }
      expect(await tools.get("wellnessdb_update_recipe")!({
        query: "chili", batch_units: null, unit_label: null,
      })).toMatchObject({ recipe: { portion: 1.24, batch_units: null, unit_label: null } });
      expect(await tools.get("wellnessdb_get_recipe_detail")!({ query: "chili" }))
        .toMatchObject({ ingredients: [{ id: 1, calories: 170 }] });
    });

    it("creates scaling metadata and preserves locks and removed flags when replacing rows", async () => {
      const created = await tools.get("wellnessdb_add_recipe")!({
        name: "Scaled", portion: 1.5, batch_units: 2, unit_label: "cup", yield_g: 200,
        ingredients: [
          { product: "core power", quantity_g: 100, scale_lock: "serving" },
          { product: "core power", quantity_g: 50, scale_lock: "batch", removed: true },
        ],
      }) as { id: number };
      expect(created).toMatchObject({ recipe: { portion: 1.5, batch_units: 2, unit_label: "cup",
        total_calories: 85 } });
      expect(await tools.get("wellnessdb_update_recipe")!({ query: String(created.id), ingredients: [
        { product: "core power", quantity_g: 100 },
        { product: "core power", quantity_g: 50, scale_lock: "batch", removed: true },
      ] })).toMatchObject({ recipe: { total_calories: 170 } });
      expect(await tools.get("wellnessdb_get_recipe_detail")!({ query: String(created.id) }))
        .toMatchObject({ ingredients: [{ scale_lock: "none" }, { scale_lock: "batch", removed: true }] });
    });

    it("archives and restores recipes while retaining detail access", async () => {
      expect(await tools.get("wellnessdb_archive_recipe")!({ query: "veggie chili" }))
        .not.toHaveProperty("error");
      for (const query of ["1", "chili", "veggie chili", "Vegetarian Chili"]) {
        expect(await tools.get("wellnessdb_search_recipe")!({ query })).toMatchObject({ count: 0 });
        expect(await tools.get("wellnessdb_get_recipe_detail")!({ query }))
          .toMatchObject({ recipe: { id: 1, archived_at: expect.any(String) } });
      }
      expect(await tools.get("wellnessdb_archive_recipe")!({ query: "1", archived: false }))
        .not.toHaveProperty("error");
      expect(await tools.get("wellnessdb_search_recipe")!({ query: "veggie chili" }))
        .toMatchObject({ count: 1, recipes: [{ archived_at: null }] });
    });

    it("duplicates stored rows and scaling metadata without aliases or shorthand, rejecting active name collisions", async () => {
      await tools.get("wellnessdb_update_recipe")!({ query: "chili", portion: 1.5, batch_units: 4,
        unit_label: "bowl", yield_g: 200, ingredients: [
          { product: "core power", quantity_g: 100, scale_lock: "serving" },
          { product: "core power", quantity_g: 25, scale_lock: "batch", removed: true },
        ] });
      const copy = await tools.get("wellnessdb_duplicate_recipe")!({ query: "veggie chili" }) as { id: number };
      expect(copy).toMatchObject({ name: "Vegetarian Chili (copy)", shorthand: null,
        portion: 1.5, batch_units: 4, unit_label: "bowl", yield_g: 200, archived_at: null });
      expect(copy.id).not.toBe(1);
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(`SELECT product_id, sub_recipe_id, ingredient_name, quantity_g, scale_lock, removed,
        calories, protein_g, carbs_g, fat_g, fiber_g FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id`);
      expect(rows.all(copy.id)).toEqual(rows.all(1));
      expect(db.prepare("SELECT alias FROM recipe_aliases WHERE recipe_id = ?").all(copy.id)).toEqual([]);
      db.close();
      expect(await tools.get("wellnessdb_duplicate_recipe")!({ query: "chili" }))
        .toMatchObject({ error: expect.any(String) });
      expect(await tools.get("wellnessdb_duplicate_recipe")!({ query: "chili", name: "Variant" }))
        .toMatchObject({ name: "Variant" });
      await tools.get("wellnessdb_archive_recipe")!({ query: String(copy.id) });
      expect(await tools.get("wellnessdb_duplicate_recipe")!({ query: "chili" }))
        .toMatchObject({ name: "Vegetarian Chili (copy)" });
    });

    it("cascades row changes and yield changes to parents using base totals independently of portion", async () => {
      const component = await tools.get("wellnessdb_add_recipe")!({ name: "Sauce", yield_g: 200,
        portion: 2, ingredients: [{ product: "core power", quantity_g: 100 }],
      }) as { id: number };
      const parent = await tools.get("wellnessdb_add_recipe")!({ name: "Plate",
        ingredients: [{ sub_recipe: "Sauce", ingredient_name: "Dressing", quantity_g: 100 }],
      }) as { id: number };
      const checkParent = async (calories: number, protein: number) => {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        expect(db.prepare("SELECT calories, protein_g FROM recipe_ingredients WHERE recipe_id = ?").get(parent.id))
          .toEqual({ calories, protein_g: protein });
        expect(db.prepare("SELECT total_calories, total_protein_g FROM recipes WHERE id = ?").get(parent.id))
          .toEqual({ total_calories: calories, total_protein_g: protein });
        db.close();
      };
      await checkParent(85, 13);
      await tools.get("wellnessdb_update_recipe_ingredient")!({ query: String(component.id),
        ingredient: "Core Power Chocolate", quantity_g: 200 });
      await checkParent(170, 26);
      const added = await tools.get("wellnessdb_add_recipe_ingredient")!({ query: "Sauce",
        product: "core power", quantity_g: 100, ingredient_name: "Drained", removed: true,
      }) as { row: { id: number } };
      await checkParent(85, 13);
      await tools.get("wellnessdb_remove_recipe_ingredient")!({ query: "Sauce", ingredient: added.row.id });
      await checkParent(170, 26);
      await tools.get("wellnessdb_update_recipe")!({ query: "Sauce", yield_g: 400, batch_units: 4 });
      await checkParent(85, 13);
      await tools.get("wellnessdb_update_recipe")!({ query: "Sauce",
        ingredients: [{ product: "core power", quantity_g: 400 }] });
      await checkParent(170, 26);
      // Linked component name resolves a row with an overridden display label.
      expect(await tools.get("wellnessdb_update_recipe_ingredient")!({ query: "Plate",
        ingredient: "SAUCE", quantity_g: 200 })).toMatchObject({ row: { calories: 340, protein_g: 52 } });
    });
  });


  it("day_summary reports which recipes were logged to FatSecret, per meal", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`INSERT INTO fatsecret_entry_links (date, meal, recipe_id, food_entry_id, created_at) VALUES
      ('2026-09-08', 'lunch', 1, 111, '2026-09-08 12:00:00'),
      ('2026-09-08', 'lunch', 1, 112, '2026-09-08 12:00:01'),
      ('2026-09-08', 'dinner', 1, 113, '2026-09-08 18:30:00');`);
    db.close();
    const summary = (await tools.get("wellnessdb_day_summary")!({ date: "2026-09-08" })) as { recipes_logged: unknown[] };
    expect(summary.recipes_logged).toEqual([
      { meal: "lunch", recipe_id: 1, recipe: "Vegetarian Chili", entries: 2, food_entry_ids: ["111", "112"], first_logged_at: "2026-09-08 12:00:00" },
      { meal: "dinner", recipe_id: 1, recipe: "Vegetarian Chili", entries: 1, food_entry_ids: ["113"], first_logged_at: "2026-09-08 18:30:00" },
    ]);
  });
});
