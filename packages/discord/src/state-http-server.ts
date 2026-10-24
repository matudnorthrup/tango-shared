import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  StateAccessContext,
  StateEntityMutation,
  StateMutationContext,
  StateQueryInput,
  StateService,
  V2AgentConfig,
} from "@tango/core";

export interface StateHttpServerOptions {
  service: StateService;
  v2Configs?: ReadonlyMap<string, V2AgentConfig>;
  host?: string;
  port?: number;
  unarchiveMemories?: (eventIds: readonly number[]) => Promise<void>;
  reportError?: (error: unknown) => void;
}

export interface StateHttpServer {
  server: Server;
  url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9340;
const MAX_BODY_BYTES = 1_000_000;

export function createStateHttpServer(options: StateHttpServerOptions): StateHttpServer {
  const host = options.host ?? process.env.TANGO_STATE_HOST ?? DEFAULT_HOST;
  const port = options.port ?? numberEnv(process.env.TANGO_STATE_PORT, DEFAULT_PORT);
  const server = createServer((req, res) => {
    void handleRequest(req, res, options).catch((error) => {
      (options.reportError ?? reportServerError)(error);
      sendJson(res, 500, { error: "Internal server error" });
    });
  });
  return {
    server,
    get url() {
      const address = server.address();
      const activePort = typeof address === "object" && address ? address.port : port;
      return `http://${host}:${activePort}`;
    },
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    }),
    stop: () => new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function reportServerError(error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
  console.error(`[state-http] request failed: ${detail}`);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: StateHttpServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://state.local");
  const path = normalizeMountedPath(url.pathname);
  if (req.method === "GET" && path === "/api/health") {
    sendJson(res, 200, { status: "ok", service: "tango-state", schema: 1 });
    return;
  }
  if (req.method === "GET" && path === "/api/types") {
    sendJson(res, 200, { types: options.service.listTypes({ includePrivate: true }) });
    return;
  }
  if (req.method === "GET" && path === "/api/entities") {
    sendJson(res, 200, options.service.query({
      includePrivate: true,
      type: valueOrUndefined(url.searchParams.get("type")),
      status: valueOrUndefined(url.searchParams.get("status")),
      text: valueOrUndefined(url.searchParams.get("q")),
      stale: booleanQuery(url.searchParams.get("stale")),
      overdue: booleanQuery(url.searchParams.get("overdue")),
      projectEntityId: valueOrUndefined(url.searchParams.get("project_entity_id")),
      ownerUserId: valueOrUndefined(url.searchParams.get("owner_user_id")),
      ownerAgentId: valueOrUndefined(url.searchParams.get("owner_agent_id")),
      source: valueOrUndefined(url.searchParams.get("source")),
      dueBefore: valueOrUndefined(url.searchParams.get("due_before")),
      dueAfter: valueOrUndefined(url.searchParams.get("due_after")),
      nextCheckBefore: valueOrUndefined(url.searchParams.get("next_check_before")),
      nextCheckAfter: valueOrUndefined(url.searchParams.get("next_check_after")),
      expectedResponseBefore: valueOrUndefined(url.searchParams.get("expected_response_before")),
      expectedResponseAfter: valueOrUndefined(url.searchParams.get("expected_response_after")),
      lastProgressBefore: valueOrUndefined(url.searchParams.get("last_progress_before")),
      lastProgressAfter: valueOrUndefined(url.searchParams.get("last_progress_after")),
      progressOlderThanDays: numberQueryOrUndefined(url.searchParams.get("progress_older_than_days")),
      progressNewerThanDays: numberQueryOrUndefined(url.searchParams.get("progress_newer_than_days")),
      relationKind: valueOrUndefined(url.searchParams.get("relation_kind")),
      relatedEntityId: valueOrUndefined(url.searchParams.get("related_entity_id")),
      referenceRole: valueOrUndefined(url.searchParams.get("reference_role")),
      includeRelations: url.searchParams.get("include_relations") === "true",
      includeReferences: url.searchParams.get("include_references") === "true",
      includeArchived: url.searchParams.get("archived") === "true",
      limit: numberQuery(url.searchParams.get("limit"), 200),
    }));
    return;
  }
  if (req.method === "GET" && path.startsWith("/api/entities/")) {
    const entityId = decodeURIComponent(path.slice("/api/entities/".length));
    const result = options.service.query({
      includePrivate: true,
      entityId,
      includeArchived: true,
      includeRelations: true,
      includeReferences: true,
      recentEvents: 100,
    });
    if (result.entities.length === 0) {
      sendJson(res, 404, { error: "Entity not found" });
      return;
    }
    sendJson(res, 200, { entity: result.entities[0] });
    return;
  }
  if (req.method === "GET" && path === "/api/board") {
    sendJson(res, 200, options.service.getBoard({ includePrivate: true }));
    return;
  }
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(STATE_DASHBOARD_HTML);
    return;
  }

  if (req.method === "POST" && path.startsWith("/api/tools/")) {
    const payload = await readJson(req);
    const input = recordValue(payload.input);
    const context = recordValue(payload.context);
    const tool = path.slice("/api/tools/".length);
    const result = await handleTool(tool, input, context, options);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && path === "/api/entities") {
    const payload = recordValue(await readJson(req));
    const result = options.service.mutate(toEntityMutation(payload), dashboardContext(payload));
    sendJson(res, 200, result);
    return;
  }
  if ((req.method === "PATCH" || req.method === "POST") && /^\/api\/entities\/[^/]+$/u.test(path)) {
    const entityId = decodeURIComponent(path.slice("/api/entities/".length));
    const payload = recordValue(await readJson(req));
    const result = options.service.mutate({ entityId, ...toEntityMutation(payload) }, dashboardContext(payload));
    sendJson(res, 200, result);
    return;
  }
  const actionMatch = /^\/api\/entities\/([^/]+)\/(archive|restore)$/u.exec(path);
  if (req.method === "POST" && actionMatch) {
    const entityId = decodeURIComponent(actionMatch[1]!);
    const context = dashboardContext({});
    const result = actionMatch[2] === "archive"
      ? options.service.archiveEntity(entityId, context)
      : options.service.restoreEntity(entityId, context);
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && path === "/api/revert") {
    const payload = recordValue(await readJson(req));
    const context = dashboardContext(payload);
    if (numericValue(payload.event_id) !== null) {
      const result = options.service.revertEvent(numericValue(payload.event_id)!, context);
      if (result.event?.revertsEventId) await options.unarchiveMemories?.([result.event.revertsEventId]);
      sendJson(res, 200, result);
      return;
    }
    const turnId = stringValue(payload.turn_id);
    if (!turnId) throw new Error("event_id or turn_id is required");
    const result = options.service.revertTurn(turnId, context);
    await options.unarchiveMemories?.(result.revertedEventIds);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleTool(
  tool: string,
  input: Record<string, unknown>,
  hidden: Record<string, unknown>,
  options: StateHttpServerOptions,
): Promise<unknown> {
  const agentId = stringValue(hidden.agent_id);
  const v2Config = agentId ? options.v2Configs?.get(agentId) : undefined;
  const access: StateAccessContext = {
    agentId,
    agentType: v2Config?.type ?? null,
    scopes: [v2Config?.type ?? "", agentId?.replace(/-ollama$/u, "") ?? ""],
  };
  if (tool === "state_query") {
    const trendInput = recordValue(input.trend);
    const query: StateQueryInput = {
      ...access,
      entityId: stringValue(input.entity_id) ?? undefined,
      type: stringValue(input.type) ?? undefined,
      status: stringValue(input.status) ?? undefined,
      stale: typeof input.stale === "boolean" ? input.stale : undefined,
      overdue: typeof input.overdue === "boolean" ? input.overdue : undefined,
      text: stringValue(input.text) ?? undefined,
      projectEntityId: stringValue(input.project_entity_id) ?? undefined,
      ownerUserId: stringValue(input.owner_user_id) ?? undefined,
      ownerAgentId: stringValue(input.owner_agent_id) ?? undefined,
      source: stringValue(input.source) ?? undefined,
      dueBefore: stringValue(input.due_before) ?? undefined,
      dueAfter: stringValue(input.due_after) ?? undefined,
      nextCheckBefore: stringValue(input.next_check_before) ?? undefined,
      nextCheckAfter: stringValue(input.next_check_after) ?? undefined,
      expectedResponseBefore: stringValue(input.expected_response_before) ?? undefined,
      expectedResponseAfter: stringValue(input.expected_response_after) ?? undefined,
      lastProgressBefore: stringValue(input.last_progress_before) ?? undefined,
      lastProgressAfter: stringValue(input.last_progress_after) ?? undefined,
      progressOlderThanDays: numericValue(input.progress_older_than_days) ?? undefined,
      progressNewerThanDays: numericValue(input.progress_newer_than_days) ?? undefined,
      relationKind: stringValue(input.relation_kind) ?? undefined,
      relatedEntityId: stringValue(input.related_entity_id) ?? undefined,
      referenceRole: stringValue(input.reference_role) ?? undefined,
      includeRelations: input.include_relations === true,
      includeReferences: input.include_references === true,
      includeArchived: input.include_archived === true,
      limit: numericValue(input.limit) ?? undefined,
      recentEvents: numericValue(input.recent_events) ?? undefined,
      ...(stringValue(trendInput.field)
        ? {
            trend: {
              field: stringValue(trendInput.field)!,
              windowDays: numericValue(trendInput.window_days) ?? undefined,
              aggregation: trendAggregation(trendInput.aggregation),
            },
          }
        : {}),
    };
    const result = options.service.query(query);
    const typeId = stringValue(input.type);
    return typeId
      ? { ...result, typeDefinition: options.service.getType(typeId, access) }
      : result;
  }
  if (tool === "state_define_type") {
    return options.service.defineType({
      id: requireString(input.id, "id"),
      displayName: requireString(input.display_name, "display_name"),
      description: stringValue(input.description),
      attributesSchema: recordValue(input.attributes_schema),
      statuses: (isRecord(input.statuses) ? input.statuses : null) as never,
      stalenessPolicy: (isRecord(input.staleness_policy) ? input.staleness_policy : null) as never,
      digestTemplate: input.digest_template === null ? null : stringValue(input.digest_template),
      bodyFields: stringArray(input.body_fields),
      visibility: stringValue(input.visibility) ?? "shared",
      origin: "conversation",
      confirm: input.confirm === true,
    }, access);
  }
  if (tool !== "state_update") throw new Error(`Unknown state tool '${tool}'.`);
  const mode = requireString(input.mode, "mode");
  const mutationContext: StateMutationContext = {
    ...access,
    actor: agentId ?? "agent",
    source: "tool",
    sessionId: stringValue(hidden.conversation_key),
    messageId: stringValue(hidden.message_id),
    turnId: stringValue(hidden.turn_id),
    occurredAt: stringValue(input.occurred_at),
  };
  if (mode === "revert_event") {
    const eventId = numericValue(input.event_id);
    if (eventId === null) throw new Error("event_id is required for revert_event");
    const result = options.service.revertEvent(eventId, mutationContext);
    await options.unarchiveMemories?.([eventId]);
    return result;
  }
  if (mode === "revert_turn") {
    const conversationKey = stringValue(hidden.conversation_key);
    const turnId = stringValue(input.turn_id)
      ?? (conversationKey ? options.service.findLatestTurnId(conversationKey, stringValue(hidden.turn_id) ?? undefined) : null);
    if (!turnId) throw new Error("No previous state-changing turn was available to revert.");
    const result = options.service.revertTurn(turnId, mutationContext);
    await options.unarchiveMemories?.(result.revertedEventIds);
    return result;
  }
  const entityMutation = toEntityMutation(input);
  if (
    mode === "upsert"
    && entityMutation.entityId
    && entityMutation.typeId
    && entityMutation.title
    && !options.service.getEntity(entityMutation.entityId, access, true)
  ) {
    // Models commonly predict the slug while creating. The service owns slug
    // assignment, so treat an unknown id plus a complete identity as a create.
    delete entityMutation.entityId;
  }
  if (mode === "transition") entityMutation.kind = "status_change";
  if (mode === "observation") entityMutation.kind = "observation";
  if (mode === "note") entityMutation.kind = "note";
  if (mode === "archive") entityMutation.archive = true;
  if (mode === "restore") entityMutation.restore = true;
  return options.service.mutate(entityMutation, mutationContext);
}

function toEntityMutation(input: Record<string, unknown>): StateEntityMutation {
  return {
    entityId: stringValue(input.entity_id) ?? undefined,
    typeId: stringValue(input.type_id) ?? undefined,
    title: stringValue(input.title) ?? undefined,
    aliases: stringArray(input.aliases),
    attributes: isRecord(input.attributes) ? input.attributes : undefined,
    ...(input.status === null || typeof input.status === "string" ? { status: input.status as string | null } : {}),
    ...(input.summary === null || typeof input.summary === "string" ? { summary: input.summary as string | null } : {}),
    ...(input.body_pointer === null || typeof input.body_pointer === "string" ? { bodyPointer: input.body_pointer as string | null } : {}),
    ...(input.project_entity_id === null || typeof input.project_entity_id === "string"
      ? { projectEntityId: input.project_entity_id as string | null }
      : {}),
    ...(input.owner_user_id === null || typeof input.owner_user_id === "string"
      ? { ownerUserId: input.owner_user_id as string | null }
      : {}),
    ...(input.owner_agent_id === null || typeof input.owner_agent_id === "string"
      ? { ownerAgentId: input.owner_agent_id as string | null }
      : {}),
    ...(input.visibility === null || typeof input.visibility === "string"
      ? { visibility: input.visibility as string | null }
      : {}),
    ...(input.due_at === null || typeof input.due_at === "string" ? { dueAt: input.due_at as string | null } : {}),
    ...(input.next_check_at === null || typeof input.next_check_at === "string"
      ? { nextCheckAt: input.next_check_at as string | null }
      : {}),
    ...(input.expected_response_at === null || typeof input.expected_response_at === "string"
      ? { expectedResponseAt: input.expected_response_at as string | null }
      : {}),
    ...(input.last_progress_at === null || typeof input.last_progress_at === "string"
      ? { lastProgressAt: input.last_progress_at as string | null }
      : {}),
    ...(typeof input.mark_progress === "boolean" ? { markProgress: input.mark_progress } : {}),
    ...(Array.isArray(input.relations) ? { relations: stateRelationArray(input.relations) } : {}),
    ...(Array.isArray(input.references) ? { references: stateReferenceArray(input.references) } : {}),
    note: stringValue(input.note),
  };
}

function dashboardContext(input: Record<string, unknown>): StateMutationContext {
  return {
    actor: "dashboard",
    source: "dashboard",
    includePrivate: true,
    turnId: stringValue(input.turn_id),
    occurredAt: stringValue(input.occurred_at),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("Request body too large");
  }
  if (!body.trim()) return {};
  const value = JSON.parse(body) as unknown;
  if (!isRecord(value)) throw new Error("JSON body must be an object");
  return value;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function normalizeMountedPath(path: string): string {
  const stripped = path.replace(/^\/tango-state(?=\/|$)/u, "");
  return stripped || "/";
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireString(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function numericValue(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function numberQuery(value: string | null, fallback: number): number {
  return numericValue(value) ?? fallback;
}

function numberQueryOrUndefined(value: string | null): number | undefined {
  return numericValue(value) ?? undefined;
}

function booleanQuery(value: string | null): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

function valueOrUndefined(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

function stateRelationArray(value: unknown[]): NonNullable<StateEntityMutation["relations"]> {
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`relations[${index}] must be an object`);
    return {
      kind: requireString(item.kind, `relations[${index}].kind`),
      targetEntityId: requireString(item.target_entity_id ?? item.targetEntityId, `relations[${index}].target_entity_id`),
      ...(item.metadata === null || isRecord(item.metadata) ? { metadata: item.metadata } : {}),
      ...(typeof item.remove === "boolean" ? { remove: item.remove } : {}),
    };
  });
}

function stateReferenceArray(value: unknown[]): NonNullable<StateEntityMutation["references"]> {
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`references[${index}] must be an object`);
    const supportsEventId = item.supports_event_id ?? item.supportsEventId;
    return {
      role: requireString(item.role, `references[${index}].role`),
      ref: requireString(item.ref, `references[${index}].ref`),
      ...(item.label === null || typeof item.label === "string" ? { label: item.label } : {}),
      ...(item.metadata === null || isRecord(item.metadata) ? { metadata: item.metadata } : {}),
      ...(supportsEventId === null ? { supportsEventId: null } : numericValue(supportsEventId) !== null
        ? { supportsEventId: numericValue(supportsEventId)! }
        : {}),
      ...(typeof item.remove === "boolean" ? { remove: item.remove } : {}),
    };
  });
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trendAggregation(value: unknown): "raw" | "average" | "min" | "max" | "change" | undefined {
  return ["raw", "average", "min", "max", "change"].includes(String(value))
    ? String(value) as "raw" | "average" | "min" | "max" | "change"
    : undefined;
}

const STATE_DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tango State</title>
  <style>
    :root{color-scheme:dark;--bg:#0a0d12;--panel:#121821;--line:#273142;--muted:#91a0b4;--text:#edf3fb;--accent:#6ee7c7;--warn:#f5be61;--danger:#fb7185}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 10% 0,#172133 0,transparent 38%),var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}header{padding:28px clamp(18px,4vw,54px) 18px;display:flex;align-items:end;justify-content:space-between;gap:20px}h1{font-size:clamp(28px,5vw,48px);margin:0;letter-spacing:-.04em}.sub{color:var(--muted);max-width:650px}.badge{padding:7px 11px;border:1px solid #2d8a76;border-radius:999px;color:var(--accent);white-space:nowrap}main{padding:0 clamp(18px,4vw,54px) 54px}.toolbar,.grid{display:grid;gap:12px}.toolbar{grid-template-columns:2fr repeat(3,1fr);margin:12px 0 18px}.grid{grid-template-columns:repeat(auto-fill,minmax(310px,1fr))}input,select,textarea,button{font:inherit;color:var(--text);background:#0d121a;border:1px solid var(--line);border-radius:10px;padding:10px 12px}button{cursor:pointer}button.primary{background:#154c42;border-color:#277765}.card{background:linear-gradient(150deg,#151c27,#10151d);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 14px 35px #0005}.card h2{font-size:18px;margin:0 0 4px}.meta{color:var(--muted);display:flex;gap:8px;flex-wrap:wrap}.pill{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 8px}.stale{color:var(--warn);border-color:#6d5328}.attrs{margin:14px 0;display:grid;grid-template-columns:auto 1fr;gap:5px 12px}.attrs dt{color:var(--muted)}.attrs dd{margin:0;overflow-wrap:anywhere}.actions{display:flex;gap:8px}.empty{color:var(--muted);padding:50px;text-align:center;border:1px dashed var(--line);border-radius:16px;grid-column:1/-1}dialog{width:min(680px,92vw);border:1px solid var(--line);border-radius:16px;background:var(--panel);color:var(--text);padding:22px}dialog::backdrop{background:#000b}.form{display:grid;gap:12px}.form label{display:grid;gap:5px;color:var(--muted)}textarea{min-height:150px;font-family:ui-monospace,SFMono-Regular,monospace}.row{display:flex;gap:10px;justify-content:flex-end}@media(max-width:760px){.toolbar{grid-template-columns:1fr 1fr}.toolbar input{grid-column:1/-1}header{align-items:start;flex-direction:column}}
    .section{margin:28px 0}.section h2{font-size:17px}.board{display:flex;gap:8px;flex-wrap:wrap}.issue{border:1px solid #6d5328;color:var(--warn);padding:8px 10px;border-radius:10px}.catalog{color:var(--muted);font-size:13px}.event{border-top:1px solid var(--line);padding:12px 0}.event code{color:var(--accent);font-size:12px}.event pre{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted);font-size:12px}.danger{color:var(--danger)}#detail{width:min(760px,94vw);max-height:90vh;overflow:auto}.actions{flex-wrap:wrap}
  </style>
</head>
<body>
<header><div><h1>Tango State</h1><div class="sub">Canonical entity heads, append-only history, staleness, and reversible edits. These values override memory.</div></div><div class="badge" id="health">connecting…</div></header>
<main><div class="toolbar"><input id="search" placeholder="Search entities"><select id="type"><option value="">All types</option></select><select id="status"><option value="">All statuses</option></select><button class="primary" id="create">New entity</button></div><section class="grid" id="grid"></section><section class="section"><h2>Attention board</h2><div class="board" id="board"></div></section><section class="section"><h2>Type catalog <span class="pill">read only</span></h2><div class="catalog" id="catalog"></div></section></main>
<dialog id="editor"><form method="dialog" class="form"><h2 id="editorTitle">Edit entity</h2><input id="entityId" type="hidden"><label>Type<select id="editType"></select></label><label>Title<input id="editTitle" required></label><label>Status<input id="editStatus"></label><label>Summary<input id="editSummary"></label><label>Attributes JSON<textarea id="editAttrs">{}</textarea></label><label>Body pointer<input id="editBody"></label><div class="row"><button value="cancel">Cancel</button><button value="save" class="primary" id="save">Save</button></div></form></dialog>
<dialog id="detail"><div class="row"><button onclick="document.querySelector('#detail').close()">Close</button></div><div id="detailContent"></div></dialog>
<script>
const base=location.pathname.startsWith('/tango-state')?'/tango-state':'';const $=s=>document.querySelector(s);let types=[],entities=[];
async function api(path,init){const r=await fetch(base+path,{headers:{'Content-Type':'application/json'},...init});const j=await r.json();if(!r.ok)throw Error(j.error||r.statusText);return j}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
function render(){const q=$('#search').value.toLowerCase(),t=$('#type').value,s=$('#status').value;const list=entities.filter(e=>(!q||JSON.stringify(e).toLowerCase().includes(q))&&(!t||e.typeId===t)&&(!s||e.status===s));$('#grid').innerHTML=list.length?list.map(e=>'<article class="card"><h2>'+esc(e.title)+'</h2><div class="meta"><span class="pill">'+esc(e.typeId)+'</span>'+(e.status?'<span class="pill">'+esc(e.status)+'</span>':'')+(e.stale?'<span class="pill stale">⚠ stale</span>':'')+(e.archivedAt?'<span class="pill">archived</span>':'')+'</div><dl class="attrs">'+Object.entries(e.attributes).slice(0,8).map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(typeof v==='object'?JSON.stringify(v):v)+'</dd>').join('')+'</dl><div class="actions"><button onclick="viewEntity(\''+esc(e.id)+'\')">History</button><button onclick="edit(\''+esc(e.id)+'\')">Edit</button><button onclick="archiveEntity(\''+esc(e.id)+'\','+(!e.archivedAt)+')">'+(e.archivedAt?'Restore':'Archive')+'</button></div></article>').join(''):'<div class="empty">No matching state entities.</div>'}
async function load(){const [h,t,e,b]=await Promise.all([api('/api/health'),api('/api/types'),api('/api/entities?archived=true&limit=500'),api('/api/board')]);$('#health').textContent=h.status==='ok'?'● service healthy':'service issue';types=t.types;entities=e.entities;const opts=types.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.displayName)+'</option>').join('');$('#type').innerHTML='<option value="">All types</option>'+opts;$('#editType').innerHTML=opts;const statuses=[...new Set(entities.map(x=>x.status).filter(Boolean))];$('#status').innerHTML='<option value="">All statuses</option>'+statuses.map(x=>'<option>'+esc(x)+'</option>').join('');$('#catalog').innerHTML=types.map(x=>'<span class="pill" title="'+esc(x.description||'')+'">'+esc(x.displayName)+' · '+esc(x.visibility)+'</span>').join(' ');const issues=b.issues||[];$('#board').innerHTML=issues.length?issues.map(x=>'<span class="issue">'+esc(x.kind)+': '+esc(x.detail)+'</span>').join(''):'<span class="meta">No open issues. Reconciler '+(b.reconciler.stalled?'stalled':'healthy')+'.</span>';render()}
window.edit=id=>{const e=entities.find(x=>x.id===id);$('#entityId').value=e.id;$('#editType').value=e.typeId;$('#editType').disabled=true;$('#editTitle').value=e.title;$('#editStatus').value=e.status||'';$('#editSummary').value=e.summary||'';$('#editAttrs').value=JSON.stringify(e.attributes,null,2);$('#editBody').value=e.bodyPointer||'';$('#editorTitle').textContent='Edit '+e.title;$('#editor').showModal()}
window.archiveEntity=async(id,archive)=>{await api('/api/entities/'+encodeURIComponent(id)+'/'+(archive?'archive':'restore'),{method:'POST',body:'{}'});await load()}
window.viewEntity=async id=>{const r=await api('/api/entities/'+encodeURIComponent(id));const e=r.entity;const body=e.bodyPointer?'<p>Body: <a href="obsidian://open?path='+encodeURIComponent(e.bodyPointer.replace(/^obsidian:/,''))+'">'+esc(e.bodyPointer)+'</a></p>':'';const events=(e.events||[]).map(v=>'<div class="event"><code>#'+v.id+' · '+esc(v.kind)+' · '+esc(v.actor)+' · '+esc(v.occurredAt)+'</code>'+(v.note?'<p>'+esc(v.note)+'</p>':'')+'<pre>'+esc(JSON.stringify(v.patch,null,2))+'</pre><div class="actions">'+(v.kind!=='revert'?'<button class="danger" onclick="revertEvent('+v.id+',\''+esc(id)+'\')">Revert event</button>':'')+(v.turnId?'<button onclick="revertTurn(\''+esc(v.turnId)+'\',\''+esc(id)+'\')">Revert turn</button>':'')+'</div></div>').join('');$('#detailContent').innerHTML='<h2>'+esc(e.title)+'</h2><p class="meta">'+esc(e.typeId)+' · '+esc(e.status||'statusless')+'</p>'+body+'<h3>Current head</h3><pre>'+esc(JSON.stringify(e.attributes,null,2))+'</pre><h3>Append-only history</h3>'+events;$('#detail').showModal()}
window.revertEvent=async(id,entityId)=>{if(!confirm('Append a revert for event #'+id+'?'))return;await api('/api/revert',{method:'POST',body:JSON.stringify({event_id:id})});await load();await viewEntity(entityId)}
window.revertTurn=async(turnId,entityId)=>{if(!confirm('Append reverts for every change in this turn?'))return;await api('/api/revert',{method:'POST',body:JSON.stringify({turn_id:turnId})});await load();await viewEntity(entityId)}
$('#create').onclick=()=>{$('#entityId').value='';$('#editType').disabled=false;$('#editTitle').value='';$('#editStatus').value='';$('#editSummary').value='';$('#editAttrs').value='{}';$('#editBody').value='';$('#editorTitle').textContent='New entity';$('#editor').showModal()};
$('#save').onclick=async ev=>{ev.preventDefault();try{const id=$('#entityId').value;const body={type_id:$('#editType').value,title:$('#editTitle').value,status:$('#editStatus').value||undefined,summary:$('#editSummary').value||null,attributes:JSON.parse($('#editAttrs').value),body_pointer:$('#editBody').value||null};await api(id?'/api/entities/'+encodeURIComponent(id):'/api/entities',{method:id?'PATCH':'POST',body:JSON.stringify(body)});$('#editor').close();await load()}catch(e){alert(e.message)}};
['search','type','status'].forEach(id=>$('#'+id).addEventListener(id==='search'?'input':'change',render));load().catch(e=>{$('#health').textContent='● '+e.message});
</script></body></html>`;
