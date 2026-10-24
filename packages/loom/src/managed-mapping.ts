import { isDeepStrictEqual } from "node:util";
import type { LeaseBackend, ResourceLeases, ResourceLease } from "./leases.js";
import type { ProcessIdentity } from "./managed-process.js";

/** Only node Serve foreground sessions are managed. No background or Funnel mutation exists here. */
export interface ServeConfig {
  TCP?: Record<string, unknown>;
  Web?: Record<string, unknown>;
  AllowFunnel?: Record<string, unknown>;
  Foreground?: Record<string, ServeConfig>;
  [key: string]: unknown;
}
export interface MappingIdentity {
  sessionId: string;
  process: ProcessIdentity;
  httpsPort: number;
  config: ServeConfig;
}

function valid(value: unknown): value is MappingIdentity {
  const id = value as MappingIdentity;
  return !!id && typeof id.sessionId === "string" && !!id.sessionId && Number.isInteger(id.httpsPort) && id.httpsPort > 0 && id.httpsPort <= 65535 && !!id.process && !!id.config &&
    Object.keys(id.config).every(key => key === "TCP" || key === "Web") &&
    Object.keys(id.config.TCP ?? {}).length === 1 && isDeepStrictEqual(id.config.TCP?.[String(id.httpsPort)], { HTTPS: true }) &&
    Object.keys(id.config.Web ?? {}).length === 1 && Object.keys(id.config.Web!)[0]!.endsWith(`:${id.httpsPort}`);
}

/** A different session or a background mapping on this port is never ours, even with the same target. */
export function inspectMappingConfig(value: unknown, status: ServeConfig): "same" | "gone" | "different" | "unknown" {
  if (!valid(value) || !status || typeof status !== "object" || Array.isArray(status)) return "unknown";
  const own = status.Foreground?.[value.sessionId];
  if (!own) return "gone";
  if (!isDeepStrictEqual(own, value.config)) return "different";
  const usesPort = (config: ServeConfig): boolean =>
    Object.hasOwn(config.TCP ?? {}, String(value.httpsPort)) ||
    Object.keys(config.Web ?? {}).some(key => key.endsWith(`:${value.httpsPort}`)) ||
    Object.keys(config.AllowFunnel ?? {}).some(key => key.endsWith(`:${value.httpsPort}`));
  if (usesPort(status) || Object.entries(status.Foreground ?? {}).some(([session, config]) => session !== value.sessionId && usesPort(config))) return "different";
  return "same";
}

/** Build the conditional-update body from a fresh snapshot, preserving every unrelated
 * mapping and Funnel field. The transport must send it with that snapshot's ETag. */
export function mappingRemoval(identity: MappingIdentity, status: ServeConfig): ServeConfig {
  const state = inspectMappingConfig(identity, status);
  if (state !== "same" && state !== "gone") throw new Error("Mapping ownership changed; preserve it and inspect Serve status");
  const next = structuredClone(status);
  delete next.Foreground?.[identity.sessionId];
  return next;
}

/** status must read the current Serve configuration. Closing the exact foreground watcher
 * lets Tailscale remove only that session; never issue port-level off/reset commands.
 * A replacement after inspection has a different session and survives watcher closure. */
export function mappingBackend(status: () => Promise<ServeConfig>, processes: LeaseBackend,
  /** Must compare the whole session configuration and remove only that entry using
   * Tailscale's ETag/If-Match update; fail on conflict, never retry with stale state. */
  removeSession: (identity: MappingIdentity) => Promise<void>,
): LeaseBackend {
  const inspect: LeaseBackend["inspect"] = async value => {
    if (!valid(value)) return "unknown";
    const mapping = inspectMappingConfig(value, await status());
    if (mapping === "different" || mapping === "unknown") return mapping;
    const process = await processes.inspect(value.process);
    if (mapping === "gone" && process === "gone") return "gone";
    if (process !== "same") return process === "gone" ? "unknown" : process;
    return "same";
  };
  return {
    inspect,
    reclaim: async value => {
      if (!valid(value) || await inspect(value) !== "same") throw new Error("Mapping ownership changed; preserve it and inspect the lease");
      const fresh = inspectMappingConfig(value, await status());
      if (fresh === "same") await removeSession(value);
      else if (fresh !== "gone") throw new Error("Mapping ownership changed; preserve it and inspect Serve status");
      // A fresh status check precedes stopping the session's nonce-verified process.
      // The adapter must own exactly one foreground watcher and no other mappings.
      if (inspectMappingConfig(value, await status()) !== "gone") throw new Error("Mapping changed during cleanup; preserve it and inspect Serve status");
      const process = await processes.inspect(value.process);
      if (process === "same") await processes.reclaim(value.process);
      else if (process !== "gone") {
        // Closing the session can leave a briefly unreaped watcher. Wait only for
        // verified absence; never signal an unknown/different (possibly reused) PID.
        for (let i = 0; i < 40; i++) {
          await new Promise(resolve => setTimeout(resolve, 25));
          if (await processes.inspect(value.process) === "gone") return;
        }
        throw new Error("Watcher identity changed; preserve it and inspect the lease");
      }
    },
    cleanup: async value => {
      if (!valid(value) || await inspect(value) !== "gone") throw new Error("Mapping disappearance is unconfirmed; retry after checking Serve status");
      await processes.cleanup?.(value.process);
    },
  };
}

/** Transport adapter reserves a gated watcher with a daemon-issued session ID, without
 * publishing a mapping. Activation must use conditional config update, reject occupied
 * ports, and add only this session. Shared/existing mappings are not adopted. */
export interface MappingReservation {
  identity: MappingIdentity;
  activate(): Promise<void>;
  /** Only the unactivated direct child; must not change Serve configuration. */
  abort(): Promise<void>;
}
export async function createManagedMapping(leases: ResourceLeases, input: {
  threadId: string; runId: string;
  reserve(): Promise<MappingReservation>;
}) {
  const reservation = await input.reserve();
  let registered: ResourceLease | undefined;
  try {
    if (!valid(reservation.identity)) throw new Error("Mapping identity is incomplete; retry with a supported Serve adapter");
    const lease = leases.register({ threadId: input.threadId, runId: input.runId, kind: "mapping", key: `serve:${reservation.identity.httpsPort}`, identity: reservation.identity, policy: "thread_cool" });
    registered = lease;
    await reservation.activate();
    return { lease };
  } catch (error) {
    // Re-read ownership through the backend even when POST may have succeeded.
    // Failed/uncertain cleanup remains durable and blocked for a later retry.
    if (registered) await leases.release(registered.id, input.threadId);
    else await reservation.abort();
    throw error;
  }
}
