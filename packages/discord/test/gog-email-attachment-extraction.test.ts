import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createEmailTools } from "../src/personal-agent-tools.js";

const originalPath = process.env.PATH;
const originalCwd = process.cwd();
const originalGogKeyringPassword = process.env.GOG_KEYRING_PASSWORD;
const tempRoots: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  process.env.PATH = originalPath;
  if (originalGogKeyringPassword === undefined) {
    delete process.env.GOG_KEYRING_PASSWORD;
  } else {
    process.env.GOG_KEYRING_PASSWORD = originalGogKeyringPassword;
  }
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tango-gog-email-test-"));
  tempRoots.push(dir);
  return dir;
}

async function writeExecutable(filePath: string, body: string): Promise<void> {
  await fs.writeFile(filePath, `#!${process.execPath}\n${body}`, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function writeFakeGog(root: string): Promise<string> {
  const gogPath = path.join(root, "gog");
  await writeExecutable(gogPath, `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const nameIndex = args.indexOf("--name");
if (args[0] === "gmail" && args[1] === "attachment" && outIndex !== -1 && nameIndex !== -1) {
  const outDir = args[outIndex + 1];
  const filename = args[nameIndex + 1];
  if (filename && !filename.includes("/") && !filename.includes("..")) {
    fs.writeFileSync(path.join(outDir, filename), "%PDF-1.7");
  }
}
process.stdout.write(JSON.stringify({ ok: true, args }));
`);
  return gogPath;
}

async function writeEnvEchoGog(root: string): Promise<string> {
  const gogPath = path.join(root, "gog");
  await writeExecutable(gogPath, `
const payload = {
  args: process.argv.slice(2),
  keyringPassword: process.env.GOG_KEYRING_PASSWORD || null,
};
process.stdout.write(JSON.stringify(payload));
`);
  return gogPath;
}

async function writeFakePdftotext(root: string, text: string): Promise<string> {
  const pdftotextPath = path.join(root, "pdftotext");
  await writeExecutable(pdftotextPath, `
process.stdout.write(${JSON.stringify(text)});
`);
  return pdftotextPath;
}

async function runGogEmail(command: string, gogCommand: string): Promise<Record<string, unknown>> {
  const tool = createEmailTools({ gogCommand })[0]!;
  return await tool.handler({ command }) as Record<string, unknown>;
}

describe("gog_email attachment extraction", () => {
  it("uses dotenv parsing and overrides inherited GOG_KEYRING_PASSWORD for background gog commands", async () => {
    const root = await makeTempRoot();
    const gogCommand = await writeEnvEchoGog(root);
    process.env.GOG_KEYRING_PASSWORD = "stale-launcher-password";
    await fs.writeFile(path.join(root, ".env"), "GOG_KEYRING_PASSWORD=canonical-password # comment\n", "utf8");
    process.chdir(root);

    const result = await runGogEmail(
      "gmail messages search 'newer_than:1d' --max 1",
      gogCommand,
    );
    const payload = JSON.parse(String(result.result)) as { keyringPassword: string | null };

    expect(payload.keyringPassword).toBe("canonical-password");
  });

  it("normalizes Gmail shorthand before invoking gog", async () => {
    const root = await makeTempRoot();
    const gogCommand = await writeEnvEchoGog(root);

    const result = await runGogEmail("messages search 'is:unread' --max 1", gogCommand);
    const payload = JSON.parse(String(result.result)) as { args: string[] };

    expect(payload.args.slice(0, 3)).toEqual(["gmail", "messages", "search"]);
  });

  it("adds bounded extracted text for safe PDF downloads into temp", async () => {
    const root = await makeTempRoot();
    const gogCommand = await writeFakeGog(root);
    await writeFakePdftotext(root, "Opening Remarks #100 Welcome\\nClosing Notes Test\n");
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;
    const filename = `notice-${Date.now()}.pdf`;

    const result = await runGogEmail(
      `gmail attachment msg-1 att-1 --out ${os.tmpdir()} --name ${filename}`,
      gogCommand,
    );

    expect(result.result).toContain("\"ok\":true");
    expect(result.attachment_text).toMatchObject({
      filename,
      method: "pdftotext",
      truncated: false,
      warnings: [],
    });
    expect((result.attachment_text as { text: string }).text).toContain("Opening Remarks #100");
    expect((result.attachment_text as { total_chars: number }).total_chars).toBeGreaterThan(0);
    await fs.rm(path.join(os.tmpdir(), filename), { force: true });
  });

  it("does not extract unsafe names or unsafe output directories", async () => {
    const root = await makeTempRoot();
    const gogCommand = await writeFakeGog(root);
    await writeFakePdftotext(root, "Should not be read");
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;

    await expect(runGogEmail(
      `gmail attachment msg-1 att-1 --out ${os.tmpdir()} --name ../notice.pdf`,
      gogCommand,
    )).resolves.not.toHaveProperty("attachment_text");

    await expect(runGogEmail(
      "gmail attachment msg-1 att-1 --out /etc --name notice.pdf",
      gogCommand,
    )).resolves.not.toHaveProperty("attachment_text");
  });

  it("does not extract non-PDF attachments", async () => {
    const root = await makeTempRoot();
    const gogCommand = await writeFakeGog(root);
    await writeFakePdftotext(root, "Should not be read");
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;

    const result = await runGogEmail(
      `gmail attachment msg-1 att-1 --out ${os.tmpdir()} --name ward.txt`,
      gogCommand,
    );

    expect(result).not.toHaveProperty("attachment_text");
  });

  it("keeps the download result when PDF text extraction fails", async () => {
    const root = await makeTempRoot();
    const gogCommand = await writeFakeGog(root);
    process.env.PATH = root;
    const filename = `notice-${Date.now()}.pdf`;

    const result = await runGogEmail(
      `gmail attachment msg-1 att-1 --out ${os.tmpdir()} --name ${filename}`,
      gogCommand,
    );

    expect(result.result).toContain("\"ok\":true");
    expect(result.attachment_text).toMatchObject({
      filename,
      method: "pdftotext",
      text: "",
      truncated: false,
      total_chars: 0,
    });
    expect((result.attachment_text as { warnings: string[] }).warnings.length).toBeGreaterThan(0);
    await fs.rm(path.join(os.tmpdir(), filename), { force: true });
  });
});
