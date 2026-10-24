# deep_research

Reusable guidance for calibrating research depth and structuring multi-search investigations.

## Depth tiers

Choose the tier that matches the task, then execute accordingly.

| Tier | When | Searches | Approach |
|------|------|----------|----------|
| Quick answer | Single fact, price check, "what is X?" | 1 `exa_answer` | Return answer + citation directly |
| Standard research | Comparison, "how does X work?", product eval | 2-4 `exa_search` | One search per angle, synthesize |
| Deep dive | Multi-faceted analysis, comprehensive review, "research X thoroughly" | 5-8 `exa_search` | Decompose into threads, cross-reference, weight sources |

## Decomposition

For standard and deep research, break the topic into independent search angles before searching:

1. **Identify the core question** — what decision or understanding does this serve?
2. **List 2-8 angles** — each should be independently searchable (e.g., "pricing", "real-world reviews", "technical specs", "alternatives")
3. **Choose search parameters per angle:**
   - `highlights: true` for scanning many results quickly
   - `text: true` for deep reading of fewer results
   - `category` when the angle is clearly news, academic, social, or company-focused
   - `num: 5-10` for most angles; `num: 15-25` only when surveying a broad landscape

## Search strategy

- Start with a broad search to map the landscape, then narrow
- Use `exa_answer` only for isolated factual lookups — never as a substitute for multi-source research
- For comparisons: search each option separately rather than one combined query
- For current events: use `category: "news"` and check result dates
- For technical topics: use `category: "research paper"` alongside general searches
- For product research: mix review sites (`highlights`) with manufacturer specs (`text`)

## Synthesis

- **Weight by source quality:** Primary sources > expert analysis > aggregator summaries > forum posts
- **Handle contradictions:** Note the disagreement, cite both sides, explain which source is more authoritative and why
- **Distinguish clearly:** Sourced facts (with URL) vs. your inference vs. common knowledge
- **Flag uncertainty:** If sources conflict or data is sparse, say so explicitly
- **Recency matters:** Prefer recent sources; flag when the best source is old

## Output structure

Return results in a structured format the orchestrator can use:

- **Summary:** 2-4 sentence executive summary with the key finding or recommendation
- **Findings:** One section per research angle with supporting evidence and sources
- **Sources:** All URLs preserved from search results
- **Confidence:** Note areas of high vs. low confidence
- **Follow-up:** Suggest what additional research could clarify, if applicable
