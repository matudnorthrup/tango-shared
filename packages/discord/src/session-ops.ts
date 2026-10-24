export function buildV2ConversationKey(channelId: string, threadId?: string): string {
  return threadId ? `thread:${threadId}` : `channel:${channelId}`;
}

export interface PendingSessionSaveMatchInput {
  agentId: string;
}

/**
 * Pending save passes are scoped to a Discord conversation (channel or thread) plus
 * agent. Do not require sessionId equality: slash commands store the thread-session
 * id from persistence while the next message may route through an active topic
 * (topic:…) or project session.
 */
export function matchesPendingSessionSave(
  pendingSave: { agentId: string } | null,
  input: PendingSessionSaveMatchInput,
): boolean {
  if (!pendingSave) {
    return false;
  }

  const agentId = input.agentId.trim();
  return agentId.length > 0 && pendingSave.agentId === agentId;
}

export function buildSavePassContext(): string {
  return [
    "Save pass (requested via /tango save):",
    "Review this conversation and capture anything that would be lost if the session ended now.",
    "Route each item to the right layer (see profile skill session-save.md):",
    "- Linked thread file: project decisions, test results, Open Items / Quick Read — patch only, never full overwrite.",
    "- Daily log (when enabled): one headline per session block — what happened today, not detail.",
    "- Atlas (memory_add): partnership, preferences, durable lessons — source manual, metadata captured_by save_pass.",
    "Do not save test artifacts, smoke-test codewords, or ephemeral session-only details unless the user explicitly asked to preserve them.",
    "Confirm what you saved in each layer (or what would go to daily log if not wired yet).",
  ].join("\n");
}

/** Ephemeral Discord reply when the operator runs `/tango save`. */
export function buildSavePassEphemeralReply(scopeLabel: string): string {
  return [
    `Save pass queued for ${scopeLabel}.`,
    "Your next message will ask the agent to review this conversation and route saves:",
    "linked **thread file** (project state), **daily log** headline (when wired), and **Atlas** (partnership recall).",
    "The agent should confirm what went to each layer.",
  ].join(" ");
}

export function mergeSendContext(...sections: Array<string | undefined | null>): string | undefined {
  const merged = sections
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section && section.length > 0))
    .join("\n\n");

  return merged.length > 0 ? merged : undefined;
}

export function buildSendContextWithOptionalSavePass(
  warmStartPrompt: string | undefined,
  pendingSave: boolean,
): string | undefined {
  if (!pendingSave) {
    return warmStartPrompt?.trim() ? warmStartPrompt : undefined;
  }

  return mergeSendContext(warmStartPrompt, buildSavePassContext());
}
