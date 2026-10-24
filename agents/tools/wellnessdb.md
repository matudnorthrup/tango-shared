# wellnessdb

Malibu's fourteen tools use the active profile's `wellness/wellness.db` through the
`wellness-db` MCP server. Jules also has other wellness.db tools in her allowlist.

| Tool | Access | Purpose and inputs |
| --- | --- | --- |
| `wellnessdb_search_product` | Read | Find products, macros, and FatSecret mappings by `query`; set `active_only: true` to exclude discontinued products. |
| `wellnessdb_search_recipe` | Read | Find recipes by `query` (name, shorthand, alias); `include_archived` defaults to false. |
| `wellnessdb_get_recipe_detail` | Read | Read recipe, ingredient/component rows, macros, and aliases by `query` (name, shorthand, alias, numeric ID). |
| `wellnessdb_day_summary` | Read | Read meals, totals, aggregates, and note for `date` (defaults to today). |
| `wellnessdb_day_range` | Read | Read daily aggregates from `start_date` through `end_date`. |
| `wellnessdb_recent_meals` | Read | Read latest meal entries with `limit` (default 10, max 50). |
| `wellnessdb_active_products` | Read | List products with no `discontinued_date`. |
| `wellnessdb_add_product` | Write | Add a product: `name`; optional `shorthand`, `brand`, `category`, `serving_size` + `grams_per_serving`, macros incl. `fiber_g`, `fatsecret_food_id`/`fatsecret_serving_id`, `scale_step_g`/`scale_step_label`, `source`, `notes`. No prices here. |
| `wellnessdb_update_product` | Write | Update by `id`: any of the fields above plus `discontinued: true|false`; `scale_step_g: null` clears the unit step. Returns `before` and `product`. |
| `wellnessdb_add_recipe` | Write | Create with `name`, `ingredients`; each item links `product` or component `sub_recipe` with `quantity_g` (or gram-style `quantity`), optional `ingredient_name`, `scale_lock` (`none` default, `serving`, `batch`), and `removed` (default false). Optional `servings`, `yield_g`, `portion`, `batch_units`, `unit_label`, `shorthand`, `instructions`, `notes`, `aliases`. |
| `wellnessdb_update_recipe` | Write | Update by `query`; optional `servings`, `yield_g`, `portion`, `batch_units`, `unit_label`, `instructions`, `notes`, added `aliases`. Omit `ingredients` to preserve rows. Only send `ingredients` for an intentional full replacement, retaining all row links, base grams, locks, and removed flags. |
| `wellnessdb_add_recipe_ingredient` | Write | Add one row by recipe `query`, `product` or `sub_recipe`, `quantity_g` or gram-style `quantity`; optional `ingredient_name`, `scale_lock`, `removed`. Returns `{ row, recipe }`. |
| `wellnessdb_update_recipe_ingredient` | Write | By recipe `query` and `ingredient`, change at least one of `quantity_g`, `ingredient_name`, `scale_lock`, `removed`. Grams changes re-derive macros. Returns `{ row, recipe }`. |
| `wellnessdb_remove_recipe_ingredient` | Write | Delete one row by recipe `query` and `ingredient`; returns the deleted row for recovery and recalculates the recipe. |
| `wellnessdb_archive_recipe` | Write | By `query`, set `archived` (default true); false restores. Archived recipes remain readable in detail but are excluded from default search and `nutrition_log_items` matching. |
| `wellnessdb_duplicate_recipe` | Write | Copy by `query`, optionally `name` (default `<name> (copy)`; active name collisions fail). Copies rows, stored macros, locks, removed flags, and portion; no aliases or shorthand. Returns the new summary. |

Recipe `query` accepts a numeric ID, name, shorthand, or alias. A row `ingredient`
selector is a row ID or a case-insensitive name: match `ingredient_name` first,
then linked product/component name. Ambiguous matches return candidates; use the
row ID from detail to disambiguate. Missing matches are errors.

Searches return matches and counts; detail returns `recipe`, `ingredients`, and
`aliases`. Create returns `{ id, recipe }`; update includes the updated recipe
summary. Row results contain stored ID, name, grams, lock, removed flag, and macros.
Product search includes discontinued products unless `active_only` is true.
Check `archived_at` on recipe detail, including lookups by numeric ID.

`portion` is saved serving size (`0 < portion <= 5`, rounded to 2 decimals;
default 1). `batch_units` is a positive number or null; `unit_label` is a string
or null stored as `recipes.scale_step_label`. A component's `yield_g` is its
finished base batch weight, and `yield_g / batch_units` defines its unit step.
Changing a component refreshes macros and totals of its direct parent recipes.

Ingredient amounts are grams. Detail reports effective `quantity_g` beside
stored `base_quantity_g`; row writes take BASE grams. Product macros derive from
grams-per-serving; component macros derive from base batch totals / `yield_g`.
`scale_lock: none` scales with saved portion and people, `serving` holds per-serving
amounts across portions, and `batch` holds the batch amount across portions and
people. `removed: true` subtracts macros and excludes the row from cost, shopping,
and logging. Ingredient step sizes belong to products and cannot be edited with
these tools; use the Food UI ingredient page. Use computed, portion-aware detail
for per-serving macros and cost; stored recipe totals remain base rollups.

Examples (resolve IDs/products first):

```json
{"query":"Taco bowl","ingredient":42,"quantity_g":180,"scale_lock":"serving"}
{"query":"Yogurt base","product":"Whey","quantity_g":90,"removed":true}
{"query":"Taco bowl","portion":1.3,"batch_units":null,"unit_label":null}
{"query":"Taco bowl","name":"Taco bowl variant"}
```

These call update-row, add-row, update-recipe, and duplicate respectively.
Always read detail before editing and re-read afterward to report per-serving
calories, protein, and cost. See `skills/recipe-management.md` for the workflow.

To log to FatSecret, pass the recipe NAME and servings (or component name and
grams) to `nutrition_log_items`; it expands nested ingredients itself. These
wellness.db summary tools read the local meal log, not the FatSecret diary.
