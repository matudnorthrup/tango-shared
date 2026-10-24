import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAtlasConversationSummary,
  listAtlasMemoriesForContext,
  listAtlasMemoriesForStateProjection,
  listAtlasPinnedFactsForContext,
  openAtlasMemoryDatabase,
  runInTransaction,
  touchAtlasMemories,
} from "../src/index.js";
import { encodeEmbedding } from "../src/search.js";
import { v4 as uuidv4 } from "uuid";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-context-read-"));
  tempDirs.push(dir);
  return openAtlasMemoryDatabase({ dbPath: path.join(dir, "memory.db") });
}

function insertMemory(
  db: ReturnType<typeof createDb>["db"],
  input: {
    content: string;
    agentId?: string | null;
    embedding?: number[] | null;
    archived?: boolean;
    createdAt?: string;
  },
): string {
  const id = uuidv4();
  const timestamp = input.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, content, source, agent_id, importance, tags, embedding, embedding_model, created_at, last_accessed_at, access_count, archived_at, metadata)
     VALUES (?, ?, 'conversation', ?, 0.6, '[]', ?, ?, ?, ?, 0, ?, '{}')`,
  ).run(
    id,
    input.content,
    input.agentId ?? null,
    input.embedding ? encodeEmbedding(input.embedding) : null,
    input.embedding ? "voyage-4-lite" : null,
    timestamp,
    timestamp,
    input.archived ? timestamp : null,
  );
  return id;
}

describe("atlas context read surface", () => {
  it("lists agent-scoped + global unarchived memories with decoded embeddings", () => {
    const { db } = createDb();
    insertMemory(db, { content: "global fact", agentId: null, embedding: [0.1, 0.2] });
    insertMemory(db, { content: "sierra fact", agentId: "sierra", embedding: [0.3, 0.4] });
    insertMemory(db, { content: "watson fact", agentId: "watson" });
    insertMemory(db, { content: "archived fact", agentId: "sierra", archived: true });

    const rows = listAtlasMemoriesForContext(db, { agentId: "sierra" });
    expect(rows.map((row) => row.content).sort()).toEqual(["global fact", "sierra fact"]);
    const embedded = rows.find((row) => row.content === "sierra fact");
    expect(embedded?.embedding).toEqual([0.3, 0.4]);

    db.close();
  });

  it("lists memories across aliased agent ids while preserving global visibility", () => {
    const { db } = createDb();
    insertMemory(db, { content: "global fact", agentId: null });
    insertMemory(db, { content: "sierra fact", agentId: "sierra" });
    insertMemory(db, { content: "sierra ollama fact", agentId: "sierra-ollama" });
    insertMemory(db, { content: "watson fact", agentId: "watson" });

    const rows = listAtlasMemoriesForContext(db, {
      agentIds: ["sierra", "sierra-ollama"],
    });

    expect(rows.map((row) => row.content).sort()).toEqual([
      "global fact",
      "sierra fact",
      "sierra ollama fact",
    ]);

    db.close();
  });

  it("reads all narrative associated with a state root without a global recency cap", () => {
    const { db } = createDb();
    const insert = db.prepare(
      `INSERT INTO memories (id, content, source, agent_id, importance, tags, embedding, embedding_model, created_at, last_accessed_at, access_count, archived_at, metadata)
       VALUES (?, ?, 'conversation', NULL, 0.6, ?, NULL, NULL, ?, ?, 0, ?, ?)`,
    );
    runInTransaction(db, () => {
      for (let index = 0; index < 5_001; index += 1) {
        insert.run(
          `noise-${index}`,
          `unrelated recent narrative ${index}`,
          "[]",
          "2026-07-18T12:00:00.000Z",
          "2026-07-18T12:00:00.000Z",
          null,
          JSON.stringify({ project_entity_id: "unrelated-project" }),
        );
      }
      insert.run(
        "project-narrative",
        "older project narrative",
        JSON.stringify(["project-history"]),
        "2025-01-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
        null,
        JSON.stringify({ project_entity_id: "project-123" }),
      );
      insert.run(
        "state-narrative",
        "older state-specific narrative",
        "[]",
        "2024-01-01T00:00:00.000Z",
        "2024-01-01T00:00:00.000Z",
        null,
        JSON.stringify({ state_entity_id: "state-456" }),
      );
      insert.run(
        "archived-project-narrative",
        "archived narrative",
        "[]",
        "2027-01-01T00:00:00.000Z",
        "2027-01-01T00:00:00.000Z",
        "2027-01-01T00:00:00.000Z",
        JSON.stringify({ project_entity_id: "project-123" }),
      );
    });

    expect(listAtlasMemoriesForContext(db, { limit: 5_000 }).some((row) => row.id === "project-narrative")).toBe(false);
    const rows = listAtlasMemoriesForStateProjection(db, {
      projectEntityId: "project-123",
      stateEntityId: "state-456",
    });
    expect(rows.map((row) => row.id)).toEqual(["project-narrative", "state-narrative"]);
    expect(rows[0]?.tags).toEqual(["project-history"]);
    expect(rows.every((row) => row.metadata !== null)).toBe(true);

    db.close();
  });

  it("reads conversation summaries and pinned facts in scope priority order", () => {
    const { db } = createDb();
    db.prepare(
      `INSERT INTO conversation_summaries (id, session_id, agent_id, summary, covers_through, created_at)
       VALUES ('s1', 'thread:123', 'sierra', 'Trip planning recap.', NULL, '2026-06-09T00:00:00.000Z')`,
    ).run();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
       VALUES ('p1', 'global', NULL, 'vehicle', 'pickup diesel, 16-17 mpg', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
       VALUES ('p2', 'agent', 'sierra', 'style', 'concise summaries', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
       VALUES ('p3', 'agent', 'watson', 'other-agent', 'should not appear', ?, ?)`,
    ).run(now, now);

    const summary = getAtlasConversationSummary(db, { sessionId: "thread:123", agentId: "sierra" });
    expect(summary?.summary).toBe("Trip planning recap.");
    expect(getAtlasConversationSummary(db, { sessionId: "thread:999", agentId: "sierra" })).toBeNull();

    const facts = listAtlasPinnedFactsForContext(db, { sessionId: "thread:123", agentId: "sierra" });
    expect(facts.map((fact) => fact.key)).toEqual(["style", "vehicle"]);

    db.close();
  });

  it("reads conversation summaries and pinned facts across aliased agent ids", () => {
    const { db } = createDb();
    db.prepare(
      `INSERT INTO conversation_summaries (id, session_id, agent_id, summary, covers_through, created_at)
       VALUES ('s1', 'thread:123', 'sierra-ollama', 'Clone recap.', NULL, '2026-06-10T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO conversation_summaries (id, session_id, agent_id, summary, covers_through, created_at)
       VALUES ('s2', 'thread:123', 'sierra', 'Canonical recap.', NULL, '2026-06-09T00:00:00.000Z')`,
    ).run();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
       VALUES ('p1', 'global', NULL, 'vehicle', 'pickup diesel', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
       VALUES ('p2', 'agent', 'sierra', 'base', 'canonical fact', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
       VALUES ('p3', 'agent', 'sierra-ollama', 'clone', 'clone fact', ?, ?)`,
    ).run(now, now);

    const summary = getAtlasConversationSummary(db, {
      sessionId: "thread:123",
      agentIds: ["sierra", "sierra-ollama"],
    });
    expect(summary?.summary).toBe("Canonical recap.");

    const facts = listAtlasPinnedFactsForContext(db, {
      sessionId: "thread:123",
      agentIds: ["sierra", "sierra-ollama"],
    });
    expect(facts.map((fact) => fact.key)).toEqual(["base", "clone", "vehicle"]);

    db.close();
  });

  it("touches memories by id, bumping access tracking", () => {
    const { db } = createDb();
    const id = insertMemory(db, { content: "touched fact", agentId: "sierra" });

    const touched = touchAtlasMemories(db, [id, id, "missing-id"]);
    expect(touched).toBe(1);
    const row = db.prepare(`SELECT access_count FROM memories WHERE id = ?`).get(id) as {
      access_count: number;
    };
    expect(row.access_count).toBe(1);

    db.close();
  });
});
