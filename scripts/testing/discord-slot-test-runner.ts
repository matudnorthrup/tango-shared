import {
  applySlotOverlay,
  closeHarnessContext,
  createHarnessContext,
  findActiveSlotSmokeThread,
  formatHarnessTarget,
  getResolvedDbPath,
  resolveExplicitHarnessTarget,
  runHarnessTurn,
} from "./discord-test-harness-lib.js";
import { loadUnifiedAgentConfigs, resolveConfigDir } from "@tango/core";

interface SlotTestCase {
  name: string;
  agentId?: string;
  channelId?: string;
  content: string;
  timeoutMs: number;
  expectReply: boolean;
  responsePattern?: RegExp;
}

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function printHelp(): void {
  console.log(`Usage:
  node --import tsx ./scripts/testing/discord-slot-test-runner.ts --slot <1|2|3> [--timeout 45] [--cleanup]

This runner resolves the current slot's active smoke-test threads, sends a few
Discord webhook probes, waits for Tango replies, and verifies a negative allowlist
probe against a smoke-test parent channel that should not answer in slot mode.
`);
}

function requireSlot(): string {
  const slot = getArg("--slot") ?? process.argv[2] ?? "";
  if (!/^[123]$/.test(slot)) {
    throw new Error("Pass --slot <1|2|3>.");
  }
  return slot;
}

function loadSmokeParentChannelId(agentId: string): string {
  const config = loadUnifiedAgentConfigs(resolveConfigDir()).find((candidate) => candidate.id === agentId);
  const channelId = config?.voice?.smokeTestChannelId?.trim() || "";
  if (!/^\d+$/.test(channelId)) {
    throw new Error(`Agent '${agentId}' does not have a configured smoke-test parent channel.`);
  }
  return channelId;
}

function buildPositiveCases(timeoutMs: number): SlotTestCase[] {
  return [
    {
      name: "watson basic reply",
      agentId: "watson",
      content: "What time is it in Los Angeles? Reply in one sentence.",
      timeoutMs,
      expectReply: true,
    },
    {
      name: "malibu push-day routing",
      agentId: "malibu",
      content: "What exercises do I do on push day? Reply briefly.",
      timeoutMs,
      expectReply: true,
      responsePattern: /\b(push|exercise|press|chest|shoulder|tricep)s?\b/i,
    },
    {
      name: "sierra basic reply",
      agentId: "sierra",
      content: "Summarize what you can help with in one sentence.",
      timeoutMs,
      expectReply: true,
    },
  ];
}

function buildNegativeCase(timeoutMs: number): SlotTestCase {
  return {
    name: "parent-channel allowlist block",
    channelId: loadSmokeParentChannelId("watson"),
    content: "Negative allowlist probe. Slot mode should not reply here.",
    timeoutMs: Math.min(timeoutMs, 12_000),
    expectReply: false,
  };
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    printHelp();
    return;
  }

  const slot = requireSlot();
  applySlotOverlay(slot);
  const timeoutSeconds = Number.parseInt(getArg("--timeout") ?? "45", 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`Invalid --timeout '${getArg("--timeout") ?? ""}'. Expected a positive integer.`);
  }
  const timeoutMs = timeoutSeconds * 1000;
  const cleanup = !hasFlag("--no-cleanup");

  const context = await createHarnessContext();
  const failures: string[] = [];

  try {
    console.log(`[slot-tests] slot=${slot} db=${getResolvedDbPath()}`);

    for (const testCase of buildPositiveCases(timeoutMs)) {
      const target = await findActiveSlotSmokeThread(context.client, {
        agentId: testCase.agentId!,
        slot,
      });
      console.log(`[slot-tests] case=${testCase.name} target=${formatHarnessTarget(target)}`);

      const result = await runHarnessTurn({
        context,
        target,
        content: testCase.content,
        waitForResponse: true,
        timeoutMs: testCase.timeoutMs,
        cleanup,
      });

      if (!result.receivedResponse || !result.responseText?.trim()) {
        failures.push(`${testCase.name}: timed out waiting for a Tango reply`);
        console.log(`[slot-tests] FAIL case=${testCase.name} reason=timeout`);
        continue;
      }

      if (testCase.responsePattern && !testCase.responsePattern.test(result.responseText)) {
        failures.push(
          `${testCase.name}: reply did not match ${testCase.responsePattern} -> ${JSON.stringify(result.responseText)}`,
        );
        console.log(`[slot-tests] FAIL case=${testCase.name} reason=pattern`);
        continue;
      }

      console.log(
        `[slot-tests] PASS case=${testCase.name} reply=${JSON.stringify(result.responseText.slice(0, 180))}`,
      );
    }

    const negativeCase = buildNegativeCase(timeoutMs);
    const negativeTarget = await resolveExplicitHarnessTarget(context.client, negativeCase.channelId!);
    console.log(`[slot-tests] case=${negativeCase.name} target=${formatHarnessTarget(negativeTarget)}`);

    const negativeResult = await runHarnessTurn({
      context,
      target: negativeTarget,
      content: negativeCase.content,
      waitForResponse: true,
      timeoutMs: negativeCase.timeoutMs,
      cleanup,
    });
    if (negativeResult.receivedResponse) {
      failures.push(
        `${negativeCase.name}: expected no reply, but received ${JSON.stringify(negativeResult.responseText ?? "")}`,
      );
      console.log(`[slot-tests] FAIL case=${negativeCase.name} reason=unexpected-reply`);
    } else {
      console.log(`[slot-tests] PASS case=${negativeCase.name} reply=none`);
    }
  } finally {
    await closeHarnessContext(context);
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }

  console.log("[slot-tests] all slot Discord harness checks passed");
}

void main().catch((error) => {
  console.error(`[slot-tests] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
