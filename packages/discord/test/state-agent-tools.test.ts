import { describe, expect, it, vi } from "vitest";
import { createStateTools } from "../src/state-agent-tools.js";

describe("state agent tool contracts", () => {
  it("exposes the generic kernel fields and keeps hidden routing context private", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ entities: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const tools = createStateTools({ apiUrl: "http://state.test/api/tools", fetchImpl: fetchImpl as typeof fetch });
    const query = tools.find((tool) => tool.name === "state_query")!;
    const update = tools.find((tool) => tool.name === "state_update")!;
    const queryProperties = (query.inputSchema as { properties: Record<string, unknown> }).properties;
    const updateProperties = (update.inputSchema as { properties: Record<string, unknown> }).properties;

    expect(queryProperties).toEqual(expect.objectContaining({
      project_entity_id: expect.any(Object),
      owner_user_id: expect.any(Object),
      overdue: expect.any(Object),
      progress_older_than_days: expect.any(Object),
      relation_kind: expect.any(Object),
      reference_role: expect.any(Object),
      include_relations: expect.any(Object),
      include_references: expect.any(Object),
    }));
    expect(updateProperties).toEqual(expect.objectContaining({
      project_entity_id: expect.any(Object),
      owner_user_id: expect.any(Object),
      visibility: expect.any(Object),
      due_at: expect.any(Object),
      mark_progress: expect.any(Object),
      relations: expect.any(Object),
      references: expect.any(Object),
    }));

    await query.handler({
      project_entity_id: "project:synthetic",
      include_relations: true,
      _requester_agent_id: "watson",
      _turn_id: "turn-fixture",
    });
    const request = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      input: Record<string, unknown>;
      context: Record<string, unknown>;
    };
    expect(body.input).toEqual({ project_entity_id: "project:synthetic", include_relations: true });
    expect(body.context).toMatchObject({ agent_id: "watson", turn_id: "turn-fixture" });
    expect(JSON.stringify(body.input)).not.toContain("_requester_agent_id");
  });
});
