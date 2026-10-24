# EXA Search Tools

Shared doc for `exa_search` and `exa_answer`.

## `exa_search`

Neural web search that can return ranked results, highlights, and full text.

Input:

```json
{
  "query": "best budget 3D printer filament 2026",
  "num": 10,
  "highlights": true,
  "category": "news"
}
```

Optional fields:
- `num`
- `text`
- `highlights`
- `category` as `news`, `research paper`, `tweet`, `company`, or `people`

Returns tool output in `result`.

## `exa_answer`

Quick factual answer with citations.

Input:

```json
{
  "question": "What is the range of a 2026 electric SUV?"
}
```

Returns tool output in `result`.

## Notes

- `exa_search` is better for multi-source synthesis and broader research.
- `exa_answer` is better for a direct factual lookup.
