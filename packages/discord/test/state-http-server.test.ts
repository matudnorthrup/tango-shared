import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateService, TangoStorage } from "@tango/core";
import { afterEach, describe, expect, it } from "vitest";
import { createStateHttpServer } from "../src/state-http-server.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("state dashboard HTTP API", () => {
  it("serves the dashboard and routes validated entity/tool writes through the state service", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-state-http-"));
    dirs.push(dir);
    const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
    const service = new StateService(storage.getDatabase(), { now: () => new Date("2026-07-18T12:00:00.000Z") });
    service.defineType({
      id: "activity",
      displayName: "Activity",
      origin: "seed",
      attributesSchema: { type: "object", additionalProperties: false, properties: {} },
      statuses: {
        values: ["open", "done"],
        transitions: { open: ["done"], done: ["open"] },
        initial: "open",
        terminal: ["done"],
      },
    }, { includePrivate: true });
    const reportedErrors: unknown[] = [];
    const server = createStateHttpServer({ service, port: 0, reportError: (error) => reportedErrors.push(error) });
    await server.start();
    try {
      const health = await fetch(`${server.url}/api/health`).then((response) => response.json()) as { status: string };
      expect(health.status).toBe("ok");
      const html = await fetch(`${server.url}/tango-state/`).then((response) => response.text());
      expect(html).toContain("Tango State");

      const emptyProjectQuery = await fetch(`${server.url}/api/tools/state_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { type: "project" }, context: { agent_id: "watson" } }),
      }).then((response) => response.json()) as { entities: unknown[]; typeDefinition: { id: string; attributesSchema: { properties: Record<string, unknown> } } };
      expect(emptyProjectQuery.entities).toEqual([]);
      expect(emptyProjectQuery.typeDefinition.id).toBe("project");
      expect(emptyProjectQuery.typeDefinition.attributesSchema.properties).toHaveProperty("progress_pct");

      const toolCreated = await fetch(`${server.url}/api/tools/state_update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { mode: "upsert", entity_id: "project:predicted", type_id: "project", title: "Predicted Fixture", status: "active", attributes: { progress_pct: 3 } },
          context: { agent_id: "watson", turn_id: "tool-turn" },
        }),
      }).then((response) => response.json()) as { created: boolean; entity: { id: string } };
      expect(toolCreated).toMatchObject({ created: true, entity: { id: "project:predicted-fixture" } });

      const activity = await fetch(`${server.url}/api/tools/state_update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: {
            mode: "upsert",
            type_id: "activity",
            title: "Synthetic checkpoint",
            status: "open",
            project_entity_id: toolCreated.entity.id,
            owner_user_id: "user:fixture",
            owner_agent_id: "watson",
            visibility: "shared",
            due_at: "2026-07-17T12:00:00.000Z",
            next_check_at: "2026-07-19T12:00:00.000Z",
            expected_response_at: "2026-07-20T12:00:00.000Z",
            last_progress_at: "2026-07-16T12:00:00.000Z",
            mark_progress: false,
            relations: [{ kind: "depends_on", target_entity_id: toolCreated.entity.id, metadata: { reason: "fixture" } }],
            references: [{ role: "evidence", ref: "profile:logs/synthetic-run.md", label: "Synthetic run log" }],
            occurred_at: "2026-07-18T11:00:00.000Z",
          },
          context: { agent_id: "watson", turn_id: "activity-turn" },
        }),
      }).then((response) => response.json()) as { entity: { id: string; projectEntityId: string } };
      expect(activity.entity.projectEntityId).toBe(toolCreated.entity.id);

      const filtered = await fetch(`${server.url}/api/tools/state_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: {
            type: "activity",
            overdue: true,
            project_entity_id: toolCreated.entity.id,
            owner_user_id: "user:fixture",
            owner_agent_id: "watson",
            source: "tool",
            due_before: "2026-07-18T12:00:00.000Z",
            due_after: "2026-07-16T12:00:00.000Z",
            next_check_before: "2026-07-20T12:00:00.000Z",
            next_check_after: "2026-07-18T12:00:00.000Z",
            expected_response_before: "2026-07-21T12:00:00.000Z",
            expected_response_after: "2026-07-19T12:00:00.000Z",
            last_progress_before: "2026-07-17T12:00:00.000Z",
            last_progress_after: "2026-07-15T12:00:00.000Z",
            progress_older_than_days: 1,
            progress_newer_than_days: 5,
            relation_kind: "depends_on",
            related_entity_id: toolCreated.entity.id,
            reference_role: "evidence",
            include_relations: true,
            include_references: true,
          },
          context: { agent_id: "watson" },
        }),
      }).then((response) => response.json()) as {
        entities: Array<{
          id: string;
          relations: Array<{ kind: string; targetEntityId: string }>;
          references: Array<{ role: string; ref: string }>;
        }>;
      };
      expect(filtered.entities).toHaveLength(1);
      expect(filtered.entities[0]).toMatchObject({
        id: activity.entity.id,
        relations: [{ kind: "depends_on", targetEntityId: toolCreated.entity.id }],
        references: [{ role: "evidence", ref: "profile:logs/synthetic-run.md" }],
      });

      const progressed = await fetch(`${server.url}/api/tools/state_update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { mode: "patch", entity_id: activity.entity.id, mark_progress: true, occurred_at: "2026-07-18T12:00:00.000Z" },
          context: { agent_id: "watson", turn_id: "progress-turn" },
        }),
      }).then((response) => response.json()) as { entity: { lastProgressAt: string } };
      expect(progressed.entity.lastProgressAt).toBe("2026-07-18T12:00:00.000Z");

      const detail = await fetch(`${server.url}/api/entities/${encodeURIComponent(activity.entity.id)}`)
        .then((response) => response.json()) as { entity: { relations: unknown[]; references: unknown[] } };
      expect(detail.entity.relations).toHaveLength(1);
      expect(detail.entity.references).toHaveLength(1);

      const created = await fetch(`${server.url}/api/entities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type_id: "project", title: "HTTP Fixture", status: "active", attributes: { progress_pct: 5 } }),
      }).then((response) => response.json()) as { entity: { id: string }; event: { actor: string } };
      expect(created.event.actor).toBe("dashboard");

      const queried = await fetch(`${server.url}/api/tools/state_query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { entity_id: created.entity.id }, context: { agent_id: "watson" } }),
      }).then((response) => response.json()) as { entities: Array<{ title: string }> };
      expect(queried.entities[0]?.title).toBe("HTTP Fixture");

      const archived = await fetch(`${server.url}/api/entities/${encodeURIComponent(created.entity.id)}/archive`, { method: "POST" }).then((response) => response.json()) as { entity: { archivedAt: string } };
      expect(archived.entity.archivedAt).toBeTruthy();

      const failed = await fetch(`${server.url}/api/entities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{private fixture details",
      });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "Internal server error" });
      expect(reportedErrors).toHaveLength(1);
      expect(reportedErrors[0]).toBeInstanceOf(SyntaxError);
    } finally {
      await server.stop();
      storage.close();
    }
  });
});
