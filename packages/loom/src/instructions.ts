import { readFileSync } from "node:fs";

/** Read only Loom's versioned instructions, never an arbitrary session cwd. */
export function instructionBlock(source: string, name: string): string {
  const start = `<!-- loom:${name}:start -->`;
  const end = `<!-- loom:${name}:end -->`;
  if (source.split(start).length !== 2 || source.split(end).length !== 2) {
    throw new Error(`AGENTS.md must contain exactly one ${name} instruction block`);
  }
  const from = source.indexOf(start) + start.length;
  const to = source.indexOf(end);
  if (to < from || !source.slice(from, to).trim()) throw new Error(`Empty or reversed ${name} instruction block`);
  return source.slice(from, to).trim();
}

const source = readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8");
export const LOOM_GUIDANCE = instructionBlock(source, "common");
export const DEFAULT_ROLE_GUIDANCE = instructionBlock(source, "default");
// Compatibility export for callers that previously imported this from catchup.ts.
export const CATCHUP_LEAD_GUIDANCE = DEFAULT_ROLE_GUIDANCE.slice(DEFAULT_ROLE_GUIDANCE.indexOf("Catch-up:"));
const roles: Record<string, string> = {
  default: DEFAULT_ROLE_GUIDANCE,
  worker: instructionBlock(source, "worker"),
  ops: instructionBlock(source, "ops"),
};
export const roleGuidance = (role?: string | null): string => role && Object.hasOwn(roles, role) ? roles[role] ?? "" : "";
