import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDailyBriefAggregation } from "../src/daily-brief-aggregator.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-daily-brief-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "_Schema", "Templates"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "_Schema", "Templates", "Daily Notes Template.md"),
    [
      "---",
      "date: {{date:YYYY-MM-DD}}",
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

function writeRegistry(vaultRoot: string): string {
  const registryPath = path.join(vaultRoot, "daily-brief-inputs.json");
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      lookbackHours: 24,
      inputs: [
        {
          scheduleId: "daily-email-review",
          displayName: "Daily Email Review",
          domain: "Email",
          logPath: "Records/Jobs/Email/YYYY-MM.md",
          critical: true,
          sections: ["flagged", "overnightJobs"],
        },
        {
          scheduleId: "nightly-email-unsubscribe-review",
          displayName: "Email Unsubscribe Review",
          domain: "Email",
          logPath: "Records/Jobs/Email/YYYY-MM.md",
          critical: true,
          sections: ["flagged", "overnightJobs"],
        },
        {
          scheduleId: "slack-saved-review",
          displayName: "Slack Saved Items Review",
          domain: "Slack",
          logPath: "Records/Jobs/Slack/YYYY-MM.md",
          critical: true,
          sections: ["items", "overnightJobs"],
        },
        {
          scheduleId: "vault-daily-check",
          displayName: "Vault Audit",
          domain: "Vault",
          logPath: "Records/Jobs/Vault/YYYY-MM.md",
          critical: true,
          sections: ["flagged", "overnightJobs"],
        },
        {
          scheduleId: "morning-planning",
          displayName: "Morning Planning",
          domain: "Planning",
          logPath: "Records/Jobs/Planning/YYYY-MM.md",
          critical: true,
          sections: ["overnightJobs"],
        },
      ],
    }),
    "utf8",
  );
  return registryPath;
}

function writeJobLog(vaultRoot: string, relativePath: string, text: string): void {
  const filePath = path.join(vaultRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

describe("daily brief aggregation", () => {
  it("writes a registry-driven brief from recent domain logs", () => {
    const vaultRoot = createVault();
    const registryPath = writeRegistry(vaultRoot);
    writeJobLog(
      vaultRoot,
      "Records/Jobs/Email/2026-05.md",
      [
        "# Email Jobs",
        "",
        "## 2026-05-24 04:30 -- Daily Email Review",
        "**Status:** Done",
        "**Summary:** Stale summary",
        "",
        "### Flagged",
        "- This should be outside the 24 hour window.",
        "",
        "## 2026-05-25 04:30 -- Daily Email Review",
        "**Status:** Done",
        "**Summary:** Inbox scanned.",
        "",
        "### Flagged -- Needs Attention",
        "**1. Domain renewal**",
        "Renewal warning needs review.",
        "",
        "**Flagged:**",
        "- Review needed: generic rollup should be ignored when specific items exist.",
        "",
        "## 2026-05-25 03:40 -- Email Unsubscribe Review",
        "**Status:** Done -- 1 candidate flagged",
        "**Summary:** Scanned all accessible Gmail accounts; one unsubscribe candidate needs confirmation.",
        "",
        "**Flagged:**",
        "- [ ] USUB-2026-05-25-01: Unsubscribe from Promo Blast on personal@example.test -- frequent sales emails with no action value.",
        "",
      ].join("\n"),
    );
    writeJobLog(
      vaultRoot,
      "Records/Jobs/Slack/2026-05.md",
      [
        "# Slack Jobs",
        "",
        "## 2026-05-25 04:45 -- Slack Saved Items Review",
        "**Status:** Done -- 1 item found",
        "**Summary:** Saved item logged.",
        "",
        "**Items:**",
        "- [ ] [Review this thread](https://slack.example/p123) -- #product",
        "",
      ].join("\n"),
    );
    writeJobLog(
      vaultRoot,
      "Records/Jobs/Vault/2026-05.md",
      [
        "# Vault Jobs",
        "",
        "## 2026-05-25 04:55 -- Vault Audit",
        "**Status:** Done -- 1 new flagged item(s)",
        "**Summary:** Vault audit found 1 new flagged item.",
        "",
        "**Flagged:**",
        "- [ ] Review missing frontmatter in `Records/Briefs/2026-05-24.md`",
        "",
        "**Known Review:**",
        "1 known review item remains; not flagged for daily planning unless it changes.",
        "- This should not be promoted into the brief.",
        "",
      ].join("\n"),
    );

    const result = runDailyBriefAggregation({
      vaultRoot,
      inputRegistryPath: registryPath,
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchCalendarEvents: () => [
        { timeLabel: "9:00am", title: "Standup", sortKey: "2026-05-25T16:00:00.000Z" },
      ],
    });

    expect(result).toMatchObject({
      entriesFound: 4,
      flaggedCount: 3,
      slackItemCount: 1,
      overnightJobCount: 4,
      calendarEventCount: 1,
    });

    const brief = fs.readFileSync(result.briefPath, "utf8");
    expect(brief).toContain("generated_by: daily-brief-aggregate");
    expect(brief).toContain("## Flagged (3)");
    expect(brief).toContain("**Daily Email Review:** Domain renewal");
    expect(brief).toContain("**Email Unsubscribe Review:** USUB-2026-05-25-01");
    expect(brief).not.toContain("generic rollup should be ignored");
    expect(brief).toContain("**Vault Audit:** Review missing frontmatter");
    expect(brief).toContain("[Review this thread](https://slack.example/p123) -- #product");
    expect(brief).toContain("- Daily Email Review -- Done: Inbox scanned.");
    expect(brief).toContain("- Email Unsubscribe Review -- Done -- 1 candidate flagged: Scanned all accessible Gmail accounts; one unsubscribe candidate needs confirmation.");
    expect(brief).toContain("- 9:00am -- Standup");
    expect(brief).not.toContain("This should be outside the 24 hour window");
    expect(brief).not.toContain("This should not be promoted");
  });

  it("omits Slack Saved Items when the recent Slack entry has no items", () => {
    const vaultRoot = createVault();
    const registryPath = writeRegistry(vaultRoot);
    writeJobLog(
      vaultRoot,
      "Records/Jobs/Slack/2026-05.md",
      [
        "# Slack Jobs",
        "",
        "## 2026-05-25 04:45 -- Slack Saved Items Review",
        "**Status:** Done -- 0 items found",
        "**Summary:** No saved messages.",
        "",
        "No flagged items.",
        "",
      ].join("\n"),
    );

    const result = runDailyBriefAggregation({
      vaultRoot,
      inputRegistryPath: registryPath,
      now: new Date("2026-05-25T12:00:00.000Z"),
      fetchCalendarEvents: () => [],
    });

    const brief = fs.readFileSync(result.briefPath, "utf8");
    expect(result.slackItemCount).toBe(0);
    expect(brief).not.toContain("## Slack Saved Items");
    expect(brief).toContain("- Slack Saved Items Review -- Done -- 0 items found: No saved messages.");
  });

  it("surfaces Kilo ledger monitor flags from the Finance job log", () => {
    const vaultRoot = createVault();
    const registryPath = path.join(vaultRoot, "daily-brief-inputs.json");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        lookbackHours: 24,
        inputs: [
          {
            scheduleId: "kilo-ledger-monitor",
            displayName: "Kilo Ledger Monitor",
            domain: "Finance",
            logPath: "Records/Jobs/Finance/YYYY-MM.md",
            critical: true,
            sections: ["flagged", "overnightJobs"],
          },
        ],
      }),
      "utf8",
    );
    writeJobLog(
      vaultRoot,
      "Records/Jobs/Finance/2026-07.md",
      [
        "# Finance Jobs",
        "",
        "## 2026-07-04 04:45 -- Kilo Ledger Monitor",
        "**Status:** Done",
        "**Summary:** Kilo ledger monitor checked the configured Kilo account; one item needs review.",
        "",
        "**Flagged:**",
        "- Kilo monthly funding for 2026-07 is due, but no posted $80.00 transfer was found.",
        "",
      ].join("\n"),
    );

    const result = runDailyBriefAggregation({
      vaultRoot,
      inputRegistryPath: registryPath,
      now: new Date("2026-07-04T12:00:00.000Z"),
      fetchCalendarEvents: () => [],
    });

    expect(result.flaggedCount).toBe(1);
    const brief = fs.readFileSync(result.briefPath, "utf8");
    expect(brief).toContain("**Kilo Ledger Monitor:** Kilo monthly funding for 2026-07 is due");
    expect(brief).toContain("- Kilo Ledger Monitor -- Done: Kilo ledger monitor checked the configured Kilo account; one item needs review.");
  });

  it("fetches and renders all calendar events without a max-results cap", () => {
    const vaultRoot = createVault();
    const registryPath = writeRegistry(vaultRoot);
    const binDir = path.join(vaultRoot, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeGogPath = path.join(binDir, "gog");
    fs.writeFileSync(
      fakeGogPath,
      [
        "#!/usr/bin/env bash",
        "saw_all_pages=0",
        "for arg in \"$@\"; do",
        "  if [ \"$arg\" = \"--max\" ]; then",
        "    echo 'unexpected --max calendar cap' >&2",
        "    exit 2",
        "  fi",
        "  if [ \"$arg\" = \"--all-pages\" ]; then",
        "    saw_all_pages=1",
        "  fi",
        "done",
        "if [ \"$saw_all_pages\" -ne 1 ]; then",
        "  echo 'expected --all-pages' >&2",
        "  exit 3",
        "fi",
        "cat <<'JSON'",
        JSON.stringify({
          events: Array.from({ length: 6 }, (_, index) => ({
            summary: `Event ${index + 1}`,
            start: { dateTime: `2026-05-25T${String(8 + index).padStart(2, "0")}:00:00-07:00` },
          })),
        }),
        "JSON",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(fakeGogPath, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      const result = runDailyBriefAggregation({
        vaultRoot,
        inputRegistryPath: registryPath,
        now: new Date("2026-05-25T12:00:00.000Z"),
      });

      expect(result.calendarEventCount).toBe(6);
      const brief = fs.readFileSync(result.briefPath, "utf8");
      expect(brief).toContain("**Today:** 6 calendar events");
      expect(brief).toContain("- 1:00pm -- Event 6");
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
