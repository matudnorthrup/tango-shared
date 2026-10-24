import type { AgentConfig } from "./types.js";

export class AgentRegistry {
  private readonly agents = new Map<string, AgentConfig>();

  constructor(agents: AgentConfig[]) {
    for (const agent of agents) {
      this.agents.set(agent.id, agent);
    }
  }

  get(agentId: string): AgentConfig | undefined {
    return this.agents.get(agentId);
  }

  list(): AgentConfig[] {
    return [...this.agents.values()];
  }
}
