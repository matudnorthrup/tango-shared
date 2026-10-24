import { describe, it, expect } from "vitest";
import { buildTurnBriefingPrompt } from "../src/turn-briefing.js";

describe("buildTurnBriefingPrompt", () => {
  it("returns undefined when there is nothing to say", () => {
    // searchFirst defaults true, so only an explicit opt-out with no other
    // content yields an empty (undefined) briefing.
    expect(buildTurnBriefingPrompt({ searchFirst: false })).toBeUndefined();
    expect(buildTurnBriefingPrompt({ searchFirst: false, signals: [], extraLines: [] })).toBeUndefined();
    expect(buildTurnBriefingPrompt({ searchFirst: false, signals: ["   "] })).toBeUndefined();
  });

  it("emits the search-first reminder by default", () => {
    const out = buildTurnBriefingPrompt({});
    expect(out).toBeDefined();
    expect(out).toContain("Session briefing");
    expect(out).toContain("Search stored memory/state");
  });

  it("includes the state-file pointer with project and status", () => {
    const out = buildTurnBriefingPrompt({
      stateFile: { path: "Projects/Italy Trip.md", project: "Italy Trip", status: "active" },
      searchFirst: false,
    });
    expect(out).toContain("State file: Projects/Italy Trip.md");
    expect(out).toContain("project: Italy Trip");
    expect(out).toContain("status: active");
    expect(out).toContain("update it after");
  });

  it("carries a live state snapshot so resumed turns reflect mid-session updates", () => {
    const out = buildTurnBriefingPrompt({
      stateFile: {
        path: "Projects/Italy Trip.md",
        status: "planning",
        snapshot: "+2 days chosen; Three Peaks loop confirmed. Only Ridgeview lodging left.",
      },
      searchFirst: false,
    });
    expect(out).toContain("Current state (live, trust this over earlier turns):");
    expect(out).toContain("Three Peaks loop confirmed");
  });

  it("renders context usage as a clamped percentage", () => {
    expect(buildTurnBriefingPrompt({ searchFirst: false, contextUsageFraction: 0.42 }))
      .toContain("~42% used");
    expect(buildTurnBriefingPrompt({ searchFirst: false, contextUsageFraction: 1.7 }))
      .toContain("~100% used");
    expect(buildTurnBriefingPrompt({ searchFirst: false, contextUsageFraction: -0.5 }))
      .toContain("~0% used");
  });

  it("appends signals and extra lines, skipping blanks", () => {
    const out = buildTurnBriefingPrompt({
      searchFirst: false,
      signals: ["80% — final save before rotation.", "   "],
      extraLines: ["Custom note."],
    });
    expect(out).toContain("80% — final save before rotation.");
    expect(out).toContain("Custom note.");
    // blank signal should not create an empty bullet
    expect(out).not.toContain("- \n");
    expect(out?.endsWith("- ")).toBe(false);
  });

  it("formats as a bulleted list under a single header", () => {
    const out = buildTurnBriefingPrompt({
      stateFile: { path: "p.md" },
      contextUsageFraction: 0.5,
    });
    const lines = out!.split("\n");
    expect(lines[0]).toBe("Session briefing (act on this every turn):");
    expect(lines.slice(1).every((l) => l.startsWith("- "))).toBe(true);
  });

  it("injects canonical typed state verbatim after behavioral bullets", () => {
    const digest = "state (canonical — overrides anything remembered):\n- [project] Fixture — active";
    const out = buildTurnBriefingPrompt({ searchFirst: false, stateDigest: digest });
    expect(out).toBe(`Session briefing (act on this every turn):\n${digest}`);
    expect(buildTurnBriefingPrompt({ searchFirst: false, stateDigest: "   " })).toBeUndefined();
  });
});
