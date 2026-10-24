import type { ModelRunRecord, StoredMessageRecord } from "./storage.js";

export interface ContextPacketTurn {
  speaker: "user" | "assistant";
  createdAt: string;
  content: string;
}

export interface ContextPacketToolOutcome {
  providerName: string;
  createdAt: string;
  usedTools: string[];
  deniedTools: string[];
}

export interface ContextPacketWorkflowOutcome {
  workflowId: string;
  workerId?: string;
  createdAt: string;
  arguments?: Record<string, unknown>;
  toolNames: string[];
}

export interface ContextPacket {
  sessionId: string;
  agentId: string;
  generatedAt: string;
  summary: string;
  compactSummary?: string;
  turns: ContextPacketTurn[];
  toolOutcomes: ContextPacketToolOutcome[];
  workflowOutcomes: ContextPacketWorkflowOutcome[];
  hasHistory: boolean;
}

export interface BuildContextPacketInput {
  sessionId: string;
  agentId: string;
  messages: StoredMessageRecord[];
  modelRuns?: ModelRunRecord[];
  compactSummary?: string;
  excludeMessageIds?: number[];
  maxTurns?: number;
  maxToolOutcomes?: number;
  maxContentCharsPerTurn?: number;
}

export interface RenderContextPacketOptions {
  maxChars?: number;
}

function truncateText(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(maxChars - 3, 1))}...`;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function buildContextPacket(input: BuildContextPacketInput): ContextPacket {
  const compactSummary = input.compactSummary?.trim();
  const excludeIds = new Set(input.excludeMessageIds ?? []);
  const maxTurns = Number.isFinite(input.maxTurns) ? Math.max(input.maxTurns ?? 8, 1) : 8;
  const maxToolOutcomes = Number.isFinite(input.maxToolOutcomes)
    ? Math.max(input.maxToolOutcomes ?? 3, 1)
    : 3;
  const maxContentCharsPerTurn = Number.isFinite(input.maxContentCharsPerTurn)
    ? Math.max(input.maxContentCharsPerTurn ?? 320, 64)
    : 320;

  const relevantTurns = input.messages
    .filter((message) => message.sessionId === input.sessionId)
    .filter((message) => message.agentId === input.agentId)
    .filter((message) => !excludeIds.has(message.id))
    .filter((message) => message.direction === "inbound" || message.direction === "outbound")
    .slice(-maxTurns)
    .map((message): ContextPacketTurn => ({
      speaker: message.direction === "inbound" ? "user" : "assistant",
      createdAt: message.createdAt,
      content: truncateText(message.content, maxContentCharsPerTurn)
    }));

  const toolOutcomes = (input.modelRuns ?? [])
    .filter((run) => run.sessionId === input.sessionId)
    .filter((run) => run.agentId === input.agentId)
    .filter((run) => run.isError === 0)
    .map((run): ContextPacketToolOutcome | null => {
      const metadata = run.metadata;
      if (!metadata || typeof metadata !== "object") return null;
      const toolTelemetry = (metadata as Record<string, unknown>).toolTelemetry;
      if (!toolTelemetry || typeof toolTelemetry !== "object") return null;
      const telemetry = toolTelemetry as Record<string, unknown>;

      const usedTools = asStringArray(telemetry.usedTools);
      const deniedTools = asStringArray(telemetry.deniedTools);
      if (usedTools.length === 0 && deniedTools.length === 0) return null;

      return {
        providerName: run.providerName,
        createdAt: run.createdAt,
        usedTools,
        deniedTools
      };
    })
    .filter((outcome): outcome is ContextPacketToolOutcome => outcome !== null)
    .slice(-maxToolOutcomes);

  const workflowOutcomes = input.messages
    .filter((message) => message.sessionId === input.sessionId)
    .filter((message) => message.agentId === input.agentId)
    .filter((message) => !excludeIds.has(message.id))
    .filter((message) => message.direction === "outbound")
    .map((message): ContextPacketWorkflowOutcome | null => {
      const metadata = asRecord(message.metadata);
      const trace = asRecord(metadata?.executionTrace);
      const workflow = asRecord(trace?.workflow);
      if (!workflow) return null;

      const workflowId =
        typeof workflow.id === "string" && workflow.id.trim().length > 0
          ? workflow.id.trim()
          : null;
      if (!workflowId) return null;

      const workerId =
        typeof workflow.workerId === "string" && workflow.workerId.trim().length > 0
          ? workflow.workerId.trim()
          : undefined;
      const argumentsRecord = asRecord(workflow.arguments) ?? undefined;
      const toolCalls = Array.isArray(trace?.toolCalls) ? trace.toolCalls : [];
      const toolNames = [
        ...new Set(
          toolCalls.flatMap((item) => {
            const toolCall = asRecord(item);
            const names = Array.isArray(toolCall?.toolNames) ? toolCall?.toolNames : [];
            return names
              .filter((name): name is string => typeof name === "string")
              .map((name) => name.trim())
              .filter((name) => name.length > 0);
          }),
        ),
      ];

      return {
        workflowId,
        workerId,
        createdAt: message.createdAt,
        arguments: argumentsRecord,
        toolNames,
      };
    })
    .filter((outcome): outcome is ContextPacketWorkflowOutcome => outcome !== null)
    .slice(-maxToolOutcomes);

  const userTurnCount = relevantTurns.filter((turn) => turn.speaker === "user").length;
  const assistantTurnCount = relevantTurns.filter((turn) => turn.speaker === "assistant").length;
  const lastUserTurn = [...relevantTurns].reverse().find((turn) => turn.speaker === "user");
  const lastAssistantTurn = [...relevantTurns].reverse().find((turn) => turn.speaker === "assistant");

  const summaryParts: string[] = [];
  if (compactSummary && compactSummary.length > 0) {
    summaryParts.push("Compacted summary available.");
  }
  if (relevantTurns.length === 0) {
    summaryParts.push("No prior turns available for this session and agent.");
  } else {
    summaryParts.push(
      `Recent turns: ${userTurnCount} user and ${assistantTurnCount} assistant.`
    );
    if (lastUserTurn) {
      summaryParts.push(`Last user turn: "${truncateText(lastUserTurn.content, 120)}"`);
    }
    if (lastAssistantTurn) {
      summaryParts.push(`Last assistant turn: "${truncateText(lastAssistantTurn.content, 120)}"`);
    }
  }

  if (toolOutcomes.length > 0) {
    summaryParts.push(`Recent tool activity captured in ${toolOutcomes.length} run(s).`);
  }
  if (workflowOutcomes.length > 0) {
    summaryParts.push(`Recent workflow activity captured in ${workflowOutcomes.length} turn(s).`);
  }

  return {
    sessionId: input.sessionId,
    agentId: input.agentId,
    generatedAt: new Date().toISOString(),
    summary: summaryParts.join(" "),
    compactSummary: compactSummary && compactSummary.length > 0 ? compactSummary : undefined,
    turns: relevantTurns,
    toolOutcomes,
    workflowOutcomes,
    hasHistory:
      relevantTurns.length > 0 ||
      toolOutcomes.length > 0 ||
      workflowOutcomes.length > 0 ||
      !!compactSummary
  };
}

export function renderContextPacket(
  packet: ContextPacket,
  options: RenderContextPacketOptions = {}
): string {
  if (!packet.hasHistory) return "";

  const maxChars = Number.isFinite(options.maxChars) ? Math.max(options.maxChars ?? 2800, 400) : 2800;
  const compactSummaryMaxChars =
    packet.turns.length > 0
      ? Math.min(Math.max(Math.floor(maxChars * 0.35), 240), 900)
      : Math.min(Math.max(Math.floor(maxChars * 0.6), 320), 1600);
  const lines: string[] = [
    "Context handoff packet (portable session context):",
    `session=${packet.sessionId} agent=${packet.agentId}`,
    `generated_at=${packet.generatedAt}`,
    `summary=${packet.summary}`
  ];

  if (packet.turns.length > 0) {
    lines.push("recent_turns:");
    for (const turn of packet.turns) {
      lines.push(`- [${turn.speaker} at ${turn.createdAt}] ${turn.content}`);
    }
  }

  if (packet.toolOutcomes.length > 0) {
    lines.push("recent_tool_outcomes:");
    for (const outcome of packet.toolOutcomes) {
      const used = outcome.usedTools.length > 0 ? outcome.usedTools.join("|") : "-";
      const denied = outcome.deniedTools.length > 0 ? outcome.deniedTools.join("|") : "-";
      lines.push(`- provider=${outcome.providerName} used=${used} denied=${denied}`);
    }
  }

  if (packet.workflowOutcomes.length > 0) {
    lines.push("recent_workflow_outcomes:");
    for (const outcome of packet.workflowOutcomes) {
      const toolNames = outcome.toolNames.length > 0 ? outcome.toolNames.join("|") : "-";
      const workerPart = outcome.workerId ? ` worker=${outcome.workerId}` : "";
      const argumentKeys = outcome.arguments ? Object.keys(outcome.arguments) : [];
      const argumentSummary =
        argumentKeys.length > 0 ? ` args=${argumentKeys.join("|")}` : " args=-";
      lines.push(
        `- workflow=${outcome.workflowId}${workerPart} tools=${toolNames}${argumentSummary}`,
      );
    }
  }

  if (packet.compactSummary && packet.compactSummary.trim().length > 0) {
    lines.push("compacted_summary:");
    lines.push(truncateText(packet.compactSummary.trim(), compactSummaryMaxChars));
  }

  lines.push("End context handoff packet.");

  const output = lines.join("\n");
  if (output.length <= maxChars) return output;

  const compact: string[] = [];
  for (const line of lines) {
    const candidate = [...compact, line, "[truncated]"].join("\n");
    if (candidate.length > maxChars) break;
    compact.push(line);
  }
  compact.push("[truncated]");
  return compact.join("\n");
}
