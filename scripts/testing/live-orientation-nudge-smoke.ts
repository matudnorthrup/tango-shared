import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TangoStorage } from "@tango/core";
import {
  applySlotOverlay,
  closeHarnessContext,
  createHarnessContext,
  formatHarnessTarget,
  parseOptionalSlotFlag,
  resolveAgentHarnessTarget,
} from "./discord-test-harness-lib.js";
import {
  OrientationNudgeStore,
  createOrientationNudgeHandler,
  readDailyNoteObservation,
  resolveOrientationNudgeConfig,
} from "../../packages/discord/src/orientation-nudge.js";

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function localDateString(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function writeSmokeDailyNote(vaultRoot: string, now: Date, timeZone: string): void {
  const date = localDateString(now, timeZone);
  const notePath = path.join(vaultRoot, "Planning", "Daily", `${date}.md`);
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, [
    "---",
    `date: ${date}`,
    "---",
    "",
    "## Today's Priorities",
    "- [ ] Smoke validation",
    "",
    "## Current Task Rotation",
    "- [ ] Validate orientation nudge smoke",
    "",
    "## Interstitial Log",
    "-",
    "",
  ].join("\n"), "utf8");
}

async function main(): Promise<void> {
  const slot = parseOptionalSlotFlag();
  applySlotOverlay(slot);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-orientation-live-"));
  const dbPath = path.join(tempRoot, "tango.sqlite");
  const vaultRoot = path.join(tempRoot, "vault");
  process.env.TANGO_DB_PATH = dbPath;

  const timeZone = "America/Los_Angeles";
  const now = new Date();
  writeSmokeDailyNote(vaultRoot, now, timeZone);

  const context = await createHarnessContext();
  const smokeStorage = new TangoStorage(dbPath);
  const config = resolveOrientationNudgeConfig({ vaultRoot, timeZone });
  const smokeStore = new OrientationNudgeStore(smokeStorage.getDatabase());
  smokeStore.recordNoteObservation(
    config.userId,
    readDailyNoteObservation(now, config),
    new Date(now.getTime() - 2 * 60 * 60_000),
  );
  let sentMessageId: string | null = null;
  try {
    const target = await resolveAgentHarnessTarget(context.client, {
      agentId: getArg("--agent") ?? "watson",
      slot,
      explicitThreadName: getArg("--thread-name") ?? "codex-orientation-nudge-smoke",
    });

    const handler = createOrientationNudgeHandler(context.client, {
      channelId: target.channelId,
      vaultRoot,
      timeZone,
      now: () => now,
      fetchCalendarBlocker: async () => null,
      recordNudgeMessage(input) {
        sentMessageId = input.messageId;
      },
    });

    const result = await handler({
      scheduleId: "orientation-nudge",
      db: smokeStorage.getDatabase(),
    });
    if (result.status !== "ok") {
      throw new Error(`Expected ok result, got ${result.status}: ${result.summary ?? ""}`);
    }
    if (!sentMessageId) {
      throw new Error("Handler did not record a sent Discord message id.");
    }

    const message = await target.channel.messages.fetch(sentMessageId);
    const rows = message.components;
    const buttons = rows.flatMap((row) => row.components);
    const customIds = buttons
      .map((component) => "customId" in component ? component.customId : null)
      .filter((value): value is string => Boolean(value));

    if (customIds.length !== 4 || customIds.some((id) => !id.startsWith("orientation:"))) {
      throw new Error(`Unexpected orientation button payload: ${JSON.stringify(customIds)}`);
    }

    if (!hasFlag("--keep-message")) {
      await message.delete().catch(() => undefined);
    }

    console.log(JSON.stringify({
      ok: true,
      target: formatHarnessTarget(target),
      messageId: sentMessageId,
      customIds,
      keptMessage: hasFlag("--keep-message"),
    }, null, 2));
  } finally {
    smokeStorage.close();
    await closeHarnessContext(context);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(`[orientation-nudge-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
