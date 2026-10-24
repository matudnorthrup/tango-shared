#!/usr/bin/env tsx

/**
 * Supervised state backfill.
 *
 * Default mode is read-only and emits a review report. Applying requires both
 * --apply and a reviewed --plan JSON file; there is no implicit apply path.
 */
import fs from "node:fs";
import { StateService, TangoStorage, resolveDatabasePath } from "../packages/core/src/index.ts";
import { AtlasMemoryClient } from "../packages/discord/src/atlas-memory-client.ts";

interface ReviewedPlan {
  type: string;
  entity_updates?: Array<{
    entity_id?: string;
    type_id?: string;
    title?: string;
    attributes?: Record<string, unknown>;
    status?: string | null;
    summary?: string | null;
    occurred_at?: string;
  }>;
  memory_actions?: Array<{
    memory_id: string;
    entity_id: string;
    event_id?: number;
    verdict: "current_truth" | "state_adjacent" | "unsure";
  }>;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const storage = new TangoStorage(resolveDatabasePath(options.dbPath));
  const state = new StateService(storage.getDatabase());
  const atlas = new AtlasMemoryClient(options.atlasDbPath);
  try {
    if (!options.apply) {
      const entities = state.query({
        type: options.type,
        ...(options.entityId ? { entityId: options.entityId } : {}),
        includePrivate: true,
        includeArchived: true,
        limit: 500,
      }).entities;
      const report = [];
      for (const entity of entities) {
        const memories = await atlas.memorySearch({
          query: [entity.title, ...Object.keys(entity.attributes)].join(" "),
          limit: options.limit,
        });
        report.push({
          entity: { id: entity.id, type: entity.typeId, title: entity.title, status: entity.status, attributes: entity.attributes },
          candidates: memories.map((memory) => ({
            id: memory.id,
            created_at: memory.createdAt,
            tags: memory.tags,
            content: memory.content,
          })),
        });
      }
      console.log(JSON.stringify({ mode: "dry-run", type: options.type, entities: report }, null, 2));
      return;
    }

    if (!options.planPath) throw new Error("--apply requires --plan <reviewed.json>.");
    const plan = JSON.parse(fs.readFileSync(options.planPath, "utf8")) as ReviewedPlan;
    if (plan.type !== options.type) throw new Error(`Reviewed plan type '${plan.type}' does not match --type '${options.type}'.`);
    const latestEventByEntity = new Map<string, number>();
    let updated = 0;
    for (const item of plan.entity_updates ?? []) {
      const result = state.mutate({
        ...(item.entity_id ? { entityId: item.entity_id } : {}),
        ...(!item.entity_id && item.type_id ? { typeId: item.type_id } : {}),
        ...(!item.entity_id && item.title ? { title: item.title } : {}),
        ...(item.attributes ? { attributes: item.attributes } : {}),
        ...(item.status !== undefined ? { status: item.status } : {}),
        ...(item.summary !== undefined ? { summary: item.summary } : {}),
        kind: "observation",
        note: "Applied from reviewed state backfill plan",
      }, {
        actor: "backfill",
        source: "backfill",
        includePrivate: true,
        occurredAt: item.occurred_at,
      });
      if (result.event) latestEventByEntity.set(result.entity.id, result.event.id);
      if (result.applied) updated += 1;
    }
    let archived = 0;
    let tagged = 0;
    for (const action of plan.memory_actions ?? []) {
      const eventId = action.event_id
        ?? latestEventByEntity.get(action.entity_id)
        ?? state.listEvents(action.entity_id, 1)[0]?.id;
      if (!eventId) throw new Error(`No owning state event is available for memory action '${action.memory_id}'.`);
      await atlas.memoryAdmin({ operation: "tag", filter: { ids: [action.memory_id], include_archived: true, add_tags: [`state:${action.entity_id}`] } });
      tagged += 1;
      if (action.verdict === "current_truth") {
        await atlas.memoryAdmin({
          operation: "archive",
          filter: { ids: [action.memory_id], include_archived: true, metadata_patch: { superseded_by: eventId, state_entity_id: action.entity_id } },
        });
        archived += 1;
      }
      state.linkMemoryVerdict({ eventId, memoryId: action.memory_id, entityId: action.entity_id, verdict: action.verdict, archived: action.verdict === "current_truth" });
    }
    console.log(JSON.stringify({ mode: "apply-reviewed-plan", type: options.type, updated, tagged, archived }, null, 2));
  } finally {
    atlas.close();
    storage.close();
  }
}

function parseArgs(args: string[]): { type: string; entityId?: string; dbPath?: string; atlasDbPath?: string; limit: number; apply: boolean; planPath?: string } {
  let type = "";
  let entityId: string | undefined;
  let dbPath: string | undefined;
  let atlasDbPath: string | undefined;
  let planPath: string | undefined;
  let limit = 20;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const next = args[index + 1];
    if (arg === "--apply") { apply = true; continue; }
    if (!next) throw new Error(`${arg} requires a value.`);
    if (arg === "--type") type = next;
    else if (arg === "--entity-id") entityId = next;
    else if (arg === "--db" || arg === "--db-path") dbPath = next;
    else if (arg === "--atlas-db") atlasDbPath = next;
    else if (arg === "--plan") planPath = next;
    else if (arg === "--limit") limit = Math.max(1, Math.min(100, Number.parseInt(next, 10)));
    else throw new Error(`Unknown argument '${arg}'.`);
    index += 1;
  }
  if (!type) throw new Error("--type is required.");
  return { type, entityId, dbPath, atlasDbPath, limit, apply, planPath };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
