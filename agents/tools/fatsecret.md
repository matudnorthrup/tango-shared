# fatsecret_api

Universal FatSecret API wrapper. Call any supported method with a `method` string and optional `params` object.

Use `nutrition_log_items` as the default write path for routine meal logging when the user already provided the foods and quantities. Keep `fatsecret_api` for readbacks, precise repair work, Atlas misses, or debugging the raw FatSecret surface.

## Input

```json
{
  "method": "foods_search",
  "params": {
    "search_expression": "chicken breast",
    "max_results": 10
  }
}
```

## Common methods

### Diary reads
- `food_entries_get({ date? })`
- `food_entries_get_month({ date? })`

### Diary writes
- `food_entry_create({ food_id, food_entry_name, serving_id, number_of_units, meal, date? })`
- `food_entry_edit({ food_entry_id, entry_name?, serving_id?, num_units?, meal? })`
- `food_entry_delete({ food_entry_id })`

### Food lookup
- `foods_search({ search_expression, max_results? })`
- `food_get({ food_id })`
- `food_find_id_for_barcode({ barcode })`
- `foods_get_most_eaten({ meal? })`
- `foods_get_recently_eaten({ meal? })`

## Parameter notes

- `meal` is one of `breakfast`, `lunch`, `dinner`, `other`.
- `number_of_units` follows the selected serving semantics. For portion-style servings it is a serving count or fraction; for raw gram servings (`measurement_description: g`) it is raw grams.
- `foods_search` uses `search_expression`, not `query`.
- `food_get` returns serving metadata such as `serving_id`, `serving_description`, and `metric_serving_amount`.

## Examples

```json
{
  "method": "food_entries_get",
  "params": {
    "date": "2026-03-07"
  }
}
```

```json
{
  "method": "food_get",
  "params": {
    "food_id": 12345
  }
}
```

```json
{
  "method": "food_entry_create",
  "params": {
    "food_id": 12345,
    "food_entry_name": "Greek Yogurt",
    "serving_id": 67890,
    "number_of_units": 1.5,
    "meal": "breakfast",
    "date": "2026-03-07"
  }
}
```

## Output

Returns parsed JSON when the API response is JSON, otherwise `result` with raw output.
