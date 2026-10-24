# memory_search, memory_add, and memory_reflect

Universal memory-bank tools for recalling and storing durable context across sessions.

## `memory_search`

Searches stored memories across conversation summaries, manual notes, reflections, Obsidian imports, and backfills.

Input:

```json
{
  "query": "what did we decide about weekly reviews",
  "source": "all",
  "limit": 5,
  "session_id": "default",
  "agent_id": "watson"
}
```

Notes:
- `query` is required.
- `source` can be `conversation`, `obsidian`, `reflection`, `manual`, `backfill`, or `all`.
- Results include score breakdowns: overall score, relevance, keyword score, semantic score, recency, and source bonus.
- Optional `session_id` / `agent_id` narrow the search scope.

Output shape:

```json
{
  "query": "weekly reviews",
  "result_count": 2,
  "results": [
    {
      "id": 12,
      "source": "manual",
      "content": "Keep weekly reviews concise and action-focused.",
      "score": 2.143
    }
  ]
}
```

## `memory_add`

Stores an explicit memory for future retrieval.

Input:

```json
{
  "content": "The user prefers concise weekly reviews with clear action items.",
  "importance": 0.8,
  "source": "manual",
  "tags": ["preferences", "weekly-review"],
  "session_id": "default",
  "agent_id": "watson"
}
```

Notes:
- `content` is required.
- `source` is `manual` or `reflection`.
- `importance` is clamped to `0.0`-`1.0`.
- Tags are stored as normalized lowercase keywords.
- If embeddings are available, the tool stores one with the memory. If not, the memory still persists.

Output shape:

```json
{
  "memory": {
    "id": 34,
    "source": "manual",
    "content": "The user prefers concise weekly reviews with clear action items."
  }
}
```

## `memory_reflect`

Generates new `reflection` memories from recent stored memories.

Input:

```json
{
  "lookback_hours": 24,
  "max_reflections": 3,
  "session_id": "default",
  "agent_id": "watson"
}
```

Notes:
- Scans recent non-reflection memories and synthesizes recurring themes, preferences, and decisions.
- Creates durable `reflection` memories with source memory IDs in metadata.
- Optional `session_id` / `agent_id` scope the reflection run. Without them, reflections are global.
- If embeddings are available, created reflections are embedded automatically.

Output shape:

```json
{
  "created_count": 2,
  "created": [
    {
      "id": 35,
      "source": "reflection",
      "content": "Recent theme: weekly review and concise updates recurred across 3 memories."
    }
  ]
}
```
