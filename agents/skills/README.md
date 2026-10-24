# Agent Skills

Shared workflow guidance for Tango agents.

See [`docs/guides/agents-structure.md`](../../docs/guides/agents-structure.md) for placement rules and the skill-creation checklist.

Purpose:
- capture reusable "how to do this well" knowledge
- avoid overloading assistant `knowledge.md` files with cross-domain guidance
- keep assistant `soul.md` files focused on identity, behavior, and output rules

Reference these docs deliberately from agent prompts when a V2 agent needs the workflow guidance.

| Doc | Skill ID | Primary use | Purpose |
| --- | --- | --- | --- |
| `amazon-orders.md` | `amazon_orders` | Foxtrot / shopping and receipts | Browser navigation for Amazon order lookup |
| `chipotle-ordering.md` | `chipotle_ordering` | Foxtrot / shopping | Browser navigation for Chipotle ordering (favorites, location selection) |
| `shared-todoist.md` | `shared_todoist` | Explicitly configured personal agents | Direct task capture and bounded cross-domain planning with Watson |
| `daily-planning.md` | `daily_planning` | Watson / planning | Morning planning, evening check-in, weekly planning workflows |
| `marketplace-listing.md` | `marketplace_listing` | Foxtrot / selling | Create Facebook Marketplace for-sale listings; photo ordering and description conventions; never publishes without user confirmation |
| `open-meteo-weather.md` | `open_meteo_weather` | Sierra / research | Open-Meteo free weather API (current + forecast) |
| `osrm-routing.md` | `osrm_routing` | Sierra / routing | Driving routes via the `driving_route` tool (HERE traffic-aware primary, OSRM fallback) — never estimate distances; raw OSRM ETAs run high |
| `offroad-planning.md` | `offroad_planning` | Sierra / off-road routes | Route legality checks, difficulty and shape labels, ride book upkeep, family-copy publishing rules |
| `email-subscription-cleanup.md` | `email_subscription_cleanup` | Watson / email | Nightly unsubscribe recommendations and confirmed unsubscribe execution |
| `email-review.md` | `email_review` | Watson / email | Email triage phases, drafting voice, reply conventions |
| `evening-checkin.md` | `evening_checkin` | Malibu / nutrition | Pre-dinner calorie budget (TDEE + FatSecret intake) |
| `health-baselines.md` | `health_baselines` | Malibu / Watson health summaries | Baseline comparisons for health summaries |
| `local-business-research.md` | `local_business_research` | Sierra / local research | Restaurants, local businesses, activities, classes, venues, events, and contact/detail verification |
| `obsidian-note-conventions.md` | `obsidian_note_conventions` | Watson / notes | Vault note structure and task conventions |
| `orientation-nudge-system.md` | `orientation_nudge_system` | Watson / planning | Runtime orientation nudges, task rotation contract, focus/vacation behavior |
| `printing-profile-selection.md` | `printing_profile_selection` | Sierra / fabrication | Print/material selection and reporting rules |
| `receipt-logging.md` | `receipt_logging` | Foxtrot / finance | General-purpose Obsidian receipt file creation |
| `session-save.md` | `session_save` | All agents | Three-layer save routing (thread file, daily log, Atlas); `/tango save` checklist |
| `sinking-fund-reconciliation.md` | `sinking_fund_reconciliation` | Foxtrot / finance | Lunch Money and Obsidian workflow for SB-backed expense reconciliation |
| `recipe-management.md` | `recipe_management` | Malibu / Jules recipes | wellness.db recipe and component management |
| `food-logging.md` | `food_logging` | Malibu / nutrition | Resolve wellness.db recipes and products for FatSecret logging |
| `nutrition-logging.md` | `nutrition_logging` | Jules / nutrition | wellness.db meal and supplement logging |
| `remote-claude-sessions.md` | `remote_claude_sessions` | Watson / dev sessions | Spawn phone-controllable Claude Code sessions (confirmation rail, verbatim prompts) |
| `transaction-categorization.md` | `transaction_categorization` | Foxtrot / finance | Lunch Money categorization, rules, splits |
| `travel-routing.md` | `travel_routing` | Sierra / travel | Current-location, route-comparison, walking-route, and diesel-stop heuristics |
| `travel-document-printing.md` | `travel_document_printing` | Sierra / travel | Travel confirmation PDF preview and paper printing workflow |
| `walmart-orders.md` | `walmart_orders` | Foxtrot / shopping and receipts | Browser navigation for Walmart order lookup |
| `costco-orders.md` | `costco_orders` | Foxtrot / shopping and receipts | Browser navigation for Costco warehouse and online receipts |

Rules:
- Skills capture reusable workflows and judgment, not tool schemas.
- Keep them short enough to reference deliberately from an agent prompt.
- Put assistant-specific facts in `agents/assistants/<id>/knowledge.md`, not here.
