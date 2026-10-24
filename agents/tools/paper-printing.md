# Paper Printing Tool

Shared doc for `paper_print`.

## `paper_print`

Create previewable PDFs for paper documents and send PDFs to the local macOS
CUPS print queue.

Input:

```json
{
  "action": "preview",
  "content": "Flight confirmation summary...",
  "title": "Travel confirmation cover sheet"
}
```

Actions:

- `list_printers` - list configured CUPS printer destinations and the system default
- `preview` - create or copy a stable PDF without printing
- `print` - create/copy the PDF and send it to `lp`; `dry_run` defaults to `true`

Supported document sources:

- `source_file` under `/tmp`, `~/Downloads`, `~/Documents`, or the paper-print output directory
- Existing PDFs are copied to the output directory before preview/print
- Text, Markdown, CSV, HTML, RTF, DOC, DOCX, and common image files are converted to PDF when local converters support them
- `content` can be plain text or Markdown-like text for generated cover sheets and summaries

Print options:

```json
{
  "action": "print",
  "source_file": "/tmp/confirmation.pdf",
  "title": "Travel confirmation",
  "printer": "Office_Printer",
  "copies": 1,
  "sides": "one-sided",
  "media": "Letter",
  "dry_run": false
}
```

Notes:

- Use `preview` before physical printing whenever content came from email or a generated summary.
- `print` with omitted `dry_run` is a dry run. Set `"dry_run": false` only after the user explicitly asked for hard copies.
- Never claim paper was printed unless the tool returns `success: true` with `lp_output`.
- If there is no configured CUPS destination, report the generated `pdf_path` and the printer setup blocker.
- Keep personal itinerary and reservation details out of Linear and tracked repo docs.
