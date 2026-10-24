import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SnowflakeUtil, type Client, type ThreadChannel } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import { createActiveThreadsTracker } from "../src/active-threads-tracker.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempVault(): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "tango-active-threads-"));
  tempDirs.push(vaultPath);
  return vaultPath;
}

function writeDailyNote(vaultPath: string, date: string, content: string): string {
  const notePath = path.join(vaultPath, "Planning", "Daily", `${date}.md`);
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, content, "utf8");
  return notePath;
}

function snowflakeFor(timestampMs: number): string {
  return SnowflakeUtil.generate({ timestamp: timestampMs }).toString();
}

function createThread(input: {
  id: string;
  name: string;
  parentName: string;
  lastMessageId?: string | null;
  createdTimestamp?: number | null;
  onMessageFetch?: () => void;
}): ThreadChannel {
  return {
    id: input.id,
    name: input.name,
    parentId: `${input.parentName}-id`,
    parent: { name: input.parentName },
    lastMessageId: input.lastMessageId ?? null,
    createdTimestamp: input.createdTimestamp ?? null,
    messages: {
      fetch: async () => {
        input.onMessageFetch?.();
        return {
          first: () => null,
        };
      },
    },
  } as unknown as ThreadChannel;
}

function createClient(threads: ThreadChannel[]): Client {
  return {
    isReady: () => true,
    guilds: {
      cache: new Map([
        [
          "guild-1",
          {
            channels: {
              fetchActiveThreads: async () => ({
                threads: new Map(threads.map((thread) => [thread.id, thread])),
              }),
            },
          },
        ],
      ]),
    },
  } as unknown as Client;
}

describe("active threads tracker", () => {
  it("tracks active threads from thread metadata without fetching messages", async () => {
    const vaultPath = makeTempVault();
    const nowMs = Date.parse("2026-04-14T20:00:00.000Z");
    const notePath = writeDailyNote(
      vaultPath,
      "2026-04-14",
      [
        "# Daily",
        "",
        "## In Progress",
        "- [ ] 🤖 #general › Existing Thread — last active 9:00 AM",
        "",
        "## Next",
        "- [ ] Review priorities",
      ].join("\n"),
    );

    let messageFetchCalls = 0;
    const client = createClient([
      createThread({
        id: "thread-existing",
        name: "Existing Thread",
        parentName: "general",
        lastMessageId: snowflakeFor(Date.parse("2026-04-14T19:31:00.000Z")),
        onMessageFetch: () => {
          messageFetchCalls++;
        },
      }),
      createThread({
        id: "thread-new",
        name: "New Thread",
        parentName: "support",
        lastMessageId: snowflakeFor(Date.parse("2026-04-14T22:05:00.000Z")),
        onMessageFetch: () => {
          messageFetchCalls++;
        },
      }),
      createThread({
        id: "thread-old",
        name: "Yesterday Thread",
        parentName: "support",
        lastMessageId: snowflakeFor(Date.parse("2026-04-13T18:10:00.000Z")),
        onMessageFetch: () => {
          messageFetchCalls++;
        },
      }),
    ]);

    const handler = createActiveThreadsTracker(client, {
      vaultPath,
      now: () => nowMs,
    });

    const result = await handler({} as never);
    const updatedNote = fs.readFileSync(notePath, "utf8");

    expect(result).toEqual({
      status: "ok",
      summary: "2 threads tracked (1 new, 1 updated)",
    });
    expect(updatedNote).toContain("#general › Existing Thread — last active 12:31 PM");
    expect(updatedNote).toContain("#support › New Thread — last active 3:05 PM");
    expect(updatedNote).not.toContain("Yesterday Thread");
    expect(messageFetchCalls).toBe(0);
  });

  it("keeps checked items untouched and falls back to created timestamps", async () => {
    const vaultPath = makeTempVault();
    const nowMs = Date.parse("2026-04-14T20:00:00.000Z");
    const notePath = writeDailyNote(
      vaultPath,
      "2026-04-14",
      [
        "# Daily",
        "",
        "## In Progress",
        "- [x] 🤖 #ops › Closed Out Thread — last active 8:00 AM",
      ].join("\n"),
    );

    let messageFetchCalls = 0;
    const client = createClient([
      createThread({
        id: "thread-closed",
        name: "Closed Out Thread",
        parentName: "ops",
        createdTimestamp: Date.parse("2026-04-14T18:00:00.000Z"),
        onMessageFetch: () => {
          messageFetchCalls++;
        },
      }),
    ]);

    const handler = createActiveThreadsTracker(client, {
      vaultPath,
      now: () => nowMs,
    });

    const result = await handler({} as never);
    const updatedNote = fs.readFileSync(notePath, "utf8");

    expect(result).toEqual({
      status: "skipped",
      summary: "1 threads — all already tracked, no changes",
    });
    expect(updatedNote).toContain("#ops › Closed Out Thread — last active 8:00 AM");
    expect(updatedNote).not.toContain("11:00 AM");
    expect(messageFetchCalls).toBe(0);
  });
});
