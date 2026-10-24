import { z } from "zod";
import { loadLayeredConfigFile } from "./config-layering.js";

/**
 * The system's own voice: the name and avatar on system messages, the call
 * sign that addresses the system in voice ("Tango, focus Sierra"), and the
 * agent that answers when nobody in particular was addressed. It is not an
 * agent and never runs a turn.
 */
export interface SystemIdentity {
  displayName: string;
  callSigns: string[];
  defaultPromptAgent: string;
}

export const DEFAULT_SYSTEM_IDENTITY: SystemIdentity = {
  displayName: "Tango",
  callSigns: ["Tango"],
  defaultPromptAgent: "watson",
};

const systemFileSchema = z.object({
  display_name: z.string().optional(),
  voice: z.object({
    call_signs: z.array(z.string()).optional(),
    default_prompt_agent: z.string().optional(),
  }).optional(),
}).passthrough();

/** Load `system.yaml` from the config layers (repo defaults, then profile). */
export function loadSystemIdentity(configDir?: string): SystemIdentity {
  const raw = loadLayeredConfigFile("system.yaml", configDir);
  if (!raw) return { ...DEFAULT_SYSTEM_IDENTITY, callSigns: [...DEFAULT_SYSTEM_IDENTITY.callSigns] };

  const parsed = systemFileSchema.parse(raw);
  const callSigns = (parsed.voice?.call_signs ?? DEFAULT_SYSTEM_IDENTITY.callSigns)
    .map((sign) => sign.trim())
    .filter(Boolean);
  return {
    displayName: parsed.display_name?.trim() || DEFAULT_SYSTEM_IDENTITY.displayName,
    callSigns,
    defaultPromptAgent:
      parsed.voice?.default_prompt_agent?.trim() || DEFAULT_SYSTEM_IDENTITY.defaultPromptAgent,
  };
}
