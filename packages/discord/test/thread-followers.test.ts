import { describe, expect, it } from "vitest";
import { ThreadFollowers, threadFollowersByChannel, type FollowableThread } from "../src/thread-followers.js";

const OWNER_A = "111";
const OWNER_B = "222";

function fakeThread(parentId: string, opts: { ownerId?: string; members?: string[]; archived?: boolean } = {}) {
  const members = new Set(opts.members ?? []);
  const adds: string[] = [];
  const thread: FollowableThread = {
    id: `t-${parentId}`,
    parentId,
    ownerId: opts.ownerId ?? "bot",
    archived: opts.archived ?? false,
    members: {
      fetch: async ({ member }) => {
        if (!members.has(member)) throw Object.assign(new Error("Unknown Member"), { code: 10007, status: 404 });
        return { id: member };
      },
      add: async (member) => {
        adds.push(member);
        members.add(member);
        return member;
      },
    },
  };
  return { thread, adds };
}

const agents = [
  { id: "sierra", discord: { defaultChannelId: "c-sierra", threadFollowers: [OWNER_A, OWNER_B] } },
  { id: "watson", discord: { defaultChannelId: "c-watson", threadFollowers: [OWNER_A, OWNER_B] } },
  { id: "jules", discord: { defaultChannelId: "c-jules" } },
];

describe("thread followers", () => {
  it("maps each agent channel to its followers, skipping agents without any", () => {
    const map = threadFollowersByChannel(agents);
    expect(map.get("c-sierra")).toEqual([OWNER_A, OWNER_B]);
    expect(map.has("c-jules")).toBe(false);
  });

  it("adds both accounts to a new thread in a followed channel", async () => {
    const followers = new ThreadFollowers(threadFollowersByChannel(agents), () => undefined);
    const { thread, adds } = fakeThread("c-sierra");
    expect(await followers.onCreated(thread)).toEqual([OWNER_A, OWNER_B]);
    expect(adds).toEqual([OWNER_A, OWNER_B]);
  });

  it("skips whoever started the thread, and channels nobody follows", async () => {
    const followers = new ThreadFollowers(threadFollowersByChannel(agents), () => undefined);
    const own = fakeThread("c-watson", { ownerId: OWNER_B });
    await followers.onCreated(own.thread);
    expect(own.adds).toEqual([OWNER_A]);
    const other = fakeThread("c-jules");
    await followers.onCreated(other.thread);
    expect(other.adds).toEqual([]);
  });

  it("keeps going when one add fails", async () => {
    const logs: string[] = [];
    const followers = new ThreadFollowers(threadFollowersByChannel(agents), (line) => logs.push(line));
    const { thread } = fakeThread("c-sierra");
    let first = true;
    const add = thread.members.add;
    thread.members.add = async (member) => {
      if (first) {
        first = false;
        throw new Error("Missing Access");
      }
      return add(member);
    };
    expect(await followers.onCreated(thread)).toEqual([OWNER_B]);
    expect(logs.some((line) => line.includes("Missing Access"))).toBe(true);
  });

  it("catch-up adds only missing members on open threads", async () => {
    const followers = new ThreadFollowers(threadFollowersByChannel(agents), () => undefined);
    const partial = fakeThread("c-sierra", { members: [OWNER_A] });
    const archived = fakeThread("c-watson", { archived: true });
    const unfollowed = fakeThread("c-jules");
    expect(await followers.catchUp([partial.thread, archived.thread, unfollowed.thread])).toBe(1);
    expect(partial.adds).toEqual([OWNER_B]);
    expect(archived.adds).toEqual([]);
    expect(unfollowed.adds).toEqual([]);
  });
});
