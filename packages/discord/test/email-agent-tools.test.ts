import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildThreadBrief,
  buildTimelineOneLiner,
  extractDriveLinks,
  parseGogSearchJson,
  parseGogThreadJson,
  resolveEmailAccount,
} from "../src/email-agent-tools.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("resolveEmailAccount", () => {
  it("allows the configured account", () => {
    expect(
      resolveEmailAccount("piper.ops@example.test", {
        defaultAccount: "piper.ops@example.test",
      }),
    ).toBe("piper.ops@example.test");
  });

  it("firewalls configured blocked accounts", () => {
    expect(() =>
      resolveEmailAccount("private.inbox@example.test", {
        defaultAccount: "piper.ops@example.test",
        firewalledAccounts: ["private.inbox@example.test"],
      }),
    ).toThrow(/firewalled/i);
  });

  it("rejects other accounts", () => {
    expect(() =>
      resolveEmailAccount("other@example.test", {
        defaultAccount: "piper.ops@example.test",
      }),
    ).toThrow(/only support/i);
  });

  it("loads account and firewall values from profile config", () => {
    const homeDir = createTempDir("tango-email-profile-");
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";
    delete process.env.PIPER_GMAIL_ACCOUNT;
    delete process.env.TANGO_EMAIL_ACCOUNT;
    delete process.env.TANGO_PIPER_FIREWALLED_GMAIL_ACCOUNTS;

    const configDir = path.join(homeDir, "profiles", "default", "config", "email");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "piper-account.txt"), "piper.ops@example.test\n");
    fs.writeFileSync(path.join(configDir, "piper-firewalled-accounts.txt"), "private.inbox@example.test\n");

    expect(resolveEmailAccount()).toBe("piper.ops@example.test");
    expect(() => resolveEmailAccount("private.inbox@example.test")).toThrow(/firewalled/i);
  });

  it("fails closed when no account is configured", () => {
    const homeDir = createTempDir("tango-email-empty-profile-");
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";
    delete process.env.PIPER_GMAIL_ACCOUNT;
    delete process.env.TANGO_EMAIL_ACCOUNT;

    expect(() => resolveEmailAccount()).toThrow(/not configured/i);
  });
});

describe("extractDriveLinks", () => {
  it("extracts docs and drive links from email bodies", () => {
    const links = extractDriveLinks(
      "See https://docs.google.com/document/d/abc123/edit and https://drive.google.com/file/d/xyz789/view",
    );
    expect(links).toHaveLength(2);
    expect(links[0]?.kind).toBe("document");
    expect(links[1]?.kind).toBe("drive_file");
  });
});

describe("parseGogThreadJson", () => {
  it("parses messages array and builds timeline one-liners", () => {
    const raw = JSON.stringify({
      threadId: "t1",
      messages: [
        {
          id: "m1",
          from: "Morgan <morgan@example.com>",
          to: "Ops Lead <piper.ops@example.test>",
          subject: "Budget review",
          date: "2026-05-28T10:00:00Z",
          body: "First message in thread.",
        },
        {
          id: "m2",
          from: "Ops Lead <piper.ops@example.test>",
          to: "Morgan <morgan@example.com>",
          subject: "Re: Budget review",
          date: "2026-05-28T11:00:00Z",
          body: "<p>Latest reply with <a href=\"https://docs.google.com/spreadsheets/d/sheet42/edit\">sheet</a>.</p>",
          attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 1200, id: "att1" }],
        },
      ],
    });

    const messages = parseGogThreadJson(raw);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.attachments[0]?.needs_extraction).toBe(true);

    const brief = buildThreadBrief({
      threadId: "t1",
      account: "piper.ops@example.test",
      messages,
      sessionId: "test-session",
      writeBody: () => {},
    });

    expect(brief.subject).toBe("Re: Budget review");
    expect(brief.latest.message_id).toBe("m2");
    expect(brief.timeline).toHaveLength(2);
    expect(brief.drive_links[0]?.kind).toBe("spreadsheet");
    expect(brief.latest_body_path).toContain("/tmp/tango-attachments/test-session/thread-t1-latest.txt");
  });

  it("parses live gog Gmail API thread JSON with payload headers and multipart bodies", () => {
    const plainBody = "Hi there,\n\nHappy Friday!";
    const plainBodyData = Buffer.from(plainBody, "utf8").toString("base64");
    const raw = JSON.stringify({
      thread: {
        id: "t-simple",
        messages: [
          {
            id: "m-simple",
            internalDate: "1780085178000",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: "Riley Rivera <riley@example.test>" },
                { name: "To", value: "Ops Lead <piper.ops@example.test>" },
                { name: "Subject", value: "Happy Friday!" },
                { name: "Date", value: "Fri, 29 May 2026 15:26:18 -0500" },
              ],
              body: { data: plainBodyData },
            },
          },
        ],
      },
    });

    const messages = parseGogThreadJson(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.from).toContain("Riley Rivera");
    expect(messages[0]?.subject).toBe("Happy Friday!");
    expect(messages[0]?.date).toBe("Fri, 29 May 2026 15:26:18 -0500");
    expect(messages[0]?.body).toContain("Happy Friday!");

    const brief = buildThreadBrief({
      threadId: "t-simple",
      account: "piper.ops@example.test",
      messages,
      sessionId: "test-gmail-api",
      writeBody: () => {},
    });

    expect(brief.subject).toBe("Happy Friday!");
    expect(brief.latest.from).toContain("Riley Rivera");
    expect(brief.participants).toContain("Riley Rivera <riley@example.test>");
  });
});

describe("buildTimelineOneLiner", () => {
  it("strips html and truncates long bodies", () => {
    const long = "word ".repeat(40);
    const oneLiner = buildTimelineOneLiner(`<p>${long}</p>`, "html");
    expect(oneLiner.endsWith("…")).toBe(true);
    expect(oneLiner.length).toBeLessThanOrEqual(140);
  });
});

describe("parseGogSearchJson", () => {
  it("normalizes search results into thread cards", () => {
    const raw = JSON.stringify({
      messages: [
        {
          threadId: "t9",
          id: "m9",
          from: "Casey <casey@example.com>",
          subject: "Cowork Hub update",
          date: "2026-05-20",
          snippet: "Quick update on Cowork Hub.",
        },
      ],
    });
    const cards = parseGogSearchJson(raw);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.thread_id).toBe("t9");
    expect(cards[0]?.subject).toBe("Cowork Hub update");
  });
});
