export function appendTopicContextToSystemPrompt(
  systemPrompt: string,
  topicTitle?: string | null,
): string {
  const normalizedPrompt = systemPrompt.trim();
  const normalizedTopicTitle = topicTitle?.trim();
  if (!normalizedTopicTitle) {
    return normalizedPrompt;
  }

  const topicInstruction =
    `Current topic: ${normalizedTopicTitle}. ` +
    `Treat references like "this topic", "the topic", or implicit follow-ups as referring to ${normalizedTopicTitle} unless the user explicitly switches topics.`;

  if (!normalizedPrompt) {
    return topicInstruction;
  }

  return `${normalizedPrompt}\n\n${topicInstruction}`;
}

export function appendProjectContextToSystemPrompt(
  systemPrompt: string,
  projectTitle?: string | null,
): string {
  const normalizedPrompt = systemPrompt.trim();
  const normalizedProjectTitle = projectTitle?.trim();
  if (!normalizedProjectTitle) {
    return normalizedPrompt;
  }

  const projectInstruction =
    `Current project: ${normalizedProjectTitle}. ` +
    `Treat this turn as belonging to ${normalizedProjectTitle} unless the user explicitly switches projects.`;

  if (!normalizedPrompt) {
    return projectInstruction;
  }

  return `${normalizedPrompt}\n\n${projectInstruction}`;
}
