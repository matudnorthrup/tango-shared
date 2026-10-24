# gog_docs_update_tab

High-level Google Docs tab updater for targeted edit batches.

Use this when you already know the exact document, target tab, account, and intended edits. It performs the common doc-update pattern in one transaction:

1. read the target tab once
2. apply the replacement batch or full-content write
3. read the same tab again
4. verify the expected text landed

## Input

Replacement batch:

```json
{
  "doc": "1abcDocId",
  "tab": "t.abc123",
  "account": "work@example.com",
  "replacements": [
    {
      "find": "Old headline",
      "replace": "New headline",
      "first": true
    }
  ],
  "verify_contains": ["New headline"]
}
```

Full tab rewrite:

```json
{
  "doc": "https://docs.google.com/document/d/1abcDocId/edit?tab=t.abc123",
  "tab": "t.abc123",
  "account": "work@example.com",
  "content": "# Draft\n\nNew copy",
  "verify_contains": ["# Draft", "New copy"]
}
```

## Rules

- Use the exact doc and tab the user specified.
- Prefer `replacements` over `content` when you can make targeted edits safely.
- If a required `find` string is missing, the tool returns `precondition_failed` instead of guessing.
- Treat `verification_failed` as a real failure. Do not claim the write landed unless verification passed.

## When To Use

- Updating a known tab with specific replacement pairs.
- Rewriting the text of a known disposable draft tab.
- Running a deterministic doc-edit smoke where you want read-write-verify in one call.

## When Not To Use

- You still need to discover the doc, tab, or account.
- You need exports, copies, comments, or other uncommon Docs operations.
- You are still exploring structure before deciding the edits.

Use raw `gog_docs` for those exploratory or uncommon cases.
