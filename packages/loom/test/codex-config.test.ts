import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { loadAccounts, loadConfig } from "../src/config.js";

it("loads optional Codex accounts, expands homes, and validates their default", () => {
  const home = mkdtempSync(join(tmpdir(), "loom-accounts-"));
  const config = loadConfig({ LOOM_HOME: home });
  try {
    expect(loadAccounts(config)).toEqual({});
    writeFileSync(config.accountsPath, JSON.stringify({ codex: { default: "personal", accounts: [{ name: "personal", home: "~/.codex-example", usageName: "Codex (Personal)", aliases: ["work"] }] } }));
    expect(loadAccounts(config).codex?.accounts[0]).toEqual({ name: "personal", home: join(homedir(), ".codex-example"), usageName: "Codex (Personal)", aliases: ["work"] });
    writeFileSync(config.accountsPath, JSON.stringify({ codex: { default: "missing", accounts: [] } }));
    expect(() => loadAccounts(config)).toThrow('default Codex account "missing"');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
