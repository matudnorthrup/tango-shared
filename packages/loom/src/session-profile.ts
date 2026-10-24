import { createHash } from "node:crypto";

export interface SessionProfile {
  system?: string;
  disallowedTools?: string[];
  sandbox?: "read-only";
  projectDocs?: boolean;
  loomTools?: boolean;
  mcpServers?: Record<string, { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> } | { type: "http" | "sse"; url: string; headers?: Record<string, string> }>;
  model?: string;
  tier?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  settingSources?: ("user" | "project" | "local")[];
  tools?: "default" | "none";
  env?: Record<string, string>;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown) => object(v) && Object.values(v).every(x => typeof x === "string");
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
export function validSessionProfile(v: unknown): v is SessionProfile {
  if (!object(v) || !keys(v, ["disallowedTools", "sandbox", "projectDocs", "system", "mcpServers", "model", "tier", "effort", "settingSources", "tools", "env", "loomTools"])) return false;
  if (["system", "model"].some(k => v[k] !== undefined && typeof v[k] !== "string")) return false;
  if (v.tier !== undefined && (typeof v.tier !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(v.tier))) return false;
  if (v.loomTools !== undefined && typeof v.loomTools !== "boolean") return false;
  if (v.sandbox !== undefined && v.sandbox !== "read-only") return false;
  if (v.projectDocs !== undefined && typeof v.projectDocs !== "boolean") return false;
  if (v.disallowedTools !== undefined && (!Array.isArray(v.disallowedTools) || !v.disallowedTools.every(x => typeof x === "string"))) return false;
  if (v.env !== undefined && !strings(v.env)) return false;
  if (v.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(v.effort as string)) return false;
  if (v.tools !== undefined && !["default", "none"].includes(v.tools as string)) return false;
  if (v.settingSources !== undefined && (!Array.isArray(v.settingSources) || !v.settingSources.every(x => ["user", "project", "local"].includes(x)))) return false;
  if (v.mcpServers !== undefined) {
    if (!object(v.mcpServers)) return false;
    for (const s of Object.values(v.mcpServers)) {
      if (!object(s)) return false;
      if (s.type === undefined || s.type === "stdio") {
        if (!keys(s, ["type", "command", "args", "env"]) || typeof s.command !== "string" || !s.command.trim() || (s.env !== undefined && !strings(s.env)) || (s.args !== undefined && (!Array.isArray(s.args) || !s.args.every(x => typeof x === "string")))) return false;
      } else if (s.type === "http" || s.type === "sse") {
        if (!keys(s, ["type", "url", "headers"]) || typeof s.url !== "string" || !s.url.trim() || (s.headers !== undefined && !strings(s.headers))) return false;
      } else return false;
    }
  }
  return true;
}
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (object(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
  return v;
}
export const profileHash = (v?: SessionProfile | null): string => createHash("sha256").update(JSON.stringify(stable(v ?? {}))).digest("hex");
/**
 * What a session host was opened with: its profile, and its role when the role changes its instructions (a
 * role add-on). A thread that changes instruction-bearing roles reopens on its next turn.
 */
export const sessionHash = (v?: SessionProfile | null, role?: string | null): string => ["default", "worker", "ops"].includes(role ?? "") ? profileHash({ ...(v ?? {}), role } as SessionProfile) : profileHash(v);
/** Error messages can echo configuration values; strip every configured secret before forwarding. */
/**
 * Secret-looking profile values, hidden from events, errors and logs. Only values under a key that names a
 * secret, or long token-shaped values, count: agent env also carries ordinary words (a worker id, a server
 * name) that must survive in the agent's own replies.
 */
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|auth|credential|private[_-]?key|cookie|session)/i;
const TOKEN_SHAPED = /^[A-Za-z0-9_\-./+=:]{24,}$/;
function secretValues(p?: SessionProfile): string[] {
  const pairs: [string, string][] = [
    ...Object.entries(p?.env ?? {}),
    ...Object.values(p?.mcpServers ?? {}).flatMap((s) => Object.entries("command" in s ? s.env ?? {} : s.headers ?? {})),
  ];
  return pairs.filter(([key, value]) => value && value.length >= 6 && (SECRET_KEY.test(key) || (TOKEN_SHAPED.test(value) && !value.startsWith("/")))).map(([, value]) => value);
}
export function redactProfile(text: string, p?: SessionProfile): string {
  for (const value of secretValues(p).sort((a, b) => b.length - a.length)) text = text.split(value).join("[REDACTED]");
  return text;
}

/** Why a session profile can't run under Codex, or null when it can. */
export function codexIncompatible(profile: SessionProfile | null | undefined): string | null {
  // Codex's built-in shell and patch tools can't be turned off, so a no-tools profile can't run here.
  if (profile?.tools === "none") return "Codex can't run a session with tools: \"none\"";
  // Only stdio MCP servers are handed to Codex; a remote one would silently go missing.
  const remote = Object.entries(profile?.mcpServers ?? {}).find(([name, server]) => name !== "loom" && !("command" in server));
  return remote ? `Codex can't run remote MCP server "${remote[0]}"` : null;
}
