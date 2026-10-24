import type { MemoryRecord } from "@tango/atlas-memory";
import type { ChatProvider, StateEntity, StateEvent, StateService } from "@tango/core";

export type StateMemoryVerdict = "current_truth" | "state_adjacent" | "unsure";

export interface StateMemorySupersessionAtlas {
  memorySearch(input: { query: string; tags?: string[]; limit?: number }): Promise<MemoryRecord[]>;
  memoryAdmin(input: { operation: "archive" | "tag"; filter: Record<string, unknown> }): Promise<unknown>;
}

export interface StateMemorySupersessionReport {
  candidates: number;
  archived: number;
  tagged: number;
  unsure: number;
  rejected: number;
}

interface Candidate {
  entity: StateEntity;
  event: StateEvent;
  memory: MemoryRecord;
}

export async function runStateMemorySupersession(input: {
  service: StateService;
  atlas: StateMemorySupersessionAtlas;
  provider: ChatProvider;
  model: string;
  maxCandidates?: number;
}): Promise<StateMemorySupersessionReport> {
  const candidates = await collectCandidates(input.service, input.atlas, input.maxCandidates ?? 50);
  if (candidates.length === 0) return { candidates: 0, archived: 0, tagged: 0, unsure: 0, rejected: 0 };
  const response = await input.provider.generate({
    model: input.model,
    reasoningEffort: "low",
    prompt: buildSupersessionPrompt(candidates),
  });
  const verdicts = parseSupersessionVerdicts(response.text);
  let archived = 0;
  let tagged = 0;
  let unsure = 0;
  let rejected = 0;
  for (const candidate of candidates) {
    const verdict = verdicts.get(candidate.memory.id);
    if (!verdict) {
      rejected += 1;
      continue;
    }
    const entityTag = `state:${candidate.entity.id}`;
    await input.atlas.memoryAdmin({
      operation: "tag",
      filter: { ids: [candidate.memory.id], include_archived: true, add_tags: [entityTag] },
    });
    tagged += 1;
    if (verdict === "current_truth") {
      await input.atlas.memoryAdmin({
        operation: "archive",
        filter: {
          ids: [candidate.memory.id],
          include_archived: true,
          metadata_patch: { superseded_by: candidate.event.id, state_entity_id: candidate.entity.id },
        },
      });
      archived += 1;
    } else if (verdict === "unsure") {
      unsure += 1;
    }
    input.service.linkMemoryVerdict({
      eventId: candidate.event.id,
      memoryId: candidate.memory.id,
      entityId: candidate.entity.id,
      verdict,
      archived: verdict === "current_truth",
    });
  }
  return { candidates: candidates.length, archived, tagged, unsure, rejected };
}

export function buildSupersessionPrompt(candidates: readonly Candidate[]): string {
  return [
    "You are Tango's batched memory/state supersession classifier. Return JSON only.",
    "For each memory, choose exactly one verdict:",
    "- current_truth: the memory asserts a value as current that canonical state now owns",
    "- state_adjacent: historical conversation, context, feelings, or decisions about the state",
    "- unsure: insufficient confidence (never archive)",
    "Never infer beyond the supplied records. Return {\"verdicts\":[{\"memory_id\":\"...\",\"verdict\":\"current_truth|state_adjacent|unsure\"}]}",
    JSON.stringify(candidates.map((candidate) => ({
      memory_id: candidate.memory.id,
      memory_created_at: candidate.memory.createdAt,
      memory_content: candidate.memory.content,
      entity_id: candidate.entity.id,
      current_head: { status: candidate.entity.status, attributes: candidate.entity.attributes, summary: candidate.entity.summary },
      owning_event: { id: candidate.event.id, occurred_at: candidate.event.occurredAt, patch: candidate.event.patch },
    }))),
  ].join("\n");
}

export function parseSupersessionVerdicts(text: string): Map<string, StateMemoryVerdict> {
  const output = new Map<string, StateMemoryVerdict>();
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as { verdicts?: unknown[] };
      for (const item of parsed.verdicts ?? []) {
        if (!isRecord(item)) continue;
        const id = typeof item.memory_id === "string" ? item.memory_id.trim() : "";
        const verdict = item.verdict;
        if (id && (verdict === "current_truth" || verdict === "state_adjacent" || verdict === "unsure")) output.set(id, verdict);
      }
      return output;
    } catch {
      continue;
    }
  }
  return output;
}

async function collectCandidates(
  service: StateService,
  atlas: StateMemorySupersessionAtlas,
  limit: number,
): Promise<Candidate[]> {
  const output: Candidate[] = [];
  const seen = new Set<string>();
  for (const entity of service.query({ includePrivate: true, limit: 500 }).entities) {
    const event = service.listEvents(entity.id, 1)[0];
    if (!event) continue;
    const tagged = await atlas.memorySearch({ query: entity.title, tags: [`state:${entity.id}`], limit: 20 });
    const semantic = await atlas.memorySearch({ query: [entity.title, ...Object.keys(entity.attributes)].join(" "), limit: 10 });
    for (const memory of [...tagged, ...semantic]) {
      const key = `${event.id}:${memory.id}`;
      if (seen.has(key) || service.hasMemoryVerdict(event.id, memory.id)) continue;
      seen.add(key);
      output.push({ entity, event, memory });
      if (output.length >= limit) return output;
    }
  }
  return output;
}

function jsonCandidates(text: string): string[] {
  const values = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/giu;
  for (const match of text.matchAll(fenced)) if (match[1]) values.push(match[1].trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) values.push(text.slice(start, end + 1));
  return [...new Set(values.filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
