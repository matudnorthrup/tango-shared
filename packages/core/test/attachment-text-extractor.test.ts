import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chunkAttachmentText,
  extractAttachmentText,
  type AttachmentTextCommand,
  type AttachmentTextCommandRunner,
} from "../src/attachment-text-extractor.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function writeTempFile(filename: string, content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-attachment-text-"));
  cleanupDirs.push(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("extractAttachmentText", () => {
  it("extracts normalized UTF-8 text-first formats", async () => {
    const txt = await extractAttachmentText(writeTempFile("notes.txt", "\uFEFFAlpha\r\nBeta  \r\n\r\n\r\nGamma\r\n"));
    expect(txt).toMatchObject({
      method: "utf8_text",
      sourceFormat: "txt",
      text: "Alpha\nBeta\n\nGamma",
      commandUsed: null,
      escalationRecommended: false,
    });
    expect(txt.quality.tokenEstimate).toBeGreaterThan(0);

    const markdown = await extractAttachmentText(writeTempFile("handoff.md", "# Handoff\n\n- Ship it\n"));
    expect(markdown).toMatchObject({
      method: "utf8_text",
      sourceFormat: "markdown",
      text: "# Handoff\n\n- Ship it",
      escalationRecommended: false,
    });

    const csv = await extractAttachmentText(writeTempFile("totals.csv", "name,total\r\nAda,12\r\n"));
    expect(csv).toMatchObject({
      method: "utf8_text",
      sourceFormat: "csv",
      text: "name,total\nAda,12",
      escalationRecommended: false,
    });

    const jsonl = await extractAttachmentText(writeTempFile("events.jsonl", "{\"type\":\"a\"}\n"));
    expect(jsonl).toMatchObject({
      method: "utf8_text",
      sourceFormat: "jsonl",
      text: "{\"type\":\"a\"}",
    });
  });

  it("reports unsupported binary attachments as escalations", async () => {
    const result = await extractAttachmentText(writeTempFile("photo.bin", Buffer.from([0, 1, 2, 3])));

    expect(result).toMatchObject({
      method: "unsupported",
      sourceFormat: "unsupported",
      text: "",
      commandUsed: null,
      escalationRecommended: true,
      confidence: 0,
      quality: {
        empty: true,
      },
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining(["unsupported_source_format", "extraction_empty"]),
    );
  });

  it("uses injected textutil command runner for DOCX-family formats", async () => {
    const filePath = writeTempFile("brief.docx", Buffer.from("fake docx bytes"));
    const calls: AttachmentTextCommand[] = [];
    const commandRunner: AttachmentTextCommandRunner = async (command) => {
      calls.push(command);
      return {
        stdout: "Title\r\nBody text\r\n",
        stderr: "",
        exitCode: 0,
        commandFound: true,
      };
    };

    const result = await extractAttachmentText(filePath, { commandRunner });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "textutil",
      args: ["-convert", "txt", "-stdout", filePath],
    });
    expect(result).toMatchObject({
      method: "textutil",
      sourceFormat: "docx",
      text: "Title\nBody text",
      commandUsed: "textutil",
      escalationRecommended: false,
    });
  });

  it("fails gracefully when textutil is unavailable", async () => {
    const missingTextutil = Object.assign(new Error("spawn textutil ENOENT"), { code: "ENOENT" });
    const commandRunner: AttachmentTextCommandRunner = async () => {
      throw missingTextutil;
    };

    const result = await extractAttachmentText(writeTempFile("brief.rtf", "{\\rtf1}"), {
      commandRunner,
    });

    expect(result).toMatchObject({
      method: "textutil",
      sourceFormat: "rtf",
      text: "",
      commandUsed: "textutil",
      escalationRecommended: true,
      confidence: 0,
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining(["command_unavailable:textutil", "extraction_empty"]),
    );
  });

  it("uses injected pdftotext command runner for PDF embedded text", async () => {
    const filePath = writeTempFile("report.pdf", Buffer.from("%PDF-1.7"));
    const calls: AttachmentTextCommand[] = [];
    const commandRunner: AttachmentTextCommandRunner = async (command) => {
      calls.push(command);
      return {
        stdout: Buffer.from("Page 1\r\nEmbedded text\r\n", "utf8"),
        stderr: "",
        exitCode: 0,
        commandFound: true,
      };
    };

    const result = await extractAttachmentText(filePath, { commandRunner });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "pdftotext",
      args: ["-layout", "-enc", "UTF-8", filePath, "-"],
    });
    expect(result).toMatchObject({
      method: "pdftotext",
      sourceFormat: "pdf",
      text: "Page 1\nEmbedded text",
      commandUsed: "pdftotext",
      escalationRecommended: false,
    });
  });

  it("fails gracefully when pdftotext cannot extract text", async () => {
    const commandRunner: AttachmentTextCommandRunner = async () => ({
      stdout: "",
      stderr: "Syntax Error: not a PDF",
      exitCode: 1,
      commandFound: true,
    });

    const result = await extractAttachmentText(writeTempFile("scan.pdf", Buffer.from("%PDF-1.7")), {
      commandRunner,
    });

    expect(result).toMatchObject({
      method: "pdftotext",
      sourceFormat: "pdf",
      text: "",
      commandUsed: "pdftotext",
      escalationRecommended: true,
      confidence: 0,
      metadata: {
        commandExitCode: 1,
        stderr: "Syntax Error: not a PDF",
      },
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining(["command_failed:pdftotext", "extraction_empty"]),
    );
  });

  it("recommends escalation when supported extraction is empty", async () => {
    const result = await extractAttachmentText(writeTempFile("empty.md", "\n\n\t\n"));

    expect(result).toMatchObject({
      method: "utf8_text",
      sourceFormat: "markdown",
      text: "",
      confidence: 0,
      escalationRecommended: true,
      quality: {
        empty: true,
        tokenEstimate: 0,
      },
    });
    expect(result.warnings).toContain("extraction_empty");
  });
});

describe("chunkAttachmentText", () => {
  it("creates deterministic chunks with token estimates", () => {
    const chunks = chunkAttachmentText("alpha beta gamma delta epsilon zeta", {
      maxTokens: 2,
      overlapTokens: 0,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
    expect(chunks.every((chunk) => chunk.tokenEstimate > 0)).toBe(true);
  });
});
