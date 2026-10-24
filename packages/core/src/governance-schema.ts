/**
 * Governance Schema — Types, DDL, and seed data for the permission system.
 *
 * Tables: principals, groups, group_members, governance_tools, permissions, governance_log
 * See docs/plans/governance-permissions.md for full design.
 */

// ============================================================
// Types
// ============================================================

export type PrincipalType = "user" | "agent" | "worker";
export type AccessLevel = "none" | "read" | "write" | "admin";
export type GovernanceLevel = "personal" | "shared" | "federation";
export type PermissionDecision = "granted" | "denied";

export interface Principal {
  id: string;
  type: PrincipalType;
  parent_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Group {
  id: string;
  display_name: string | null;
  governance_level: GovernanceLevel;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  group_id: string;
  principal_id: string;
  added_by: string | null;
  created_at: string;
}

export interface GovernanceTool {
  id: string;
  domain: string | null;
  display_name: string | null;
  access_type: "read" | "write";
  description: string | null;
  created_at: string;
}

export interface Permission {
  id: number;
  principal_id: string | null;
  group_id: string | null;
  tool_id: string;
  access_level: AccessLevel;
  granted_by: string | null;
  reason: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GovernanceLogEntry {
  id: number;
  principal_id: string;
  tool_id: string;
  action: string;
  decision: PermissionDecision;
  access_level_required: string | null;
  access_level_found: string | null;
  resolved_via: string | null;
  context: string | null;
  created_at: string;
}

export interface PermissionCheckResult {
  granted: boolean;
  resolvedVia: string;
  accessLevel?: AccessLevel;
}

// ============================================================
// Access Level Utilities
// ============================================================

const ACCESS_LEVEL_ORDER: Record<AccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

export function accessLevelMeetsRequired(found: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_LEVEL_ORDER[found] >= ACCESS_LEVEL_ORDER[required];
}

// ============================================================
// Schema DDL
// ============================================================

export const GOVERNANCE_DDL = `
  -- PRINCIPALS
  -- Users, agents, and workers that can be granted permissions.
  -- Hierarchy: user -> agent -> worker (permissions inherit downward)
  CREATE TABLE IF NOT EXISTS principals (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    parent_id TEXT,
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES principals(id)
  );

  CREATE INDEX IF NOT EXISTS idx_principals_type ON principals(type);
  CREATE INDEX IF NOT EXISTS idx_principals_parent ON principals(parent_id);

  -- GROUPS
  -- User-defined permission groups. Principals can belong to many.
  -- Governance level controls override hierarchy (personal > shared > federation).
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    governance_level TEXT NOT NULL DEFAULT 'personal',
    description TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- GROUP_MEMBERS
  -- Which principals belong to which groups.
  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    added_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, principal_id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (principal_id) REFERENCES principals(id)
  );

  -- GOVERNANCE_TOOLS
  -- Registry of all tools available in the system.
  CREATE TABLE IF NOT EXISTS governance_tools (
    id TEXT PRIMARY KEY,
    domain TEXT,
    display_name TEXT,
    access_type TEXT NOT NULL DEFAULT 'read',
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_governance_tools_domain ON governance_tools(domain);

  -- PERMISSIONS
  -- Allowlist: principals/groups can ONLY use tools explicitly granted.
  -- Exactly one of principal_id or group_id must be set.
  CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_id TEXT,
    group_id TEXT,
    tool_id TEXT NOT NULL,
    access_level TEXT NOT NULL,
    granted_by TEXT,
    reason TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (principal_id) REFERENCES principals(id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (tool_id) REFERENCES governance_tools(id),
    CHECK (
      (principal_id IS NOT NULL AND group_id IS NULL) OR
      (principal_id IS NULL AND group_id IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_permissions_principal ON permissions(principal_id);
  CREATE INDEX IF NOT EXISTS idx_permissions_group ON permissions(group_id);
  CREATE INDEX IF NOT EXISTS idx_permissions_tool ON permissions(tool_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_principal_tool
    ON permissions(principal_id, tool_id) WHERE principal_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_group_tool
    ON permissions(group_id, tool_id) WHERE group_id IS NOT NULL;

  -- GOVERNANCE_LOG
  -- Audit trail of every permission check.
  CREATE TABLE IF NOT EXISTS governance_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    action TEXT NOT NULL,
    decision TEXT NOT NULL,
    access_level_required TEXT,
    access_level_found TEXT,
    resolved_via TEXT,
    context TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_governance_log_principal ON governance_log(principal_id);
  CREATE INDEX IF NOT EXISTS idx_governance_log_created ON governance_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_governance_log_decision ON governance_log(decision);
`;

// ============================================================
// Seed Data
// ============================================================

export const GOVERNANCE_SEED = `
  -- Principals: user -> agents -> workers
  INSERT OR IGNORE INTO principals (id, type, display_name)
    VALUES ('user:owner', 'user', 'Owner');

  -- Tools (from MCP server)
  INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
    ('fatsecret_api', 'wellness', 'FatSecret API', 'write'),
    ('nutrition_log_items', 'wellness', 'Nutrition Item Logger', 'write'),
    ('health_query', 'wellness', 'Health Query', 'read'),
    ('workout_sql', 'wellness', 'Workout SQL', 'write'),
    ('atlas_sql', 'wellness', 'Atlas SQL', 'write'),
    ('recipe_list', 'wellness', 'Recipe List', 'read'),
    ('recipe_read', 'wellness', 'Recipe Read', 'read'),
    ('recipe_write', 'wellness', 'Recipe Write', 'write'),
    ('gog_email', 'personal', 'Gmail', 'write'),
    ('gog_calendar', 'personal', 'Google Calendar', 'write'),
    ('gog_docs', 'personal', 'Google Docs', 'write'),
    ('gog_docs_update_tab', 'personal', 'Google Docs Tab Updater', 'write'),
    ('obsidian', 'personal', 'Obsidian Vault', 'write'),
    ('study_library', 'personal', 'Study Library', 'write'),
    ('health_morning', 'personal', 'Health Morning Briefing', 'read'),
    ('lunch_money', 'personal', 'Lunch Money Finance', 'write'),
    ('receipt_registry', 'personal', 'Receipt Registry', 'write'),
    ('expense_reimbursement', 'personal', 'ExpenseDesk Reimbursement Automation', 'write'),
    ('kilo_ledger', 'personal', 'Kilo Ledger', 'write'),
    ('bank_transfer', 'personal', 'Bank Transfers (owner-approved)', 'write'),
    ('memory_search', 'shared', 'Memory Search', 'read'),
    ('memory_add', 'shared', 'Memory Add', 'write'),
    ('memory_reflect', 'shared', 'Memory Reflect', 'write'),
    ('attachment_search', 'attachments', 'Attachment Search', 'read'),
    ('attachment_read', 'attachments', 'Attachment Read', 'read'),
    ('attachment_status', 'attachments', 'Attachment Status', 'read'),
    ('attachment_reprocess', 'attachments', 'Attachment Reprocess', 'write'),
    ('exa_search', 'research', 'EXA Web Search', 'read'),
    ('exa_answer', 'research', 'EXA Answer', 'read'),
    ('printer_command', 'research', 'PrusaLink Printer', 'write'),
    ('openscad_render', 'research', 'OpenSCAD Render', 'write'),
    ('prusa_slice', 'research', 'PrusaSlicer', 'write'),
    ('paper_print', 'research', 'Paper Printing', 'write'),
    ('location_read', 'research', 'GPS Location', 'read'),
    ('local_business_search', 'research', 'Local Business Search', 'read'),
    ('driving_route', 'research', 'Driving Route Planner', 'read'),
    ('route_ahead_search', 'research', 'Along-Route POI Search', 'read'),
    ('walking_route', 'research', 'Walking Route Planner', 'read'),
    ('find_diesel', 'research', 'Diesel Finder', 'read'),
    ('offroad_check', 'research', 'Off-Road Route Check', 'read'),
    ('offroad_plan', 'research', 'Off-Road Route Planner', 'read'),
    ('offroad_networks', 'research', 'Off-Road All-Vehicle Networks', 'read'),
    ('offroad_photos', 'research', 'Off-Road Stop Photos', 'read'),
    ('trail_app_library', 'research', 'Trail App Library (read-only)', 'read'),
    ('trail_app_import', 'research', 'Trail App Import (Sierra folders only)', 'write'),
    ('ridebook_status', 'research', 'Ride Book Status', 'read'),
    ('ridebook_update', 'research', 'Ride Book Update (private copy)', 'write'),
    ('ridebook_publish', 'research', 'Ride Book Family Preview', 'write'),
    ('ridebook_promote', 'research', 'Ride Book Family Publish', 'write'),
    ('walmart', 'shopping', 'Walmart Shopping', 'write'),
    ('browser', 'shared', 'Browser Automation', 'write'),
    ('slack', 'shared', 'Slack Workspace Read', 'read'),
    ('file_ops', 'research', 'File Operations', 'write'),
    ('jules_files', 'wellness', 'Jules Wellness Files', 'write'),
    ('wellnessdb_search_product', 'wellness-db', 'Wellness DB Product Search', 'read'),
    ('wellnessdb_search_supplement', 'wellness-db', 'Wellness DB Supplement Search', 'read'),
    ('wellnessdb_search_recipe', 'wellness-db', 'Wellness DB Recipe Search', 'read'),
    ('wellnessdb_get_recipe_detail', 'wellness-db', 'Wellness DB Recipe Detail', 'read'),
    ('wellnessdb_day_summary', 'wellness-db', 'Wellness DB Day Summary', 'read'),
    ('wellnessdb_day_range', 'wellness-db', 'Wellness DB Day Range', 'read'),
    ('wellnessdb_recent_meals', 'wellness-db', 'Wellness DB Recent Meals', 'read'),
    ('wellnessdb_active_supplements', 'wellness-db', 'Wellness DB Active Supplements', 'read'),
    ('wellnessdb_active_products', 'wellness-db', 'Wellness DB Active Products', 'read'),
    ('wellnessdb_log_meal', 'wellness-db', 'Wellness DB Log Meal', 'write'),
    ('wellnessdb_log_supplement', 'wellness-db', 'Wellness DB Log Supplement', 'write'),
    ('wellnessdb_log_weight', 'wellness-db', 'Wellness DB Log Weight', 'write'),
    ('wellnessdb_log_activity', 'wellness-db', 'Wellness DB Log Activity', 'write'),
    ('wellnessdb_log_hydration', 'wellness-db', 'Wellness DB Log Hydration', 'write'),
    ('wellnessdb_log_presence', 'wellness-db', 'Wellness DB Log Presence', 'write'),
    ('wellnessdb_add_product', 'wellness-db', 'Wellness DB Add Product', 'write'),
    ('wellnessdb_update_product', 'wellness', 'Wellness DB Update Product', 'write'),
    ('wellnessdb_update_supplement', 'wellness', 'Wellness DB Update Supplement', 'write'),
    ('wellnessdb_delete_product', 'wellness', 'Wellness DB Delete Product', 'write'),
    ('wellnessdb_delete_supplement', 'wellness', 'Wellness DB Delete Supplement', 'write'),
    ('wellnessdb_add_recipe', 'wellness-db', 'Wellness DB Add Recipe', 'write'),
    ('wellnessdb_update_recipe', 'wellness-db', 'Wellness DB Update Recipe', 'write'),
    ('wellnessdb_add_recipe_ingredient', 'wellness-db', 'Wellness DB Add Recipe Ingredient', 'write'),
    ('wellnessdb_update_recipe_ingredient', 'wellness-db', 'Wellness DB Update Recipe Ingredient', 'write'),
    ('wellnessdb_remove_recipe_ingredient', 'wellness-db', 'Wellness DB Remove Recipe Ingredient', 'write'),
    ('wellnessdb_archive_recipe', 'wellness-db', 'Wellness DB Archive Recipe', 'write'),
    ('wellnessdb_duplicate_recipe', 'wellness-db', 'Wellness DB Duplicate Recipe', 'write'),
    ('wellnessdb_add_day_note', 'wellness-db', 'Wellness DB Add Day Note', 'write'),
    ('wellnessdb_delete_meal_entry', 'wellness-db', 'Wellness DB Delete Meal Entry', 'write'),
    ('email_thread_brief', 'email', 'Email Thread Brief', 'read'),
    ('email_search', 'email', 'Email Search', 'read'),
    ('email_inbox_scan', 'email', 'Email Inbox Scan', 'read'),
    ('email_draft_create', 'email', 'Email Draft Create', 'write'),
    ('email_thread_archive', 'email', 'Email Thread Archive', 'write'),
    ('agent_docs', 'tango', 'Agent Documentation', 'write'),
    ('tango_shell', 'tango', 'Tango Shell', 'write'),
    ('tango_file', 'tango', 'Tango File Editor', 'write'),
    ('discord_manage', 'tango', 'Discord Server Management', 'write'),
    ('onepassword', 'shared', '1Password Credential Retrieval', 'read'),
    ('linear', 'personal', 'Linear Project Management', 'write'),
    ('imessage', 'personal', 'iMessage Read/Send', 'write'),
    ('acme_run', 'personal', 'Acme Remote MCP (Notion, Slack, etc.)', 'write'),
    ('wispr_flow', 'personal', 'Wispr Flow Remote MCP (meeting notes, transcripts, scratchpad, calendar)', 'read'),
    ('notion', 'personal', 'Notion (direct API)', 'write'),
    ('todoist', 'personal', 'Todoist task management', 'write'),
    ('todoist_manage', 'personal', 'Todoist workspace management', 'write'),
    ('things_read', 'personal', 'Things lists and tasks', 'read'),
    ('things_write', 'personal', 'Things task and project management', 'write'),
    ('dayone_read', 'personal', 'Day One journal entries', 'read'),
    ('dayone_write', 'personal', 'Day One journal entry writing', 'write'),
    ('orientation_nudge', 'personal', 'Orientation Nudge Controls', 'write'),
    ('youtube_transcript', 'research', 'YouTube Transcript', 'read'),
    ('youtube_analyze', 'research', 'YouTube Video Analysis', 'read'),
    ('spawn_claude_session', 'tango', 'Spawn Claude Code Session', 'write'),
    ('list_claude_sessions', 'tango', 'List Claude Code Sessions', 'read'),
    ('collaborate_with_agent', 'tango', 'Agent Collaboration', 'write'),
    ('discord_send_image', 'tango', 'Discord Image Send', 'write'),
    ('background_job', 'tango', 'Background Job', 'write'),
    ('screen', 'tango', 'Agent Screens', 'write'),
    ('agent_inbox', 'tango', 'Agent Inbox', 'write'),
    ('desk_mail', 'tango', 'Desk Mail', 'write');

  -- Default groups
  INSERT OR IGNORE INTO groups (id, display_name, governance_level, description) VALUES
    ('self', 'Self', 'personal', 'Owner and their own agents'),
    ('family', 'Family', 'shared', 'Family members with limited access'),
    ('team', 'Team', 'shared', 'Work team with project-scoped access');

  -- Universal memory tools available to all agents/workers via inheritance from the owner
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('user:owner', 'memory_search', 'read', 'universal memory retrieval'),
    ('user:owner', 'memory_add', 'write', 'universal memory storage'),
    ('user:owner', 'memory_reflect', 'write', 'universal memory reflection'),
    ('user:owner', 'collaborate_with_agent', 'write', 'bounded agent-to-agent collaboration');
`;
// ============================================================
// Example Roster Seed (NOT applied by any production path)
// ============================================================
// A governance database is born ungranted: GOVERNANCE_SEED above creates the
// owner principal, the tool catalog, default groups, and owner-level universal
// grants — and nothing else. Install-specific agents, workers, and their
// permissions belong to each install's own profile/grant process, so no install
// is born holding another install's roster or access.
//
// This example preserves the original upstream roster verbatim as opt-in
// reference material: an install that wants it (or a test that asserts against
// it) applies GOVERNANCE_DDL + GOVERNANCE_SEED + GOVERNANCE_EXAMPLE_SEED
// explicitly. Nothing applies it implicitly.
export const GOVERNANCE_EXAMPLE_SEED = `
  -- Example principals: agents and their workers
  INSERT OR IGNORE INTO principals (id, type, parent_id, display_name) VALUES
    ('agent:watson', 'agent', 'user:owner', 'Watson'),
    ('agent:malibu', 'agent', 'user:owner', 'Malibu'),
    ('agent:sierra', 'agent', 'user:owner', 'Sierra'),
    ('agent:charlie', 'agent', 'user:owner', 'Charlie'),
    ('agent:victor', 'agent', 'user:owner', 'Victor'),
    ('agent:papa', 'agent', 'user:owner', 'Papa'),
    ('agent:jules', 'agent', 'user:owner', 'Jules'),
    ('agent:foxtrot', 'agent', 'user:owner', 'Foxtrot'),
    ('agent:foxtrot-ollama', 'agent', 'user:owner', 'Foxtrot (Ollama)'),
    ('agent:sierra-ollama', 'agent', 'user:owner', 'Sierra (Ollama)'),
    ('agent:kilo', 'agent', 'user:owner', 'Kilo');

  INSERT OR IGNORE INTO principals (id, type, parent_id, display_name) VALUES
    ('worker:nutrition-logger', 'worker', 'agent:jules', 'Nutrition Logger'),
    ('worker:health-analyst', 'worker', 'agent:jules', 'Health Analyst'),
    ('worker:workout-recorder', 'worker', 'agent:malibu', 'Workout Recorder'),
    ('worker:recipe-librarian', 'worker', 'agent:jules', 'Recipe Librarian'),
    ('worker:activity-tracker', 'worker', 'agent:jules', 'Activity Tracker'),
    ('worker:personal-assistant', 'worker', 'agent:watson', 'Personal Assistant'),
    ('worker:research-assistant', 'worker', 'agent:sierra', 'Research Assistant'),
    ('worker:charlie', 'worker', 'agent:charlie', 'Charlie Runtime'),
    ('worker:charlie-ollama', 'worker', 'agent:charlie', 'Charlie Ollama Runtime'),
    ('worker:dev-assistant', 'worker', 'agent:victor', 'Dev Assistant'),
    ('worker:operations-assistant', 'worker', 'agent:victor', 'Operations Assistant'),
    ('worker:study-assistant', 'worker', 'agent:papa', 'Study Assistant'),
    ('worker:note-librarian', 'worker', NULL, 'Note Librarian'),
    ('worker:foxtrot', 'worker', 'agent:foxtrot', 'Foxtrot Runtime'),
    ('worker:foxtrot-ollama', 'worker', 'agent:foxtrot-ollama', 'Foxtrot Ollama Runtime'),
    ('worker:sierra-ollama', 'worker', 'agent:sierra-ollama', 'Sierra Ollama Runtime'),
    ('worker:kilo', 'worker', 'agent:kilo', 'Kilo Runtime');

  -- Worker permissions (seeded from current tool assignments)
  -- nutrition-logger
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:nutrition-logger', 'nutrition_log_items', 'write', 'seed from config'),
    ('worker:nutrition-logger', 'fatsecret_api', 'write', 'seed from config'),
    ('worker:nutrition-logger', 'atlas_sql', 'write', 'seed from config'),
    ('worker:nutrition-logger', 'recipe_read', 'read', 'seed from config'),
    ('worker:nutrition-logger', 'health_query', 'read', 'evening checkin: TDEE for calorie budget');

  -- health-analyst
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:health-analyst', 'health_query', 'read', 'seed from config');

  -- workout-recorder
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:workout-recorder', 'workout_sql', 'write', 'seed from config');

  -- recipe-librarian
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:recipe-librarian', 'atlas_sql', 'write', 'seed from config'),
    ('worker:recipe-librarian', 'recipe_list', 'read', 'seed from config'),
    ('worker:recipe-librarian', 'recipe_read', 'read', 'seed from config'),
    ('worker:recipe-librarian', 'recipe_write', 'write', 'seed from config'),
    ('worker:recipe-librarian', 'fatsecret_api', 'write', 'seed from config');

  -- personal-assistant (Watson)
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:personal-assistant', 'gog_email', 'write', 'seed from config'),
    ('worker:personal-assistant', 'gog_calendar', 'write', 'seed from config'),
    ('worker:personal-assistant', 'gog_docs', 'write', 'seed from config'),
    ('worker:personal-assistant', 'gog_docs_update_tab', 'write', 'seed from config'),
    ('worker:personal-assistant', 'obsidian', 'write', 'seed from config'),
    ('worker:personal-assistant', 'health_morning', 'read', 'seed from config'),
    ('worker:personal-assistant', 'lunch_money', 'write', 'seed from config'),
    ('worker:personal-assistant', 'receipt_registry', 'write', 'seed from config'),
    ('worker:personal-assistant', 'expense_reimbursement', 'write', 'seed from config'),
    ('worker:personal-assistant', 'agent_docs', 'write', 'seed from config'),
    ('worker:personal-assistant', 'slack', 'read', 'seed from config'),
    ('worker:personal-assistant', 'linear', 'write', 'seed from config'),
    ('worker:personal-assistant', 'imessage', 'write', 'seed from config'),
    ('worker:personal-assistant', 'acme_run', 'write', 'seed from config'),
    ('worker:personal-assistant', 'wispr_flow', 'read', 'Watson reads Wispr Flow meeting notes, transcripts, and scratchpad notes'),
    ('worker:personal-assistant', 'orientation_nudge', 'write', 'Watson controls orientation focus/vacation modes'),
    ('worker:personal-assistant', 'spawn_claude_session', 'write', 'spawn remote-controllable Claude Code sessions'),
    ('worker:personal-assistant', 'list_claude_sessions', 'read', 'list spawned Claude Code sessions');

  -- research-assistant (Sierra)
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:research-assistant', 'exa_search', 'read', 'seed from config'),
    ('worker:research-assistant', 'exa_answer', 'read', 'seed from config'),
    ('worker:research-assistant', 'printer_command', 'write', 'seed from config'),
    ('worker:research-assistant', 'openscad_render', 'write', 'seed from config'),
    ('worker:research-assistant', 'prusa_slice', 'write', 'seed from config'),
    ('worker:research-assistant', 'paper_print', 'write', 'travel document PDF previews and local paper printing'),
    ('worker:research-assistant', 'obsidian', 'write', 'travel planning + research filing'),
    ('worker:research-assistant', 'location_read', 'read', 'travel navigation'),
    ('worker:research-assistant', 'local_business_search', 'read', 'local business, restaurant, venue, class, and event candidate discovery'),
    ('worker:research-assistant', 'driving_route', 'read', 'travel route planning and drive-time verification'),
    ('worker:research-assistant', 'route_ahead_search', 'read', 'along-route POI search: rest areas, stops, and services ahead of the driver'),
    ('worker:research-assistant', 'walking_route', 'read', 'travel walking route planning and walk-time verification'),
    ('worker:research-assistant', 'find_diesel', 'read', 'travel navigation'),
    ('worker:research-assistant', 'browser', 'write', 'web automation for research and source review'),
    ('worker:research-assistant', 'slack', 'read', 'seed from config'),
    ('worker:research-assistant', 'file_ops', 'write', 'file access for Downloads, 3d-printing, Documents'),
    ('worker:research-assistant', 'youtube_transcript', 'read', 'YouTube transcript extraction'),
    ('worker:research-assistant', 'youtube_analyze', 'read', 'YouTube video analysis via Gemini');

  -- Sierra Ollama clone — explicit research/travel surface for direct clone channels.
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:sierra-ollama', 'exa_search', 'read', 'Sierra Ollama research parity'),
    ('worker:sierra-ollama', 'exa_answer', 'read', 'Sierra Ollama research parity'),
    ('worker:sierra-ollama', 'paper_print', 'write', 'Sierra Ollama paper document printing'),
    ('worker:sierra-ollama', 'location_read', 'read', 'Sierra Ollama travel navigation'),
    ('worker:sierra-ollama', 'local_business_search', 'read', 'Sierra Ollama local business and activity candidate discovery'),
    ('worker:sierra-ollama', 'driving_route', 'read', 'Sierra Ollama travel route planning and drive-time verification'),
    ('worker:sierra-ollama', 'route_ahead_search', 'read', 'Sierra Ollama along-route POI search: rest areas, stops, and services ahead of the driver'),
    ('worker:sierra-ollama', 'walking_route', 'read', 'Sierra Ollama walking route planning and walk-time verification'),
    ('worker:sierra-ollama', 'find_diesel', 'read', 'Sierra Ollama travel navigation'),
    ('worker:sierra-ollama', 'browser', 'write', 'Sierra Ollama web automation for research and source review');

  -- personal-assistant browser access (Watson — receipt lookup, transaction categorization)
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:personal-assistant', 'browser', 'write', 'web automation for receipt lookup and transaction categorization');

  -- Charlie — quick answers plus ephemeral current-location narration.
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:charlie', 'exa_search', 'read', 'quick factual lookup'),
    ('worker:charlie', 'exa_answer', 'read', 'quick factual lookup'),
    ('worker:charlie', 'obsidian', 'write', 'baseline quick-agent tool parity'),
    ('worker:charlie', 'agent_docs', 'write', 'agent documentation updates'),
    ('worker:charlie', 'location_read', 'read', 'ephemeral location narration'),
    ('worker:charlie-ollama', 'exa_search', 'read', 'quick factual lookup'),
    ('worker:charlie-ollama', 'exa_answer', 'read', 'quick factual lookup'),
    ('worker:charlie-ollama', 'obsidian', 'write', 'baseline quick-agent tool parity'),
    ('worker:charlie-ollama', 'agent_docs', 'write', 'agent documentation updates'),
    ('worker:charlie-ollama', 'location_read', 'read', 'ephemeral location narration');

  -- Foxtrot finance agents — canonical and Ollama share the same finance MCP surface.
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:foxtrot', 'attachment_search', 'read', 'finance attachment lookup'),
    ('worker:foxtrot', 'attachment_read', 'read', 'finance attachment lookup'),
    ('worker:foxtrot', 'attachment_status', 'read', 'finance attachment lookup'),
    ('worker:foxtrot', 'lunch_money', 'write', 'finance account and transaction operations'),
    ('worker:foxtrot', 'receipt_registry', 'write', 'receipt cataloging and reconciliation'),
    ('worker:foxtrot', 'expense_reimbursement', 'write', 'ExpenseDesk reimbursement automation'),
    ('worker:foxtrot', 'browser', 'write', 'finance and shopping web automation'),
    ('worker:foxtrot', 'walmart', 'write', 'Walmart shopping queue, history, and cart support'),
    ('worker:foxtrot', 'obsidian', 'write', 'finance runbooks and notes'),
    ('worker:foxtrot', 'onepassword', 'read', 'finance credential retrieval'),
    ('worker:foxtrot', 'gog_email', 'write', 'finance email lookup and drafting'),
    ('worker:foxtrot', 'agent_docs', 'write', 'agent documentation updates'),
    ('worker:foxtrot', 'kilo_ledger', 'write', 'Kilo spending ledger operations'),
    ('worker:foxtrot', 'bank_transfer', 'write', 'owner-approved Bank sinking-fund draws'),
    ('worker:foxtrot', 'memory_search', 'read', 'finance context retrieval'),
    ('worker:foxtrot', 'memory_add', 'write', 'finance memory capture'),
    ('worker:foxtrot', 'memory_reflect', 'write', 'finance memory reflection'),
    ('worker:foxtrot-ollama', 'attachment_search', 'read', 'finance attachment lookup'),
    ('worker:foxtrot-ollama', 'attachment_read', 'read', 'finance attachment lookup'),
    ('worker:foxtrot-ollama', 'attachment_status', 'read', 'finance attachment lookup'),
    ('worker:foxtrot-ollama', 'lunch_money', 'write', 'finance account and transaction operations'),
    ('worker:foxtrot-ollama', 'receipt_registry', 'write', 'receipt cataloging and reconciliation'),
    ('worker:foxtrot-ollama', 'expense_reimbursement', 'write', 'ExpenseDesk reimbursement automation'),
    ('worker:foxtrot-ollama', 'browser', 'write', 'finance and shopping web automation'),
    ('worker:foxtrot-ollama', 'walmart', 'write', 'Walmart shopping queue, history, and cart support'),
    ('worker:foxtrot-ollama', 'obsidian', 'write', 'finance runbooks and notes'),
    ('worker:foxtrot-ollama', 'onepassword', 'read', 'finance credential retrieval'),
    ('worker:foxtrot-ollama', 'gog_email', 'write', 'finance email lookup and drafting'),
    ('worker:foxtrot-ollama', 'agent_docs', 'write', 'agent documentation updates'),
    ('worker:foxtrot-ollama', 'kilo_ledger', 'write', 'Kilo spending ledger operations'),
    ('worker:foxtrot-ollama', 'memory_search', 'read', 'finance context retrieval'),
    ('worker:foxtrot-ollama', 'memory_add', 'write', 'finance memory capture'),
    ('worker:foxtrot-ollama', 'memory_reflect', 'write', 'finance memory reflection');

  -- Kilo kid-facing finance agent
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:kilo', 'kilo_ledger', 'write', 'Kilo bucket ledger operations');

  -- Jules wellness workers — browser + exa for macro/recipe/health lookups at worker cost
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:nutrition-logger', 'exa_search', 'read', 'Wellness worker macro and restaurant lookup'),
    ('worker:nutrition-logger', 'exa_answer', 'read', 'Wellness worker macro and restaurant lookup'),
    ('worker:nutrition-logger', 'browser', 'write', 'Wellness worker macro and restaurant lookup'),
    ('worker:recipe-librarian', 'exa_search', 'read', 'Wellness worker recipe research'),
    ('worker:recipe-librarian', 'exa_answer', 'read', 'Wellness worker recipe research'),
    ('worker:recipe-librarian', 'browser', 'write', 'Wellness worker recipe research'),
    ('worker:health-analyst', 'exa_search', 'read', 'Wellness worker health research'),
    ('worker:health-analyst', 'exa_answer', 'read', 'Wellness worker health research'),
    ('worker:health-analyst', 'browser', 'write', 'Wellness worker health research');

  -- 1Password access — Watson (personal assistant) needs credentials for service logins and API keys
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:personal-assistant', 'onepassword', 'read', 'credential retrieval for service logins and API keys');

  -- 1Password access — Sierra (research assistant) needs credentials for service logins
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:research-assistant', 'onepassword', 'read', 'credential retrieval for service logins');

  -- note-librarian — shared file-backed Obsidian access
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:note-librarian', 'obsidian', 'write', 'shared Obsidian note access'),
    ('worker:note-librarian', 'jules_files', 'write', 'bounded wellness workspace file access'),
    ('worker:nutrition-logger', 'wellnessdb_search_product', 'read', 'Jules wellness.db lookup'),
    ('worker:nutrition-logger', 'wellnessdb_search_supplement', 'read', 'Jules wellness.db lookup'),
    ('worker:nutrition-logger', 'wellnessdb_day_summary', 'read', 'Jules wellness.db day summary'),
    ('worker:nutrition-logger', 'wellnessdb_recent_meals', 'read', 'Jules wellness.db recent meals'),
    ('worker:nutrition-logger', 'wellnessdb_active_supplements', 'read', 'Jules wellness.db active supplements'),
    ('worker:nutrition-logger', 'wellnessdb_active_products', 'read', 'Jules wellness.db active products'),
    ('worker:nutrition-logger', 'wellnessdb_log_meal', 'write', 'Jules wellness.db meal logging'),
    ('worker:nutrition-logger', 'wellnessdb_log_supplement', 'write', 'Jules wellness.db supplement logging'),
    ('worker:nutrition-logger', 'wellnessdb_add_product', 'write', 'Jules wellness.db product creation'),
    ('worker:nutrition-logger', 'wellnessdb_add_day_note', 'write', 'Jules wellness.db day notes'),
    ('worker:nutrition-logger', 'wellnessdb_delete_meal_entry', 'write', 'Jules wellness.db meal corrections'),
    ('worker:recipe-librarian', 'wellnessdb_search_recipe', 'read', 'Jules wellness.db recipe lookup'),
    ('worker:recipe-librarian', 'wellnessdb_get_recipe_detail', 'read', 'Jules wellness.db recipe detail'),
    ('worker:recipe-librarian', 'wellnessdb_active_products', 'read', 'Jules wellness.db active products'),
    ('worker:recipe-librarian', 'wellnessdb_add_recipe', 'write', 'Jules wellness.db recipe creation'),
    ('worker:recipe-librarian', 'wellnessdb_update_recipe', 'write', 'Jules wellness.db recipe updates'),
    ('worker:health-analyst', 'wellnessdb_day_summary', 'read', 'Jules wellness.db day summary'),
    ('worker:health-analyst', 'wellnessdb_day_range', 'read', 'Jules wellness.db trend analysis'),
    ('worker:activity-tracker', 'wellnessdb_log_weight', 'write', 'Jules wellness.db weight logging'),
    ('worker:activity-tracker', 'wellnessdb_log_activity', 'write', 'Jules wellness.db activity logging'),
    ('worker:activity-tracker', 'wellnessdb_log_hydration', 'write', 'Jules wellness.db hydration logging'),
    ('agent:jules', 'wellnessdb_log_presence', 'write', 'Jules direct presence check logging'),
    ('worker:note-librarian', 'memory_search', 'read', 'memory lookup while resolving notes'),
    ('worker:note-librarian', 'memory_add', 'write', 'memory capture for durable note context'),
    ('worker:note-librarian', 'memory_reflect', 'write', 'memory reflection for durable note context');

  -- attachment read tools are safe for all current workers
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
  SELECT p.id, tool_ids.tool_id, 'read', 'attachment read tools available to all workers'
  FROM principals p
  CROSS JOIN (
    SELECT 'attachment_search' AS tool_id
    UNION ALL SELECT 'attachment_read'
    UNION ALL SELECT 'attachment_status'
  ) AS tool_ids
  WHERE p.type = 'worker';

  -- dev-assistant (Victor) — uses built-in Claude tools for dev work, MCP for Discord + tango management
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:dev-assistant', 'discord_manage', 'write', 'seed from config'),
    ('worker:dev-assistant', 'tango_shell', 'write', 'seed from config'),
    ('worker:dev-assistant', 'tango_file', 'write', 'seed from config');

  -- operations-assistant (Victor) — Linear + Obsidian operational project tracking
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:operations-assistant', 'linear', 'write', 'operations project tracking'),
    ('worker:operations-assistant', 'obsidian', 'write', 'operations context and decision logs'),
    ('worker:operations-assistant', 'memory_search', 'read', 'memory lookup for durable operations context'),
    ('worker:operations-assistant', 'memory_add', 'write', 'memory capture for durable operations context'),
    ('worker:operations-assistant', 'memory_reflect', 'write', 'memory reflection for durable operations context');

  -- study-assistant (Papa) — study and calling support
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:study-assistant', 'study_library', 'write', 'study library marking and linking'),
    ('worker:study-assistant', 'obsidian', 'write', 'library study notes and study outlines'),
    ('worker:study-assistant', 'browser', 'write', 'authenticated Study Library marking and linking'),
    ('worker:study-assistant', 'onepassword', 'read', 'credential retrieval for Library login if explicitly configured'),
    ('worker:study-assistant', 'gog_email', 'read', 'read-only study context from email'),
    ('worker:study-assistant', 'memory_search', 'read', 'memory lookup for durable library context'),
    ('worker:study-assistant', 'memory_add', 'write', 'memory capture for durable library context'),
    ('worker:study-assistant', 'memory_reflect', 'write', 'memory reflection for durable library context');

  -- discord_send_image — outbound Discord images for every persona whose YAML carries
  -- the send-image MCP entry (all agents except kilo, which is excluded pending owner
  -- decision). Deliberately NOT granted via user:owner inheritance so the kilo
  -- exclusion holds. The -ollama clone principals are live-managed rather than seeded
  -- (except sierra/foxtrot); scripts/grant-send-image.mjs applies the same grant to
  -- them and to already-initialized DBs, which never re-run this seed.
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:personal-assistant', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:research-assistant', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:study-assistant', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:dev-assistant', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:operations-assistant', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:charlie', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:charlie-ollama', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:workout-recorder', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:foxtrot', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:foxtrot-ollama', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:sierra-ollama', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:nutrition-logger', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:recipe-librarian', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:health-analyst', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:activity-tracker', 'discord_send_image', 'write', 'outbound Discord image sending'),
    ('worker:note-librarian', 'discord_send_image', 'write', 'outbound Discord image sending');

  -- screen (staging scenes for the owner's screens) has no seeded grants: its
  -- principals are the live agent principals (worker:<agent-id>, from WORKER_ID),
  -- which the seed does not create. scripts/grant-screen.mjs grants it.
  -- desk_mail (agents' conversations mailing each other and starting threads) likewise:
  -- scripts/grant-desk-mail.mjs grants it to every agent whose YAML mounts it.

  -- Todoist is scoped to the personal assistant; other installations opt in explicitly.
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('worker:personal-assistant', 'todoist', 'write', 'personal task management');

  -- Example-roster agent collaboration grants
  INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
    ('agent:watson', 'collaborate_with_agent', 'write', 'Watson bounded specialist collaboration'),
    ('agent:victor', 'collaborate_with_agent', 'write', 'Victor bounded specialist collaboration');
`;
