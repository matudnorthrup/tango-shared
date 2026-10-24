/**
 * Link a conversation (Discord channel/thread) to a project state file.
 *
 * Creates or updates a project_state "head" (Unified Memory System, Slice 1) so
 * the agent in that conversation gets the per-turn state-file pointer and a
 * project-aware reseed after rotation.
 *
 * Usage:
 *   node --import tsx scripts/link-project-state.ts \
 *     --key thread:<threadId>            # or channel:<channelId>
 *     --path "Projects/Launch Plan.md"   # legacy Obsidian/vault-relative .md
 *     # or: --provider profile --path "threads/launch-plan.md"
 *     # or: --path "profile:threads/launch-plan.md"
 *     [--title "Launch Plan"] [--status planning] \
 *     [--quick-read "Release path locked; vendor decision open."] [--agent sierra]
 *
 * The conversationKey is `thread:{threadId}` when the conversation is a Discord
 * thread/forum post, else `channel:{channelId}` — the same key TangoRouter uses.
 * The body is the canonical narrative; the head is the recall index/pointer.
 */
import { resolveDatabasePath, TangoStorage } from "@tango/core";
import {
  formatStateBodyPointer,
  parseStateBodyPointer,
  type StateBodyProviderId,
} from "../packages/discord/src/state-body-provider.js";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const key = arg("key");
const bodyPath = arg("path");
const provider = arg("provider") as StateBodyProviderId | undefined;
if (!key || !bodyPath) {
  console.error(
    "required: --key <thread:ID|channel:ID> --path <vault-relative.md|profile:threads/file.md> "
    + "[--provider obsidian|profile] [--title T] [--status S] [--quick-read Q] [--agent A]",
  );
  process.exit(1);
}

let stateBodyPointer: string;
try {
  stateBodyPointer = formatStateBodyPointer(parseStateBodyPointer(bodyPath, { provider }));
} catch (error) {
  console.error(`invalid state body pointer: ${(error as Error).message}`);
  process.exit(1);
}

const storage = new TangoStorage(resolveDatabasePath(process.env.TANGO_DB_PATH));
const record = storage.upsertProjectState({
  projectId: key,
  obsidianPath: stateBodyPointer,
  ...(arg("title") ? { title: arg("title")! } : {}),
  ...(arg("status") ? { status: arg("status")! } : {}),
  ...(arg("quick-read") ? { quickRead: arg("quick-read")! } : {}),
  ...(arg("agent") ? { leadAgentId: arg("agent")! } : {}),
});
console.log("Linked project_state head:");
console.log(JSON.stringify(record, null, 2));
storage.close();
