// Adds the owner's Discord accounts to every new thread in their agents'
// channels. Discord only lists a thread in someone's sidebar once they are a
// member, and a thread an agent or the voice operator starts has no members
// but the bot, so it gets lost. Configured per agent with
// discord.thread_followers (Discord user ids, kept in the profile overlay).

export interface FollowableThread {
  id: string;
  parentId: string | null;
  ownerId?: string | null;
  archived?: boolean | null;
  members: {
    fetch(options: { member: string; cache?: boolean }): Promise<unknown>;
    add(member: string): Promise<unknown>;
  };
}

export interface ThreadFollowerAgent {
  id: string;
  discord: { defaultChannelId: string; threadFollowers?: string[] };
}

/** Channel id → the user ids to add to its new threads. */
export function threadFollowersByChannel(agents: Iterable<ThreadFollowerAgent>): Map<string, string[]> {
  const byChannel = new Map<string, Set<string>>();
  for (const agent of agents) {
    const followers = agent.discord.threadFollowers ?? [];
    if (!followers.length) continue;
    const set = byChannel.get(agent.discord.defaultChannelId) ?? new Set<string>();
    for (const id of followers) set.add(id);
    byChannel.set(agent.discord.defaultChannelId, set);
  }
  return new Map([...byChannel].map(([channel, ids]) => [channel, [...ids]]));
}

/** Discord's "Unknown Member": the user isn't in the thread. */
function isNotMember(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const status = (error as { status?: unknown })?.status;
  return code === 10007 || status === 404;
}

export class ThreadFollowers {
  constructor(
    private readonly followers: Map<string, string[]>,
    private readonly log: (message: string) => void = (message) => console.log(message),
  ) {}

  get enabled(): boolean {
    return this.followers.size > 0;
  }

  /** The users to add to a thread under this channel. */
  followersFor(thread: Pick<FollowableThread, "parentId">): string[] {
    return thread.parentId ? this.followers.get(thread.parentId) ?? [] : [];
  }

  /**
   * A thread was just created: add every follower except whoever started it.
   * Returns the ids added.
   */
  async onCreated(thread: FollowableThread): Promise<string[]> {
    const added: string[] = [];
    for (const userId of this.followersFor(thread)) {
      if (userId === thread.ownerId) continue;
      try {
        await thread.members.add(userId);
        added.push(userId);
      } catch (error) {
        this.log(`[thread-followers] could not add ${userId} to thread ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (added.length) this.log(`[thread-followers] added ${added.length} follower(s) to thread ${thread.id}`);
    return added;
  }

  /**
   * Catch up on open threads (e.g. ones started while the bot was down): add
   * followers who aren't members yet. Checks membership first, because each
   * add posts an "added to the thread" notice. Returns the number of adds.
   */
  async catchUp(threads: Iterable<FollowableThread>): Promise<number> {
    let added = 0;
    for (const thread of threads) {
      if (thread.archived) continue;
      for (const userId of this.followersFor(thread)) {
        if (userId === thread.ownerId) continue;
        try {
          await thread.members.fetch({ member: userId, cache: false });
          continue;
        } catch (error) {
          if (!isNotMember(error)) {
            this.log(`[thread-followers] could not check ${userId} in thread ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
        }
        try {
          await thread.members.add(userId);
          added += 1;
        } catch (error) {
          this.log(`[thread-followers] could not add ${userId} to thread ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (added) this.log(`[thread-followers] catch-up added ${added} follower membership(s)`);
    return added;
  }
}
