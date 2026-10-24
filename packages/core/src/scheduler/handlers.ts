/**
 * Scheduler Handlers — Registry for deterministic and pre-check handler functions.
 *
 * Handlers are registered during Tango boot (main.ts). The scheduler references
 * them by name from YAML config files.
 */

import type {
  DeterministicHandler,
  PreCheckHandler,
} from "./types.js";

const deterministicHandlers = new Map<string, DeterministicHandler>();
const preCheckHandlers = new Map<string, PreCheckHandler>();

export function registerDeterministicHandler(name: string, handler: DeterministicHandler): void {
  if (deterministicHandlers.has(name)) {
    throw new Error(`Deterministic handler '${name}' is already registered`);
  }
  deterministicHandlers.set(name, handler);
}

export function registerPreCheckHandler(name: string, handler: PreCheckHandler): void {
  if (preCheckHandlers.has(name)) {
    throw new Error(`Pre-check handler '${name}' is already registered`);
  }
  preCheckHandlers.set(name, handler);
}

export function getDeterministicHandler(name: string): DeterministicHandler | undefined {
  return deterministicHandlers.get(name);
}

export function getPreCheckHandler(name: string): PreCheckHandler | undefined {
  return preCheckHandlers.get(name);
}

export function listRegisteredHandlers(): {
  deterministic: string[];
  preCheck: string[];
} {
  return {
    deterministic: [...deterministicHandlers.keys()],
    preCheck: [...preCheckHandlers.keys()],
  };
}
