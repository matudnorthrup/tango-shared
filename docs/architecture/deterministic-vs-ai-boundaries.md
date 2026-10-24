# Architectural Boundaries: Deterministic vs AI Layers

## Core Principle

**The deterministic layer handles identification and safety. The AI layer handles reasoning.**

If a human can figure something out from context and general knowledge, the LLM should too — don't write code for it.

## Boundary Map

### Deterministic Layer (code, rules, data)

The deterministic layer should own:

- **Food/item identification**: Atlas DB matching, scoring, alias resolution — finding the RIGHT item
- **Safety gates**: tool allowlists, channel allowlists, access control, write confirmation
- **Data integrity**: confirmed diary writes, FatSecret API calls, database transactions
- **Routing**: intent classification → worker dispatch, agent selection, tool scoping
- **Schema/structure**: database tables, API contracts, config formats

### AI/LLM Layer (reasoning, judgment)

The AI layer should own:

- **Quantity interpretation**: "2 tablespoons", "a handful", "half a cup" → the LLM knows approximate conversions
- **Unit conversion**: tbsp → grams, cups → ml — the LLM has this knowledge natively
- **Disambiguation**: "egg" vs "egg white" when context is ambiguous — the LLM can ask or infer
- **Natural language understanding**: "that's pull day b, not a" — corrections, follow-ups, context
- **Planning and workflow design**: "how should we implement this" — reasoning about process
- **Content synthesis**: composing reports, summaries, recommendations from data

### The Handoff Pattern

When the deterministic layer partially succeeds (e.g., matches a food but can't convert units):

1. **DON'T** mark the item as completely "unresolved" — that tells the LLM to give up
2. **DON'T** add hardcoded conversion tables — that's the LLM's job
3. **DO** pass the partial match to the LLM with context: "Atlas matched White Rice (food_id X, 130 cal/100g) but couldn't convert '2 tablespoons' to servings. Use FatSecret serving options or your own knowledge to complete this."
4. **DO** let the LLM call FatSecret with the matched food_id to find the right serving option

## Anti-Patterns

### 1. Hardcoding what the LLM can reason about

**Bad**: Adding `VOLUME_UNIT_GRAMS = { tbsp: 15, cup: 240 }` to the code
**Why bad**: Fragile, incomplete (misses "a splash", "a handful", "half a cup"), and the LLM already knows these conversions
**Good**: Pass the quantity string to the LLM and let it reason about the conversion

### 2. Giving the LLM raw tools it will misuse

**Bad**: Adding `atlas_sql` to the nutrition log worker's tool surface
**Why bad**: The LLM calls Atlas directly, then calls FatSecret, then ignores Atlas results and uses FatSecret. The integrated `nutrition_log_items` tool has Atlas-first logic that the raw tool bypass breaks.
**Good**: Only expose the integrated tool (`nutrition_log_items`) that enforces the correct priority order

### 3. Solving classification problems with regex

**Bad**: Adding increasingly specific regex patterns for feedback/planning/correction detection
**Why bad**: Every new pattern creates edge cases that break other patterns ("Ok. Try adding..." matches feedback AND action)
**Good**: Use the LLM's native understanding of conversational intent. If the pattern list grows beyond 5-6 entries, the classification is probably better handled by the LLM.

### 4. Making the deterministic path too aggressive

**Bad**: Routing ALL messages through the deterministic classifier, including conversational follow-ups
**Why bad**: The deterministic path treats each message independently, losing conversation context. Multi-turn conversations break.
**Good**: Use the deterministic path for clear, single-turn commands. Let ambiguous or conversational messages fall through to the LLM.

## Decision Checklist

Before implementing a fix, ask:

1. **Am I adding deterministic logic for something the LLM should handle?**
   - If the fix involves a lookup table, conversion formula, or hardcoded rule for something a human would "just know" → redesign

2. **Am I giving a tool to the LLM that it will misuse?**
   - If the tool bypasses an integrated pipeline that enforces correct behavior → don't expose it

3. **Am I solving a classification problem with more regex?**
   - If the regex list is growing and edge cases keep appearing → the LLM should classify instead

4. **What happens when the deterministic layer partially succeeds?**
   - If partial success = "unresolved" → wrong. Partial success should pass context to the LLM for completion.

5. **Would this fix survive a new food/unit/pattern the user hasn't tried yet?**
   - If the fix only handles the specific case reported → too narrow. Design for the general case.

## Applying to Tango

### Nutrition Logging

- Atlas matching (deterministic) → identifies the food
- Unit conversion (AI) → the LLM interprets "2 tablespoons" using FatSecret serving data or its own knowledge
- When Atlas can't convert → pass the match to the LLM, don't fail silently

### Intent Classification

- Clear commands ("log my workout", "check my email") → deterministic routing
- Conversational follow-ups ("that's not what I meant", "what are the next steps") → LLM reasoning
- Boundary: if a message could be interpreted multiple ways, it's an LLM problem, not a regex problem

### Tool Scoping

- Restrict tools to prevent misuse (don't give raw DB access when an integrated tool exists)
- But don't restrict so tightly that the LLM can't recover from partial failures
