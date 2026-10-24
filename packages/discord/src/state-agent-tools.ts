import type { AgentTool } from "@tango/core";

const DEFAULT_STATE_API_URL = "http://127.0.0.1:9340/api/tools";

export interface StateToolOptions {
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

function hiddenContext(input: Record<string, unknown>): Record<string, unknown> {
  return {
    agent_id: stringOrUndefined(input._requester_agent_id),
    conversation_key: stringOrUndefined(input._conversation_key),
    turn_id: stringOrUndefined(input._turn_id),
    message_id: stringOrUndefined(input._message_id),
    channel_id: stringOrUndefined(input._channel_id),
    thread_id: stringOrUndefined(input._thread_id),
  };
}

function publicInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith("_")));
}

export function createStateTools(options: StateToolOptions = {}): AgentTool[] {
  const apiUrl = (options.apiUrl ?? process.env.TANGO_STATE_API_URL ?? DEFAULT_STATE_API_URL).replace(/\/+$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  const call = async (tool: string, input: Record<string, unknown>): Promise<unknown> => {
    const response = await fetchImpl(`${apiUrl}/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: publicInput(input), context: hiddenContext(input) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { result: text };
    }
    if (!response.ok) {
      const detail = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return parsed;
  };

  return [
    {
      name: "state_query",
      description: [
        "Read canonical typed state. State results override conflicting memories.",
        "List/filter entities, inspect one entity with recent events/relations/references, or query a numeric event trend.",
        "Generic filters cover project association, owners, source, deadlines, overdue work, progress age, relations, and evidence/reference roles.",
        "A query with type returns typeDefinition (the authoritative schema/status catalog) even when entities is empty.",
        "A zero-entity result means no matching entity; it does NOT mean the type is missing.",
        "Examples: {type:'project',status:'active'}, {entity_id:'body-composition:current',trend:{field:'weight_lb',window_days:30,aggregation:'change'}}.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          entity_id: { type: "string" },
          type: { type: "string" },
          status: { type: "string" },
          stale: { type: "boolean" },
          overdue: { type: "boolean" },
          text: { type: "string" },
          project_entity_id: { type: "string" },
          owner_user_id: { type: "string" },
          owner_agent_id: { type: "string" },
          source: { type: "string" },
          due_before: { type: "string", description: "Inclusive ISO date or timestamp upper bound." },
          due_after: { type: "string", description: "Inclusive ISO date or timestamp lower bound." },
          next_check_before: { type: "string", description: "Inclusive ISO date or timestamp upper bound." },
          next_check_after: { type: "string", description: "Inclusive ISO date or timestamp lower bound." },
          expected_response_before: { type: "string", description: "Inclusive ISO date or timestamp upper bound." },
          expected_response_after: { type: "string", description: "Inclusive ISO date or timestamp lower bound." },
          last_progress_before: { type: "string", description: "Inclusive ISO date or timestamp upper bound." },
          last_progress_after: { type: "string", description: "Inclusive ISO date or timestamp lower bound." },
          progress_older_than_days: { type: "number", minimum: 0 },
          progress_newer_than_days: { type: "number", minimum: 0 },
          relation_kind: { type: "string" },
          related_entity_id: { type: "string" },
          reference_role: { type: "string" },
          include_relations: { type: "boolean" },
          include_references: { type: "boolean" },
          include_archived: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          recent_events: { type: "integer", minimum: 0, maximum: 100 },
          trend: {
            type: "object",
            properties: {
              field: { type: "string" },
              window_days: { type: "integer", minimum: 1, maximum: 3650 },
              aggregation: { type: "string", enum: ["raw", "average", "min", "max", "change"] },
            },
            required: ["field"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      handler: async (input) => call("state_query", input),
    },
    {
      name: "state_update",
      description: [
        "Create or update a canonical state entity through the validated append-only state ledger.",
        "Seeded type IDs include project, travel, body-composition, vehicle, automation-job, and finance-review; inspect them with state_query {type:...} and use only declared attributes.",
        "Cross-cutting fields such as project association, owners, visibility, deadlines, progress timestamps, relations, and evidence references work for every type.",
        "mark_progress=true records meaningful progress; routine touches should leave it false/omitted. Do not mark completion from narrative, plans, or document existence alone—require explicit verified evidence.",
        "Every mutation is idempotent, visible in a turn receipt, and revertible. Use revert_turn for 'undo that'.",
        "Modes: upsert, patch, transition, observation, note, archive, restore, revert_event, revert_turn.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["upsert", "patch", "transition", "observation", "note", "archive", "restore", "revert_event", "revert_turn"],
          },
          entity_id: { type: "string" },
          type_id: { type: "string" },
          title: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          attributes: { type: "object" },
          status: { type: ["string", "null"] },
          summary: { type: ["string", "null"] },
          body_pointer: { type: ["string", "null"] },
          project_entity_id: { type: ["string", "null"] },
          owner_user_id: { type: ["string", "null"] },
          owner_agent_id: { type: ["string", "null"] },
          visibility: { type: ["string", "null"] },
          due_at: { type: ["string", "null"] },
          next_check_at: { type: ["string", "null"] },
          expected_response_at: { type: ["string", "null"] },
          last_progress_at: { type: ["string", "null"] },
          mark_progress: { type: "boolean" },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string" },
                target_entity_id: { type: "string" },
                metadata: { type: ["object", "null"] },
                remove: { type: "boolean" },
              },
              required: ["kind", "target_entity_id"],
              additionalProperties: false,
            },
          },
          references: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                ref: { type: "string" },
                label: { type: ["string", "null"] },
                metadata: { type: ["object", "null"] },
                supports_event_id: { type: ["integer", "null"], minimum: 1 },
                remove: { type: "boolean" },
              },
              required: ["role", "ref"],
              additionalProperties: false,
            },
          },
          note: { type: "string" },
          occurred_at: { type: "string", description: "When the observation was true; ISO timestamp." },
          event_id: { type: "integer", minimum: 1 },
          turn_id: { type: "string", description: "Turn to undo; omit to undo the latest state-changing turn in this conversation." },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      handler: async (input) => call("state_update", input),
    },
    {
      name: "state_define_type",
      description: [
        "Create or add optional fields to a typed state definition.",
        "Conversation-created types require confirm=true after the user explicitly confirms the one-line draft.",
        "V1 evolution is additive-only: existing fields/statuses cannot be renamed, removed, or retyped.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          display_name: { type: "string" },
          description: { type: "string" },
          attributes_schema: { type: "object" },
          statuses: { type: ["object", "null"] },
          staleness_policy: { type: ["object", "null"] },
          digest_template: { type: ["string", "null"] },
          body_fields: { type: "array", items: { type: "string" } },
          visibility: { type: "string" },
          confirm: { type: "boolean" },
        },
        required: ["id", "display_name", "attributes_schema", "confirm"],
        additionalProperties: false,
      },
      handler: async (input) => call("state_define_type", input),
    },
  ];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
