import type { OrchestratorContinuityMode } from "@tango/core";

export function resolveWarmStartContinuityMode(input: {
  isOllamaBacked: boolean;
  sessionMode?: OrchestratorContinuityMode;
}): OrchestratorContinuityMode {
  if (input.isOllamaBacked) {
    return "stateless";
  }

  return input.sessionMode ?? "provider";
}
