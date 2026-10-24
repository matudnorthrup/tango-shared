# Agent Tool Docs

Standalone tool docs for callable surfaces. V2 agents receive tools through MCP
server allowlists; add concise operating guidance to loaded agent prompts or
focused skills when a tool needs judgment beyond its schema.

See [`docs/guides/agents-structure.md`](../../docs/guides/agents-structure.md) for placement rules, and [`docs/guides/adding-tools.md`](../../docs/guides/adding-tools.md) for the runtime wiring checklist.

| Doc | Tool IDs | Primary agents/domains | Paired skills |
| --- | --- | --- | --- |
| `fatsecret.md` | `fatsecret_api` | Malibu / nutrition | |
| `nutrition-log-items.md` | `nutrition_log_items` | Malibu / nutrition | `food-logging.md` |
| `health.md` | `health_query` | Malibu / health | `health-baselines.md` |
| `workout-sql.md` | `workout_sql` | Malibu / workouts | |
| `wellnessdb.md` | `wellnessdb_search_product`, `wellnessdb_search_recipe`, `wellnessdb_get_recipe_detail`, `wellnessdb_day_summary`, `wellnessdb_day_range`, `wellnessdb_recent_meals`, `wellnessdb_active_products`, `wellnessdb_add_recipe`, `wellnessdb_update_recipe` | Malibu / Jules wellness | `recipe-management.md`, `food-logging.md` |
| `gog-email.md` | `gog_email` | Watson / email | |
| `gog-calendar.md` | `gog_calendar` | Watson / calendar | |
| `gog-docs.md` | `gog_docs` | Watson / docs | |
| `gog-docs-update-tab.md` | `gog_docs_update_tab` | Watson / docs | |
| `obsidian.md` | `obsidian` | Watson / notes | `obsidian-note-conventions.md` |
| `health-morning.md` | `health_morning` | Watson / health brief | `health-baselines.md` |
| `orientation-nudge.md` | `orientation_nudge` | Watson / planning state | |
| `lunch-money.md` | `lunch_money` | Foxtrot / finance | |
| `bank-transfer.md` | `bank_transfer` | Foxtrot / owner-approved transfers between own Bank accounts | `sinking-fund-reconciliation.md` |
| `exa.md` | `exa_search`, `exa_answer` | Sierra / research | |
| `printing.md` | `printer_command`, `openscad_render`, `prusa_slice` | Sierra / fabrication | `printing-profile-selection.md` |
| `paper-printing.md` | `paper_print` | Sierra / travel documents | `travel-document-printing.md` |
| `travel.md` | `location_read`, `local_business_search`, `driving_route`, `walking_route`, `find_diesel` | Sierra / travel and local research; Charlie / narration (`location_read` only) | `travel-routing.md`, `local-business-research.md` |
| `offroad.md` | `offroad_check`, `offroad_plan`, `offroad_networks`, `offroad_photos`, `trail_app_library`, `trail_app_import`, `ridebook_status`, `ridebook_update`, `ridebook_publish`, `ridebook_promote` | Sierra / off-road routes and ride books (`sierra-ollama`: read tools only) | `offroad-planning.md` |
| `walmart.md` | `walmart` | Foxtrot / shopping | |
| `browser.md` | `browser` | Watson / Sierra / Foxtrot browser flows | |
| `background-job.md` | `background_job` | Sierra / long research batches | |
| `agent-collaboration.md` | `collaborate_with_agent` | cross-agent bounded collaboration | |
| `agent-docs.md` | `agent_docs` | Agent self-update | |
| `todoist.md` | `todoist`, `todoist_manage` | Watson / personal task management (explicitly granted agents) | |
| `wispr-flow.md` | `wispr_flow` | Watson / meeting recordings, notes, calendar | |
| `dayone.md` | `dayone_read`, `dayone_write` | Personal agents / Day One journal | |
| `notion.md` | `notion` | Sierra / research filing; Watson / notes | |
| `linear.md` | `linear` | Victor / project tracking | |
| `attachments.md` | `attachment_search`, `attachment_read`, `attachment_status`, `attachment_reprocess`, `attachment_update`, `attachment_enumerate` | all agents/workers (`attachment_update`, `attachment_enumerate` ship UNGRANTED — see `attachments.md`) | |
| `discord-manage.md` | `discord_manage` | Dev agents | |
| `tango-dev.md` | `tango_shell`, `tango_file` | Dev agents | |

Notes:
- Tool docs describe capabilities, params, return shapes, and examples.
- Reusable workflow guidance belongs in `agents/skills/*.md`, not in tool docs.
- Assistant domain knowledge lives in `agents/assistants/<agent>/knowledge.md`, not here.
