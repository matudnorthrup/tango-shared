import { createHash } from "node:crypto";

type Resource = "filters" | "view_options";
type Row = Record<string, unknown>;
interface Snapshot {
  token: string;
  filters: Map<string, Row>;
  view_options: Map<string, Row>;
}

const resources: Resource[] = ["filters", "view_options"];
const snapshots = new Map<string, Snapshot>();
// Keep serialization separate from the bounded LRU snapshots. An in-flight
// account may be evicted, but requests for that account must still serialize.
const queues = new Map<string, Promise<void>>();
const MAX_ACCOUNTS = 4;

function invalidResponse(): never {
  throw new Error("Unexpected Todoist sync response. Verify current state before retrying a write.");
}

function identity(row: Row, resource: Resource): string {
  if (row.id !== undefined && (typeof row.id !== "string" || !row.id.trim())) invalidResponse();
  if (resource === "view_options" && row.view_type !== undefined) {
    if (typeof row.view_type !== "string") invalidResponse();
    const type = row.view_type.toLowerCase();
    const objectView = ["project", "label", "filter", "workspace_filter"].includes(type);
    if (!objectView && !["today", "upcoming", "assigned_to_me"].includes(type)) invalidResponse();
    if (objectView ? typeof row.object_id !== "string" || !row.object_id.trim() : row.object_id !== undefined && row.object_id !== null) invalidResponse();
    return `view:${JSON.stringify([type, row.object_id ?? null])}`;
  }
  if (typeof row.id !== "string" || !row.id.trim()) invalidResponse();
  return `id:${row.id}`;
}

function rows(value: unknown, required: boolean, resource: Resource): Row[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) invalidResponse();
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) invalidResponse();
    const key = identity(row, resource);
    if (seen.has(key)) invalidResponse();
    if (row.is_deleted !== undefined && ![true, false, 0, 1].includes(row.is_deleted)) invalidResponse();
    seen.add(key);
  }
  return structuredClone(value) as Row[];
}

function merged(previous: Map<string, Row> | undefined, changes: Row[], resource: Resource): Map<string, Row> {
  const result = new Map(previous);
  for (const row of changes) {
    const identified = identity(row, resource);
    // A view tombstone may contain only its ID, while documented views can omit
    // IDs entirely. Match either stable ID or the normalized logical view key.
    const byId = row.id === undefined ? undefined : [...result].find(([, existing]) => existing.id === row.id)?.[0];
    const key = byId ?? identified;
    if (row.is_deleted === true || row.is_deleted === 1) result.delete(key);
    else {
      const combined = { ...result.get(key), ...row };
      result.delete(key);
      result.set(identity(combined, resource), combined);
    }
  }
  return result;
}

function remember(key: string, snapshot: Snapshot) {
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > MAX_ACCOUNTS) snapshots.delete(snapshots.keys().next().value!);
}

/**
 * Sync only the two management resources, retaining incremental state in memory.
 * Every call contacts Todoist; cached state is never used to hide a failed call.
 * Commands are sent once, unchanged, and their acknowledgements remain available
 * to the operation handler even when an individual command failed.
 */
export async function syncTodoistManagement(
  token: string,
  args: Record<string, string>,
  send: (args: Record<string, string>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (!token.trim()) throw new Error("Todoist sync requires a credential.");
  if (args.resource_types !== undefined) {
    let requested: unknown;
    try { requested = JSON.parse(args.resource_types); } catch { throw new Error("Invalid Todoist management resource types."); }
    if (!Array.isArray(requested) || !requested.length || requested.some(resource => !resources.includes(resource))) throw new Error("Unsupported Todoist management resource types.");
  }
  const key = createHash("sha256").update(token).digest("hex");
  const requestArgs = { ...args };
  const previous = queues.get(key) ?? Promise.resolve();
  const task = previous.then(async () => {
    const current = snapshots.get(key);
    if (current) remember(key, current);
    const response = await send({ ...requestArgs, sync_token: current?.token ?? "*", resource_types: JSON.stringify(resources) });
    if (!response || typeof response !== "object" || Array.isArray(response)
      || typeof response.full_sync !== "boolean" || typeof response.sync_token !== "string"
      || !response.sync_token.trim() || response.sync_token === "*" || (!current && !response.full_sync)) invalidResponse();
    // Validate both resources before changing either the rows or the sync token.
    const filters = rows(response.filters, response.full_sync, "filters");
    const views = rows(response.view_options, response.full_sync, "view_options");
    const snapshot: Snapshot = {
      token: response.sync_token,
      filters: merged(response.full_sync ? undefined : current?.filters, filters, "filters"),
      view_options: merged(response.full_sync ? undefined : current?.view_options, views, "view_options"),
    };
    const result = structuredClone({ ...response, filters: [...snapshot.filters.values()], view_options: [...snapshot.view_options.values()] });
    remember(key, snapshot);
    return result;
  });
  // A rejected call must not poison subsequent calls for this credential.
  const tail = task.then(() => undefined, () => undefined);
  queues.set(key, tail);
  try { return await task; }
  finally { if (queues.get(key) === tail) queues.delete(key); }
}

/** Test isolation only; callers must not clear state while requests are running. */
export function resetTodoistManagementSyncForTests(): void {
  if (queues.size) throw new Error("Cannot clear Todoist sync state while requests are running.");
  snapshots.clear();
}
