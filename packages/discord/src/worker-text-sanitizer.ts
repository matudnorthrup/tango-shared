function parseStructuredWorkerText(workerText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(workerText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function looksLikeStructuredKeyValueBlock(block: string): boolean {
  const lines = block
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return false;
  }

  const structuredLineCount = lines.filter((line) =>
    /^[a-z_][\w.-]*:\s*$/iu.test(line)
    || /^[a-z_][\w.-]*:\s+\S/iu.test(line)
    || /^-\s+[a-z_][\w.-]*:\s*/iu.test(line)
  ).length;

  return structuredLineCount >= Math.min(2, lines.length);
}

function shouldStripStructuredFence(infoString: string, body: string): boolean {
  const normalizedInfo = infoString.trim().toLowerCase();
  if (["json", "yaml", "yml"].includes(normalizedInfo)) {
    return true;
  }

  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return false;
  }

  return parseStructuredWorkerText(trimmedBody) !== null
    || looksLikeStructuredKeyValueBlock(trimmedBody);
}

function stripStructuredFencedBlocks(text: string): string {
  return text.replace(/```([^\n`]*)\n([\s\S]*?)\n```/gu, (fullMatch, infoString, body) =>
    shouldStripStructuredFence(String(infoString ?? ""), String(body ?? "")) ? "" : fullMatch,
  );
}

export function sanitizeWorkerTextForDisplay(workerText: unknown): string {
  if (typeof workerText !== "string") {
    return "";
  }

  const trimmed = workerText.trim();
  if (!trimmed) {
    return "";
  }

  if (parseStructuredWorkerText(trimmed)) {
    return "";
  }

  const stripped = stripStructuredFencedBlocks(trimmed)
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  if (!stripped || parseStructuredWorkerText(stripped)) {
    return "";
  }

  return stripped;
}

const SALVAGE_FIELDS = ["response", "reply", "message", "text", "answer", "content", "summary"] as const;

/**
 * Display coercion for stateless OpenAI-compatible (Ollama) replies, which can
 * occasionally wrap output in a JSON object or fenced structured block instead of
 * plain prose. Strips accidental structured fences; if the whole reply was
 * structured, salvages a human-readable field from the JSON; only as a last resort
 * returns the original trimmed text. Never blanks a non-empty reply (which would
 * render as "[empty response]"), and never leaks an obvious all-JSON payload when a
 * readable field is present.
 */
export function coerceWorkerReplyForDisplay(workerText: unknown): string {
  if (typeof workerText !== "string") {
    return "";
  }

  const sanitized = sanitizeWorkerTextForDisplay(workerText);
  if (sanitized) {
    return sanitized;
  }

  // Sanitizer blanked it → the reply was entirely structured. Try to recover a
  // human-readable field rather than rendering raw JSON or an empty message.
  const parsed = parseStructuredWorkerText(workerText.trim());
  if (parsed) {
    for (const field of SALVAGE_FIELDS) {
      const value = parsed[field];
      if (typeof value === "string" && value.trim()) {
        return sanitizeWorkerTextForDisplay(value) || value.trim();
      }
    }
  }

  // Last resort: original text. No worse than the pre-fix behavior.
  return workerText.trim();
}
