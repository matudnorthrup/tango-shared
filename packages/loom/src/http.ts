import { askRow, askPayload, listAsks } from "./asks.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { LoomCommandError, type Command, type LoomEvent, type LoomHost } from "./host.js";
import { publicRule } from "./rules.js";

export interface HttpOptions {
  token: string;
  /** Replays longer than this send a fresh snapshot instead. */
  maxReplay?: number;
  /** A subscriber with more than this many bytes unsent is told to resume. */
  maxBufferedBytes?: number;
  heartbeatMs?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Loom's API. It binds to loopback only; the Desk reaches it from the same
 * machine. Every route except /health needs the bearer token.
 *
 *   GET  /asks?status=open     ask ledger across threads
 *   GET  /asks/:id             one ask, including recorded state and steps
 *   GET  /health
 *   GET  /snapshot             threads plus the current sequence
 *   GET  /decisions?since=<ms> acted and defaulted decisions across threads ("Decided for you"), and rule changes
 *   GET  /decisions/review?since=<ms> the Delegation review: rules created, suspended, demoted; recurring dissent
 *   GET  /decisions/ids       the numbers of every decision (the desk links D-<n> only for these)
 *   GET  /decisions/:id       one decision with its brief, revision, changes, status and outcome (the desk's brief page)
 *   GET  /rules                the standing rules and the learned class levels
 *   GET  /threads/:id          one thread's runs, messages, items, open requests
 *   GET  /resources             leases and report-only external inventory
 *   POST /threads/:id/resources managed process creation in the owning worktree
 *   POST /threads/:id/resources/:leaseId/release release one owned lease
 *   GET  /attachments/:id      an image on a message
 *   POST /commands             { type, commandId, ... }
 *   GET  /events?after=<seq>   server-sent events, resumable by sequence
 */
/** Aborts when the client hangs up before the answer is written: a mutation still waiting then doesn't apply. */
function gone(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once("close", () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
}

export function createLoomServer(host: LoomHost, options: HttpOptions): Server {
  const maxReplay = options.maxReplay ?? 2000;
  const maxBuffered = options.maxBufferedBytes ?? 8 * 1024 * 1024;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const expected = Buffer.from(`Bearer ${options.token}`);

  const authorized = (req: IncomingMessage): boolean => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const server = createServer(async (req, res) => {
    const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTS.has(hostHeader)) return send(res, 403, { ok: false, code: "forbidden_host" });
    const url = new URL(req.url ?? "/", "http://loom");

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, seq: host.store.highWater() });
    }
    if (!authorized(req)) return send(res, 401, { ok: false, code: "unauthorized" });

    try {
      if (url.pathname === "/maintenance") {
        if (req.method === "GET") return send(res, 200, host.maintenance());
        if (req.method === "POST") {
          let body;
          try { body = await readJson(req) as { on?: unknown; reason?: unknown }; }
          catch { return send(res, 400, { code: "invalid", message: "Expected JSON" }); }
          if (!body || typeof body.on !== "boolean" || (body.reason !== undefined && typeof body.reason !== "string")) return send(res, 400, { code: "invalid", message: "on must be boolean; reason must be a string" });
          return send(res, 200, await host.setMaintenance(body.on, body.reason as string | undefined));
        }
      }
      // Bot acknowledges only after persisting the run in its existing delivery recovery ledger.
      if (req.method === "GET" && url.pathname === "/decision-deliveries") {
        return send(res, 200, { deliveries: host.store.pendingDecisionDeliveries() });
      }
      const decisionDelivery = url.pathname.match(/^\/decision-deliveries\/([^/]+)\/ack$/);
      if (req.method === "POST" && decisionDelivery) {
        host.store.acknowledgeDecisionDelivery(decodeURIComponent(decisionDelivery[1]!));
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/resources") return send(res, 200, await host.resourceInventory());
      const resourceRelease = url.pathname.match(/^\/threads\/([^/]+)\/resources\/([^/]+)\/release$/);
      if (req.method === "POST" && resourceRelease) {
        try {
          const body = await readJson(req) as { runId?: unknown };
          if (!body || typeof body.runId !== "string" || !body.runId.trim() || Object.keys(body).some(key => key !== "runId"))
            return send(res, 400, { code: "invalid", message: "Resource release accepts only the current Loom runId" });
          return send(res, 200, await host.releaseResource(decodeURIComponent(resourceRelease[1]!), decodeURIComponent(resourceRelease[2]!), body.runId));
        } catch (error) {
          if (error instanceof LoomCommandError) return send(res, error.code === "too_large" ? 413 : error.code === "conflict" ? 409 : 400, { code: error.code, message: error.message });
          throw error;
        }
      }
      const resourceOwner = url.pathname.match(/^\/threads\/([^/]+)\/resources$/);
      if (req.method === "POST" && resourceOwner) {
        try {
          const body = await readJson(req) as { runId?: unknown; kind?: unknown; command?: unknown; args?: unknown; cwd?: unknown; profile?: unknown; localPort?: unknown; httpsPort?: unknown; managed?: unknown };
          if (body && body.cwd !== undefined && body.kind !== "dev_server") return send(res, 400, { code: "invalid", message: "cwd is supported only for dev_server" });
          if (body?.kind === "dev_server" && (typeof body.cwd !== "string" || !body.cwd.trim())) return send(res, 400, { code: "invalid", message: "Supply the caller cwd for dev_server; cd into this thread’s worktree and retry" });
          if (!body || typeof body.runId !== "string" || !body.runId.trim()) return send(res, 400, { code: "invalid", message: "Supply the current Loom runId before launching a resource" });
          if (body.managed !== undefined) {
            if (body.managed !== true || body.kind !== "browser" || Object.keys(body).some(key => !["runId", "kind", "managed"].includes(key))) return send(res, 400, { code: "invalid", message: "Managed Chrome accepts only runId, kind: browser and managed: true" });
            return send(res, 200, await host.createResource(decodeURIComponent(resourceOwner[1]!), body as { runId: string; kind: "browser"; managed: true }));
          }
          if (body.kind === "mapping") {
            if (body.command !== undefined || body.args !== undefined || body.profile !== undefined || ![body.localPort, body.httpsPort].every(p => typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 65535)) return send(res, 400, { code: "invalid", message: "Mapping requires localPort and httpsPort between 1 and 65535, without command, args or profile" });
            return send(res, 200, await host.createResource(decodeURIComponent(resourceOwner[1]!), body as { runId: string; kind: "mapping"; localPort: number; httpsPort: number }));
          }
          if (Object.keys(body).some(key => !["runId", "kind", "command", "args", "profile", "cwd"].includes(key))) return send(res, 400, { code: "invalid", message: "Unsupported process creation field" });
          if (body.profile !== undefined && (body.profile !== "exclusive" || body.kind !== "browser")) return send(res, 400, { code: "invalid", message: "Use profile: exclusive only with a browser; existing profiles cannot be adopted" });
          if (!body || !["build", "dev_server", "browser"].includes(String(body.kind)) || typeof body.command !== "string" || !body.command.trim() || !Array.isArray(body.args) || !body.args.every(arg => typeof arg === "string")) return send(res, 400, { code: "invalid", message: "Expected kind (build/dev_server/browser), command and string args" });
          return send(res, 200, await host.createResource(decodeURIComponent(resourceOwner[1]!), body as { runId: string; kind: "build" | "dev_server" | "browser"; command: string; args: string[]; cwd?: string; profile?: "exclusive" }));
        } catch (error) {
          if (error instanceof LoomCommandError) return send(res, error.code === "too_large" ? 413 : error.code === "conflict" ? 409 : 400, { code: error.code, message: error.message });
          throw error;
        }
      }
      if (req.method === "GET" && url.pathname === "/worktrees") return send(res, 200, await host.worktrees?.list() ?? []);
      if (req.method === "POST" && url.pathname === "/worktrees/reclaim") {
        let body: { dryRun?: unknown };
        try { body = await readJson(req) as { dryRun?: unknown }; }
        catch (error) {
          if (error instanceof LoomCommandError) return send(res, error.code === "too_large" ? 413 : 400, { code: error.code, message: error.message });
          throw error;
        }
        if (!body || typeof body.dryRun !== "boolean") return send(res, 400, { code: "invalid", message: "dryRun must be a boolean" });
        return send(res, 200, await host.worktrees?.reclaim(body.dryRun) ?? { dryRun: body.dryRun, plans: [], freedBytes: 0 });
      }
      if (req.method === "GET" && url.pathname === "/machine") return send(res, 200, await host.machine());
      const warm = url.pathname.match(/^\/threads\/([^/]+)\/warm$/);
      if (req.method === "POST" && warm) {
        const id = decodeURIComponent(warm[1]!);
        if (!host.store.thread(id)) return send(res, 404, { code: "not_found" });
        return send(res, 200, await host.warm(id));
      }
      if (req.method === "GET" && url.pathname === "/releases") return send(res, 200, host.releases());
      if (req.method === "GET" && url.pathname === "/snapshot") return send(res, 200, host.snapshot());
      if (req.method === "GET" && url.pathname === "/capacity") return send(res, 200, host.capacity());
      if (req.method === "GET" && url.pathname === "/asks") return send(res, 200, listAsks(host.store, url.searchParams.get("status") ?? undefined).map(askPayload));
      const askMatch = url.pathname.match(/^\/asks\/([^/]+)$/);
      if (req.method === "GET" && askMatch) {
        const ask = askRow(host.store, decodeURIComponent(askMatch[1]!));
        return ask ? send(res, 200, askPayload(ask)) : send(res, 404, { code: "not_found" });
      }
      if (req.method === "GET" && url.pathname === "/triggers") return send(res, 200, host.triggers.list(undefined, url.searchParams.get("status") ?? undefined));
      const fanOutList = url.pathname.match(/^\/threads\/([^/]+)\/fan-outs$/);
      if (req.method === "GET" && fanOutList) {
        const id = decodeURIComponent(fanOutList[1]!);
        return host.store.thread(id) ? send(res, 200, host.fanOuts.list(id)) : send(res, 404, { code: "not_found" });
      }
      const fanOut = url.pathname.match(/^\/threads\/([^/]+)\/fan-outs\/([^/]+)$/);
      if (req.method === "GET" && fanOut) {
        try { return send(res, 200, host.fanOuts.status(decodeURIComponent(fanOut[1]!), decodeURIComponent(fanOut[2]!))); } catch { return send(res, 404, { code: "not_found" }); }
      }
      const waits = url.pathname.match(/^\/threads\/([^/]+)\/triggers$/);
      if (req.method === "GET" && waits) {
        const id = decodeURIComponent(waits[1]!);
        return host.store.thread(id) ? send(res, 200, host.triggers.list(id)) : send(res, 404, { code: "not_found" });
      }
      if (req.method === "POST" && url.pathname === "/presence") {
        let body: { at?: unknown; source?: unknown } = {};
        try { body = ((await readJson(req)) ?? {}) as { at?: unknown; source?: unknown }; } catch { body = {}; }
        const at = typeof body.at === "number" ? body.at : undefined;
        return send(res, 200, host.beat(at, typeof body.source === "string" ? body.source : null));
      }
      // "Decided for you": acted and defaulted decisions across threads since ?since=<ms> (default: the last 7 days).
      if (req.method === "GET" && url.pathname === "/decisions") {
        const since = Number(url.searchParams.get("since"));
        return send(res, 200, host.decided(Number.isFinite(since) && since > 0 ? since : host.store.now() - 7 * 86_400_000));
      }
      // Catch-up: what leads wrote for the owner (desk_update lines, chapter notes) after ?after=<seq>, a page at a time.
      if (req.method === "GET" && url.pathname === "/catchup") {
        const after = Number(url.searchParams.get("after"));
        return send(res, 200, host.catchup.since(Number.isFinite(after) && after > 0 ? after : 0));
      }
      // The weekly Delegation review (default: the last 7 days).
      if (req.method === "GET" && url.pathname === "/decisions/review") {
        const since = Number(url.searchParams.get("since"));
        return send(res, 200, host.review(Number.isFinite(since) && since > 0 ? since : host.store.now() - 7 * 86_400_000));
      }
      if (req.method === "GET" && url.pathname === "/decisions/ids") return send(res, 200, { ids: host.decisionIds() });
      const oneDecision = url.pathname.match(/^\/decisions\/(D-\d+)$/);
      if (req.method === "GET" && oneDecision) {
        const found = host.decisionDetail(oneDecision[1]!);
        return found ? send(res, 200, found) : send(res, 404, { code: "not_found" });
      }
      if (req.method === "GET" && url.pathname === "/rules") {
        // The file may have changed off Loom: read it before saying which rules stand.
        host.store.tx(() => host.rules.importFile());
        return send(res, 200, { rules: host.rules.all().map(publicRule), class_levels: host.rules.classLevels() });
      }
      const decisions = url.pathname.match(/^\/threads\/([^/]+)\/decisions$/);
      if (req.method === "GET" && decisions) {
        const id = decodeURIComponent(decisions[1]!);
        if (!host.store.thread(id)) return send(res, 404, { code: "not_found" });
        return send(res, 200, host.decisionCheck(id, url.searchParams.get("class")));
      }
      const handoff = url.pathname.match(/^\/threads\/([^/]+)\/handoff$/);
      if (req.method === "POST" && handoff) {
        let body: unknown;
        try { body = await readJson(req); } catch { return send(res, 400, { code: "bad_json" }); }
        const saved = host.saveHandoff(decodeURIComponent(handoff[1]!), body);
        return saved.ok ? send(res, 200, saved) : send(res, saved.code === "not_found" ? 404 : 400, saved);
      }
      const keep = url.pathname.match(/^\/threads\/([^/]+)\/keep-session$/);
      if (req.method === "POST" && keep) {
        let body: { keep?: unknown };
        try { body = ((await readJson(req)) ?? {}) as { keep?: unknown }; } catch { return send(res, 400, { code: "bad_json" }); }
        if (typeof body.keep !== "boolean") return send(res, 400, { code: "invalid", message: "keep must be a boolean" });
        const kept = await host.keepSession(decodeURIComponent(keep[1]!), body.keep, gone(res));
        return send(res, kept.ok ? 200 : kept.code === "not_found" ? 404 : 409, kept);
      }
      const freshStart = url.pathname.match(/^\/threads\/([^/]+)\/fresh-start$/);
      if (req.method === "POST" && freshStart) {
        const started = await host.freshStart(decodeURIComponent(freshStart[1]!), gone(res));
        return send(res, started.ok ? 200 : started.code === "not_found" ? 404 : 409, started);
      }
      const taskEnded = url.pathname.match(/^\/threads\/([^/]+)\/task-ended$/);
      if (req.method === "POST" && taskEnded) {
        let body: { why?: unknown };
        try { body = ((await readJson(req)) ?? {}) as typeof body; } catch { return send(res, 400, { code: "bad_json" }); }
        const ended = await host.taskEnded(decodeURIComponent(taskEnded[1]!), typeof body.why === "string" && body.why.trim() ? body.why.trim() : "its task ended", gone(res));
        return send(res, ended.ok ? 200 : ended.code === "not_found" ? 404 : 409, ended);
      }
      const budget = url.pathname.match(/^\/threads\/([^/]+)\/budget$/);
      if (req.method === "POST" && budget) {
        // {raise: true}: +50% for today. {limit: tokens | null}: the thread's own budget, or back to its role's default.
        let body: { raise?: unknown; limit?: unknown };
        try { body = ((await readJson(req)) ?? {}) as typeof body; } catch { return send(res, 400, { code: "bad_json" }); }
        const id = decodeURIComponent(budget[1]!);
        const valid = body.limit === null || (typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit >= 0);
        if (body.raise !== true && !valid) return send(res, 400, { code: "invalid", message: "send {raise: true} or {limit: tokens | null}" });
        const result = body.raise === true ? host.raiseBudget(id) : host.setBudget(id, body.limit === null ? null : Math.round(body.limit as number));
        return send(res, result.ok ? 200 : result.code === "not_found" ? 404 : 409, result);
      }
      const carry = url.pathname.match(/^\/threads\/([^/]+)\/carry$/);
      if (req.method === "GET" && carry) {
        const text = host.carry(decodeURIComponent(carry[1]!));
        return text === undefined ? send(res, 404, { code: "not_found" }) : send(res, 200, { text });
      }
      const timeline = url.pathname.match(/^\/threads\/([^/]+)\/timeline$/);
      if (req.method === "GET" && timeline) {
        const id = decodeURIComponent(timeline[1]!);
        return host.store.thread(id) ? send(res, 200, host.ledger.timeline(id)) : send(res, 404, { code: "not_found" });
      }
      const history = url.pathname.match(/^\/threads\/([^/]+)\/accounts$/);
      if (req.method === "GET" && history) {
        const id = decodeURIComponent(history[1]!);
        return host.store.thread(id) ? send(res, 200, host.store.accountHistory(id)) : send(res, 404, { ok: false, code: "not_found" });
      }
      const move = url.pathname.match(/^\/threads\/([^/]+)\/move$/);
      const image = url.pathname.match(/^\/attachments\/([^/]+)$/);
      if (req.method === "GET" && image) {
        const file = host.attachmentFile(decodeURIComponent(image[1]!));
        if (!file) return send(res, 404, { ok: false, code: "not_found" });
        res.writeHead(200, { "Content-Type": file.mimeType, "Content-Length": file.bytes.length, "X-Content-Type-Options": "nosniff" });
        return res.end(file.bytes);
      }
      const detail = url.pathname.match(/^\/threads\/([^/]+)$/);
      if (req.method === "GET" && detail) {
        const body = host.detail(decodeURIComponent(detail[1]!));
        return body ? send(res, 200, body) : send(res, 404, { ok: false, code: "not_found" });
      }
      if (req.method === "POST" && (url.pathname === "/commands" || move)) {
        let command: Command;
        try {
          const body = await readJson(req);
          command = (move && body && typeof body === "object" ? { ...body, type: "move", threadId: decodeURIComponent(move[1]!) } : body) as Command;
        } catch (error) {
          if (error instanceof LoomCommandError) {
            return send(res, error.code === "too_large" ? 413 : 400, { ok: false, code: error.code, message: error.message });
          }
          throw error;
        }
        if (!command || typeof command.commandId !== "string" || typeof command.type !== "string") {
          return send(res, 400, { ok: false, code: "invalid", message: "commandId and type are required" });
        }
        try {
          return send(res, 200, { ok: true, result: await host.execute(command) });
        } catch (error) {
          if (error instanceof LoomCommandError) {
            return send(res, error.code === "not_found" ? 404 : 409, { ok: false, code: error.code, message: error.message });
          }
          throw error;
        }
      }
      if (req.method === "GET" && url.pathname === "/events") {
        return streamEvents(host, req, res, url.searchParams.get("after"), { maxReplay, maxBuffered, heartbeatMs });
      }
      return send(res, 404, { ok: false, code: "not_found" });
    } catch (error) {
      return send(res, 500, { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) });
    }
  });
  // A submit that makes a worktree can spend minutes in git (fetch, then worktree add).
  server.requestTimeout = 15 * 60_000;
  return server;
}

function streamEvents(
  host: LoomHost,
  req: IncomingMessage,
  res: ServerResponse,
  afterParam: string | null,
  limits: { maxReplay: number; maxBuffered: number; heartbeatMs: number },
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let lastSeq = 0;
  let replaying = true;
  const held: LoomEvent[] = [];
  let closed = false;

  const close = (reason?: string) => {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    if (reason) res.write(`event: resume\ndata: ${JSON.stringify({ reason, after: lastSeq })}\n\n`);
    res.end();
  };

  const write = (event: LoomEvent) => {
    if (closed) return;
    if (event.seq !== undefined) {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      res.write(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
    } else {
      res.write(`event: delta\ndata: ${JSON.stringify(event)}\n\n`);
    }
    if (res.writableLength > limits.maxBuffered) close("overflow");
  };

  // Subscribe before reading the stored tail, so nothing committed in between is lost.
  const unsubscribe = host.subscribe((event) => (replaying ? held.push(event) : write(event)));
  const heartbeat = setInterval(() => !closed && res.write(": ping\n\n"), limits.heartbeatMs);
  req.on("close", () => close());

  const after = afterParam === null ? null : Number(afterParam);
  const store = host.store;
  const tail = after === null || !Number.isFinite(after) ? null : store.changesAfter(after, limits.maxReplay + 1);
  const gap = after !== null && after > 0 && after < store.lowWater() - 1;
  if (tail === null || gap || tail.length > limits.maxReplay) {
    const snapshot = host.snapshot();
    lastSeq = snapshot.seq;
    res.write(`id: ${snapshot.seq}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  } else {
    for (const change of tail) {
      write({
        seq: change.seq,
        threadId: change.thread_id,
        entity: change.entity,
        entityId: change.entity_id,
        data: host.entity(change.entity, change.entity_id),
      });
    }
  }
  replaying = false;
  for (const event of held.splice(0)) write(event);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Eight 10 MB images, base64-encoded, plus the words.
    if (size > 120 * 1024 * 1024) throw new LoomCommandError("too_large", "Request body over 120 MB");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LoomCommandError("invalid", "Body is not JSON");
  }
}
