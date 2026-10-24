import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDailyNote,
  getMorningFlowDate,
  runMorningFlowSentinel,
} from "../src/morning-flow.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-morning-flow-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "_Schema", "Templates"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "_Schema", "Templates", "Daily Notes Template.md"),
    [
      "---",
      "date: {{date:YYYY-MM-DD}}",
      "types:",
      "  - \"[[Daily Note]]\"",
      "areas:",
      "  - \"[[Personal]]\"",
      "week: \"[[{{date:YYYY [Week] w [Plan]}}]]\"",
      "quarterly: \"[[{{date:YYYY [Q]Q [Plan]}}]]\"",
      "brief: \"[[Records/Briefs/{{date:YYYY-MM-DD}}]]\"",
      "---",
      "",
      "## Today's Priorities",
      "- [ ]",
      "",
    ].join("\n"),
    "utf8",
  );
  return dir;
}

function createScheduleDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec([
    "CREATE TABLE schedule_runs (",
    "id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "schedule_id TEXT NOT NULL,",
    "started_at TEXT NOT NULL,",
    "finished_at TEXT,",
    "status TEXT NOT NULL,",
    "error TEXT,",
    "summary TEXT",
    ")",
  ].join(" "));
  return db;
}

describe("morning flow deterministic helpers", () => {
  it("computes the local daily-note date and week plan", () => {
    const flowDate = getMorningFlowDate(
      new Date("2026-05-25T12:01:00.000Z"),
      "America/Los_Angeles",
    );

    expect(flowDate).toMatchObject({
      date: "2026-05-25",
      month: "2026-05",
      displayDate: "Mon May 25",
      weekPlan: "2026 Week 22 Plan",
      quarterPlan: "2026 Q2 Plan",
    });
  });

  it("creates today's daily note from the template with the brief link", () => {
    const vaultRoot = createVault();

    const result = ensureDailyNote({
      vaultRoot,
      now: new Date("2026-05-25T12:01:00.000Z"),
    });

    expect(result.createdNote).toBe(true);
    expect(result.updatedNote).toBe(true);
    expect(result.notePath).toBe(path.join(vaultRoot, "Planning", "Daily", "2026-05-25.md"));

    const note = fs.readFileSync(result.notePath, "utf8");
    expect(note).toContain("date: 2026-05-25");
    expect(note).toContain("week: \"[[2026 Week 22 Plan]]\"");
    expect(note).toContain("quarterly: \"[[2026 Q2 Plan]]\"");
    expect(note).toContain("brief: \"[[Records/Briefs/2026-05-25]]\"");
    expect(note).toContain("## Interstitial Log");
  });

  it("carries unchecked task rotation items forward into a new daily note", () => {
    const vaultRoot = createVault();
    const priorPath = path.join(vaultRoot, "Planning", "Daily", "2026-05-23.md");
    fs.mkdirSync(path.dirname(priorPath), { recursive: true });
    fs.writeFileSync(
      priorPath,
      [
        "---",
        "date: 2026-05-23",
        "---",
        "",
        "## Current Task Rotation",
        "- [ ] Blog post outline",
        "- [x] Review pull request",
        "- [ ] Feedback form filtering",
        "- [ ]",
        "",
        "## Today's Priorities",
        "- [ ] Something else entirely",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = ensureDailyNote({
      vaultRoot,
      now: new Date("2026-05-25T12:01:00.000Z"),
    });

    expect(result.createdNote).toBe(true);
    expect(result.carriedRotation).toEqual([
      "Blog post outline",
      "Review pull request",
      "Feedback form filtering",
    ]);

    const note = fs.readFileSync(result.notePath, "utf8");
    expect(note).toContain("- [ ] Blog post outline");
    expect(note).toContain("- [ ] Feedback form filtering");
    // Checked means "nudged this pass", not done — it carries forward with its state.
    expect(note).toContain("- [x] Review pull request");
    expect(note).not.toContain("Something else entirely");
    expect(note).toContain("## Today's Priorities");
    expect(note).toContain("## Interstitial Log");
  });

  it("sorts blocked rotation items to the bottom when carrying forward", () => {
    const vaultRoot = createVault();
    const priorPath = path.join(vaultRoot, "Planning", "Daily", "2026-05-23.md");
    fs.mkdirSync(path.dirname(priorPath), { recursive: true });
    fs.writeFileSync(
      priorPath,
      [
        "---",
        "date: 2026-05-23",
        "---",
        "",
        "## Current Task Rotation",
        "- [ ] 🚧 Refine discovery controls — blocked: waiting on a collaborator",
        "- [ ] Blog post outline",
        "- [x] 🚧 Review financial report — blocked: needs the integration fixed",
        "- [x] Review pull request",
        "",
        "## Today's Priorities",
        "- [ ]",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = ensureDailyNote({
      vaultRoot,
      now: new Date("2026-05-25T12:01:00.000Z"),
    });

    expect(result.carriedRotation).toEqual([
      "Blog post outline",
      "Review pull request",
      "🚧 Refine discovery controls — blocked: waiting on a collaborator",
      "🚧 Review financial report — blocked: needs the integration fixed",
    ]);

    const note = fs.readFileSync(result.notePath, "utf8");
    // Checkbox state survives the re-sort.
    expect(note).toContain("- [x] 🚧 Review financial report — blocked: needs the integration fixed");
    expect(note).toContain("- [ ] 🚧 Refine discovery controls — blocked: waiting on a collaborator");
  });

  it("repairs an existing daily note missing the brief frontmatter and expected sections", () => {
    const vaultRoot = createVault();
    const notePath = path.join(vaultRoot, "Planning", "Daily", "2026-05-25.md");
    fs.mkdirSync(path.dirname(notePath), { recursive: true });
    fs.writeFileSync(notePath, "---\ndate: 2026-05-25\n---\n\n## Notes\n-\n", "utf8");

    const result = ensureDailyNote({
      vaultRoot,
      now: new Date("2026-05-25T12:01:00.000Z"),
    });

    expect(result.createdNote).toBe(false);
    expect(result.updatedNote).toBe(true);
    expect(result.addedFrontmatterFields).toEqual(["brief", "rotation_carried"]);
    expect(result.addedSections).toContain("Today's Priorities");
    expect(result.addedSections).toContain("Interstitial Log");

    const note = fs.readFileSync(notePath, "utf8");
    expect(note).toContain("brief: \"[[Records/Briefs/2026-05-25]]\"");
    expect(note).toContain("## Today's Priorities");
    expect(note).toContain("## Interstitial Log");
  });

  it("creates a fallback brief when the morning brief artifact is missing", () => {
    const vaultRoot = createVault();
    const db = createScheduleDb();
    db.prepare(
      "INSERT INTO schedule_runs (schedule_id, started_at, finished_at, status, error, summary) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "daily-brief",
      "2026-05-25T12:00:01.000Z",
      "2026-05-25T12:00:05.000Z",
      "error",
      "Claude Code exited with code 1. No stderr output.",
      null,
    );

    const result = runMorningFlowSentinel({
      vaultRoot,
      db,
      now: new Date("2026-05-25T12:25:00.000Z"),
    });

    expect(result.createdFallbackBrief).toBe(true);
    expect(result.issues.some((issue) => issue.includes("Morning brief file is missing"))).toBe(true);
    expect(result.issues.some((issue) => issue.includes("daily-brief failed"))).toBe(true);

    const brief = fs.readFileSync(result.briefPath, "utf8");
    expect(brief).toContain("generated_by: morning-flow-sentinel");
    expect(brief).toContain("Claude Code exited with code 1");
    expect(brief).toContain("## Overnight Jobs");
  });

  it("repairs an existing brief and annotates pipeline failures", () => {
    const vaultRoot = createVault();
    const briefPath = path.join(vaultRoot, "Records", "Briefs", "2026-05-25.md");
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(
      briefPath,
      [
        "---",
        "date: 2026-05-25",
        "type: morning-brief",
        "---",
        "",
        "# Morning Brief -- Mon May 25",
        "",
        "## Overnight Jobs",
        "- daily-brief -- ok",
        "",
      ].join("\n"),
      "utf8",
    );

    const db = createScheduleDb();
    db.prepare(
      "INSERT INTO schedule_runs (schedule_id, started_at, finished_at, status, error, summary) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "daily-email-review",
      "2026-05-25T11:30:00.000Z",
      "2026-05-25T11:30:02.000Z",
      "error",
      "Claude Code exited with code 1. No stderr output.",
      null,
    );

    const result = runMorningFlowSentinel({
      vaultRoot,
      db,
      now: new Date("2026-05-25T12:25:00.000Z"),
    });

    expect(result.createdFallbackBrief).toBe(false);
    expect(result.updatedBrief).toBe(true);
    expect(result.addedBriefFrontmatterFields).toEqual(["types", "areas"]);
    expect(result.updatedBriefWarnings).toBe(true);

    const brief = fs.readFileSync(briefPath, "utf8");
    expect(brief).toContain("types:\n  - \"[[Brief]]\"");
    expect(brief).toContain("areas:\n  - \"[[Personal]]\"");
    expect(brief).toContain("## Pipeline Warnings");
    expect(brief).toContain("daily-email-review failed");
    expect(brief).toContain("## Overnight Jobs");
  });

  it("uses the input registry to decide which schedules are critical", () => {
    const vaultRoot = createVault();
    ensureDailyNote({
      vaultRoot,
      now: new Date("2026-05-25T12:01:00.000Z"),
    });

    const briefPath = path.join(vaultRoot, "Records", "Briefs", "2026-05-25.md");
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(
      briefPath,
      [
        "---",
        "date: 2026-05-25",
        "types:",
        "  - \"[[Brief]]\"",
        "areas:",
        "  - \"[[Personal]]\"",
        "---",
        "",
        "# Morning Brief -- Mon May 25",
        "",
      ].join("\n"),
      "utf8",
    );

    const registryPath = path.join(vaultRoot, "daily-brief-inputs.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        inputs: [
          {
            scheduleId: "daily-email-review",
            domain: "Email",
            logPath: "Records/Jobs/Email/YYYY-MM.md",
            critical: true,
          },
          {
            scheduleId: "slack-saved-review",
            domain: "Slack",
            logPath: "Records/Jobs/Slack/YYYY-MM.md",
            critical: false,
          },
        ],
      }),
      "utf8",
    );

    const result = runMorningFlowSentinel({
      vaultRoot,
      db: createScheduleDb(),
      inputRegistryPath: registryPath,
      now: new Date("2026-05-25T12:25:00.000Z"),
    });

    expect(result.issues).toEqual(["daily-email-review has no run in the last 24 hours."]);
  });

  it("flags morning planning success when it used the wrong date and left the note blank", () => {
    const vaultRoot = createVault();
    ensureDailyNote({
      vaultRoot,
      now: new Date("2026-05-25T12:01:00.000Z"),
    });

    const briefPath = path.join(vaultRoot, "Records", "Briefs", "2026-05-25.md");
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(
      briefPath,
      [
        "---",
        "date: 2026-05-25",
        "types:",
        "  - \"[[Brief]]\"",
        "areas:",
        "  - \"[[Personal]]\"",
        "---",
        "",
        "# Morning Brief -- Mon May 25",
        "",
        "## Flagged (1)",
        "- Review a time-sensitive item.",
        "",
      ].join("\n"),
      "utf8",
    );

    const registryPath = path.join(vaultRoot, "daily-brief-inputs.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        inputs: [
          {
            scheduleId: "morning-planning",
            domain: "Planning",
            logPath: "Records/Jobs/Planning/YYYY-MM.md",
            critical: true,
          },
        ],
      }),
      "utf8",
    );

    const db = createScheduleDb();
    db.prepare(
      "INSERT INTO schedule_runs (schedule_id, started_at, finished_at, status, error, summary) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "morning-planning",
      "2026-05-25T12:15:00.000Z",
      "2026-05-25T12:16:00.000Z",
      "ok",
      null,
      "**Morning Planning Complete — Thu Apr 30**\n\nDaily note updated.",
    );

    const result = runMorningFlowSentinel({
      vaultRoot,
      db,
      inputRegistryPath: registryPath,
      now: new Date("2026-05-25T12:25:00.000Z"),
    });

    expect(result.issues).toContain("morning-planning reported Thu Apr 30 instead of Mon May 25.");
    expect(result.issues).toContain("morning-planning left generated daily-note planning sections blank for 2026-05-25.");
    expect(result.updatedBriefWarnings).toBe(true);
  });
});
