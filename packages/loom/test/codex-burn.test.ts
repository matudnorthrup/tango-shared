import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

it("adds Codex rollout growth once, ignores repeated token counts, and retains Claude output", () => {
  const home = mkdtempSync(join(tmpdir(), "loom-burn-"));
  const event = (timestamp: string, input: number, cached: number, output: number) => JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
  try {
    mkdirSync(join(home, "sessions"));
    writeFileSync(join(home, "sessions", "rollout.jsonl"), [event("2020-01-01T12:00:00Z", 100, 50, 10), event("2026-01-02T12:00:00Z", 150, 70, 20), event("2026-01-02T12:00:01Z", 150, 70, 20), event("2026-01-02T12:00:02Z", 220, 100, 30)].join("\n"));
    writeFileSync(join(home, "accounts.json"), JSON.stringify({ codex: { default: "main", accounts: [{ name: "main", home }] } }));
    const result = execFileSync(process.execPath, [fileURLToPath(new URL("../../../scripts/loom-burn.mjs", import.meta.url)), "--root", join(home, "claude"), "--db", join(home, "missing.sqlite"), "--since", "2026-01-01", "--codex", "--accounts", join(home, "accounts.json"), "--json", join(home, "result.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    expect(result).toContain("Loom Claude usage since"); expect(result).toContain("Codex usage since");
    const data = JSON.parse(readFileSync(join(home, "result.json"), "utf8"));
    expect(data.codex).toEqual([{ account: "main", day: expect.any(String), calls: 2, input: 120, cached: 50, output: 20 }]);
    expect(data.days).toEqual({}); expect(data.threads).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
