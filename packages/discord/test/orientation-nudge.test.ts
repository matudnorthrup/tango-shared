import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TangoStorage } from "@tango/core";
import {
  OrientationNudgeStore,
  appendLineToSection,
  createOrientationNudgeHandler,
  evaluateOrientationNudge,
  findBlockingCalendarEvent,
  handleOrientationNudgeInteraction,
  parseDailyNote,
  readDailyNoteObservation,
  resolveOrientationNudgeConfig,
} from "../src/orientation-nudge.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix = "tango-orientation-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createStorage(): { storage: TangoStorage; store: OrientationNudgeStore } {
  const dir = tempDir();
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"), { seedExampleRoster: true });
  return {
    storage,
    store: new OrientationNudgeStore(storage.getDatabase()),
  };
}

function writeDailyNote(vaultRoot: string, date: string, body: string): string {
  const notePath = path.join(vaultRoot, "Planning", "Daily", `${date}.md`);
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, body, "utf8");
  return notePath;
}

describe("orientation nudge config", () => {
  it("keeps defaults when live handler options are explicitly undefined", () => {
    const previousTimeZone = process.env.ORIENTATION_NUDGE_TIME_ZONE;
    const previousVaultRoot = process.env.ORIENTATION_NUDGE_VAULT_ROOT;
    try {
      delete process.env.ORIENTATION_NUDGE_TIME_ZONE;
      delete process.env.ORIENTATION_NUDGE_VAULT_ROOT;

      const config = resolveOrientationNudgeConfig({
        timeZone: undefined,
        vaultRoot: undefined,
      });

      expect(config.timeZone).toBe("America/Los_Angeles");
      expect(config.vaultRoot).toBe(path.join(os.homedir(), "Documents", "main"));
    } finally {
      if (previousTimeZone === undefined) {
        delete process.env.ORIENTATION_NUDGE_TIME_ZONE;
      } else {
        process.env.ORIENTATION_NUDGE_TIME_ZONE = previousTimeZone;
      }
      if (previousVaultRoot === undefined) {
        delete process.env.ORIENTATION_NUDGE_VAULT_ROOT;
      } else {
        process.env.ORIENTATION_NUDGE_VAULT_ROOT = previousVaultRoot;
      }
    }
  });
});

describe("orientation nudge daily-note parsing", () => {
  it("uses the first top-level unchecked task rotation item and latest interstitial entry", () => {
    const parsed = parseDailyNote([
      "## Current Task Rotation",
      "- [x] Done thing",
      "- [ ] Current thing",
      "  - [ ] Nested thing ignored",
      "- [ ] Later thing",
      "",
      "## Interstitial Log",
      "- 07:15 - early task",
      "- [09:45] later task",
      "",
    ].join("\n"), "2026-06-25");

    expect(parsed.currentTask).toBe("Current thing");
    expect(parsed.rotationItems).toEqual([
      { checked: true, text: "Done thing" },
      { checked: false, text: "Current thing" },
      { checked: false, text: "Later thing" },
    ]);
    expect(parsed.latestInterstitial?.text).toBe("later task");
  });

  it("skips blocked rotation items when picking the current task", () => {
    const parsed = parseDailyNote([
      "## Current Task Rotation",
      "- [x] Done thing",
      "- [ ] 🚧 Stuck thing — blocked: waiting on a collaborator",
      "- [ ] Current thing",
      "",
    ].join("\n"), "2026-06-25");

    expect(parsed.currentTask).toBe("Current thing");
    // Blocked items still appear in the rotation, they just aren't nudged.
    expect(parsed.rotationItems).toHaveLength(3);
  });

  it("reports no current task when every unchecked rotation item is blocked", () => {
    const parsed = parseDailyNote([
      "## Current Task Rotation",
      "- [x] Done thing",
      "- [ ] 🚧 Stuck thing — blocked: waiting on a collaborator",
      "",
    ].join("\n"), "2026-06-25");

    expect(parsed.currentTask).toBeNull();
  });

  it("appends interstitial lines without replacing human-owned section content", () => {
    const before = [
      "## Notes",
      "- keep this",
      "",
      "## Interstitial Log",
      "<!-- format note -->",
      "- 08:00 - old",
      "",
      "## Energy Reflection",
      "- later",
      "",
    ].join("\n");

    const after = appendLineToSection(before, "Interstitial Log", "- 09:00 - new");
    expect(after).toContain("<!-- format note -->\n- 08:00 - old\n\n- 09:00 - new\n## Energy Reflection");
    expect(after).toContain("## Notes\n- keep this");
  });
});

describe("orientation nudge trigger decisions", () => {
  it("sends after stale note activity during active hours", () => {
    const { storage, store } = createStorage();
    try {
      const config = resolveOrientationNudgeConfig();
      const now = new Date("2026-06-25T17:30:00.000Z");
      const stale = new Date("2026-06-25T15:00:00.000Z");
      store.recordInterstitialActivity(config.userId, stale, "old task");
      const state = store.getState(config.userId, now);
      const decision = evaluateOrientationNudge({
        state,
        now,
        config,
        calendarBlocker: null,
        observation: {
          notePath: "/tmp/note.md",
          noteFound: true,
          date: "2026-06-25",
          currentTask: "Ship feature",
          latestInterstitial: null,
          rotationItems: [{ checked: false, text: "Ship feature" }],
          rotationSignature: " :Ship feature",
        },
      });
      // Rotation contents never name the nudge task; with no interstitial entry
      // we don't know what he's doing, so the nudge asks instead of guessing.
      expect(decision).toEqual({ action: "send", task: null });
    } finally {
      storage.close();
    }
  });

  it("takes the nudge task from the interstitial log, not the rotation", () => {
    const { storage, store } = createStorage();
    try {
      const config = resolveOrientationNudgeConfig();
      const now = new Date("2026-06-25T17:30:00.000Z");
      const stale = new Date("2026-06-25T15:00:00.000Z");
      store.recordInterstitialActivity(config.userId, stale, "Task rotation");
      const decision = evaluateOrientationNudge({
        state: store.getState(config.userId, now),
        now,
        config,
        calendarBlocker: null,
        observation: {
          notePath: "/tmp/note.md",
          noteFound: true,
          date: "2026-06-25",
          currentTask: "Ship feature",
          latestInterstitial: { at: stale, text: "Task rotation" },
          rotationItems: [{ checked: false, text: "Ship feature" }],
          rotationSignature: " :Ship feature",
        },
      });
      expect(decision).toEqual({ action: "send", task: "Task rotation" });
    } finally {
      storage.close();
    }
  });

  it("skips for focus mode, vacation mode, calendar events, and recent note activity", () => {
    const { storage, store } = createStorage();
    try {
      const config = resolveOrientationNudgeConfig();
      const now = new Date("2026-06-25T17:30:00.000Z");
      const observation = {
        notePath: "/tmp/note.md",
        noteFound: true,
        date: "2026-06-25",
        currentTask: null,
        latestInterstitial: null,
        rotationItems: [],
        rotationSignature: null,
      };

      store.recordInterstitialActivity(config.userId, new Date("2026-06-25T17:00:00.000Z"), "recent");
      expect(evaluateOrientationNudge({
        state: store.getState(config.userId, now),
        now,
        config,
        calendarBlocker: null,
        observation,
      })).toMatchObject({ action: "skip", reason: "recent daily note activity" });

      store.setFocusMode(config.userId, "deep work", new Date("2026-06-25T19:00:00.000Z"), now, "test");
      expect(evaluateOrientationNudge({
        state: store.getState(config.userId, now),
        now,
        config,
        calendarBlocker: null,
        observation,
      })).toMatchObject({ action: "skip", reason: "focus mode active" });
      store.clearFocusMode(config.userId, now, "test");

      store.setVacationMode(config.userId, new Date("2026-06-30T19:00:00.000Z"), now, "test");
      expect(evaluateOrientationNudge({
        state: store.getState(config.userId, now),
        now,
        config,
        calendarBlocker: null,
        observation,
      })).toMatchObject({ action: "skip", reason: "vacation mode active" });
      store.clearVacationMode(config.userId, now, "test");

      expect(evaluateOrientationNudge({
        state: store.getState(config.userId, now),
        now,
        config,
        calendarBlocker: {
          title: "Meeting",
          startsAt: "2026-06-25T17:00:00.000Z",
          endsAt: "2026-06-25T18:00:00.000Z",
        },
        observation,
      })).toMatchObject({ action: "skip", reason: "calendar event: Meeting" });
    } finally {
      storage.close();
    }
  });

  it("doubles cooldown after the first two missed nudges", () => {
    const { storage, store } = createStorage();
    try {
      const config = resolveOrientationNudgeConfig();
      const firstSentAt = new Date("2026-06-25T17:00:00.000Z");
      const firstDueAt = new Date("2026-06-25T17:31:00.000Z");
      const secondSentAt = new Date("2026-06-25T18:00:00.000Z");
      const secondDueAt = new Date("2026-06-25T18:31:00.000Z");
      const thirdSentAt = new Date("2026-06-25T19:00:00.000Z");
      const thirdDueAt = new Date("2026-06-25T19:31:00.000Z");

      store.recordNudgeSent({
        userId: config.userId,
        nudgeId: "nudge-1",
        messageId: "msg-1",
        channelId: "chan-1",
        task: "task",
        now: firstSentAt,
      });
      expect(store.markActiveNudgeIgnoredIfDue(config.userId, firstDueAt, config).state.cooldownUntil).toBeNull();

      store.recordNudgeSent({
        userId: config.userId,
        nudgeId: "nudge-2",
        messageId: "msg-2",
        channelId: "chan-1",
        task: "task",
        now: secondSentAt,
      });
      expect(store.markActiveNudgeIgnoredIfDue(config.userId, secondDueAt, config).state.cooldownUntil).toBeNull();

      store.recordNudgeSent({
        userId: config.userId,
        nudgeId: "nudge-3",
        messageId: "msg-3",
        channelId: "chan-1",
        task: "task",
        now: thirdSentAt,
      });
      const state = store.markActiveNudgeIgnoredIfDue(config.userId, thirdDueAt, config).state;
      expect(state.unansweredNudgeCount).toBe(3);
      expect(state.cooldownUntil).toBe("2026-06-25T20:01:00.000Z");
    } finally {
      storage.close();
    }
  });
});

describe("orientation nudge calendar blocking", () => {
  it("blocks timed events but ignores all-day events and Block placeholders", () => {
    const now = new Date("2026-06-25T17:30:00.000Z");
    expect(findBlockingCalendarEvent([
      {
        summary: "Busy all day",
        start: { date: "2026-06-25" },
        end: { date: "2026-06-26" },
      },
    ], now)).toBeNull();

    expect(findBlockingCalendarEvent([
      {
        summary: "Tentative focus block",
        start: { dateTime: "2026-06-25T17:00:00.000Z" },
        end: { dateTime: "2026-06-25T18:00:00.000Z" },
      },
    ], now)).toMatchObject({ title: "Tentative focus block" });

    expect(findBlockingCalendarEvent([
      {
        summary: "  Block: Collaboration",
        start: { dateTime: "2026-06-25T17:00:00.000Z" },
        end: { dateTime: "2026-06-25T18:00:00.000Z" },
      },
      {
        summary: "block: Morning focus work",
        start: { dateTime: "2026-06-25T17:00:00.000Z" },
        end: { dateTime: "2026-06-25T18:00:00.000Z" },
      },
    ], now)).toBeNull();

    expect(findBlockingCalendarEvent([
      {
        summary: "Block: Collaboration",
        start: { dateTime: "2026-06-25T17:00:00.000Z" },
        end: { dateTime: "2026-06-25T18:00:00.000Z" },
      },
      {
        summary: "Doctor appointment",
        start: { dateTime: "2026-06-25T17:15:00.000Z" },
        end: { dateTime: "2026-06-25T18:15:00.000Z" },
      },
    ], now)).toMatchObject({ title: "Doctor appointment" });
  });
});

describe("orientation nudge Discord flow", () => {
  it("sends a Discord message with four nudge buttons", async () => {
    const { storage } = createStorage();
    try {
      const vaultRoot = tempDir("tango-orientation-vault-");
      writeDailyNote(vaultRoot, "2026-06-25", [
        "## Today's Priorities",
        "- [ ] Something",
        "",
        "## Interstitial Log",
        "-",
        "",
      ].join("\n"));
      const sentPayloads: Array<{ content: string; components: unknown[] }> = [];
      const fakeClient = {
        isReady: () => true,
        channels: {
          fetch: async () => ({
            isTextBased: () => true,
            send: async (payload: { content: string; components: unknown[] }) => {
              sentPayloads.push(payload);
              return { id: "msg-1" };
            },
          }),
        },
      };
      const handler = createOrientationNudgeHandler(fakeClient as never, {
        channelId: "chan-1",
        vaultRoot,
        now: () => new Date("2026-06-25T17:30:00.000Z"),
        fetchCalendarBlocker: async () => null,
      });

      const result = await handler({
        scheduleId: "orientation-nudge",
        db: storage.getDatabase(),
      });

      expect(result.status).toBe("ok");
      expect(sentPayloads).toHaveLength(1);
      const row = sentPayloads[0]!.components[0] as { toJSON: () => { components: Array<{ custom_id: string }> } };
      const ids = row.toJSON().components.map((component) => component.custom_id);
      expect(ids).toHaveLength(4);
      expect(ids.every((id) => id.startsWith("orientation:"))).toBe(true);
    } finally {
      storage.close();
    }
  });

  it("handles Yes buttons and No modals against the active nudge only", async () => {
    const { storage, store } = createStorage();
    try {
      const now = new Date("2026-06-25T17:30:00.000Z");
      const config = resolveOrientationNudgeConfig();
      store.recordNudgeSent({
        userId: config.userId,
        nudgeId: "nudge-yes",
        messageId: "msg-yes",
        channelId: "chan",
        task: "Task rotation: Ship it",
        now,
      });

      let updated: unknown = null;
      const yesInteraction = {
        isButton: () => true,
        isModalSubmit: () => false,
        customId: "orientation:yes:nudge-yes",
        update: async (payload: unknown) => { updated = payload; },
        reply: async () => undefined,
      };

      await handleOrientationNudgeInteraction(yesInteraction as never, {
        db: storage.getDatabase(),
        now: () => now,
      });
      expect(updated).toMatchObject({ components: [] });
      expect(store.getState(config.userId, now).activeNudgeId).toBeNull();

      const vaultRoot = tempDir("tango-orientation-vault-");
      writeDailyNote(vaultRoot, "2026-06-25", [
        "## Interstitial Log",
        "- 08:00 - old",
        "",
      ].join("\n"));
      store.recordNudgeSent({
        userId: config.userId,
        nudgeId: "nudge-no",
        messageId: "msg-no",
        channelId: "chan",
        task: "Old task",
        now,
      });

      const replies: unknown[] = [];
      const modalInteraction = {
        isButton: () => false,
        isModalSubmit: () => true,
        customId: "orientation:modal:no:nudge-no",
        fields: { getTextInputValue: () => "New work" },
        reply: async (payload: unknown) => { replies.push(payload); },
        message: { edit: async () => undefined },
      };

      await handleOrientationNudgeInteraction(modalInteraction as never, {
        db: storage.getDatabase(),
        vaultRoot,
        now: () => now,
      });
      expect(replies[0]).toMatchObject({ ephemeral: true });
      const note = fs.readFileSync(path.join(vaultRoot, "Planning", "Daily", "2026-06-25.md"), "utf8");
      expect(note).toContain("New work");
      expect(store.getState(config.userId, now).lastInterstitialLogAt).toBe(now.toISOString());
    } finally {
      storage.close();
    }
  });
});
