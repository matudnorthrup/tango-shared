// Live check: a real Tango agent's runtime config, through LoomRuntimeAdapter, on a scratch Loom.
import { loadLayeredV2AgentConfigs, resolveConfigDir } from "@tango/core";
import { LoomRuntimeAdapter } from "@tango/core";
import { buildV2RuntimeConfigs } from "../packages/discord/src/v2-runtime.ts";
const agent = process.argv[2] ?? "charlie";
const configs = buildV2RuntimeConfigs(loadLayeredV2AgentConfigs(resolveConfigDir()));
const config = configs.get(agent);
if (!config) throw new Error(`no config for ${agent}; have ${[...configs.keys()].join(",")}`);
console.log("agent", agent, "model", config.runtimePreferences.model, "mcp", config.mcpServers.map((s) => s.name).join(","), "isolated", !!config.isolated, "prompt chars", config.systemPrompt.length);
const sessions = new Map<string, any>();
const store = {
  getProviderSession: (k: string, p: string) => sessions.get(k + p),
  upsertProviderSession: (r: any) => sessions.set(r.conversationKey + r.providerName, r),
  clearProviderSession: (k: string, p: string) => sessions.delete(k + p),
  upsertSession: () => {},
} as any;
const adapter = new LoomRuntimeAdapter({ conversationKey: "live-test:p4", store, port: Number(process.env.SCRATCH_PORT), tokenFile: process.env.SCRATCH_HOME + "/token" });
await adapter.initialize(config);
const events: string[] = [];
const r1 = await adapter.send("In one sentence: who are you, and what do you help with? Then use exactly one of your MCP tools that only reads (a lookup or search; nothing that writes or sends) and name the tool you used.", { onEvent: (e: any) => events.push(e.name ?? e.type), timeout: 300_000 });
console.log("REPLY 1:", r1.text.slice(0, 400));
console.log("tools used:", r1.toolsUsed, "| activity events:", events.length, "| thread", adapter.getSessionId());
// A new adapter instance (as after a bot restart) resumes the same Loom thread.
const again = new LoomRuntimeAdapter({ conversationKey: "live-test:p4", store, port: Number(process.env.SCRATCH_PORT), tokenFile: process.env.SCRATCH_HOME + "/token" });
await again.initialize(config);
const r2 = await again.send("What did I ask you in my previous message? One short sentence.", { timeout: 300_000 });
console.log("REPLY 2:", r2.text.slice(0, 300), "| same thread:", again.getSessionId() === adapter.getSessionId());
