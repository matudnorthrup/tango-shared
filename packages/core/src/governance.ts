/**
 * Governance — Permission checker with 4-step resolution and audit logging.
 *
 * Resolution order:
 *   1. Explicit principal permission
 *   2. Group permissions (highest access level wins)
 *   3. Parent principal inheritance (worker→agent→user)
 *   4. Default deny
 *
 * Every check is logged to governance_log.
 * See docs/plans/governance-permissions.md for full design.
 */

import { DatabaseSync } from "node:sqlite";
import type { AccessLevel, PermissionCheckResult } from "./governance-schema.js";
import { accessLevelMeetsRequired } from "./governance-schema.js";

export class GovernanceChecker {
  private db: DatabaseSync;

  // Cached prepared statements
  private stmtExplicitPerm;
  private stmtGroupPerms;
  private stmtParent;
  private stmtExplicitTools;
  private stmtGroupTools;
  private stmtLogInsert;
  private stmtToolAccessType;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.stmtExplicitPerm = db.prepare(
      `SELECT access_level FROM permissions
       WHERE principal_id = ? AND tool_id = ?
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    );
    this.stmtGroupPerms = db.prepare(
      `SELECT p.access_level, p.group_id FROM permissions p
       JOIN group_members gm ON p.group_id = gm.group_id
       WHERE gm.principal_id = ? AND p.tool_id = ?
       AND (p.expires_at IS NULL OR p.expires_at > datetime('now'))`,
    );
    this.stmtParent = db.prepare(
      "SELECT parent_id FROM principals WHERE id = ?",
    );
    this.stmtExplicitTools = db.prepare(
      `SELECT tool_id FROM permissions
       WHERE principal_id = ? AND access_level != 'none'
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    );
    this.stmtGroupTools = db.prepare(
      `SELECT DISTINCT p.tool_id FROM permissions p
       JOIN group_members gm ON p.group_id = gm.group_id
       WHERE gm.principal_id = ? AND p.access_level != 'none'
       AND (p.expires_at IS NULL OR p.expires_at > datetime('now'))`,
    );
    this.stmtLogInsert = db.prepare(
      `INSERT INTO governance_log
       (principal_id, tool_id, action, decision, access_level_required, access_level_found, resolved_via, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtToolAccessType = db.prepare(
      "SELECT access_type FROM governance_tools WHERE id = ?",
    );
  }

  /**
   * Check if a principal has permission to use a tool at the required level.
   * Logs the result to governance_log.
   */
  checkPermission(
    principalId: string,
    toolId: string,
    requiredLevel: AccessLevel,
    context?: Record<string, unknown>,
  ): PermissionCheckResult {
    const result = this.resolve(principalId, toolId, requiredLevel);
    this.log(principalId, toolId, requiredLevel, result, context);
    return result;
  }

  /**
   * Check if a principal can use a tool at the required level without writing
   * an audit log entry. Useful for pre-filtering tools/list results.
   */
  hasPermission(
    principalId: string,
    toolId: string,
    requiredLevel: AccessLevel,
  ): boolean {
    return this.resolve(principalId, toolId, requiredLevel).granted;
  }

  /**
   * Get all tool IDs a principal is permitted to use (any level above 'none').
   * Checks explicit, group, and inherited permissions.
   */
  getPermittedTools(principalId: string): string[] {
    const toolIds = new Set<string>();
    this.collectPermittedTools(principalId, toolIds);
    return [...toolIds];
  }

  /**
   * Look up a tool's inherent access type ('read' or 'write') from the registry.
   * Returns null if the tool is not registered.
   */
  getToolAccessType(toolId: string): "read" | "write" | null {
    const row = this.stmtToolAccessType.get(toolId) as
      | { access_type: "read" | "write" }
      | undefined;
    return row?.access_type ?? null;
  }

  // --------------------------------------------------------
  // 4-step resolution
  // --------------------------------------------------------

  private resolve(
    principalId: string,
    toolId: string,
    requiredLevel: AccessLevel,
  ): PermissionCheckResult {
    // Step 1: Explicit principal permission
    const explicit = this.stmtExplicitPerm.get(principalId, toolId) as
      | { access_level: AccessLevel }
      | undefined;

    if (explicit) {
      if (explicit.access_level === "none") {
        return { granted: false, resolvedVia: "explicit_deny" };
      }
      if (accessLevelMeetsRequired(explicit.access_level, requiredLevel)) {
        return {
          granted: true,
          resolvedVia: "explicit",
          accessLevel: explicit.access_level,
        };
      }
    }

    // Step 2: Group permissions (highest wins)
    const groupPerms = this.stmtGroupPerms.all(principalId, toolId) as Array<{
      access_level: AccessLevel;
      group_id: string;
    }>;

    if (groupPerms.length > 0) {
      let best = groupPerms[0]!;
      for (const gp of groupPerms) {
        if (accessLevelMeetsRequired(gp.access_level, best.access_level)) {
          best = gp;
        }
      }
      if (accessLevelMeetsRequired(best.access_level, requiredLevel)) {
        return {
          granted: true,
          resolvedVia: `group:${best.group_id}`,
          accessLevel: best.access_level,
        };
      }
    }

    // Step 3: Parent inheritance
    const principal = this.stmtParent.get(principalId) as
      | { parent_id: string | null }
      | undefined;

    if (principal?.parent_id) {
      const parentResult = this.resolve(
        principal.parent_id,
        toolId,
        requiredLevel,
      );
      if (parentResult.granted) {
        return {
          granted: true,
          resolvedVia: `inherited:${principal.parent_id}`,
          accessLevel: parentResult.accessLevel,
        };
      }
    }

    // Step 4: Default deny
    return { granted: false, resolvedVia: "default_deny" };
  }

  // --------------------------------------------------------
  // Collect all permitted tools (for tools/list filtering)
  // --------------------------------------------------------

  private collectPermittedTools(
    principalId: string,
    toolIds: Set<string>,
  ): void {
    // Explicit permissions
    const explicit = this.stmtExplicitTools.all(principalId) as Array<{
      tool_id: string;
    }>;
    for (const row of explicit) toolIds.add(row.tool_id);

    // Group permissions
    const groupTools = this.stmtGroupTools.all(principalId) as Array<{
      tool_id: string;
    }>;
    for (const row of groupTools) toolIds.add(row.tool_id);

    // Parent inheritance
    const principal = this.stmtParent.get(principalId) as
      | { parent_id: string | null }
      | undefined;
    if (principal?.parent_id) {
      this.collectPermittedTools(principal.parent_id, toolIds);
    }
  }

  // --------------------------------------------------------
  // Audit log
  // --------------------------------------------------------

  private log(
    principalId: string,
    toolId: string,
    requiredLevel: AccessLevel,
    result: PermissionCheckResult,
    context?: Record<string, unknown>,
  ): void {
    try {
      this.stmtLogInsert.run(
        principalId,
        toolId,
        "permission_check",
        result.granted ? "granted" : "denied",
        requiredLevel,
        result.accessLevel ?? null,
        result.resolvedVia,
        context ? JSON.stringify(context) : null,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[governance] audit log write failed for ${principalId}/${toolId}: ${message}`);
    }
  }
}
