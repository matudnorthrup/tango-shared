/**
 * Project-state integration (Unified Memory System, Slice 1 — the spine).
 *
 * Binds a conversation to a project arc's state file:
 *  - the DB "head" (project_state, in core storage) is the source of truth for
 *    recall — status, a short Quick Read, and a pointer to the markdown body;
 *  - the per-turn whisper carries the pointer (read-before / update-after);
 *  - cold-start / rotation reseed re-loads the head so the agent knows where the
 *    project stands after its provider session is gone.
 *
 * The arc is keyed by the runtime conversationKey (`thread:{id}` / `channel:{id}`)
 * — the one key shared by the whisper, reseed, and post-turn paths. Mapping a
 * Tango `project:{id}` onto this key is a future refinement.
 */
import path from "node:path";
import {
  resolveConfiguredPath,
  resolveDefaultObsidianVaultPath,
  resolveTangoProfileDir,
  type TangoStorage,
} from "@tango/core";
import {
  parseStateBodyPointer,
  readStateBody as readProviderStateBody,
  type StateBodyPointer,
  type StateBodyReadRoots,
} from "./state-body-provider.js";

type StorageReader = Pick<TangoStorage, "getProjectState" | "listActiveContextItems">;
type StorageWriter = Pick<TangoStorage, "getProjectState" | "upsertProjectState">;

export interface StateFilePointer {
  path: string;
  project: string;
  status: string;
  /** Live Quick Read snapshot from the provider-backed body when available. */
  snapshot?: string;
}

/** Read the `status:` scalar from a note's YAML frontmatter (wikilink/quotes stripped). */
function extractFrontmatterStatus(content: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!fm) return undefined;
  const m = /^status:\s*(.+?)\s*$/mu.exec(fm[1] ?? "");
  if (!m) return undefined;
  return m[1]!.replace(/^["'[\]]+|["'[\]]+$/gu, "").trim() || undefined;
}

/** Mirror of TangoRouter.getConversationKey — keep in sync. */
export function conversationKeyFor(channelId: string, threadId?: string): string {
  return threadId ? `thread:${threadId}` : `channel:${channelId}`;
}

/**
 * Obsidian vault root shared by project-state and typed-state adapters.
 *
 * An explicitly injected root wins. Dev-slot profiles stay inside the slot
 * even when the shared .env configures the production vault; other configured
 * roots keep their normal precedence. A selected profile without a configured
 * vault also uses profile-local notes before the legacy production fallback.
 */
export function resolveStateVaultRoot(explicitRoot?: string | null): string {
  const injected = explicitRoot?.trim();
  if (injected) return resolveConfiguredPath(injected);

  const profileName = process.env.TANGO_PROFILE?.trim();
  const slotName = process.env.TANGO_SLOT?.trim();
  if (slotName || (profileName && /^wt-[1-9][0-9]*$/u.test(profileName))) {
    return path.join(resolveTangoProfileDir(), "notes");
  }

  const configured = process.env.TANGO_OBSIDIAN_VAULT?.trim();
  if (configured) return resolveConfiguredPath(configured);

  if (profileName || process.env.TANGO_HOME?.trim()) {
    return path.join(resolveTangoProfileDir(), "notes");
  }

  return resolveConfiguredPath(resolveDefaultObsidianVaultPath());
}

/** Active Tango profile root for profile-backed state bodies. */
export function resolveStateProfileRoot(): string {
  return resolveTangoProfileDir();
}

/**
 * Extract a markdown section body by H2 heading ("## Heading"), up to the next
 * H2 or end of document. Returns trimmed text, or undefined if not found.
 */
function extractSection(content: string, heading: string): string | undefined {
  const lines = content.split(/\r?\n/u);
  const target = heading.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+(.+?)\s*$/u.exec(lines[i] ?? "");
    if (m && m[1]!.trim().toLowerCase() === target) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;
  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s+/u.test(lines[i] ?? "")) break;
    body.push(lines[i] ?? "");
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

/** Bullet lines ("- ...") within a section, normalized (no leading dash). */
function extractBullets(content: string, heading: string): string[] {
  const section = extractSection(content, heading);
  if (!section) return [];
  return section
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/u, "").trim())
    .filter((l) => l.length > 0);
}

function parseLinkedStateBodyPointer(input: string | null | undefined): StateBodyPointer | undefined {
  const raw = input?.trim();
  if (!raw) return undefined;
  try {
    return parseStateBodyPointer(raw);
  } catch {
    return undefined;
  }
}

function readLinkedStateBody(pointer: StateBodyPointer, roots: StateBodyReadRoots): string | undefined {
  try {
    return readProviderStateBody(pointer, roots);
  } catch {
    return undefined;
  }
}

/**
 * Pointer for the per-turn whisper. Undefined unless this conversation has a
 * project_state head with a linked state body.
 */
export function buildStateFilePointer(
  storage: StorageReader,
  conversationKey: string,
  options: StateBodyReadRoots = {},
): StateFilePointer | undefined {
  const head = storage.getProjectState(conversationKey);
  const bodyPointer = parseLinkedStateBodyPointer(head?.obsidianPath);
  if (!head || !bodyPointer) {
    return undefined;
  }
  let status = head.status;
  let snapshot: string | undefined;

  // Read a LIVE snapshot from the body so the per-turn whisper reflects
  // mid-session edits on resumed turns (the agent should trust this over what
  // it read on an earlier turn).
  const body = readLinkedStateBody(bodyPointer, options);
  if (body) {
    status = extractFrontmatterStatus(body) ?? status;
    const quickRead = extractSection(body, "Quick Read");
    if (quickRead) {
      snapshot = quickRead.length > 400 ? `${quickRead.slice(0, 400)}…` : quickRead;
    }
  }

  return { path: bodyPointer.displayPath, project: head.title, status, ...(snapshot ? { snapshot } : {}) };
}

/**
 * Reseed block for cold-start / rotation: the project arc's current state. Lets
 * an agent that just lost its provider session re-orient on where things stand.
 * Returns undefined when this conversation is not bound to a project arc.
 */
export function renderProjectStateBlock(
  storage: StorageReader,
  conversationKey: string,
  options: StateBodyReadRoots = {},
): string | undefined {
  const head = storage.getProjectState(conversationKey);
  if (!head) {
    return undefined;
  }
  const bodyPointer = parseLinkedStateBodyPointer(head.obsidianPath);

  // Read the canonical markdown body live so reseed reflects the current
  // narrative. Tests omit provider roots to stay hermetic and fall back to the
  // DB head + working set.
  const body = bodyPointer ? readLinkedStateBody(bodyPointer, options) : undefined;
  const status = (body ? extractFrontmatterStatus(body) : undefined) ?? head.status;

  const lines: string[] = [`Project: ${head.title} (status: ${status})`];

  const quickRead = (body ? extractSection(body, "Quick Read") : undefined) ?? head.quickRead?.trim();
  if (quickRead) {
    lines.push(`Quick read: ${quickRead}`);
  }

  if (bodyPointer) {
    lines.push(
      `State file: ${bodyPointer.displayPath} — read it before responding; update it after changes.`,
    );
  }

  const bodyItems = body ? extractBullets(body, "Open Items") : [];
  if (bodyItems.length > 0) {
    lines.push("Open items:");
    for (const item of bodyItems.slice(0, 12)) {
      lines.push(`- ${item}`);
    }
  } else {
    const openItems = storage.listActiveContextItems({
      scope: { projectId: conversationKey },
      limit: 10,
    });
    if (openItems.length > 0) {
      lines.push("Open items:");
      for (const item of openItems) {
        lines.push(`- [${item.kind}] ${item.title ?? item.key}: ${item.summary}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Per-turn save bookkeeping: bump updated_at and record the current provider
 * session id (session chaining for deep recall). No-op unless a head exists —
 * we do not auto-create heads for every conversation.
 */
export function refreshProjectHeadOnTurn(
  storage: StorageWriter,
  conversationKey: string,
  prevSessionId: string | null | undefined,
): void {
  const head = storage.getProjectState(conversationKey);
  if (!head) {
    return;
  }
  storage.upsertProjectState({
    projectId: conversationKey,
    ...(prevSessionId?.trim() ? { prevSessionId: prevSessionId.trim() } : {}),
  });
}
