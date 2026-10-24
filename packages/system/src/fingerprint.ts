import { createHash } from "node:crypto";

/**
 * Lowercases and replaces the parts of a title that vary between otherwise
 * identical events: long quoted strings, ISO timestamps, UUIDs, absolute paths,
 * durations, ports, hex ids and numbers. Order matters: the specific patterns
 * run before the generic number rule.
 */
export function normalize(title: string): string {
  let s = title.toLowerCase();
  // Quoted strings over 40 characters.
  s = s.replace(/"[^"]{41,}"/g, "<str>").replace(/'[^']{41,}'/g, "<str>").replace(/`[^`]{41,}`/g, "<str>");
  // ISO timestamps (date, optional time, optional zone).
  s = s.replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?\b/g, "<ts>");
  // Times of day.
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "<time>");
  // UUIDs.
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>");
  // Absolute paths (and ~/ paths) at a word boundary.
  s = s.replace(/(^|[\s('"=,\[])(?:~|\/)(?:[^\s'"(),\]]*\/)?[^\s'"(),\]]*/g, (match, lead: string) => {
    const body = match.slice(lead.length);
    return body === "/" || body === "~" ? match : `${lead}<path>`;
  });
  // Durations: 4012ms, 3.2s, 5 min, 2h.
  s = s.replace(/\b\d+(?:\.\d+)?\s?(?:ms|msec|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/g, "<dur>");
  // Ports.
  s = s.replace(/(:)\d{2,5}\b/g, "$1<port>");
  s = s.replace(/\bport\s+\d{2,5}\b/g, "port <port>");
  // Hex ids (7+ hex chars with at least one digit and one letter, or 0x...).
  s = s.replace(/\b0x[0-9a-f]+\b/g, "<hex>");
  s = s.replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g, "<hex>");
  // Remaining numbers.
  s = s.replace(/\d+(?:\.\d+)?/g, "<n>");
  return s.replace(/\s+/g, " ").trim();
}

/** Hash job + kind + normalized title, or an explicit entity identity; the source is deliberately left out. */
export function fingerprint(jobId: string | null | undefined, kind: string, title: string, identity?: string): string {
  return createHash("sha1").update(`${jobId ?? ""}\u0000${kind}\u0000${identity === undefined ? normalize(title) : `identity:${identity}`}`).digest("hex");
}
