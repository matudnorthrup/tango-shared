import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendInterstitialLogEntry,
  parseInterstitialStatusCapture,
} from "../src/interstitial-log-capture.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-interstitial-log-"));
  tempDirs.push(dir);
  return dir;
}

function writeDailyNote(vaultRoot: string, date: string, content: string): string {
  const notePath = path.join(vaultRoot, "Planning", "Daily", `${date}.md`);
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, content, "utf8");
  return notePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("interstitial log capture", () => {
  it("captures first-person current activity using the Discord sent timestamp", () => {
    const capture = parseInterstitialStatusCapture({
      message: "I'm walking",
      messageTimestamp: new Date("2026-06-26T00:43:11.223Z"),
      timeZone: "America/Los_Angeles",
    });

    expect(capture).toMatchObject({
      task: "Walking",
      timestampSource: "message-sent",
      localDate: "2026-06-25",
      localTime: "17:43",
    });
    expect(capture?.timestamp.toISOString()).toBe("2026-06-26T00:43:11.223Z");
  });

  it("uses an explicit user-provided time when one is present", () => {
    const capture = parseInterstitialStatusCapture({
      message: "5:15 - I'm eating dinner",
      messageTimestamp: new Date("2026-06-26T00:43:11.223Z"),
      timeZone: "America/Los_Angeles",
    });

    expect(capture).toMatchObject({
      task: "Eating dinner",
      timestampSource: "explicit-user-time",
      localDate: "2026-06-25",
      localTime: "17:15",
    });
  });

  it("does not backdate future planned explicit times", () => {
    const capture = parseInterstitialStatusCapture({
      message: "at 7pm I'm eating dinner",
      messageTimestamp: new Date("2026-06-26T00:43:11.223Z"),
      timeZone: "America/Los_Angeles",
    });

    expect(capture).toBeNull();
  });

  it("ignores questions and meta chatter", () => {
    expect(parseInterstitialStatusCapture({
      message: "Can you check whether I'm walking enough?",
      messageTimestamp: new Date("2026-06-26T00:43:11.223Z"),
      timeZone: "America/Los_Angeles",
    })).toBeNull();
    expect(parseInterstitialStatusCapture({
      message: "I'm wondering whether dinner was captured",
      messageTimestamp: new Date("2026-06-26T00:43:11.223Z"),
      timeZone: "America/Los_Angeles",
    })).toBeNull();
    expect(parseInterstitialStatusCapture({
      message: "I'm going to eat dinner at 7pm",
      messageTimestamp: new Date("2026-06-26T00:43:11.223Z"),
      timeZone: "America/Los_Angeles",
    })).toBeNull();
  });

  it("appends inside the Interstitial Log section without replacing human content", () => {
    const vaultRoot = tempDir();
    const notePath = writeDailyNote(vaultRoot, "2026-06-25", [
      "## Notes",
      "- human note",
      "",
      "## Interstitial Log",
      "<!-- Quick timestamped entries. -->",
      "- 08:00 - Old work",
      "",
      "## Energy Reflection",
      "- still here",
      "",
    ].join("\n"));

    const result = appendInterstitialLogEntry(
      vaultRoot,
      new Date("2026-06-26T00:43:11.223Z"),
      "America/Los_Angeles",
      "Walking",
    );

    expect(result.notePath).toBe(notePath);
    expect(result.line).toBe("- 17:43 - Walking");
    expect(fs.readFileSync(notePath, "utf8")).toBe([
      "## Notes",
      "- human note",
      "",
      "## Interstitial Log",
      "<!-- Quick timestamped entries. -->",
      "- 08:00 - Old work",
      "",
      "- 17:43 - Walking",
      "## Energy Reflection",
      "- still here",
      "",
    ].join("\n"));
  });
});
