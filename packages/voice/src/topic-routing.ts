export type SharedTopicSystemCommand =
  | {
      type: "open-topic";
      topicName: string;
      projectName: string | null;
      standalone: boolean;
    }
  | {
      type: "move-topic-to-project";
      topicName: string | null;
      projectName: string;
    }
  | {
      type: "detach-topic-from-project";
      topicName: string | null;
    }
  | { type: "current-topic" }
  | { type: "clear-topic" };

export interface InlineTopicReference {
  topicName: string;
  promptText: string;
  /** True when the reference used the explicit "topic" keyword ("on topic X: ..."). */
  usedTopicKeyword: boolean;
}

function normalizeSpacing(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/g, "").trim();
}

export function normalizeTopicSlug(value: string): string {
  return normalizeSpacing(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildTopicSessionId(topicId: string): string {
  return `topic:${topicId}`;
}

export function formatTopicReference(
  topicTitle: string,
  projectDisplayName?: string | null
): string {
  return projectDisplayName
    ? `topic ${normalizeSpacing(topicTitle)} in project ${normalizeSpacing(projectDisplayName)}`
    : `standalone topic ${normalizeSpacing(topicTitle)}`;
}

export function formatOpenedTopicMessage(
  topicTitle: string,
  projectDisplayName?: string | null
): string {
  return `Opened ${formatTopicReference(topicTitle, projectDisplayName)}. You can keep talking.`;
}

export function formatCurrentTopicMessage(
  topicTitle: string,
  projectDisplayName?: string | null
): string {
  return `You are in ${formatTopicReference(topicTitle, projectDisplayName)}.`;
}

export function parseSharedTopicSystemCommand(
  promptText: string
): SharedTopicSystemCommand | null {
  const source = stripTrailingPunctuation(normalizeSpacing(promptText));
  if (!source) return null;

  const lowered = source.toLowerCase();
  if (
    /^(?:what\s+topic\s+am\s+i\s+in|which\s+topic(?:\s+am\s+i\s+in)?|current\s+topic|active\s+topic|what\s+project\s+is\s+this\s+topic\s+in)$/.test(
      lowered
    )
  ) {
    return { type: "current-topic" };
  }

  if (
    /^(?:clear\s+topic|leave\s+topic|exit\s+topic|back\s+to\s+default\s+topic|back\s+to\s+no\s+topic)$/.test(
      lowered
    )
  ) {
    return { type: "clear-topic" };
  }

  const standaloneMatch = source.match(
    /^(?:open|resume|use|switch\s+to|go\s+to)\s+(?:a\s+)?standalone\s+topic\s+(.+)$/i
  );
  if (standaloneMatch?.[1]) {
    const topicName = normalizeSpacing(standaloneMatch[1]);
    if (!topicName) return null;
    return { type: "open-topic", topicName, projectName: null, standalone: true };
  }

  const moveCurrentMatch = source.match(
    /^(?:attach|move)\s+(?:this|current)\s+topic\s+to\s+project\s+(.+)$/i
  );
  if (moveCurrentMatch?.[1]) {
    const projectName = normalizeSpacing(moveCurrentMatch[1]);
    if (!projectName) return null;
    return { type: "move-topic-to-project", topicName: null, projectName };
  }

  const moveNamedMatch = source.match(
    /^(?:attach|move)\s+topic\s+(.+?)\s+to\s+project\s+(.+)$/i
  );
  if (moveNamedMatch?.[1] && moveNamedMatch[2]) {
    const topicName = normalizeSpacing(moveNamedMatch[1]);
    const projectName = normalizeSpacing(moveNamedMatch[2]);
    if (!topicName || !projectName) return null;
    return { type: "move-topic-to-project", topicName, projectName };
  }

  const detachCurrentMatch = source.match(
    /^(?:detach|remove)\s+(?:this|current)\s+topic(?:\s+from\s+project)?$/i
  );
  if (detachCurrentMatch) {
    return { type: "detach-topic-from-project", topicName: null };
  }

  const detachNamedMatch = source.match(
    /^(?:detach|remove)\s+topic\s+(.+?)\s+from\s+project$/i
  );
  if (detachNamedMatch?.[1]) {
    const topicName = normalizeSpacing(detachNamedMatch[1]);
    if (!topicName) return null;
    return { type: "detach-topic-from-project", topicName };
  }

  const standaloneCurrentMatch = source.match(
    /^(?:make|set)\s+(?:this|current)\s+topic\s+standalone$/i
  );
  if (standaloneCurrentMatch) {
    return { type: "detach-topic-from-project", topicName: null };
  }

  const standaloneNamedMatch = source.match(
    /^(?:make|set)\s+topic\s+(.+?)\s+standalone$/i
  );
  if (standaloneNamedMatch?.[1]) {
    const topicName = normalizeSpacing(standaloneNamedMatch[1]);
    if (!topicName) return null;
    return { type: "detach-topic-from-project", topicName };
  }

  const projectMatch = source.match(
    /^(?:open|resume|use|switch\s+to|go\s+to)\s+topic\s+(.+?)\s+in\s+project\s+(.+)$/i
  );
  if (projectMatch?.[1] && projectMatch[2]) {
    const topicName = normalizeSpacing(projectMatch[1]);
    const projectName = normalizeSpacing(projectMatch[2]);
    if (!topicName || !projectName) return null;
    return { type: "open-topic", topicName, projectName, standalone: false };
  }

  const openMatch = source.match(
    /^(?:open|resume|use|switch\s+to|go\s+to)\s+topic\s+(.+)$/i
  );
  if (!openMatch?.[1]) return null;

  const topicName = normalizeSpacing(openMatch[1]);
  if (!topicName) return null;
  return { type: "open-topic", topicName, projectName: null, standalone: true };
}

export function extractInlineTopicReference(promptText: string): InlineTopicReference | null {
  const source = normalizeSpacing(promptText);
  if (!source) return null;

  const match = source.match(/^(?:in|on)\s+(topic\s+)?(.+?)[,:]\s*(.+)$/i);
  if (!match?.[2] || !match[3]) return null;

  const topicName = normalizeSpacing(match[2]);
  const remainder = normalizeSpacing(match[3]);
  if (!topicName || !remainder) return null;

  return {
    topicName,
    promptText: remainder,
    usedTopicKeyword: Boolean(match[1])
  };
}
