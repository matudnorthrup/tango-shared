/**
 * V2 → Legacy AgentConfig Bridge
 *
 * Generates legacy AgentConfig objects from V2AgentConfig so that the
 * agentRegistry and all its consumers (access control, voice routing,
 * tool policy, capability registry, etc.) can be populated from v2
 * configs alone.
 */

import fs from "node:fs";
import path from "node:path";
import { expandHomePath } from "./runtime-paths.js";
import { assembleAgentPrompt } from "./system-prompt.js";
import type { AgentConfig } from "./types.js";
import type { V2AgentConfig } from "./v2-config-loader.js";
import { isV2AgentEnabled, loadLayeredV2AgentConfigs } from "./v2-config-loader.js";
import { loadAgentConfigs } from "./config.js";

function resolveV2PromptFile(
  systemPromptFile: string,
  repoRoot?: string,
): string {
  const expanded = expandHomePath(systemPromptFile.trim());
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  const root = repoRoot ?? process.cwd();
  return path.resolve(root, expanded);
}

function resolveV2Prompt(
  agentId: string,
  systemPromptFile: string,
  repoRoot?: string,
): { prompt?: string; promptFile?: string } {
  const resolvedFile = resolveV2PromptFile(systemPromptFile, repoRoot);

  if (!fs.existsSync(resolvedFile)) {
    console.warn(
      `[v2-legacy-bridge] Agent '${agentId}' system_prompt_file not found: ${resolvedFile}`,
    );
    return { prompt: undefined, promptFile: undefined };
  }

  if (path.basename(resolvedFile) === "soul.md") {
    return {
      prompt: assembleAgentPrompt(path.dirname(resolvedFile)),
      promptFile: resolvedFile,
    };
  }

  return {
    prompt: fs.readFileSync(resolvedFile, "utf8"),
    promptFile: resolvedFile,
  };
}

export function v2ToLegacyAgentConfig(
  v2: V2AgentConfig,
  options: { repoRoot?: string } = {},
): AgentConfig {
  const { prompt, promptFile } = resolveV2Prompt(
    v2.id,
    v2.systemPromptFile,
    options.repoRoot,
  );

  // Build the legacy provider block. Prefer explicit legacyProvider if set,
  // otherwise synthesize from v2 runtime fields.
  const provider = v2.legacyProvider ?? {
    default: "claude-oauth",
    model: v2.runtime.model,
    reasoningEffort: v2.runtime.reasoningEffort,
    fallback: v2.runtime.fallback ? [v2.runtime.fallback] : undefined,
  };

  return {
    id: v2.id,
    type: v2.type,
    displayName: v2.displayName,
    avatarURL: v2.avatarURL,
    avatarPath: v2.avatarPath,
    provider,
    prompt,
    promptFile,
    defaultTopic: v2.defaultTopic,
    defaultProject: v2.defaultProject,
    voice: v2.voice
      ? {
          callSigns: v2.voice.callSigns,
          defaultPromptAgent: v2.voice.defaultPromptAgent,
          kokoroVoice: v2.voice.kokoroVoice,
          defaultChannelId: v2.voice.defaultChannelId,
          smokeTestChannelId: v2.voice.smokeTestChannelId,
        }
      : undefined,
    discord: v2.discord.typingTokenEnv
      ? {
          typingTokenEnv: v2.discord.typingTokenEnv,
        }
      : undefined,
    responseMode: v2.responseMode,
    access: v2.access
      ? {
          mode: v2.access.mode,
          allowlistChannelIds: v2.access.allowlistChannelIds,
          allowlistUserIds: v2.access.allowlistUserIds,
        }
      : undefined,
    tools: v2.tools
      ? {
          mode: v2.tools.mode,
          allowlist: v2.tools.allowlist,
          permissionMode: v2.tools.permissionMode,
        }
      : undefined,
    orchestration: v2.orchestration
      ? {
          workerIds: v2.orchestration.workerIds,
          writeConfirmation: v2.orchestration.writeConfirmation,
        }
      : undefined,
    deterministicRouting: v2.deterministicRouting
      ? {
          enabled: v2.deterministicRouting.enabled,
          projectScope: v2.deterministicRouting.projectScope,
          additionalDomains: v2.deterministicRouting.additionalDomains,
          confidenceThreshold: v2.deterministicRouting.confidenceThreshold,
          provider: v2.deterministicRouting.provider,
        }
      : undefined,
  };
}

/**
 * Load agent configs with unified v2 + legacy support.
 *
 * Strategy: v2 configs are authoritative for every agent that has a v2 file.
 * The legacy loader is retained only for legacy-only system agents such as
 * dispatch until they get first-class v2 configs.
 */
export function loadUnifiedAgentConfigs(
  configDir: string,
  options: { repoRoot?: string } = {},
): AgentConfig[] {
  const v2Configs = loadLayeredV2AgentConfigs(configDir);
  const v2Ids = new Set(v2Configs.keys());
  const v2AgentConfigs = [...v2Configs.values()]
    .filter(isV2AgentEnabled)
    .map((v2Config) => v2ToLegacyAgentConfig(v2Config, options));
  const legacyOnlyConfigs = loadAgentConfigs(configDir).filter((config) => !v2Ids.has(config.id));

  return [...legacyOnlyConfigs, ...v2AgentConfigs];
}
