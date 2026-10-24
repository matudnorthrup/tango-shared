import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSchedule } from "../src/scheduler/executor.js";
import { getPreCheckHandler, registerDeterministicHandler, registerPreCheckHandler } from "../src/scheduler/handlers.js";
import type { ScheduleConfig } from "../src/scheduler/types.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalObsidianVault = process.env.TANGO_OBSIDIAN_VAULT;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalObsidianVault === undefined) {
    delete process.env.TANGO_OBSIDIAN_VAULT;
  } else {
    process.env.TANGO_OBSIDIAN_VAULT = originalObsidianVault;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAgentSchedule(overrides?: Partial<ScheduleConfig>): ScheduleConfig {
  return {
    id: "daily-email-review",
    description: "Run inbox maintenance.",
    enabled: true,
    schedule: {
      cron: "0 16 * * *",
      timezone: "America/Los_Angeles",
    },
    execution: {
      mode: "agent",
      workerId: "personal-assistant",
      deterministicAgentId: "watson",
      task: "Review and maintain the inbox.",
      timeoutSeconds: 30,
      ...overrides?.execution,
    },
    ...overrides,
  };
}

function createTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-scheduler-home-"));
  tempDirs.push(dir);
  const vaultRoot = path.join(dir, "Documents", "main");
  fs.mkdirSync(vaultRoot, { recursive: true });
  // Keep the fixture hermetic when the developer or CI environment exports a
  // real vault path. The scheduler correctly prefers this variable over HOME.
  process.env.TANGO_OBSIDIAN_VAULT = vaultRoot;
  return dir;
}

describe("executeSchedule", () => {
  it("preserves deterministic handler data as run metadata", async () => {
    registerDeterministicHandler("test-deterministic-metadata", async () => ({
      status: "ok",
      summary: "metadata recorded",
      data: { decisionsWritten: 2 },
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        execution: {
          mode: "deterministic",
          handler: "test-deterministic-metadata",
        },
      }),
      {
        store: { getState: () => null } as never,
        db: {} as never,
      },
    );

    expect(result).toMatchObject({
      status: "ok",
      summary: "metadata recorded",
      metadata: { decisionsWritten: 2 },
    });
  });

  it("writes an Obsidian job log after a successful deterministic run when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T11:45:00Z"));
    process.env.HOME = createTempHome();

    registerDeterministicHandler("test-deterministic-obsidian-log", async () => ({
      status: "ok",
      summary: "Kilo ledger monitor checked the configured Kilo account cleanly.",
      data: { checked: true },
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        id: "kilo-ledger-monitor",
        obsidianLog: {
          domain: "Finance",
          jobName: "Kilo Ledger Monitor",
        },
        execution: {
          mode: "deterministic",
          handler: "test-deterministic-obsidian-log",
          timeoutSeconds: 30,
        },
      }),
      {
        store: { getState: () => null } as never,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");

    const logPath = path.join(
      process.env.HOME!,
      "Documents",
      "main",
      "Records",
      "Jobs",
      "Finance",
      "2026-07.md",
    );
    const logText = fs.readFileSync(logPath, "utf8");

    expect(logText).toContain("areas:\n  - \"[[Finance]]\"");
    expect(logText).toContain("## 2026-07-03");
    expect(logText).toContain("Kilo Ledger Monitor");
    expect(logText).toContain("**Status:** Done");
    expect(logText).toContain("**Summary:** Kilo ledger monitor checked the configured Kilo account cleanly.");
    expect(logText).toContain("No flagged items.");
  });

  it("routes migrated explicit-intent agent schedules through executeV2Turn", async () => {
    const executeV2Turn = vi.fn(async () => ({
      text: "v2 schedule turn",
      durationMs: 25,
      model: "claude-sonnet-4-6",
      metadata: { runtime: "v2", deterministicIntentIds: ["email.inbox_maintenance"] },
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        runtime: "v2",
        execution: {
          mode: "agent",
          workerId: "personal-assistant",
          intentIds: ["email.inbox_maintenance"],
          deterministicAgentId: "watson",
          task: "Review and maintain the inbox.",
          timeoutSeconds: 30,
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("v2 schedule turn");
    expect(result.modelUsed).toBe("claude-sonnet-4-6");
    expect(result.metadata).toEqual({ runtime: "v2", deterministicIntentIds: ["email.inbox_maintenance"] });
    expect(executeV2Turn).toHaveBeenCalledOnce();
    expect(executeV2Turn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "watson",
      task: "Review and maintain the inbox.",
    }));
  });

  it("fails closed for agent schedules that have not migrated to runtime=v2", async () => {
    const result = await executeSchedule(
      createAgentSchedule(),
      {
        store: { getState: () => null } as never,
        db: {} as never,
      },
    );

    expect(result.status).toBe("error");
    expect(result.error).toBe(
      "Agent schedule 'daily-email-review' must set runtime: v2; legacy worker execution has been retired.",
    );
  });

  it("routes runtime=v2 agent schedules through executeV2Turn", async () => {
    const executeV2Turn = vi.fn(async () => ({
      text: "fresh v2 runtime run",
      durationMs: 20,
      model: "claude-sonnet-4-6",
      metadata: { runtime: "v2", sessionId: "provider-session-123" },
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        runtime: "v2",
        delivery: {
          agentId: "malibu",
          mode: "message",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("fresh v2 runtime run");
    expect(result.modelUsed).toBe("claude-sonnet-4-6");
    expect(result.metadata).toEqual({ runtime: "v2", sessionId: "provider-session-123" });
    expect(executeV2Turn).toHaveBeenCalledOnce();
    expect(executeV2Turn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "malibu",
      task: "Review and maintain the inbox.",
    }));
  });

  it("routes conditional-agent schedules through v2 only after a proceed pre-check", async () => {
    if (!getPreCheckHandler("test-unreviewed-transactions")) {
      registerPreCheckHandler("test-unreviewed-transactions", async () => ({
        action: "proceed",
        context: {
          startDate: "2026-03-31",
          endDate: "2026-04-02",
          unreviewedCount: 2,
        },
      }));
    }

    const executeV2Turn = vi.fn(async () => ({
      text: "v2 conditional schedule turn",
      durationMs: 25,
      model: "claude-sonnet-4-6",
      metadata: { runtime: "v2", deterministicIntentIds: ["finance.transaction_categorization"] },
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        runtime: "v2",
        execution: {
          mode: "conditional-agent",
          deterministicAgentId: "foxtrot",
          preCheck: { handler: "test-unreviewed-transactions" },
          workerId: "personal-assistant",
          intentIds: ["finance.transaction_categorization"],
          taskTemplate:
            "Found {{unreviewedCount}} unreviewed transactions between {{startDate}} and {{endDate}}.",
          timeoutSeconds: 30,
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("v2 conditional schedule turn");
    expect(result.preCheckResult).toContain("\"action\":\"proceed\"");
    expect(executeV2Turn).toHaveBeenCalledOnce();
    expect(executeV2Turn.mock.calls[0]?.[0].task).toContain("Found 2 unreviewed transactions");
  });

  it("drains conditional-agent batches until the pre-check reports nothing left", async () => {
    // Pre-check reports a shrinking backlog: 3 batches then skip.
    const backlogs = [9, 6, 3];
    let call = 0;
    registerPreCheckHandler("test-drain-shrinking", async () => {
      const remaining = backlogs[call];
      call++;
      if (remaining === undefined) {
        return { action: "skip", reason: "No candidates left." };
      }
      return {
        action: "proceed",
        context: {
          totalRetailerCandidateCount: remaining,
          reimbursementGapCandidateCount: 0,
          retailerCandidateCount: Math.min(remaining, 3),
        },
      };
    });

    const executeV2Turn = vi.fn(async () => ({
      text: "cataloged a batch",
      durationMs: 25,
      model: "claude-sonnet-4-6",
      metadata: {},
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        runtime: "v2",
        execution: {
          mode: "conditional-agent",
          deterministicAgentId: "foxtrot",
          preCheck: { handler: "test-drain-shrinking" },
          workerId: "personal-assistant",
          taskTemplate: "Process {{retailerCandidateCount}} candidates.",
          drainBatches: true,
          timeoutSeconds: 30,
        },
      }),
      { store: { getState: () => null } as never, executeV2Turn, db: {} as never },
    );

    expect(result.status).toBe("ok");
    // 3 proceed batches, then the 4th pre-check returns skip and stops the loop.
    expect(executeV2Turn).toHaveBeenCalledTimes(3);
    expect(result.metadata?.batchesRun).toBe(3);
  });

  it("keeps draining while only invalid-category repairs remain", async () => {
    // No retailer or reimbursement work, just notes to repair: 5, then 2, then none.
    const repairs = [5, 2];
    let call = 0;
    registerPreCheckHandler("test-drain-repairs", async () => {
      const remaining = repairs[call];
      call++;
      if (remaining === undefined) return { action: "skip", reason: "Nothing left." };
      return {
        action: "proceed",
        context: { totalRetailerCandidateCount: 0, reimbursementGapCandidateCount: 0, invalidCategoryNoteCount: remaining },
      };
    });
    const executeV2Turn = vi.fn(async () => ({ text: "repaired notes", durationMs: 25, model: "claude-sonnet-4-6", metadata: {} }));

    const result = await executeSchedule(
      createAgentSchedule({
        runtime: "v2",
        execution: {
          mode: "conditional-agent",
          deterministicAgentId: "foxtrot",
          preCheck: { handler: "test-drain-repairs" },
          workerId: "personal-assistant",
          taskTemplate: "Repair {{invalidCategoryNoteCount}} notes.",
          drainBatches: true,
          timeoutSeconds: 30,
        },
      }),
      { store: { getState: () => null } as never, executeV2Turn, db: {} as never },
    );

    expect(result.status).toBe("ok");
    expect(executeV2Turn).toHaveBeenCalledTimes(2);
  });

  it("keeps draining when a batch turns a receipt into a repair", async () => {
    // Batch 1 clears the receipt but leaves a note to repair; batch 2 repairs it.
    const states = [
      { totalRetailerCandidateCount: 1, invalidCategoryNoteCount: 0 },
      { totalRetailerCandidateCount: 0, invalidCategoryNoteCount: 1 },
    ];
    let call = 0;
    registerPreCheckHandler("test-drain-shift", async () => {
      const state = states[call];
      call++;
      if (!state) return { action: "skip", reason: "Nothing left." };
      return { action: "proceed", context: { ...state, reimbursementGapCandidateCount: 0 } };
    });
    const executeV2Turn = vi.fn(async () => ({ text: "batch", durationMs: 25, model: "claude-sonnet-4-6", metadata: {} }));

    const result = await executeSchedule(
      createAgentSchedule({
        runtime: "v2",
        execution: {
          mode: "conditional-agent",
          deterministicAgentId: "foxtrot",
          preCheck: { handler: "test-drain-shift" },
          workerId: "personal-assistant",
          taskTemplate: "Work.",
          drainBatches: true,
          timeoutSeconds: 30,
        },
      }),
      { store: { getState: () => null } as never, executeV2Turn, db: {} as never },
    );

    expect(result.status).toBe("ok");
    expect(executeV2Turn).toHaveBeenCalledTimes(2);
  });

  it("halts draining when the backlog stops shrinking (stuck candidate)", async () => {
    // Backlog never decreases — a receipt the agent can't clear.
    registerPreCheckHandler("test-drain-stuck", async () => ({
      action: "proceed",
      context: {
        totalRetailerCandidateCount: 4,
        reimbursementGapCandidateCount: 0,
        retailerCandidateCount: 3,
      },
    }));

    const executeV2Turn = vi.fn(async () => ({
      text: "tried a batch",
      durationMs: 25,
      model: "claude-sonnet-4-6",
      metadata: {},
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        runtime: "v2",
        execution: {
          mode: "conditional-agent",
          deterministicAgentId: "foxtrot",
          preCheck: { handler: "test-drain-stuck" },
          workerId: "personal-assistant",
          taskTemplate: "Process {{retailerCandidateCount}} candidates.",
          drainBatches: true,
          drainMaxBatches: 15,
          timeoutSeconds: 30,
        },
      }),
      { store: { getState: () => null } as never, executeV2Turn, db: {} as never },
    );

    expect(result.status).toBe("ok");
    // First batch runs; second pre-check shows no progress, so it stops.
    expect(executeV2Turn).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain("backlog not decreasing");
  });

  it("logs and flags a failed finance pre-check instead of running the worker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:34:00Z"));
    const vaultRoot = path.join(createTempHome(), "vault");
    process.env.TANGO_OBSIDIAN_VAULT = vaultRoot;
    if (!getPreCheckHandler("test-missing-finance-rules")) {
      registerPreCheckHandler("test-missing-finance-rules", async () => {
        throw new Error(
          "Finance automation blocked: unable to read required rules note 'References/Finance/Lunch Money Rules.md' (ENOENT).",
        );
      });
    }
    const executeV2Turn = vi.fn();

    const result = await executeSchedule(
      createAgentSchedule({
        id: "nightly-transaction-categorizer",
        runtime: "v2",
        obsidianLog: {
          domain: "Finance",
          jobName: "Nightly Transaction Categorizer",
        },
        execution: {
          mode: "conditional-agent",
          deterministicAgentId: "foxtrot",
          preCheck: { handler: "test-missing-finance-rules" },
          workerId: "personal-assistant",
          taskTemplate: "Rules: {{categorizationRules}}",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("Finance automation blocked"),
    });
    expect(executeV2Turn).not.toHaveBeenCalled();

    const logText = fs.readFileSync(
      path.join(vaultRoot, "Records", "Jobs", "Finance", "2026-07.md"),
      "utf8",
    );
    expect(logText).toContain("**Status:** Failed");
    expect(logText).toContain("**Flagged:**");
    expect(logText).toContain("unable to read required rules note");
  });

  it("writes an Obsidian job log after a successful agent run when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T12:34:00Z"));
    process.env.HOME = createTempHome();

    const executeV2Turn = vi.fn(async () => ({
      text: "Planned focus blocks for inbox zero and budget review.",
      durationMs: 12,
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        id: "morning-planning",
        runtime: "v2",
        obsidianLog: {
          domain: "Planning",
          jobName: "Morning Planning",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");

    const logPath = path.join(
      process.env.HOME!,
      "Documents",
      "main",
      "Records",
      "Jobs",
      "Planning",
      "2026-04.md",
    );
    const logText = fs.readFileSync(logPath, "utf8");

    expect(logText).toContain("types:\n  - \"[[Record]]\"");
    expect(logText).toContain("areas:\n  - \"[[Personal]]\"");
    expect(logText).toContain("record_kind: job_log");
    expect(logText).toContain("## 2026-04-29");
    expect(logText).toContain("Morning Planning");
    expect(logText).toContain("**Status:** Done");
    expect(logText).toContain("**Summary:** Planned focus blocks for inbox zero and budget review.");
    expect(logText).toContain("No flagged items.");
  });

  it("writes a Flagged section when an Obsidian job summary contains review signals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T14:05:00Z"));
    process.env.HOME = createTempHome();

    const executeV2Turn = vi.fn(async () => ({
      text: [
        "Categorized 1 transaction tonight.",
        "",
        "**Needs your review (2 transactions):**",
        "- Corner Cafe $29.80 - personal, family, or Acme?",
        "- Apple $149.00 - hardware or software?",
      ].join("\n"),
      durationMs: 12,
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        id: "nightly-transaction-categorizer",
        runtime: "v2",
        obsidianLog: {
          domain: "Finance",
          jobName: "Nightly Transaction Categorizer",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");

    const logPath = path.join(
      process.env.HOME!,
      "Documents",
      "main",
      "Records",
      "Jobs",
      "Finance",
      "2026-05.md",
    );
    const logText = fs.readFileSync(logPath, "utf8");

    expect(logText).toContain("**Flagged:**");
    expect(logText).toContain("Needs your review");
    expect(logText).toContain("Corner Cafe");
    expect(logText).not.toContain("No flagged items.");
  });

  it("does not duplicate explicit Flagged sections in Obsidian job logs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T11:45:00Z"));
    process.env.HOME = createTempHome();

    const executeV2Turn = vi.fn(async () => ({
      text: [
        "Kilo ledger monitor checked the configured Kilo account; one item needs review.",
        "",
        "**Flagged:**",
        "- Kilo monthly funding for 2026-07 is due.",
        "",
        "**Snapshot:**",
        "- Ledger total: $0.00",
      ].join("\n"),
      durationMs: 12,
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        id: "kilo-ledger-monitor",
        runtime: "v2",
        obsidianLog: {
          domain: "Finance",
          jobName: "Kilo Ledger Monitor",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");

    const logPath = path.join(
      process.env.HOME!,
      "Documents",
      "main",
      "Records",
      "Jobs",
      "Finance",
      "2026-07.md",
    );
    const logText = fs.readFileSync(logPath, "utf8");
    expect(logText.match(/\*\*Flagged:\*\*/gu)).toHaveLength(1);
    expect(logText).toContain("**Summary:** Kilo ledger monitor checked the configured Kilo account; one item needs review.");
    expect(logText).toContain("**Snapshot:**");
  });

  it("preserves long explicit Flagged sections for daily brief aggregation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T22:37:00-07:00"));
    process.env.HOME = createTempHome();

    const candidates = Array.from({ length: 12 }, (_, index) => {
      const id = String(index + 1).padStart(2, "0");
      return `- [ ] USUP-2026-06-20-${id}: Unsubscribe from Newsletter ${id} on personal@example.test -- recurring low-value promotional email with enough detail to make this line realistic.`;
    });
    const executeV2Turn = vi.fn(async () => ({
      text: [
        "Scanned both Gmail accounts; 12 unsubscribe candidates identified.",
        "",
        "**Flagged:**",
        ...candidates,
        "",
        "**Notes:**",
        "- The flagged list should be preserved for the daily brief.",
      ].join("\n"),
      durationMs: 12,
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        id: "nightly-email-unsubscribe-review",
        runtime: "v2",
        obsidianLog: {
          domain: "Email",
          jobName: "Email Unsubscribe Review",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");

    const logPath = path.join(
      process.env.HOME!,
      "Documents",
      "main",
      "Records",
      "Jobs",
      "Email",
      "2026-06.md",
    );
    const logText = fs.readFileSync(logPath, "utf8");
    expect(logText).toContain("USUP-2026-06-20-01");
    expect(logText).toContain("USUP-2026-06-20-12: Unsubscribe from Newsletter 12");
    expect(logText).toContain("Newsletter 12 on personal@example.test -- recurring low-value promotional email with enough detail to make this line realistic.");
    expect(logText).not.toContain("Newsletter 07 on personal@example.test -- recurring low-value promotional email with enough detail to make this line realistic...");
  });

  it("repairs existing Obsidian job logs that predate frontmatter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    process.env.HOME = createTempHome();

    const logPath = path.join(
      process.env.HOME!,
      "Documents",
      "main",
      "Records",
      "Jobs",
      "Finance",
      "2026-06.md",
    );
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "# Finance Job Log — June 2026\n\n## Existing Entry\n", "utf8");

    const executeV2Turn = vi.fn(async () => ({
      text: "Receipt cataloger completed cleanly.",
      durationMs: 12,
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        id: "receipt-cataloger",
        runtime: "v2",
        obsidianLog: {
          domain: "Finance",
          jobName: "Receipt Cataloger",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");

    const logText = fs.readFileSync(logPath, "utf8");
    expect(logText).toMatch(/^---\ndate: 2026-06-01/mu);
    expect(logText).toContain("areas:\n  - \"[[Finance]]\"");
    expect(logText).toContain("record_kind: job_log");
    expect(logText).toContain("# Finance Job Log — June 2026");
    expect(logText).toContain("## Existing Entry");
    expect(logText).toContain("## 2026-06-03");
  });

  it("normalizes leading whitespace before existing Obsidian job log frontmatter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T12:00:00Z"));
    process.env.HOME = createTempHome();

    const logPath = path.join(
      process.env.HOME!,
      "Documents",
      "main",
      "Records",
      "Jobs",
      "Slack",
      "2026-06.md",
    );
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      "\n---\ndate: 2026-06-01\ntypes:\n  - \"[[Record]]\"\nareas:\n  - \"[[Acme]]\"\n---\n\n# Slack Jobs\n",
      "utf8",
    );

    const executeV2Turn = vi.fn(async () => ({
      text: "Slack saved review completed.",
      durationMs: 12,
    }));

    await executeSchedule(
      createAgentSchedule({
        id: "slack-saved-review",
        runtime: "v2",
        obsidianLog: {
          domain: "Slack",
          jobName: "Slack Saved Items Review",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    const logText = fs.readFileSync(logPath, "utf8");
    expect(logText.startsWith("---\n")).toBe(true);
    expect(logText).toContain("Slack saved review completed.");
  });

  it("keeps successful runs green when Obsidian log writing fails", async () => {
    process.env.HOME = createTempHome();

    const executeV2Turn = vi.fn(async () => ({ text: "v2 runtime run", durationMs: 12 }));
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await executeSchedule(
      createAgentSchedule({
        runtime: "v2",
        obsidianLog: {
          domain: "Email",
          jobName: "Daily Email Review",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("v2 runtime run");
    expect(consoleError).toHaveBeenCalledWith(
      "[scheduler] obsidian-log error for daily-email-review:",
      expect.any(Error),
    );
  });
});
