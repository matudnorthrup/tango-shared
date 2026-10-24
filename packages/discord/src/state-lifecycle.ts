import type { StateService } from "@tango/core";
import type { StateHealthAutoExportAdapter, HealthAutoExportSyncReport } from "./state-health-adapter.js";
import type { StateObsidianAdapter, StateObsidianScanReport } from "./state-obsidian-adapter.js";
import type { StateMemorySupersessionReport } from "./state-memory-supersession.js";
import type { StateProjectionReport, StateProjectionRunner } from "./state-projection.js";

export interface StateCheckInRequest {
  entityId: string;
  title: string;
  typeId: string;
  agentId: string;
  prompt: string;
}

export interface StateLifecycleReport {
  sweep: ReturnType<StateService["sweep"]>;
  obsidian?: StateObsidianScanReport;
  health?: HealthAutoExportSyncReport;
  supersession?: StateMemorySupersessionReport;
  projections?: StateProjectionReport;
  checkIns: { due: number; prompted: number; failed: number };
}

export class StateLifecycleRunner {
  constructor(private readonly options: {
    service: StateService;
    obsidian?: Pick<StateObsidianAdapter, "scan">;
    health?: Pick<StateHealthAutoExportAdapter, "sync">;
    runSupersession?: () => Promise<StateMemorySupersessionReport>;
    projections?: Pick<StateProjectionRunner, "run">;
    promptCheckIn?: (request: StateCheckInRequest) => Promise<void>;
  }) {}

  async run(): Promise<StateLifecycleReport> {
    const sweep = this.options.service.sweep();
    const [obsidian, health, supersession] = await Promise.all([
      this.options.obsidian?.scan(),
      this.options.health?.sync(),
      this.options.runSupersession?.(),
    ]);
    // Render after adapters finish so projections consume their latest heads.
    const projections = this.options.projections?.run();
    const due = this.options.service.listDueCheckIns();
    let prompted = 0;
    let failed = 0;
    for (const item of due) {
      if (!this.options.promptCheckIn) break;
      try {
        await this.options.promptCheckIn({
          entityId: item.entity.id,
          title: item.entity.title,
          typeId: item.type.id,
          agentId: item.agentId,
          prompt: item.prompt,
        });
        this.options.service.markCheckInPrompted(item.entity.id, {
          actor: "schedule:state-sweep",
          source: "schedule:state-sweep",
          includePrivate: true,
        });
        prompted += 1;
      } catch (error) {
        this.options.service.openIssue(item.entity.id, "check_in_failed", error instanceof Error ? error.message : String(error));
        failed += 1;
      }
    }
    return {
      sweep,
      ...(obsidian ? { obsidian } : {}),
      ...(health ? { health } : {}),
      ...(supersession ? { supersession } : {}),
      ...(projections ? { projections } : {}),
      checkIns: { due: due.length, prompted, failed },
    };
  }
}
