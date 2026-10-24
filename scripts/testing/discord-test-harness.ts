import {
  applySlotOverlay,
  closeHarnessContext,
  createHarnessContext,
  formatHarnessTarget,
  parseOptionalSlotFlag,
  resolveAgentHarnessTarget,
  resolveExplicitHarnessTarget,
  runHarnessTurn,
} from "./discord-test-harness-lib.js";

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
  node --import tsx ./scripts/testing/discord-test-harness.ts --thread <thread-id> --message "What time is it?" [--wait-response] [--timeout 30] [--cleanup]
  node --import tsx ./scripts/testing/discord-test-harness.ts --channel <channel-id> --message "Probe" [--wait-response]
  node --import tsx ./scripts/testing/discord-test-harness.ts --agent <agent-id> [--slot 1|2|3] --message "Probe"

Options:
  --thread <id>         Send into an explicit Discord thread.
  --channel <id>        Send into an explicit Discord text channel.
  --agent <id>          Resolve a smoke thread for an agent. With --slot, use the active slot thread.
  --slot <1|2|3>        Apply the slot profile overlay before reading the DB and resolving slot threads.
  --message <text>      Message content to send through the harness webhook.
  --wait-response       Wait for a Tango reply and print the reply text to stdout.
  --wait-state-receipt  Wait for a later Discord follow-up beginning with “⟢ state:”.
  --timeout <seconds>   Response timeout in seconds. Default: 30.
  --cleanup             Delete the harness input message and captured reply after verification.
  --thread-name <name>  When resolving --agent without --slot, create or reuse this smoke thread name.
  --user <name>         Webhook username for the synthetic test user. Default: Tango Test Harness.
  --json                Print structured JSON instead of plain text.
  --help                Show this help text.
`);
}

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    printHelp();
    return;
  }

  const slot = parseOptionalSlotFlag();
  applySlotOverlay(slot);

  const message = getArg("--message");
  if (!message?.trim()) {
    throw new Error("Pass --message \"...\".");
  }

  const timeoutSeconds = Number.parseInt(getArg("--timeout") ?? "30", 10);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`Invalid --timeout '${getArg("--timeout") ?? ""}'. Expected a positive integer.`);
  }

  const explicitThreadId = getArg("--thread");
  const explicitChannelId = getArg("--channel");
  const agentId = getArg("--agent");
  if (!explicitThreadId && !explicitChannelId && !agentId) {
    throw new Error("Pass one of --thread <id>, --channel <id>, or --agent <agent-id>.");
  }

  const context = await createHarnessContext();
  try {
    const target = explicitThreadId
      ? await resolveExplicitHarnessTarget(context.client, explicitThreadId)
      : explicitChannelId
        ? await resolveExplicitHarnessTarget(context.client, explicitChannelId)
        : await resolveAgentHarnessTarget(context.client, {
            agentId: agentId!,
            slot,
            explicitThreadName: getArg("--thread-name"),
          });

    const result = await runHarnessTurn({
      context,
      target,
      content: message,
      username: getArg("--user"),
      waitForResponse: hasFlag("--wait-response"),
      followUpPrefix: hasFlag("--wait-state-receipt") ? "⟢ state:" : undefined,
      timeoutMs: timeoutSeconds * 1000,
      cleanup: hasFlag("--cleanup"),
    });

    if (hasFlag("--json")) {
      console.log(JSON.stringify({
        ...result,
        target: formatHarnessTarget(target),
        dbPath: context.dbPath,
      }, null, 2));
      if ((hasFlag("--wait-response")) && !result.receivedResponse) {
        process.exitCode = 1;
      }
      if (hasFlag("--wait-state-receipt") && !result.receivedFollowUp) {
        process.exitCode = 1;
      }
      return;
    }

    if (!hasFlag("--wait-response") && !hasFlag("--wait-state-receipt")) {
      console.log(result.sentMessageId);
      return;
    }

    if (hasFlag("--wait-response") && (!result.receivedResponse || !result.responseText)) {
      throw new Error(
        `Timed out waiting for a Tango response in ${timeoutSeconds}s on ${formatHarnessTarget(target)}.`,
      );
    }

    if (hasFlag("--wait-state-receipt") && (!result.receivedFollowUp || !result.followUpText)) {
      throw new Error(
        `Timed out waiting for a state receipt in ${timeoutSeconds}s on ${formatHarnessTarget(target)}.`,
      );
    }

    if (result.responseText) console.log(result.responseText);
    if (result.followUpText) console.log(result.followUpText);
  } finally {
    await closeHarnessContext(context);
  }
}

void main().catch((error) => {
  console.error(`[discord-test-harness] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
