// Resolve an agent's PRODUCTION system prompt for `systemFromAgent` fixtures.
//
// Uses the same loaders as the v2 runtime (packages/discord/src/v2-runtime.ts):
// layered v2 agent config (repo defaults + active profile overlay), soul/rules/
// knowledge assembly, and per-agent profile prompt overlays. The assembled
// prompt may contain private profile context, so it only ever lands in the
// private results file under ~/.tango/evals/results — never in committed
// fixtures or verdict summaries.

import { resolve } from "node:path";

export async function resolveAgentSystemPrompt(agentId, repoRoot) {
  const core = await import(resolve(repoRoot, "packages/core/dist/index.js"));
  const configs = core.loadLayeredV2AgentConfigs(resolve(repoRoot, "config/v2/agents"));
  const config = configs.get(agentId);
  if (!config) throw new Error(`systemFromAgent: no v2 agent config for '${agentId}'`);
  return core.assembleV2SystemPrompt(config, {
    repoRoot,
    overlayDirs: core.resolveTangoProfileAgentPromptDirs(agentId),
  });
}
