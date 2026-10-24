# evening_checkin

Pre-dinner calorie budget check. Combines Apple Health TDEE with FatSecret diary intake to compute how much room is left for dinner.

## When to use

When the user asks about dinner planning, calorie budget, how much they can eat, or requests an evening/dinner check-in.

## Workflow

1. Call `health_query` with `command: "checkin"` to get today's TDEE so far (basal + active calories).
2. Call `fatsecret_api` with `method: "food_entries_get"` (no date param = today) to get all logged meals and their calorie totals.
3. Compute:
   - **Consumed:** Sum of calories from FatSecret entries
   - **Burned (TDEE):** From health checkin
   - **Remaining for dinner:** TDEE - consumed calories
   - **Deficit/surplus context:** If the user has a deficit goal, factor that in

## Output

Report concisely:
- TDEE so far (and note it will keep climbing until bedtime)
- Calories consumed (with meal breakdown if helpful)
- Remaining dinner budget
- If the budget is tight, note it honestly; if generous, say so

## Rules

- Never invent calorie numbers. Both tools must return data before computing.
- If FatSecret has no entries, say so — don't assume zero intake.
- TDEE is a running total that grows throughout the day. Mention this if the check-in is early.
- The user's baseline food budget is profile-configured, but prefer the live TDEE from health data.
