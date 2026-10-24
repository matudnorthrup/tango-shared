import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deskReplyContent,
  deskReplyText,
  isOwnerOnlyChannel,
  loadOwnerPersona,
  refreshGuildMembers,
  resetDeskReplyCaches,
  type PersonaChannelLike,
} from "../src/desk-reply.js";

const VIEW = 1n << 10n;

function member(id: string, bot = false) {
  return { id, user: { username: id, bot } };
}

/** A guild whose members are found by username prefix, and a channel `viewers` can see. */
function channel(members: ReturnType<typeof member>[], viewers: string[], options: { failSearch?: boolean } = {}): PersonaChannelLike {
  return {
    guild: {
      id: `guild-${Math.random()}`,
      members: {
        async search({ query }) {
          if (options.failSearch) throw new Error("Missing Access");
          return new Map(members.filter((m) => m.user.username.startsWith(query)).map((m) => [m.id, m]));
        },
        async fetch({ user }) {
          const found = members.find((m) => m.id === user);
          if (!found) throw new Error("Unknown Member");
          return found;
        },
      },
    },
    permissionsFor: (m) => ({ has: (permission: bigint) => permission === VIEW && viewers.includes(m.id) }),
  };
}

describe("desk reply text", () => {
  it("keeps the owner's words and drops the marker", () => {
    expect(deskReplyText("🖥️ full shake")).toBe("full shake");
    expect(deskReplyText("  full shake ")).toBe("full shake");
  });

  it("unwraps old relay wrappers however deep a re-send nested them", () => {
    const nested = [
      '🖥️ The owner replied from the screen (re: "The assistant restarted and lost your meal log…"):',
      'The owner replied from the screen (re: "Today\'s meals are logged…"):',
      'The owner replied from the screen (re: "Your slow, careful expensedesk…"):',
      "All right for food today:",
      "- breakfast was a yogurt bowl",
    ].join("\n");
    expect(deskReplyText(nested)).toBe("All right for food today:\n- breakfast was a yogurt bowl");
  });

  it("leaves words that only mention the wrapper alone", () => {
    expect(deskReplyText('why does it say "The owner replied from the screen"?')).toBe('why does it say "The owner replied from the screen"?');
  });

  it("posts the marker then the words, and the marker alone for images", () => {
    expect(deskReplyContent("full shake")).toBe("🖥️ full shake");
    expect(deskReplyContent("")).toBe("🖥️");
    expect(deskReplyText(deskReplyContent("full shake"))).toBe("full shake");
  });
});

describe("owner persona", () => {
  const tempDirs: string[] = [];
  afterEach(() => tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  function profile(content?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desk-reply-"));
    tempDirs.push(dir);
    if (content !== undefined) fs.writeFileSync(path.join(dir, "owner.yaml"), content);
    return dir;
  }

  it("reads the owner from the profile", () => {
    expect(loadOwnerPersona(profile('discord_user_id: "111"\ndisplay_name: Owner\n'))).toEqual({ discordUserId: "111", otherDiscordUserIds: [], displayName: "Owner" });
    expect(loadOwnerPersona(profile('discord_user_id: "111"\ndisplay_name: Owner\nother_discord_user_ids: ["222"]\n'))?.otherDiscordUserIds).toEqual(["222"]);
    expect(loadOwnerPersona(profile('discord_user_id: "111"\ndisplay_name: Owner\navatar_url: https://example.com/a.png\n'))?.avatarUrl).toBe("https://example.com/a.png");
  });

  it("is off without an owner.yaml, and refuses a half-filled one", () => {
    expect(loadOwnerPersona(profile())).toBeNull();
    expect(() => loadOwnerPersona(profile("display_name: Owner\n"))).toThrow();
  });
});

describe("owner-only channels", () => {
  afterEach(() => resetDeskReplyCaches());
  const owner = new Set(["owner", "owner-alt"]);

  async function check(target: PersonaChannelLike, count: number, now = 0): Promise<boolean> {
    await refreshGuildMembers(target.guild, now);
    return isOwnerOnlyChannel(target, owner, count, now);
  }

  it("is owner-only when only the owner's accounts and bots can see it", async () => {
    const members = [member("owner"), member("owner-alt"), member("kid"), member("bot", true)];
    expect(await check(channel(members, ["owner", "owner-alt", "bot"]), 4)).toBe(true);
  });

  it("is shared when another person can see it", async () => {
    const members = [member("owner"), member("kid"), member("bot", true)];
    expect(await check(channel(members, ["owner", "kid", "bot"]), 3)).toBe(false);
  });

  it("answers shared until the members are known; a reply never waits on the sweep", async () => {
    const members = [member("owner"), member("bot", true)];
    const target = channel(members, ["owner"]);
    expect(await isOwnerOnlyChannel(target, owner, 2, 0)).toBe(false);
    await refreshGuildMembers(target.guild, 0);
    expect(await isOwnerOnlyChannel(target, owner, 2, 1_000)).toBe(true);
  });

  it("sweeps every prefix, so a low member count can't cut it short", async () => {
    const members = [member("owner"), member("zed")];
    // Discord says 1; the sweep finds 2, so the list doesn't match and isn't trusted.
    expect(await check(channel(members, ["owner", "zed"]), 1)).toBe(false);
    expect(await check(channel(members, ["owner", "zed"]), 2)).toBe(false);
  });

  it("reads each person's access fresh, so a new role shows at once", async () => {
    const viewers = ["owner"];
    const target = channel([member("owner"), member("kid")], viewers);
    expect(await check(target, 2)).toBe(true);
    viewers.push("kid");
    expect(await isOwnerOnlyChannel(target, owner, 2, 1_000)).toBe(false);
  });

  it("stops trusting the list when the member count moves, or after ten minutes", async () => {
    const members = [member("owner"), member("bot", true)];
    const target = channel(members, ["owner", "guest"]);
    expect(await check(target, 2)).toBe(true);
    members.push(member("guest"));
    expect(await isOwnerOnlyChannel(target, owner, 3, 1_000)).toBe(false);
    await refreshGuildMembers(target.guild, 1_000);
    expect(await isOwnerOnlyChannel(target, owner, 3, 2_000)).toBe(false);
    const quiet = channel([member("owner")], ["owner"]);
    expect(await check(quiet, 1)).toBe(true);
    expect(await isOwnerOnlyChannel(quiet, owner, 1, 10 * 60_000)).toBe(false);
  });

  it("counts as shared when the search fails or a person can't be looked up", async () => {
    const members = [member("owner"), member("bot", true)];
    expect(await check(channel(members, ["owner"], { failSearch: true }), 2)).toBe(false);
    const leaving = [member("owner"), member("kid")];
    const target = channel(leaving, ["owner"]);
    expect(await check(target, 2)).toBe(true);
    leaving.pop();
    expect(await isOwnerOnlyChannel(target, owner, 2, 1_000)).toBe(false);
  });
});
