import { reclaimCall } from "./reclaim-io.js";
import { AskClock, reconcileAgentAsks, askPayload, askRow, closeThreadAsk, finishAsk, openAsk, recordAskRow, reopenAsk, resolveSpec, validateAsk, type AskSpec, type AskStatus, type LedgerClosure } from "./asks.js";
import { createManagedBrowser } from "./managed-browser.js";
import { createManagedMapping, mappingBackend, inspectMappingConfig, type MappingIdentity } from "./managed-mapping.js";
import { reserveServeMapping, serveStatus, removeServeSession } from "./serve-transport.js";
import { recoveryPaused } from "./recovery-admission.js";
import { git } from "./git.js";
import { FanOuts, type FanOutInput } from "./fan-outs.js";
import { ResourceLeases } from "./leases.js";
import { createManagedProcess, externalMappings, externalResourceProcesses, processBackend, inspectProcess } from "./managed-process.js";
import { approvedWork, prAsset, readMergeFacts, mergeReady, type ReadMergeFacts, type PrRef } from "./merge-facts.js";
import { codexIncompatible, validSessionProfile, profileHash, redactProfile, sessionHash, type SessionProfile } from "./session-profile.js";
import { stall } from "./stall.js";
import { readPressure, hostMemory, warmthLimits, overBudget, ownerFits, diskFits, type Pressure, type WarmthLimits } from "./warmth.js";
import { TriggerService, describeTrigger, checkCommand, type TriggerRow } from "./triggers.js";
import { CatchupStore, lintNote, lintUpdate } from "./catchup.js";
import { Ledger, upgradeNote, coolingNote } from "./ledger.js";
import { Worktrees } from "./worktrees.js";
import { missingAnswerRun, MISSING_ANSWER_WAKE_PREFIX, UNCLEAR_ASK_WAKE_TEXT, AGENT_STALL_WAKE_TEXT, wakeCause, closingHandoff, MISSING_HANDOFF_WAKE_TEXT, RERECORD_ASK_WAKE_TEXT, NEXT_KINDS, STALL_WAKE_TEXT, STALL_WAKE_TEXTS, UNADDRESSED_WAKE_TEXT, WHO_HELP, type Handoff, type NextKind, type OpenAsk, type RecordedHandoff } from "./handoff.js";
import { deskPerson, isDeskPerson } from "./people.js";
import { renderCarry } from "./carry.js";
import { UsageLedger } from "./usage.js";
import { BUDGET_FRESH_AT, budgetDefaults, budgetState, raised, type BudgetState } from "./budget.js";
import { dayStart } from "./usage.js";
import { describeFresh, freshModeFor, freshPacket, freshPolicy, Handoffs, HANDOFF_PROMPT, type FreshPolicy, type FreshReason } from "./fresh.js";
import { projectSlug } from "./claude/project-store.js";
import { atlasReader, type MemoryReader } from "./memory.js";
import { POINTER, addAskLint, askLintOn, askLintWake, classifyAsk, classifyDeclaredAsk, mayWake, normalizeAsk, sameAsk } from "./ask-lint.js";
import { existsSync, readFileSync, statSync, realpathSync, lstatSync } from "node:fs";
import type { QuotaHistory } from "./forecast.js";
import { capacitySnapshot, PolicyAccounts } from "./capacity.js";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { isLiveHost, readHostLedgers } from "./host-ledger.js";
import { speaksSupported } from "./remote-runtime.js";
import { randomUUID } from "node:crypto";
import type { Admission, ChangeRow, Entity, MessageOrigin, RunRow, ThreadRole, ThreadRow } from "./store.js";
import { isThreadRole, LoomStore, THREAD_ROLES } from "./store.js";
import { durationMs, Presence, VetoClock } from "./presence.js";
import { answerText, defaultRuleChoice, lintBrief, lintLog, loadBoard, reviseBrief, undoText, type Board, type BriefChange, type DecisionBrief, type DecisionRow, type RuleChoice, type RuleProposal } from "./decisions.js";
import { asItStands, canPromote, generalizeRule, oneLine, parseProposedRule, publicRule, Rules, sameScope, similarOption } from "./rules.js";
import { scopeCovers } from "./decisions.js";
import { HostOutcomeUnknown, PEER_WAKE_TEXT, holdsWork, taskEnded, type BackgroundTask, type Runtime, type RuntimeEvent, type RuntimeFailure, type RuntimeSession } from "./runtime.js";
import type { AccountPool } from "./pool.js";
import { decodeImages, type AttachmentFiles, type DecodedImage, type ImageUpload, type TurnImage } from "./attachments.js";

/** A lead's fresh packet asked for a handoff; the session it opens isn't known yet. */
const PACKET_PENDING = "packet";

export type Command =
  | { type: "fan_out.create"; commandId: string; threadId: string; input: FanOutInput }
  | { type: "ask.resolve"; commandId: string; askId: string; revision?: number; outcome: "done" | "withdrawn"; step?: string; note?: string; by: "person" | "desk" | "agent" }
  | { type: "asks.rerecord"; commandId: string; dryRun?: boolean }
  | { type: "handoff.record"; ask?: AskSpec; commandId: string; threadId: string; owner?: RecordedHandoff["owner"] | "agent"; kind?: NextKind; who?: string | null; text: string; assets?: { kind: string; title: string; url: string }[]; buildInstruction?: string; requestedAction?: "merge"; to?: string | null; waitingOn?: string | null; messageId?: string | null; runId?: string | null; at?: number; source?: "tool" }
  | { type: "trigger.create"; commandId: string; threadId: string; kind: string; spec: unknown; note: string; timeoutMinutes?: number }
  | { type: "trigger.cancel"; commandId: string; triggerId: string }
  | {
      type: "submit";
      tier?: string;
      commandId: string;
      threadId?: string;
      text: string;
      session?: SessionProfile;
      context?: string;
      /** Required when threadId is absent: Loom creates the thread. */
      cwd?: string;
      /** Instead of cwd: Loom makes a fresh worktree of this checkout and runs the thread there. */
      worktree?: { repoPath: string } | boolean | "auto" | "local" | "worktree";
      /** A worker may reuse its parent's existing build worktree. */
      sameTree?: boolean;
      provider?: string;
      /** The account to start on, if it has room (a name or alias). */
      account?: string | null;
      /** The accounts this thread may ever run on (names or aliases); the pool never moves it elsewhere. */
      accounts?: string[];
      accountsFrom?: "policy";
      kind?: string;
      title?: string | null;
      /** The title is a stand-in from the prompt: Loom may name the thread itself. */
      autoTitle?: boolean;
      /** The checkout the thread works on, when cwd is a subfolder or a copy of it. */
      repo?: string;
      /** Not the owner's words: another agent's conversation (desk mail). Shown as such, kept out of the owner's conversation. */
      origin?: MessageOrigin;
      /**
       * Into the turn in progress when the thread is busy (read as soon as its current step finishes),
       * instead of queueing a run behind it. An idle thread starts a turn as usual.
       */
      steer?: boolean;
      /** Images on the message (PNG, JPEG, GIF or WebP data URLs; 10 MB each, 8 at most). */
      attachments?: ImageUpload[];
      /** A new thread's role (default interactive) and owner (a desk item id). */
      role?: ThreadRole;
      parentThreadId?: string | null;
    }
  /** `allow`: the owner picked this account for a thread not allowed on it (one tap on a held thread); it's added to the allowed list. */
  | { type: "move"; commandId: string; threadId: string; account: string; allow?: boolean }
  | { type: "answer"; commandId: string; requestId: string; answer: unknown }
  /** With runId: only if that run is still the one in progress (a stale Stop never hits the next turn). */
  | { type: "interrupt"; commandId: string; threadId: string; runId?: string }
  | { type: "stop"; commandId: string; threadId: string }
  | { type: "settle"; commandId: string; threadId: string; settledAt?: number }
  | { type: "settle.undo"; commandId: string; threadId: string; settledAt: number }
  | { type: "clear" | "clear.undo"; commandId: string; threadId: string; clearedAt: number }
  | { type: "unsettle"; commandId: string; threadId: string }
  | { type: "rename"; commandId: string; threadId: string; title: string }
  /** Who the thread works for; parentThreadId null clears its owner, absent keeps it. */
  | { type: "role"; commandId: string; threadId: string; role: ThreadRole; parentThreadId?: string | null }
  | { type: "delete"; commandId: string; threadId: string }
  /** The agent brings a decision to its owner as a brief (docs/specs/decisions-and-delegation.md). */
  | { type: "decision.request"; commandId: string; threadId: string; brief: unknown }
  /** The owner's answer to a brief: an option, or their own words; it wakes the thread with them. */
  | { type: "decision.answer"; commandId: string; decisionId: string; option?: string | null; text?: string | null; reason?: string | null; rule?: RuleChoice | null; revision?: number | null }
  /**
   * A brief revised in place (TGO-1079): the same id, the next revision, the change logged with why. From the thread
   * that raised it, its workers at any depth, or its lead or carrier.
   */
  | { type: "thread.seen"; commandId: string; threadId: string; at: number }
  | { type: "decision.keep"; commandId: string; threadId: string; decisionId: string; why: string }
  | { type: "decision.update"; commandId: string; threadId: string; decisionId: string; changes: unknown; why: string }
  /**
   * An agent closes a brief: no longer needed (withdrawn), moot (new information settled it), or the owner answered it
   * in the conversation. Withdrawn or moot from anyone in its chain (as decision.update); answered-in-chat from any
   * thread in its chain too, or one that named the id (the owner may answer in a lead's conversation), with the
   * owner's rule choice and reason.
   */
  | { type: "decision.close"; commandId: string; threadId: string; decisionId: string; outcome: "withdrawn" | "moot" | "answered-in-chat"; option?: string | null; note?: string | null; rule?: RuleChoice | null; reason?: string | null }
  /** Level 4, act and tell: the agent logs what it decided and did, for "Decided for you". */
  | { type: "decision.log"; commandId: string; threadId: string; class: string; summary: string; undo?: string | null; ref?: string | null; rule?: string | null; scope?: string | null; dissent?: string | null }
  /** The owner changes how an answered brief counts: Always (make its rule), Ask me next time, or Just this once. */
  | { type: "decision.rule"; commandId: string; decisionId: string; rule: RuleChoice; reason?: string | null; /** D-61: the proposed rule's text as the owner saw it, when confirming one. */ proposal?: string | null }
  /** The owner read the weekly review: the rules it showed as due come up again after another review period. */
  | { type: "rules.reviewed"; commandId: string; ruleIds: string[] }
  /** A standing rule's words, revised (the owner's own policy, as D-61 rewrote R-2): scope, what to do, reason. */
  | { type: "rule.retire"; commandId: string; ruleId: string; reason: string }
  | { type: "rule.update"; commandId: string; ruleId: string; scope?: string | null; do?: string | null; reason?: string | null }
  /** D-61: the named rules (made from a single first approval) go back to being precedents. */
  | { type: "rules.keepAsPrecedents"; commandId: string; ruleIds: string[] }
  /** The owner reverses something decided for them: "I wouldn't have" (undo false), or Undo, which wakes the thread. */
  | { type: "decision.reverse"; commandId: string; decisionId: string; note?: string | null; undo: boolean }
  | { type: "decision.confirm"; commandId: string; decisionId: string }
  /** A lead's line of news for the owner's catch-up (docs/specs/catch-up.md): the desk reads it into its ledger. */
  | { type: "update.post"; commandId: string; threadId: string; kind: unknown; title: unknown; detail?: unknown; moment?: unknown; refs?: unknown; shot?: unknown; supersedes?: unknown }
  /** A lead sets its space's chapter headline and status: chapter metadata, never a line of news. */
  | { type: "chapter.note"; commandId: string; threadId: string; headline?: unknown; status?: unknown };

export interface CommandResult {
  fanOutId?: string;
  probes?: { label: string; threadId: string }[];
  triggerId?: string;
  threadId?: string;
  runId?: string;
  decisionId?: string;
  /** update.post: the line's id (U-<n>), for a later one that supersedes it; chapter.note: N-<n>. */
  updateId?: string;
  noteId?: string;
  /** decision.request: its level on the board, whether it can become a rule, and the brief it replaced. */
  level?: number;
  /** decision.update: the brief's revision now, what changed, and whether the change was material. */
  revision?: number;
  changed?: string;
  material?: boolean;
  candidate?: boolean;
  superseded?: string | null;
  /** Phase 3: the standing rule an answer made or a log cited; what a reversal suspended or demoted. */
  rule?: string | null;
  /** rules.keepAsPrecedents: the rules it turned back into precedents. */
  kept?: string[];
  /** decision.request: the earlier approval (precedent) this brief matches (D-61). */
  precedent?: string | null;
  /** decision.rule: the state of the rule the decision backed, after the change. */
  ruleState?: string | null;
  suspended?: string | null;
  demoted?: { from: number; to: number } | null;
  /** The words went into the turn in progress (submit with steer). */
  steered?: boolean;
  /** A decision resolved: the other threads whose open ask pointed at it, told and woken (passOnResolved). */
  told?: string[];
  asks?: { threadId: string; title: string | null; ask: OpenAsk; queued: boolean }[];
}

export class LoomCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One live update. Change events carry a sequence number; streaming deltas do not. */
export type LoomEvent =
  | { seq: number; threadId: string; entity: Entity; entityId: string; data: unknown }
  | { seq?: undefined; threadId: string; type: "delta"; runId: string; text: string };

/** After this many automatic continues in a row, a thread waits for a person. */
export const MAX_CONTINUE_CHAIN = 3;

export const RESTART_NOTE =
  "Loom restarted while you were working, so your last turn was cut off and any background tasks it started were stopped. Continue where you left off.";

export const LIMIT_CONTINUE_NOTE =
  "Your last turn stopped because the account it ran on hit its usage limit. You are now on another account with the same conversation. Continue where you left off.";

export const OVERLOAD_RETRY_NOTE =
  "Loom is retrying your last turn: the model was at capacity and turned it away, so Loom waited and is sending it again in the same conversation. If you had already started on it, continue where you left off rather than starting over.";

/**
 * Pauses before each retry of a turn the provider turned away as overloaded ("Selected model is at capacity"):
 * capacity is the model's, not the account's, so the same session waits and tries again. After the last one
 * the run fails as before. On 10/21 a worker's turn failed on the first refusal and sat Failed on the desk.
 */
export const OVERLOAD_RETRY_MS = [60_000, 3 * 60_000, 10 * 60_000, 20 * 60_000];

/** A run moves between accounts at most this many times before it waits for a person. */
export const MAX_LIMIT_MOVES = 6;

/** How long a thread waits for capacity when no reset time is known. */
const CAPACITY_RETRY_MS = 5 * 60_000;

/** Failures that would fail the next queued run the same way. Those runs wait instead. */
const HOLD_QUEUE_ON: ReadonlySet<RuntimeFailure["kind"]> = new Set(["usage_limit", "auth"]);

/** Long enough for the harness to start the wake turn that reports a finished background task. */
export const BACKGROUND_SETTLE_MS = 30_000;
/**
 * The model a new thread gets for its role (docs/architecture/loom.md "Models by role"). Absent: the harness
 * default, for the owner's threads and leads. Set once, as the thread's first turn starts, so a session
 * never switches models (that would throw away its prompt cache); the session profile's model overrides it.
 */
export const ROLE_MODELS: Partial<Record<string, string>> = { probe: "codex", worker: "codex", ops: "haiku", qa: "codex:gpt-6.1-sol@medium" };
export const ROLE_FALLBACK_MODELS: Partial<Record<string, string>> = { probe: "sonnet", worker: "sonnet", ops: "haiku", qa: "sonnet" };
/**
 * How long an automatic turn (a wake, another agent's mail) waits before it starts, so a burst of them becomes one
 * turn: each turn rereads the whole context, so fewer turns is what saves tokens. main.ts sets it; tests start at 0.
 */
export const AUTOMATIC_SETTLE_MS = 60_000;

/**
 * Every host open waits in one warmth queue. A step that never settles (a pressure read stuck on a
 * wedged disk, a host that never hangs up) would strand every cold thread behind it, as it did for
 * 8.5 hours on 10/18: past this the queue moves on without it.
 */
export const WARMTH_STEP_MS = 90_000;
/** How long a worker's host stays up after its turn (LOOM_WORKER_WARM_FLOOR_MS): long enough for a prompt reply from its parent. */
export const WORKER_WARM_FLOOR_MS = Number(process.env.LOOM_WORKER_WARM_FLOOR_MS) > 0 ? Number(process.env.LOOM_WORKER_WARM_FLOOR_MS) : 120_000;
/** A pressure reading that takes longer than this is replaced by the last good one. */
export const PRESSURE_READ_MS = 10_000;
/**
 * How long maintenance may hold the owner's own message. A drain waits for every running turn, so on 10/24 one
 * held owner messages for up to 12 minutes behind another thread's 13-minute turn. Past this the owner's turn starts
 * anyway: hosts outlive a coordinator restart, so the drain loses nothing but its count of zero.
 */
export const MAINTENANCE_OWNER_GRACE_MS = 120_000;

/** Keep or Fresh start whose asker stopped waiting before its turn in the mailbox came (Codex review on #840). */
const ABANDONED = { ok: false, code: "abandoned", message: "The request was given up before it could apply; nothing changed" } as const;

const millions = (n: number) => `${Math.round(n / 100_000) / 10}M`;

export class LoomHost {
  readonly triggers: TriggerService;
  readonly fanOuts: FanOuts;
  private readonly sessionHashes = new Map<string, string>();
  private readonly heartbeats = new Map<string, { runId: string; at: number }>();
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly opening = new Map<string, Promise<RuntimeSession | null>>();
  /** One pending kick per thread for an owner's message maintenance holds, at the end of its grace. */
  private readonly graceKicks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly mailboxes = new Map<string, Promise<void>>();
  /** Bumped whenever a thread's session is replaced, so a closed session's late events are dropped. */
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<(event: LoomEvent) => void>();

  private retiredJobs = 0;
  private readonly worktreeTimer: ReturnType<typeof setInterval>;
  private readonly reclaiming = new Map<string, Promise<unknown>>();
  readonly worktrees: Worktrees | null;
  readonly leases: ResourceLeases;
  private readonly leaseTimer: ReturnType<typeof setInterval>;
  private readonly warmthTimer: ReturnType<typeof setInterval>;
  private diskClosing = false;
  private diskPass: Promise<unknown> | null = null;
  private diskRetryAt = 0;
  private diskEpisode = false;
  private warmthQueue: Array<{ start: () => void; priority: () => boolean }> = [];
  private warmthBusy = false;
  /** Hosts closing to cool, with the close (bounded): a turn for one waits for it, then opens a new host. */
  private readonly cooling = new Map<string, Promise<boolean>>();
  /**
   * Threads whose live host was just closed for an account move, with a run waiting to reopen it: that one
   * reopen, within 30 s, takes the freed slot without asking admission.
   */
  private readonly replacing = new Map<string, number>();
  private takeReplacement(id: string): boolean {
    const at = this.replacing.get(id);
    this.replacing.delete(id);
    return at !== undefined && Date.now() - at < 30_000;
  }
  private pressureEpisode = false;
  private readonly movedAccounts = new Set<string>();
  private readonly upgradeTimer: ReturnType<typeof setInterval>;
  /** When each thread's background work last dropped to none (see backgroundJustEnded). */
  private readonly backgroundEndedAt = new Map<string, number>();
  readonly ledger: Ledger;
  readonly usage: UsageLedger;
  readonly handoffs: Handoffs;
  readonly freshPolicy: FreshPolicy;
  private readonly budgets: Record<ThreadRole, number>;
  private readonly budgetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Shadow mode logs a would-be reset once per thread and context reading. */
  private shadowed = new Map<string, string>();
  private memoryReader: MemoryReader | undefined;
  readonly presence: Presence;
  private readonly vetoClock: VetoClock;
  readonly askClock: AskClock;
  /** Standing rules and learned class levels (phase 3), mirrored to the profile's rules file when one is given. */
  readonly rules: Rules;
  /** What leads write for the owner's catch-up (catchup.ts). */
  readonly catchup: CatchupStore;
  private readonly rulesTimer: ReturnType<typeof setInterval>;
  private readonly policyAccounts = new PolicyAccounts();
  private recovering = false;
  private detaching = false;

  private readonly waits = new Map<string, ReturnType<typeof setTimeout>>();
  /** Commands awaiting an external result, by commandId, so retries share the same delivery. */
  private readonly preparing = new Map<string, Promise<CommandResult>>();

  constructor(
    readonly store: LoomStore,
    private readonly runtimes: Record<string, Runtime>,
    private readonly options: {
      readMergeFacts?: ReadMergeFacts;
      pressure?: () => Promise<Pressure>;
      recoveryHealthFile?: string;
      warmthLimits?: Partial<WarmthLimits>;
      /** How long one warmth step may hold the queue (WARMTH_STEP_MS). */
      warmthStepMs?: number;
      /** Workers cool this long after their last activity (default WORKER_WARM_FLOOR_MS). */
      workerWarmFloorMs?: number;
      /** How long a machine pressure reading may take (PRESSURE_READ_MS). */
      pressureReadMs?: number;
      /** How long maintenance holds the owner's own message (MAINTENANCE_OWNER_GRACE_MS). */
      maintenanceOwnerGraceMs?: number;
      pool?: AccountPool;
      quotaHistory?: QuotaHistory;
      releasesDir?: string;
      loomHome?: string;
      maxHostAgeMs?: number;
      upgradeIntervalMs?: number;
      /** How long after background work ends before the thread counts as a safe point. */
      backgroundSettleMs?: number;
      /** The model each role or task tier starts with (ROLE_MODELS); without it every thread uses the harness default. */
      roleModels?: Partial<Record<string, string>>;
      /** How long an automatic turn waits for others to fold into it (AUTOMATIC_SETTLE_MS); 0 starts it at once. */
      automaticSettleMs?: number;
      /** The pauses before each retry of an overloaded turn (OVERLOAD_RETRY_MS); tests shorten them. */
      overloadRetryMs?: number[];
      /** Makes a new thread's worktree (git.ts createWorktree); without it, worktree submits are refused. */
      createWorktree?: (repoPath: string, threadId: string, options?: { fromHead?: boolean }) => Promise<{ path: string; repo?: string; branch?: string }>;
      /** Names a new thread from its first message (claude/titler.ts); null keeps the draft title. */
      fanOutArtifacts?: string;
      fanOutArtifactUrl?: string;
      titler?: (text: string, account: string | null) => Promise<string | null>;
      /** Writes one rule for the pattern two similar approvals share (D-61); null keeps the plain one. */
      ruleWriter?: (briefs: Array<{ ask: string; proposedRule: string }>) => Promise<string | null>;
      /** Where messages' images are kept; without it, a message with images is refused. */
      attachments?: AttachmentFiles;
      /** The profile's rules file (rules.ts rulesFilePath): imported once, then written as the rules table's mirror. */
      rulesFile?: string | null;
      /**
       * What the owner has seen in a lead's space since `since` (catch-up "turn preamble"), as a block for the start of
       * its turn; null when there's nothing (or the desk can't be read). Only space defaults get it.
       */
      seenBrief?: (threadId: string, since: number) => Promise<string | null>;
      /** When threads start fresh sessions (fresh.ts); default from LOOM_FRESH_* (shadow mode). */
      fresh?: FreshPolicy;
      /** Each role's daily budget in input tokens (budget.ts); default BUDGET_DEFAULTS with LOOM_BUDGET_* overrides. */
      budgets?: Partial<Record<ThreadRole, number>>;
      /** Loom's shared copy of Claude transcripts, so a fresh session can name its predecessor's. */
      claudeProjectsDir?: string;
      /** Reads what Tango's memory kept from threads (memory.ts); default: Atlas, read only. */
      memories?: MemoryReader;
    } = {},
  ) {
    this.adoptPolicyAccounts();
    this.ledger = new Ledger(store);
    const managedProcessBackend = options.loomHome ? processBackend(options.loomHome) : undefined;
    this.leases = new ResourceLeases(store, { warm: id => this.sessions.has(id) || this.opening.has(id), backends: { dev_server: managedProcessBackend, browser: managedProcessBackend, build: managedProcessBackend, mapping: managedProcessBackend ? mappingBackend(serveStatus, managedProcessBackend, removeServeSession) : undefined } });
    this.leaseTimer = setInterval(() => { if (!this.detaching && !this.recovering) void this.leases.reconcile().catch(error => console.warn("Lease reconciliation failed", error)); }, 60_000);
    this.leaseTimer.unref?.();
    this.catchup = new CatchupStore(store.db, () => store.now());
    this.usage = new UsageLedger(store);
    this.handoffs = new Handoffs(store);
    this.freshPolicy = options.fresh ?? freshPolicy();
    this.budgets = { ...budgetDefaults(), ...options.budgets };
    this.presence = new Presence(store, () => { try { return durationMs(loadBoard().defaults.idle_after, 10 * 60_000); } catch { return 10 * 60_000; } });
    this.vetoClock = new VetoClock(store, this.presence, (row, option) => this.runDefault(row, option), (row) => store.tx(() => store.noteThread(row.thread_id)), undefined, (row, error) => {
      const text = `Loom: your wait on decision ${row.id} cannot be checked: ${error}`;
      // One wake per episode (the clock calls this once at the third failure); only a still-pending copy is skipped.
      if (!store.runs(row.thread_id).some(run => run.source === "wake" && run.text === text && (run.status === "queued" || run.status === "running"))) store.tx(() => {
        store.createRun(row.thread_id, "wake", text);
        store.updateThread(row.thread_id, { settled_at: null });
      });
      void this.kick(row.thread_id).catch(error => console.warn("Veto error wake could not start", error));
    }, () => this.returnExpiredKeptDiscussions());
    this.rules = new Rules(store, { file: options.rulesFile ?? null, board: () => loadBoard() });
    try {
      store.tx(() => this.rules.importFile());
      this.rules.changed();
    } catch (e) { console.warn("Reading the rules file failed", e); }
    // Hourly: a demoted class with a clean 30 days goes back up, and rules unused for 90 days retire.
    this.rulesTimer = setInterval(() => { try { store.tx(() => this.rules.tick()); } catch (e) { console.warn("Rules tick failed", e); } }, 60 * 60_000);
    this.rulesTimer.unref?.();
    this.warmthTimer = setInterval(() => { void this.checkWarmth().catch(e => console.warn("Warmth check failed", e)); }, 60_000);
    this.warmthTimer.unref?.();
    this.worktrees = options.loomHome ? new Worktrees(store, options.loomHome, {
      gh: (args, cwd) => checkCommand("gh", args, cwd, 30_000),
      live: (id) => this.sessions.has(id) || this.opening.has(id),
      leased: (id) => this.leases.holds(id),
      diskFree: options.pressure ? async () => (await options.pressure!()).disk.freeBytes : undefined,
      active: () => !this.diskClosing && !this.detaching && !this.recovering,
      cool: async (id) => {
        if (this.detaching || this.recovering || !this.eligible(id, this.limits().warmFloorMs, true)) return false;
        return this.coolOne(this.store.thread(id)!);
      },
      // A finished thread's idle session is ended so its worktree can go (its next message reopens both).
      release: (id) => this.closeSession(id),
      mailbox: (id, work) => this.inMailbox(id, async () => {
        const pending = work();
        this.reclaiming.set(id, pending);
        try { return await pending; } finally { this.reclaiming.delete(id); }
      }),
    }) : null;
    // Report-only until the owner turns it on (LOOM_WORKTREE_RECLAIM=on): the timer then removes and shrinks.
    this.worktreeTimer = setInterval(() => {
      if (this.detaching || this.recovering) return;
      this.retireJobs();
      void this.worktrees?.reclaimScheduled(process.env.LOOM_WORKTREE_RECLAIM !== "on").catch((e) => console.warn("Worktree reclaim failed", e));
    }, 30 * 60_000);
    this.worktreeTimer.unref?.();
    this.triggers = new TriggerService(store, (id) => { void this.kick(id); });
    this.askClock = new AskClock(store, id => { void this.kick(id); });
    this.fanOuts = new FanOuts(store, this.triggers, options.loomHome ?? join(homedir(), ".tango", "loom"), {
      create: (parent, input, label, profile) => {
        const tier = (options.roleModels ?? ROLE_MODELS)[input.tier ?? "probe"] ?? "codex";
        const explicit = input.provider && input.provider !== "auto";
        let provider = explicit ? input.provider! : tier.startsWith("codex") ? "codex" : "claude";
        let placement = this.placeNewThread(provider, null, input.accounts ?? null, input.accounts ? undefined : "policy", parent.repo ?? parent.cwd);
        if (!explicit && !input.accounts && provider === "codex" && (!this.runtimes.codex || options.pool && !placement.account)) {
          provider = "claude";
          placement = this.placeNewThread(provider, null, null, "policy", parent.repo ?? parent.cwd);
        }
        if (!this.runtimes[provider]) throw new Error(`Unknown provider ${provider}`);
        const chosen = provider === "claude" && tier.startsWith("codex") ? "sonnet" : tier.replace(/^codex:?/, "");
        const [model, effort] = chosen.split("@");
        const thread = store.createThread({ kind: "probe", title: label, titleSource: "given", cwd: parent.cwd, repo: parent.repo,
          provider, ...placement, accountsSource: input.accounts ? null : "policy", parentThreadId: `loom:${parent.id}` });
        store.updateThread(thread.id, { session_profile: JSON.stringify({ ...profile, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }) });
        // Placement is counted before the next item, so batches spread across the normal pool.
        if (placement.account) options.pool?.placed(provider, placement.account);
        return store.thread(thread.id)!;
      },
      ready: () => !this.recovering && !this.detaching,
      kick: id => this.kick(id), close: id => this.closeSession(id),
      stop: async id => { if (store.thread(id)) await this.execute({ type: "stop", threadId: id, commandId: randomUUID() }); },
    }, options.fanOutArtifacts, options.fanOutArtifactUrl);
    store.onCommit = (changes) => {
      this.publishChanges(changes);
      for (const c of changes) {
        if (c.entity === "thread" || c.entity === "run") queueMicrotask(() => {
          if (this.detaching) return;
          this.triggers.threadChanged(c.thread_id, c.entity === "run" && ["completed", "failed"].includes(this.store.run(c.entity_id)?.status ?? ""));
          void this.fanOuts.tick().catch(e => console.warn("Fan-out update failed", e));
        });
      }
    };
    this.upgradeTimer = setInterval(() => { void this.checkUpgrades().catch((error) => console.warn("Release upgrade failed", error)); }, options.upgradeIntervalMs ?? 60_000);
    this.upgradeTimer.unref?.();
  }

  async resourceInventory() {
    const [processes, mappings] = await Promise.allSettled([externalResourceProcesses(), externalMappings()]);
    return {
      leases: this.leases.list(),
      external: processes.status === "fulfilled" ? processes.value : [],
      mappings: mappings.status === "fulfilled" ? mappings.value : [],
      discoveryErrors: [processes, mappings].flatMap(result => result.status === "rejected" ? [String(result.reason)] : []),
      coverage: "Managed launches only. External browser profiles, persistent tailnet mappings and ad-hoc processes are report-only; discovery is best effort.",
    };
  }

  async createResource(threadId: string, input: { runId: string; kind: "build" | "dev_server" | "browser"; command: string; args: string[]; cwd?: string; profile?: "exclusive" } | { runId: string; kind: "browser"; managed: true } | { runId: string; kind: "mapping"; localPort: number; httpsPort: number }) {
    return this.inMailbox(threadId, async () => {
      const thread = this.store.thread(threadId);
      const run = this.store.activeRun(threadId);
      if (!thread || !run || thread.status === "stopped" || !this.options.loomHome || this.detaching || this.recovering) throw new LoomCommandError("conflict", "Managed creation requires an active run and a ready Loom home");
      if (input.runId !== run.id) throw new LoomCommandError("conflict", "Resource run is stale; retry from the current Loom turn with its runId");
      if (thread.session_profile && JSON.parse(thread.session_profile).loomTools === false) throw new LoomCommandError("invalid", "Managed processes are disabled for isolated sessions");
      try {
        const root = realpathSync(join(this.options.loomHome, "worktrees"));
        const cwd = realpathSync(thread.cwd);
        if (lstatSync(join(this.options.loomHome, "worktrees")).isSymbolicLink() ||
            lstatSync(thread.cwd).isSymbolicLink() || !cwd.startsWith(root + sep) ||
            !this.worktrees?.owns(thread) ||
            this.worktrees.borrowed(thread) ||
            this.store.threads().some(other => other.kind !== "probe" && other.id !== threadId && resolve(other.cwd) === resolve(thread.cwd))) throw new Error("unowned cwd");
      } catch {
        throw new LoomCommandError("invalid", "Managed creation requires the target thread's Loom-owned worktree");
      }
      let launchCwd = thread.cwd;
      if (input.kind === "dev_server") {
        try {
          if (typeof input.cwd !== "string" || !input.cwd.startsWith(sep)) throw new Error("missing absolute cwd");
          const root = realpathSync.native(thread.cwd);
          launchCwd = realpathSync.native(input.cwd);
          if ((launchCwd !== root && !launchCwd.startsWith(root + sep)) || !statSync(launchCwd).isDirectory()) throw new Error("outside worktree");
        } catch {
          throw new LoomCommandError("invalid", "Dev-server cwd must resolve to an existing directory inside this thread's worktree; cd into that worktree or a subdirectory and retry (no root fallback)");
        }
      }
      if (input.kind === "browser" && "managed" in input) return createManagedBrowser(this.leases, this.options.loomHome, { threadId, runId: run.id, cwd: thread.cwd });
      if (input.kind === "mapping") {
        if (this.leases.list().some(row => row.resource_key === `browser-port:${input.localPort}` && row.thread_id !== threadId && row.state !== "reclaimed"))
          throw new LoomCommandError("conflict", "Local port belongs to another thread's browser lease; inspect resources");
        const existing = this.leases.list().find(row => row.resource_key === `serve:${input.httpsPort}` && row.state !== "reclaimed");
        if (existing) {
          const identity = JSON.parse(existing.identity) as MappingIdentity;
          const target = Object.values(identity.config?.Web ?? {})[0] as { Handlers?: Record<string, { Proxy?: string }> } | undefined;
          if (existing.thread_id !== threadId || existing.kind !== "mapping") throw new LoomCommandError("conflict", "Serve port belongs to another lease; inspect resources");
          const mapping = inspectMappingConfig(identity, await serveStatus());
          if (existing.state === "active" &&
              target?.Handlers?.["/"]?.Proxy === `http://127.0.0.1:${input.localPort}` &&
              mapping === "same" && inspectProcess(identity.process) === "same") return { lease: existing };
          // A failed activation or externally removed session can leave a live
          // watcher on a warm thread. Release only this owner's exact lease.
          if (mapping === "gone") await this.leases.release(existing.id, threadId);
          if (this.leases.list().find(row => row.id === existing.id)?.state !== "reclaimed")
            throw new LoomCommandError("conflict", "Serve port already leased or ownership changed; inspect resources");
        }
        return createManagedMapping(this.leases, { threadId, runId: run.id, reserve: () => reserveServeMapping(input.localPort, input.httpsPort) });
      }
      return createManagedProcess(this.leases, this.options.loomHome, { ...input, threadId, runId: run.id, cwd: launchCwd });
    });
  }

  async releaseResource(threadId: string, leaseId: string, runId: string) {
    return this.inMailbox(threadId, async () => {
      const thread = this.store.thread(threadId);
      const run = this.store.activeRun(threadId);
      if (!thread || !run || thread.status === "stopped" || this.detaching || this.recovering || run.id !== runId)
        throw new LoomCommandError("conflict", "Resource release requires this thread's current active runId and a ready coordinator");
      if (thread.session_profile && JSON.parse(thread.session_profile).loomTools === false)
        throw new LoomCommandError("invalid", "Managed resources are disabled for isolated sessions");
      if (!this.leases.list(threadId).some(row => row.id === leaseId))
        throw new LoomCommandError("conflict", "Lease is not owned by this thread; inspect this thread's resources");
      const lease = (await this.leases.release(leaseId, threadId)).find(row => row.id === leaseId)!;
      if (lease.state !== "reclaimed")
        throw new LoomCommandError("conflict", `Lease release not confirmed: ${lease.result ?? lease.state}; inspect resources before retrying`);
      return { lease };
    });
  }

  private inMailbox<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.mailboxes.get(id) ?? Promise.resolve()).then(work);
    this.mailboxes.set(id, result.then(() => {}, () => {}));
    return result;
  }

  // Subscriptions

  subscribe(listener: (event: LoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: LoomEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not break the host.
      }
    }
  }

  private publishChanges(changes: ChangeRow[]): void {
    for (const change of changes) {
      this.publish({
        seq: change.seq,
        threadId: change.thread_id,
        entity: change.entity,
        entityId: change.entity_id,
        data: this.entity(change.entity, change.entity_id),
      });
    }
  }

  // Reads

  entity(kind: Entity, id: string): unknown {
    const entity = this.store.entity(kind, id);
    return kind === "thread" && entity ? this.threadPayload(entity as ThreadRow) : entity;
  }

  /** state.json, re-read only when it changes: thread payloads ask for it on every change event. */
  private releaseCache: { mtimeMs: number; state: { current: string | null; pins: Record<string, string>; [key: string]: unknown } } | null = null;

  private releaseState(): { current: string | null; pins: Record<string, string>; [key: string]: unknown } {
    const file = join(this.releasesRoot(), "state.json");
    try {
      const { mtimeMs } = statSync(file);
      if (this.releaseCache?.mtimeMs !== mtimeMs) this.releaseCache = { mtimeMs, state: JSON.parse(readFileSync(file, "utf8")) };
      return this.releaseCache.state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.releaseCache = null;
      return { current: null, pins: {} };
    }
  }

  private targetRelease(thread: ThreadRow): string | null {
    const state = this.releaseState();
    const id = state.pins?.[thread.id] ?? state.current ?? null;
    // A release whose hosts this coordinator can't talk to waits for the coordinator's own restart.
    if (id && !speaksSupported(this.releasesRoot(), id)) return thread.host_release;
    return id;
  }

  private releasesRoot(): string {
    return this.options.releasesDir ?? process.env.LOOM_RELEASES_DIR ?? join(homedir(), ".tango/releases/loom");
  }

  private aged(threadId: string): boolean {
    const reported = this.sessions.get(threadId)?.hello?.startedAt;
    // Protocol-1 hosts predating startedAt still have an OS-verified start time in their ledger.
    const ledger = reported === undefined && this.options.loomHome
      ? readHostLedgers(join(this.options.loomHome, "hosts")).find((h) => h.threadId === threadId && isLiveHost(h)) : undefined;
    const started = reported ?? (ledger ? Date.parse(ledger.started) : undefined);
    const limit = this.options.maxHostAgeMs ?? Number(process.env.LOOM_MAX_HOST_AGE_MS ?? 6 * 3600_000);
    return started !== undefined && this.store.now() - started >= (Number.isFinite(limit) && limit >= 0 ? limit : 6 * 3600_000);
  }

  private threadPayload(thread: ThreadRow) {
    const target = this.targetRelease(thread) ?? thread.host_release;
    const upgrade = !thread.host_release || target === thread.host_release ? "current" as const : this.aged(thread.id) ? "max_age_pending" as const : "waiting_safe_point" as const;
    // The session profile can carry secrets (MCP env, auth headers): clients get only its hash.
    const { session_profile, ...shown } = thread;
    const discussing = this.discussingBriefs(thread.id);
    if (shown.ask && discussing.some(row => this.namedId(row.id).test(shown.ask!))) shown.ask = null;
    const open = thread.ask ? JSON.parse(thread.ask) as OpenAsk : null;
    const row = open?.id ? askRow(this.store, open.id) : undefined;
    // Old desk clients count any non-null ask. Keep pointers readable as records, without making a second owner move.
    return { ...shown, ask: open?.kind === "pointer" ? null : shown.ask, ask_record: row ? askPayload(row) : null, closingHandoff: this.latestTurnHandoff(thread.id), heartbeatAt: this.heartbeatOf(thread.id), sourceHealth: { ok: true, at: this.store.now() }, maintenance: this.maintenanceState().on, session_profile_hash: session_profile ? profileHash(JSON.parse(session_profile)) : null, warmth: this.sessions.has(thread.id) ? "warm" : "cooled", waiting_on: this.triggers.list(thread.id, "waiting").filter(t => !t.ask_id).map(t => ({ id: t.id, kind: t.kind, description: describeTrigger(t), expiresAt: t.expires_at })), target_release: target, upgrade, decision: this.openBrief(thread.id), discussing: discussing.map(row => ({ id: row.id, ask: row.ask, since: row.discussing_since, runId: row.discussing_run })), context: this.usage.summary(thread.id), budget: this.budgetOf(thread) };
  }

  releases() {
    const counts: Record<string, number> = {};
    if (this.options.loomHome) {
      for (const host of readHostLedgers(join(this.options.loomHome, "hosts"))) if (isLiveHost(host)) counts[host.release] = (counts[host.release] ?? 0) + 1;
    } else {
      for (const session of this.sessions.values()) if (session.hello && !session.hello.ended) counts[session.hello.release] = (counts[session.hello.release] ?? 0) + 1;
    }
    return { ...this.releaseState(), live_hosts: counts };
  }

  /**
   * A background task that just finished is not a safe point yet: the harness delivers its
   * completion in a wake turn a moment later, and moving the session first would lose it.
   */
  private backgroundJustEnded(threadId: string): boolean {
    const ended = this.backgroundEndedAt.get(threadId);
    return ended !== undefined && Date.now() - ended < (this.options.backgroundSettleMs ?? BACKGROUND_SETTLE_MS);
  }

  /** Share dispatch's mailbox so a timer cannot close a session while a queued turn starts. */
  async checkUpgrades(): Promise<void> {
    if (this.detaching || this.recovering) return;
    await Promise.all(this.store.threads().map((thread) => {
      const prior = this.mailboxes.get(thread.id) ?? Promise.resolve();
      const next = prior.then(async () => {
        if (this.detaching || this.recovering) return;
        await this.applyAccountMove(thread.id);
        if (await this.upgradeSession(thread.id)) await this.dispatch(thread.id);
      }).catch((error) => console.warn("Release upgrade failed", thread.id, error));
      this.mailboxes.set(thread.id, next);
      return next;
    }));
  }

  private async upgradeSession(threadId: string): Promise<boolean> {
    const thread = this.store.thread(threadId);
    if (!thread || thread.status === "stopped" || this.store.activeRun(threadId) || this.store.openRequests(threadId).length) return false;
    const intent = this.store.hostMove(threadId);
    // Only a session host reports a release; an in-process session (tests, embedders) has none to move.
    if (!intent && !this.sessions.get(threadId)?.hello) return false;
    const target = this.targetRelease(thread);
    if (!intent && (!this.sessions.has(threadId) || !target || target === thread.host_release || ((holdsWork(thread.background ? JSON.parse(thread.background) : null) || this.backgroundJustEnded(threadId)) && !this.aged(threadId)))) return false;
    if (!intent) {
      // Persist the reason before crossing the socket boundary. Recovery retries the close and queues
      // exactly one wake even if killed after closing the host or opening its replacement.
      // Work only goes at the maximum age; watchers (ambient) go at any upgrade, since closing the harness
      // stops them. Either way the agent hears what stopped, truthfully, in one wake.
      const tasks = thread.background ? JSON.parse(thread.background) as BackgroundTask[] : [];
      const note = upgradeNote(target, tasks);
      this.store.tx(() => this.store.beginHostMove(threadId, thread.host_instance_id, note));
    }
    const move = this.store.hostMove(threadId)!;
    const live = this.sessions.get(threadId);
    if (live && (!live.hello || live.hello.instanceId === move.instance_id)) {
      if (live.closeForUpgrade) {
        const frozen = await live.closeForUpgrade(this.aged(threadId));
        if (!frozen) {
          this.store.tx(() => this.store.endHostMove(threadId));
          return false;
        }
        if (Array.isArray(frozen)) {
          move.note = upgradeNote(target, frozen);
          this.store.db.prepare("UPDATE host_moves SET note = ? WHERE thread_id = ?").run(move.note, threadId);
        }
        this.sessions.delete(threadId);
        this.generations.set(threadId, (this.generations.get(threadId) ?? 0) + 1);
        this.clearBackground(threadId);
      } else await this.closeSession(threadId);
    }
    // A stop or delete may have landed while the old host was closing: don't bring the thread back.
    const current = this.store.thread(threadId);
    if (!current || current.status === "stopped") {
      this.store.tx(() => { if (this.store.thread(threadId)) this.store.endHostMove(threadId); });
      return false;
    }
    if (!await this.ensureSession(current, false, "move")) return false;
    this.store.tx(() => {
      if (move.note) this.store.createRun(threadId, "wake", move.note);
      this.ledger.event(threadId, "host_move", `Moved to release ${target}`, current.host_instance_id ?? threadId);
      this.store.endHostMove(threadId);
    });
    return true;
  }

  private limits(): WarmthLimits { return { ...warmthLimits(), ...this.options.warmthLimits }; }
  /**
   * Machine pressure, reused for 15 s: reading it runs a subprocess, and admission asks before every new
   * host, so an uncached read would delay each turn's start. Injected readings (tests) are never cached.
   */
  private pressureCache: { at: number; value: Promise<Pressure> } | null = null;
  private lastPressure: Pressure | null = null;
  private pressure(fresh = false): Promise<Pressure> {
    if (this.options.pressure) return this.bounded(this.options.pressure());
    const now = Date.now();
    if (fresh || !this.pressureCache || now - this.pressureCache.at > 15_000) {
      const value = this.bounded(readPressure(this.options.loomHome ?? process.cwd()));
      this.pressureCache = { at: now, value };
      value.catch(() => { if (this.pressureCache?.value === value) this.pressureCache = null; });
    }
    return this.pressureCache.value;
  }
  /** A reading that hangs gives way to the last good one (or, with none yet, the host count alone). */
  private bounded(reading: Promise<Pressure>): Promise<Pressure> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Pressure>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`Loom machine pressure read took over ${this.options.pressureReadMs ?? PRESSURE_READ_MS} ms; using the last reading`);
        resolve(this.lastPressure ?? { memory: { totalBytes: 0, freePct: 100 }, disk: { totalBytes: 0, freeBytes: Number.MAX_SAFE_INTEGER } });
      }, this.options.pressureReadMs ?? PRESSURE_READ_MS);
      timer.unref?.();
    });
    return Promise.race([reading.then((p) => { this.lastPressure = p; return p; }), late]).finally(() => clearTimeout(timer));
  }
  private withWarmth<T>(work: () => Promise<T>, priority = () => false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.warmthQueue.push({ priority, start: () => {
        const limit = this.options.warmthStepMs ?? WARMTH_STEP_MS;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          clearTimeout(timer);
          this.warmthBusy = false;
          this.drainWarmth();
        };
        const timer = setTimeout(() => {
          console.warn(`Loom warmth step still running after ${limit} ms; the queue moves on without it`);
          release();
        }, limit);
        timer.unref?.();
        void Promise.resolve().then(work).then(resolve, reject).finally(release);
      } });
      this.drainWarmth();
    });
  }
  private drainWarmth(): void {
    if (this.warmthBusy || !this.warmthQueue.length) return;
    const priority = this.warmthQueue.findIndex(step => step.priority());
    const [step] = this.warmthQueue.splice(Math.max(0, priority), 1);
    this.warmthBusy = true;
    step!.start();
  }
  /** Conversational assistant messages outrank background opens, without promoting scheduled jobs or peer mail. */
  private assistantTurn(id: string): boolean {
    return this.store.thread(id)?.kind === "tango-agent" && this.ownerTurnAt(id) >= 0;
  }
  private eligible(id: string, floorMs = this.limits().warmFloorMs, reclaimOwner = false): boolean {
    const t = this.store.thread(id);
    return !!t && this.sessions.has(id) && !this.opening.has(id) && (reclaimOwner || !this.reclaiming.has(id)) && !this.cooling.has(id) &&
      !this.store.activeRun(id) && !this.store.nextQueuedRun(id) && !this.store.openRequests(id).length &&
      !holdsWork(t.background ? JSON.parse(t.background) : null) && !this.leases.building(id) && !this.backgroundJustEnded(id) &&
      !this.store.pendingAccountMove(id) && !this.store.hostMove(id) && this.store.now() - this.lastActive(t) >= floorMs;
  }
  /**
   * When the thread last did something: a run queued, started or ended, or its host opened for work. Not
   * updated_at or a release move, which bookkeeping also causes: a restart reattaches every host and the
   * upgrade then moves each idle one, so none could cool for ten minutes and work that wasn't the owner's waited.
   */
  private lastActive(t: ThreadRow): number {
    const row = this.store.db.prepare(`SELECT MAX(at) AS at FROM (
      SELECT MAX(MAX(created_at, COALESCE(started_at, 0), COALESCE(ended_at, 0))) AS at FROM runs WHERE thread_id = ?
      UNION ALL SELECT MAX(at) FROM host_opens WHERE threadId = ? AND reason != 'move')`).get(t.id, t.id) as { at: number | null };
    return Math.max(t.created_at, row.at ?? 0);
  }
  private async makeRoom(extra: number): Promise<Pressure> {
    let p = await this.pressure();
    const attempted = new Set<string>();
    while (overBudget(p, this.sessions.size + extra, this.limits())) {
      if (this.detaching || this.recovering) break;
      const t = this.store.threads().filter(t => !attempted.has(t.id) && this.eligible(t.id)).map(t => ({ t, at: this.lastActive(t) })).sort((a, b) => a.at - b.at)[0]?.t;
      if (!t) {
        if (!this.pressureEpisode) console.warn("Loom machine pressure: no eligible idle host to cool");
        this.pressureEpisode = true;
        return p;
      }
      attempted.add(t.id);
      if (!(await this.coolOne(t))) continue;
      p = await this.pressure(true);  // fresh: cooling just changed it
    }
    if (!overBudget(p, this.sessions.size + extra, this.limits())) this.pressureEpisode = false;
    return p;
  }
  /**
   * Closes one idle host, keeping what its background work needs to resume; false: it wouldn't freeze, or closing
   * failed (a host that disconnects mid-close). A failure never ends the sweep: the rest still cool (Codex review on #841).
   */
  private coolOne(t: ThreadRow): Promise<boolean> {
    const session = this.sessions.get(t.id)!;
    const limit = this.options.warmthStepMs ?? WARMTH_STEP_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still closing after ${limit} ms`)), limit); timer.unref?.(); });
    // A close that fails or never finishes leaves a host that can't take a turn (a remote one has already let go of
    // it): drop it, so the next turn opens a new host and resumes the session there (Codex review on #841).
    const cooled: Promise<boolean> = Promise.race([this.coolOneNow(t, session), late])
      .catch(async (e) => {
        console.warn("Loom could not cool host; dropping it", t.id, e);
        if (this.sessions.get(t.id) !== session) return false;
        // Dropping it stops its watchers as cooling would: the next turn hears so, as it does after a cooling.
        const tasks: BackgroundTask[] = t.background ? JSON.parse(t.background) : [];
        const note = [this.store.thread(t.id)?.cooling_note, coolingNote(tasks)].filter(Boolean).join("\n") || null;
        if (note) this.store.tx(() => { if (this.store.thread(t.id)) this.store.updateThread(t.id, { cooling_note: note }); });
        await this.closeSession(t.id);
        return false;
      })
      .finally(() => { clearTimeout(timer); if (this.cooling.get(t.id) === cooled) this.cooling.delete(t.id); });
    this.cooling.set(t.id, cooled);
    return cooled;
  }
  private async coolOneNow(t: ThreadRow, session: RuntimeSession): Promise<boolean> {
    let tasks: BackgroundTask[] = t.background ? JSON.parse(t.background) : [];
    if (session.closeForUpgrade) {
      const frozen = await session.closeForUpgrade(false);
      // Given up on and dropped meanwhile, or replaced: nothing of this close applies any more.
      if (this.sessions.get(t.id) !== session) return false;
      if (!frozen) return false;
      if (Array.isArray(frozen)) tasks = frozen;
    }
    await this.closeSession(t.id);
    const note = [this.store.thread(t.id)?.cooling_note, coolingNote(tasks)].filter(Boolean).join("\n") || null;
    this.store.tx(() => {
      if (this.store.thread(t.id)) this.store.updateThread(t.id, { cooled_at: this.store.now(), cooling_note: note });
    });
    await this.leases.reconcile();
    return true;
  }

  /**
   * Workers cool right after their turn (resilient-runtime.md, roles): no ten-minute warm floor, only a short one
   * so a parent's prompt reply still finds the host up. Their next turn resumes (or starts fresh) from the store.
   */
  private async coolWorkers(): Promise<void> {
    const floor = this.options.workerWarmFloorMs ?? WORKER_WARM_FLOOR_MS;
    for (const t of this.store.threads()) {
      if (this.detaching || this.recovering) return;
      if (t.role === "worker" && this.eligible(t.id, floor)) await this.coolOne(t);
    }
  }

  // Open requests are serialized by warmthQueue; only live sessions consume slots here.
  private async admit(id: string): Promise<boolean> {
    // A turn's start never waits on a pressure subprocess: with nothing to make room for and no reading yet,
    // judge by host count alone and refresh the reading in the background (the 60 s timer handles memory).
    if (!this.options.pressure && !this.pressureCache && this.sessions.size + 1 <= this.limits().maxWarmHosts) {
      void this.pressure().catch(() => {});
      this.store.tx(() => { if (this.store.thread(id)?.admission) this.store.updateThread(id, { admission: null, admission_until: null }); });
      return true;
    }
    const p = await this.makeRoom(1);
    const limits = this.limits();
    const strict: Admission | null = !diskFits(p, limits) ? "disk_low" : p.memory.freePct < limits.minFreeMemoryPct ? "memory" : this.sessions.size + 1 > limits.maxWarmHosts ? "host_cap" : null;
    // Only the owner's own message gets past the limits: not wakes, continues, or mail from other agents. It counts
    // however long it has waited (10/19: one held past two minutes fell to the 20 GB floor), and one queued behind
    // automatic runs moves ahead of them, so the exemption only ever starts the owner's turn (Codex review on #807).
    // A continue (a turn a limit cut off) stays first and keeps the strict limits.
    let held = strict;
    if (strict) {
      const at = this.ownerTurnAt(id);
      if (at >= 0) {
        held = ownerFits(p) ? null : "disk_low";
        if (!held) this.ownerFirst(id, at);
      }
    }
    this.store.tx(() => this.store.updateThread(id, { admission: held, admission_until: null }));
    return !held;
  }
  /**
   * Where the owner's own turn waits in the thread's queue, when nothing ahead of it has started (a continue stays
   * first; `pastStarted` lets it pass one too): -1 when there is none. The owner gets past the machine limits and
   * the daily budget; nothing else does.
   */
  private ownerTurnAt(id: string, pastStarted = false): number {
    if (this.store.thread(id)?.kind === "probe") return -1;
    const queued = this.store.queuedRuns(id);
    const owners = new Set(this.store.messages(id).filter((m) => m.role === "user" && !m.origin && m.run_id !== null).map((m) => m.run_id));
    // A scheduled job's opening turn arrives as a user message with no origin, but it isn't the owner asking (10/19).
    // Later ones on that thread are (an answered decision, a reply), so only the first run is excluded.
    if (this.store.thread(id)?.kind === "tango-job") owners.delete(this.store.runs(id)[0]?.id ?? null);
    const at = queued.findIndex((r) => r.source === "user" && owners.has(r.id));
    return at >= 0 && (pastStarted || queued.slice(0, at).every((r) => !this.store.attempts(r.id).length)) ? at : -1;
  }
  /** Moves the owner's turn at `at` ahead of the automatic runs queued before it. */
  private ownerFirst(id: string, at: number): void {
    if (at <= 0) return;
    const queued = this.store.queuedRuns(id);
    const moved = [queued[at]!, ...queued.slice(0, at)];
    const positions = queued.slice(0, at + 1).map((r) => r.position);
    this.store.tx(() => moved.forEach((r, i) => this.store.db.prepare("UPDATE runs SET position = ? WHERE id = ?").run(positions[i]!, r.id)));
  }

  /** The thread's daily budget today (budget.ts): its limit with raises, and what it has sent since midnight. */
  budgetOf(thread: ThreadRow): BudgetState {
    return budgetState(thread, this.usage.summary(thread.id)?.today ?? 0, this.store.now(), this.budgets);
  }

  /**
   * Over its daily budget, a thread's automatic turns (wakes, mail, handoffs) wait for midnight; the owner's own turn
   * goes first and runs. "hold": held now; "again": the queue changed, dispatch again; "run": go ahead.
   */
  private budgetGate(thread: ThreadRow): "run" | "hold" | "again" {
    const budget = this.budgetOf(thread);
    if (!budget.limit || budget.today < budget.limit) {
      if (thread.admission === "budget") this.store.tx(() => this.store.updateThread(thread.id, { admission: null, admission_until: null }));
      return "run";
    }
    // The budget never blocks the owner: their turn goes ahead even of a requeued automatic run, which is held
    // anyway (Codex review on #846).
    const at = this.ownerTurnAt(thread.id, true);
    if (at === 0) return "run";
    if (at > 0) { this.ownerFirst(thread.id, at); return "again"; }
    if (thread.admission !== "budget" || thread.admission_until !== budget.resetsAt) {
      this.store.tx(() => {
        this.store.updateThread(thread.id, { admission: "budget", admission_until: budget.resetsAt });
        this.ledger.event(thread.id, "budget-hold", `Held: daily budget (${millions(budget.today)} of ${millions(budget.limit)}), resumes at midnight`, "");
      });
    }
    if (!this.budgetTimers.has(thread.id)) {
      const timer = setTimeout(() => { this.budgetTimers.delete(thread.id); if (!this.detaching) void this.kick(thread.id); }, Math.min(Math.max(1_000, budget.resetsAt - this.store.now() + 1_000), 2 ** 31 - 1));
      timer.unref?.();
      this.budgetTimers.set(thread.id, timer);
    }
    return "hold";
  }

  /** The owner's Raise: +50% of the thread's budget for the rest of today, and a held thread goes again. */
  raiseBudget(threadId: string): { ok: true; budget: BudgetState } | { ok: false; code: string } {
    const thread = this.store.thread(threadId);
    if (!thread) return { ok: false, code: "not_found" };
    const before = this.budgetOf(thread);
    if (!before.base) return { ok: false, code: "no_budget" };
    this.store.tx(() => {
      this.store.updateThread(threadId, { budget_raise: JSON.stringify(raised(thread, before.base, this.store.now())) });
      this.ledger.event(threadId, "budget-raise", `Budget raised for today to ${millions(this.budgetOf(this.store.thread(threadId)!).limit)}`, "");
    });
    void this.kick(threadId);
    return { ok: true, budget: this.budgetOf(this.store.thread(threadId)!) };
  }

  /** The thread's own daily budget (tokens), or null for its role's default; 0 turns the budget off for it. */
  setBudget(threadId: string, limit: number | null): { ok: true; budget: BudgetState } | { ok: false; code: string } {
    const thread = this.store.thread(threadId);
    if (!thread) return { ok: false, code: "not_found" };
    this.store.tx(() => this.store.updateThread(threadId, { budget: limit }));
    void this.kick(threadId);
    return { ok: true, budget: this.budgetOf(this.store.thread(threadId)!) };
  }

  async checkWarmth(): Promise<void> {
    if (this.detaching || this.recovering) return;
    await this.withWarmth(() => this.makeRoom(0));
    await this.withWarmth(() => this.coolWorkers());
    // Independent from admission/warmth serialization: disk scans must not stall host opens.
    void this.checkDiskPressure().catch(e => console.warn("Disk reclaim failed", e));
    // Each waiting thread retries on its own: one whose mailbox is held up must not hold up the rest.
    // An account hold has its own timer for the reset, and retries here too as soon as an allowed account has room
    // again (a usage reading can recover before the reset it advertised: Codex review on #807).
    const roomAgain = (t: ThreadRow) => !!this.options.pool?.best(t.provider, { only: this.allowedAccounts(t) });
    await Promise.all(this.store.threads().filter(t => t.admission && (t.admission !== "account_limit" || roomAgain(t))).map(t => (this.store.nextQueuedRun(t.id) ? this.kick(t.id) : this.warm(t.id)).catch(e => console.warn("Warmth retry failed", t.id, e))));
  }
  async checkDiskPressure(): Promise<void> {
    if (this.diskClosing || !this.worktrees || this.detaching || this.recovering || this.store.now() < this.diskRetryAt) return;
    if (this.diskPass) { await this.diskPass; return; }
    const dryRun = process.env.LOOM_WORKTREE_RECLAIM !== "on";
    const work = this.worktrees.withPass("disk tick", dryRun, async () => {
      const floor = (this.limits().minFreeDiskGB + 5) * 1024 ** 3;
      const target = floor + 2 * 1024 ** 3;
      const p = await reclaimCall(() => this.options.pressure ? this.options.pressure() : readPressure(this.options.loomHome ?? process.cwd()));
      if (p.disk.freeBytes >= target) this.diskEpisode = false;
      if (p.disk.freeBytes >= (this.diskEpisode ? target : floor)) {
        await this.worktrees!.logPressureSkipped(p.disk.freeBytes, this.diskEpisode ? target : floor, dryRun);
        return;
      }
      const result = await this.worktrees!.pressure(dryRun, { floorBytes: this.diskEpisode ? target : floor, targetBytes: target, idleMs: this.limits().warmFloorMs });
      if (!dryRun) this.diskEpisode = result.afterBytes < target;
      // Give APFS accounting time to settle; no-progress/dry passes back off longer.
      this.diskRetryAt = this.store.now() + (result.freedBytes > 0 ? 60_000 : 300_000);
      this.pressureCache = null;
    });
    this.diskPass = work;
    try { await work; }
    catch (error) { this.diskRetryAt = this.store.now() + 300_000; throw error; }
    finally { if (this.diskPass === work) this.diskPass = null; }
  }

  async warm(id: string) {
    return this.inMailbox(id, async () => {
      await this.applyAccountMove(id);
      const t = this.store.thread(id);
      if (!t) throw new LoomCommandError("not_found", "Thread not found");
      if (!this.sessions.has(id) && t.status !== "stopped" && this.chooseAccount(t)) {
        await this.worktrees?.restore(t);
        await this.ensureSession(this.store.thread(id)!, false, "warm");
      }
      return this.threadPayload(this.store.thread(id)!);
    });
  }
  /** Retire completed scheduled-job history; active hosts and owner asks always win. */
  retireJobs(): number {
    const configured = Number(process.env.LOOM_JOB_RETENTION_DAYS ?? 7);
    const days = Number.isFinite(configured) && configured >= 0 ? configured : 7;
    const cutoff = this.store.now() - days * 86_400_000;
    const live = new Set(this.options.loomHome ? readHostLedgers(join(this.options.loomHome, "hosts")).filter(isLiveHost).map(h => h.threadId) : []);
    let count = 0;
    this.store.tx(() => {
      for (const thread of this.store.threads()) {
        if ((thread.kind !== "tango-job" && thread.kind !== "probe") || this.sessions.has(thread.id) || this.opening.has(thread.id) || live.has(thread.id)) continue;
        if (thread.kind === "probe" && (thread.status === "running" || thread.settled_at === null || thread.settled_at >= cutoff || !this.fanOuts.retirable(thread.id))) continue;
        const runs = this.store.runs(thread.id);
        const last = runs.at(-1);
        if ((thread.kind !== "probe" && last?.ended_at == null) || (last?.ended_at != null && last.ended_at >= cutoff) || runs.some(r => r.status === "queued" || r.status === "running")) continue;
        if (this.store.openRequests(thread.id).length || this.store.openDecisions(thread.id).length) continue;
        // A job still waiting on a trigger isn't finished. Triggers have no foreign key to threads,
        // so the retired job's fired and cancelled trigger history goes with it here.
        if (this.triggers.list(thread.id, "waiting").length) continue;
        this.store.db.prepare("DELETE FROM triggers WHERE thread_id = ?").run(thread.id);
        this.releaseThreadPrecedents(thread.id);
        this.store.deleteThread(thread.id, this.worktrees?.owns(thread) ?? false);
        count++;
      }
    });
    this.fanOuts.retireEmpty();
    this.retiredJobs = count;
    console.info(`Loom job retirement: ${count} retired`);
    return count;
  }

  async machine() {
    const p = await this.pressure();
    const agents = this.options.loomHome ? await hostMemory(this.options.loomHome) : [];
    const timings = this.store.db.prepare("SELECT threadId, reason, ms, at FROM host_opens ORDER BY id DESC LIMIT 50").all() as unknown as { ms: number }[];
    const sorted = timings.map(t => t.ms).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length ? (sorted[middle]! + sorted[Math.floor((sorted.length - 1) / 2)]!) / 2 : null;
    // memory.agents in the Desk's CapacityMachine shape ({ name, processes, bytes }), one per Loom thread host.
    const desk = agents.map((a) => ({ name: this.store.thread(a.threadId)?.title ?? a.threadId, threadId: a.threadId, processes: a.processes, bytes: a.rssBytes }));
    return { at: this.store.now(), memory: { ...p.memory, agents: desk, hostsRssBytes: agents.reduce((n, a) => n + a.rssBytes, 0) }, disk: p.disk,
      retiredJobs: this.retiredJobs, worktrees: { count: await this.worktrees?.count() ?? 0 }, warm: this.sessions.size,
      cooled: this.store.threads().filter(t => !this.sessions.has(t.id)).length, limits: this.limits(), hostOpens: timings, medianOpenMs: median, stall: stall.reading() };
  }

  capacity() { return capacitySnapshot(this.store, this.options.pool, t => this.allowedAccounts(t), this.options.quotaHistory); }

  /** The stored flag only (a key lookup): read on every dispatch and payload, so no run counts here. */
  private maintenanceState(): { on: boolean; reason: string | null; since: number | null } {
    const row = this.store.db.prepare("SELECT value FROM coordinator_state WHERE key = 'maintenance'").get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { on: false, reason: null, since: null };
  }

  /**
   * Whether maintenance holds this thread's queued work: everything, except the owner's own message once it has waited
   * the grace (MAINTENANCE_OWNER_GRACE_MS). A running turn is never held.
   */
  private maintenanceHolds(threadId: string): boolean {
    if (!this.maintenanceState().on) return false;
    const at = this.ownerTurnAt(threadId);
    if (at < 0) return true;
    const due = this.store.queuedRuns(threadId)[at]!.created_at + (this.options.maintenanceOwnerGraceMs ?? MAINTENANCE_OWNER_GRACE_MS) - this.store.now();
    if (due <= 0) return false;
    // Held anywhere in dispatch (even mid-open), the owner's turn is kicked again when its grace runs out (Codex review on #1135).
    if (!this.graceKicks.has(threadId)) {
      const timer = setTimeout(() => { this.graceKicks.delete(threadId); if (!this.detaching) void this.kick(threadId); }, due + 50);
      timer.unref?.();
      this.graceKicks.set(threadId, timer);
    }
    return true;
  }

  maintenance() {
    const state = this.maintenanceState();
    const count = (status: string) => (this.store.db.prepare("SELECT count(*) AS n FROM runs WHERE status = ?").get(status) as { n: number }).n;
    return { ...state, running: count("running"), queued: count("queued") };
  }

  async setMaintenance(on: boolean, reason?: string) {
    const previous = this.maintenanceState();
    this.store.tx(() => {
      this.store.db.prepare("INSERT OR REPLACE INTO coordinator_state (key,value) VALUES ('maintenance',?)").run(JSON.stringify({ on, reason: reason ?? null, since: on ? (previous.on ? previous.since : this.store.now()) : null }));
      for (const t of this.store.threads()) this.store.touchThread(t.id);
    });
    if (!on) await Promise.all(this.store.threads().map(t => this.kick(t.id)));
    return this.maintenance();
  }

  snapshot() {
    const seq = this.store.highWater();
    const threads = this.store.threads().map((t) => ({ ...this.threadPayload(t), open_requests: this.store.openRequests(t.id).length }));
    return { seq, threads, maintenance: this.maintenanceState().on };
  }

  /**
   * What the agent checks before asking (decision_check): the class's level on the board, the tripwires, the
   * standing rules for it, and the briefs this thread already has open. Without a class: the whole board.
   */
  /** The owner is active on Tango (the desk, voice): counts toward level 3 veto windows. */
  beat(at = this.store.now(), source: string | null = null): { lastBeat: number | null } {
    this.store.tx(() => this.presence.beat(Math.min(at, this.store.now()), source));
    return { lastBeat: this.presence.lastBeat() };
  }

  /** The brief a thread is waiting on its owner for: the newest open one (one per class; see decision.request). */
  private openBrief(threadId: string) {
    const rows = this.store.openDecisions(threadId).filter(row => row.discussing_since == null);
    const row = rows.at(-1);
    return row ? { ...briefPayload(row), open: rows.length, veto: this.vetoClock.state(row) } : null;
  }

  private discussingBriefs(threadId: string): DecisionRow[] {
    return (this.store.db.prepare("SELECT * FROM decisions WHERE status='open' AND discussing_since IS NOT NULL").all() as unknown as DecisionRow[])
      .filter(row => row.thread_id === threadId || this.carriersOf(row, false).has(threadId));
  }

  private discussBriefs(threadId: string, runId: string): void {
    const rows = this.store.db.prepare("SELECT * FROM decisions WHERE status='open'").all() as unknown as DecisionRow[];
    for (const row of rows) {
      if (row.thread_id !== threadId && !this.carriersOf(row, false).has(threadId)) continue;
      this.store.db.prepare("UPDATE decisions SET discussing_since=?, discussing_run=?, discussed=discussed+1, kept_at=NULL, unaddressed_at=NULL WHERE id=?")
        .run(this.store.now(), runId, row.id);
      this.store.noteThread(row.thread_id);
      for (const carrier of this.carriersOf(row, true).keys()) this.store.noteThread(carrier);
    }
  }

  private discussionNote(runId: string): string {
    const rows = this.store.db.prepare("SELECT * FROM decisions WHERE status='open' AND discussing_run=?").all(runId) as unknown as DecisionRow[];
    return rows.map(row => `Loom: Your brief ${row.id} (${row.ask}) is in discussion because the owner replied instead of answering. Before this turn ends: revise it with decision_update, close it with decision_close (answered-in-chat, moot or withdrawn), or, if their message had nothing to do with it, put it back with decision_keep. After revising or keeping it, Loom waits until this turn ends and the owner sees the reply before returning it to Needs you, with a fallback after 30 minutes of owner active time following turn end.`).join("\n");
  }

  private returnExpiredKeptDiscussions(): void {
    this.store.tx(() => {
      const rows = this.store.db.prepare("SELECT * FROM decisions WHERE status='open' AND kept_at IS NOT NULL AND discussing_run IS NOT NULL").all() as unknown as DecisionRow[];
      for (const row of rows) {
        const run = this.store.run(row.discussing_run!);
        if (run?.ended_at != null && this.presence.activeSince(run.ended_at, this.store.now()) >= 30 * 60_000) this.returnDiscussion(row);
      }
    });
  }

  private returnDiscussion(row: DecisionRow, unaddressed = false): void {
    const carriers = this.carriersOf(row, true);
    this.store.db.prepare("UPDATE decisions SET discussing_since=NULL, discussing_run=NULL, kept_at=NULL, window_from=?, unaddressed_at=? WHERE id=?")
      .run(this.store.now(), unaddressed ? this.store.now() : null, row.id);
    this.store.noteThread(row.thread_id);
    for (const carrier of carriers.keys()) this.store.noteThread(carrier);
  }

  /** A level 3 brief the owner let pass: its default goes ahead, and the thread wakes to carry it out. */
  private runDefault(row: DecisionRow, option: string): void {
    let queued = false;
    let told: string[] = [];
    this.store.tx(() => {
      const current = this.store.decision(row.id);
      const thread = this.store.thread(row.thread_id);
      if (current?.status !== "open" || current.discussing_since != null || !thread) return;
      if (thread.status === "stopped") {
        this.store.resolveDecision(row.id, { status: "withdrawn", decided_by: "stopped" });
        // A thread elsewhere pointing the owner at it stops waiting, as when the thread is stopped with it open.
        told = this.passOnResolved(row, "the thread that raised it was stopped, so it is withdrawn", true);
        return;
      }
      const brief = JSON.parse(row.brief) as DecisionBrief;
      const chosen = brief.options.find((o) => o.key === option);
      const followed = brief.options.find((o) => o.recommended)?.key === option ? 1 : 0;
      this.store.resolveDecision(row.id, { status: "defaulted", decided_by: "default", answer_option: option, followed_recommendation: followed });
      const hours = Math.round(this.vetoClock.windowMs() / 360_000) / 10;
      this.store.createRun(row.thread_id, "wake", `Loom: decision ${row.id} (${row.ask}) had no veto after ${hours} hours of the owner's active time, so its default goes ahead: ${option}${chosen ? ` · ${chosen.label}` : ""}. Carry it out, and say so under "Decided for you" in your report.`);
      this.store.updateThread(row.thread_id, { settled_at: null });
      told = this.passOnResolved(row, `no veto, so its default went ahead: ${option}${chosen ? ` · ${chosen.label}` : ""}`, true);
      queued = true;
    });
    if (queued) void this.kick(row.thread_id);
    for (const threadId of told) void this.kick(threadId);
  }

  /** The first Loom thread up a worker's chain that is neither a worker nor a job (the desk's ownerFacingLead); none outside Loom. */
  private ownerFacingLead(worker: ThreadRow): ThreadRow | undefined {
    const seen = new Set([worker.id]);
    let parent = worker.parent_thread_id;
    while (parent?.startsWith("loom:")) {
      const thread = this.store.thread(parent.slice(5));
      if (!thread || seen.has(thread.id)) return undefined;
      if (thread.role !== "worker" && thread.role !== "ops") return thread;
      seen.add(thread.id);
      parent = thread.parent_thread_id;
    }
    return undefined;
  }

  /** Matches a decision id as a word ("D-4", not "D-41"). */
  private namedId(id: string): RegExp {
    return new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![\\w-])`);
  }

  /**
   * The Loom threads that carry a brief (TGO-1075): any other thread whose open ask or newest words name its id, and,
   * with `lead`, the lead a worker's brief goes up to (past any worker that started it, as the desk carries it).
   */
  private carriersOf(row: DecisionRow, lead: boolean, askOnly = false): Map<string, ThreadRow> {
    const raisedOn = this.store.thread(row.thread_id);
    const named = this.namedId(row.id);
    const targets = new Map<string, ThreadRow>();
    const discussionRun = row.discussing_run ? this.store.run(row.discussing_run) : undefined;
    const discussingOn = discussionRun ? this.store.thread(discussionRun.thread_id) : undefined;
    if (discussingOn && discussingOn.id !== row.thread_id) targets.set(discussingOn.id, discussingOn);
    for (const thread of this.store.threadsAskingAbout(row.id)) {
      let text = "";
      try {
        text = String((JSON.parse(thread.ask!) as { text?: unknown }).text ?? "");
      } catch {
        continue;
      }
      if (thread.id !== row.thread_id && named.test(text)) targets.set(thread.id, thread);
    }
    // The desk also carries a brief on a thread whose newest words name it, recorded ask or not (desk/asks.ts
    // carryBriefs): that thread hears it too (Codex review on #781).
    for (const { thread, text } of askOnly ? [] : this.store.threadsLastSaying(row.id)) {
      if (thread.id !== row.thread_id && named.test(text)) targets.set(thread.id, thread);
    }
    // The lead a worker's brief went up to (past any worker that started it, as the desk carries it) always hears
    // how it went: Loom tells it here rather than relying on desk mail, which can be refused. A lead outside Loom
    // is told by the desk (source-loom.ts tellCarrier). Codex review on #781.
    const parent = lead && raisedOn?.role === "worker" ? this.ownerFacingLead(raisedOn) : undefined;
    if (parent) targets.set(parent.id, parent);
    return targets;
  }

  /** The Loom threads up a thread's chain of owners (parent_thread_id), nearest first. */
  private ancestors(thread: ThreadRow): ThreadRow[] {
    const out: ThreadRow[] = [];
    const seen = new Set([thread.id]);
    let parent = thread.parent_thread_id;
    while (parent?.startsWith("loom:")) {
      const next = this.store.thread(parent.slice(5));
      if (!next || seen.has(next.id)) break;
      out.push(next);
      seen.add(next.id);
      parent = next.parent_thread_id;
    }
    return out;
  }

  /**
   * Who may revise or withdraw a brief (TGO-1079): the thread that raised it, its workers at any depth, its lead (any
   * thread up its chain), or a thread that carries it. Everyone else is refused.
   */
  private inBriefChain(actor: ThreadRow, row: DecisionRow, askOnly = false): boolean {
    if (actor.id === row.thread_id) return true;
    if (this.ancestors(actor).some((t) => t.id === row.thread_id)) return true;
    const raisedOn = this.store.thread(row.thread_id);
    if (raisedOn && this.ancestors(raisedOn).some((t) => t.id === actor.id)) return true;
    return this.carriersOf(row, true, askOnly).has(actor.id);
  }

  /** A turn of Loom's own words on another thread (an FYI), unless it is stopped or put away. True when one was queued. */
  private tell(thread: ThreadRow, words: string, from: string): boolean {
    if (thread.status === "stopped" || thread.settled_at) return false;
    const run = this.store.createRun(thread.id, "user", words);
    this.store.addMessage(thread.id, run.id, "user", words, { kind: "peer", name: "Loom", from: `loom:${from}` });
    return true;
  }

  /** A pending question settled; its pointer asks are references, not additional owner moves. */
  private settleRequestPointers(requestId: string): void {
    const rows = this.store.db.prepare("SELECT id,thread,text FROM asks WHERE status='open' AND kind='pointer' AND points_to=?").all(requestId) as { id: string; thread: string; text: string }[];
    for (const ask of rows) {
      if (!finishAsk(this.store, ask.id, "resolved", `record:${requestId}`)) continue;
      this.store.createRun(ask.thread, "wake", `Loom: Ask ${ask.id} resolved: ${ask.text}. Request ${requestId} is ${this.store.request(requestId)?.status}.`);
      queueMicrotask(() => { void this.kick(ask.thread); });
    }
  }

  /**
   * A decision resolved, so a thread that pointed the owner at it ("answer D-6 on your desk") isn't waiting on them
   * any more: its open ask is cleared, and it hears how the decision went as a turn of its own, so it doesn't ask
   * again (TGO-1075). `except`: the thread that settled it, which knows already. Inside the transaction; the caller
   * wakes the threads returned.
   */
  private passOnResolved(row: DecisionRow, how: string, tellParent: boolean, except: string | null = null): string[] {
    const raisedOn = this.store.thread(row.thread_id);
    // Only an answer or a default goes ahead; a withdrawn, moot or replaced brief, or one whose thread was stopped or
    // deleted, does not (Codex review on #781).
    const status = this.store.decision(row.id)?.status;
    const goesAhead = status === "answered" || status === "defaulted" ? "That thread carries it out." : "Nothing goes ahead from it.";
    const words = `Loom: decision ${row.id} (${row.ask}), raised on "${raisedOn?.title ?? row.thread_id}", is settled: ${how}. ${goesAhead} Any open ask of yours pointing at it is cleared; don't ask the owner about ${row.id} again.`;
    const named = this.namedId(row.id);
    const told: string[] = [];
    for (const thread of this.carriersOf(row, tellParent).values()) {
      if (thread.status === "stopped") continue;
      if (thread.ask && named.test(thread.ask)) closeThreadAsk(this.store, thread.id, "resolved", `record:${row.id}`);
      if (thread.id !== except && this.tell(thread, words, row.thread_id)) told.push(thread.id);
    }
    return told;
  }

  /**
   * Acted and defaulted decisions since `since` (ms), across threads: the desk's "Decided for you". The oldest `limit`
   * of them, shown newest first; `more` says there are later ones still to read once these are seen.
   */
  decided(since: number, limit = 200) {
    this.store.tx(() => this.rules.importFile());
    const at = (row: DecisionRow) => row.resolved_at ?? row.created_at;
    // Up to the millisecond before now: anything landing in this same millisecond, after the read, has a time past
    // what the reader can mark seen, so it comes in the next read rather than being skipped.
    const cap = this.store.now() - 1;
    const rows = this.store.decided(since, limit + 1, cap);
    let batch = rows.slice(0, limit);
    let more = rows.length > limit;
    // Readers page by time (seen up to the newest shown): a batch never ends partway through one millisecond, so rows
    // tied at its edge (many defaults in one veto-clock tick) all come in it rather than being skipped.
    if (more && at(rows[limit]!) === at(batch.at(-1)!)) {
      const edge = at(batch.at(-1)!);
      batch = this.store.decided(since, Number.MAX_SAFE_INTEGER, edge);
      more = this.store.decided(edge + 1, 1, cap).length > 0;
    }
    // What the learning loop changed in the same span, up to this page's newest decision (taken before the page is
    // reversed for display): the owner's FYI.
    const until = more && batch.length ? at(batch.at(-1)!) : cap;
    const decisions = batch.reverse().map((row) => {
      const brief = row.status === "defaulted" ? (JSON.parse(row.brief) as DecisionBrief) : null;
      const option = brief?.options.find((o) => o.key === row.answer_option);
      return {
        id: row.id, thread_id: row.thread_id, thread_title: row.thread_title, class: row.class, level: row.level, status: row.status, decided_by: row.decided_by,
        // A default says what went ahead; a log is the agent's own line.
        summary: option ? `${row.ask} → ${option.key} · ${option.label}` : row.ask,
        undo: row.undo, ref: row.ref, at: row.resolved_at ?? row.created_at,
        reversed_at: row.reversed_at, reversal: row.reversal, reversal_note: row.reversal_note, confirmed_at: row.confirmed_at,
        // The standing rule it was made under: the desk's catch-up treats it as routine.
        rule: row.rule_id ?? null,
      };
    });
    // Only what the system did: a rule the owner made, took back or settled from their own answer is theirs, not
    // something decided for them (it shows on the answered brief and in the weekly review instead).
    const ownAnswer = (e: { decision_id: string | null }) => { const d = e.decision_id ? this.store.decision(e.decision_id) : undefined; return d?.status === "answered"; };
    // A suspension the owner's own answer made (a conflict where they kept neither rule) is theirs too.
    const rules = this.rules.events(since, until).filter((e) => !OWNER_RULE_EVENTS.has(e.kind) && !(e.kind === "rule-suspended" && ownAnswer(e))).map((e) => {
      const decision = e.decision_id ? this.store.decision(e.decision_id) : undefined;
      return { id: `E-${e.id}`, kind: e.kind, at: e.at, rule: e.rule_id, class: e.class, decision: e.decision_id, thread_id: decision?.thread_id ?? null, from_level: e.from_level, to_level: e.to_level, text: e.text, rule_choice: e.kind === "rule-created" || e.kind === "rule-reaffirmed" ? decision?.rule_choice ?? null : null, state: e.rule_id ? this.rules.rule(e.rule_id)?.state ?? null : null };
    });
    return { decisions, more, rules };
  }

  /**
   * What an owner's answer teaches (on the desk or in chat). D-2: the first unchanged approval of a candidate makes
   * its rule (Always, the default there); a non-candidate only on an explicit Always; "Just this once" says the scope
   * is not a candidate. An answer other than a level 3 default (another option, or the owner's own words instead)
   * overrides it: a reversal for the class, as Undo is. Returns the rule it made.
   */
  private learnFromAnswer(row: DecisionRow, brief: DecisionBrief, answer: { option: string | null; text: string | null; asItStands: boolean; rule: RuleChoice | null; reason: string | null }) {
    const { option, text, rule, reason } = answer;
    // A rule of another scope that overlaps this one and says otherwise came since the brief opened: no rule is made
    // (both standing would be a conflict); the answer itself stands.
    const own = brief.proposedRule ? parseProposedRule(brief.proposedRule) : null;
    const rival = rule === "always" && own ? this.rules.rival(row.class, own.scope, own.action) : undefined;
    const made = rule === "always" && !rival && canPromote(brief, answer.asItStands) ? this.rules.create({ class: row.class, proposedRule: brief.proposedRule!, reason, decisionId: row.id, guard: loadBoard().classes[row.class]?.guard ?? null }) : null;
    if (made) {
      this.store.setDecisionRule(row.id, { rule_id: made.id });
      this.store.db.prepare("UPDATE decisions SET precedent = 0 WHERE id = ?").run(row.id);
    }
    // Always that can't make a rule (another option, own words, a tripwire, no rule proposed) isn't recorded as one.
    else if (rule === "always") this.store.setDecisionRule(row.id, { rule_choice: null });
    // D-61: "Just this once" (the default on a candidate) keeps the answer as a precedent; a second similar one
    // proposes a rule for the owner to confirm.
    if (rule === "once" && row.candidate === 1 && canPromote(brief, answer.asItStands)) this.notePrecedent(row, brief, option);
    // A precedent conflict: the rule the chosen option keeps stands, and the others are superseded (none kept: suspended).
    if (brief.tripwire === "precedent-conflict") {
      const named = brief.options.map((o) => o.rule).filter((r): r is string => typeof r === "string" && !!r.trim());
      const caseScope = brief.proposedRule ? parseProposedRule(brief.proposedRule).scope : null;
      if (named.length) this.rules.settleConflict(named, brief.options.find((o) => o.key === option)?.rule ?? null, row.id, caseScope);
    }
    const overrode = row.level === 3 && brief.default && (option === null ? !!text : option !== brief.default);
    if (overrode) {
      this.store.reverseDecision(row.id, { reversal: "override", reversal_note: reason ?? text });
      this.rules.reversed({ id: row.id, class: row.class, rule_id: null }, option === null ? `the owner answered ${row.id} in their own words instead of the default ${brief.default}` : `the owner chose ${option} over the default ${brief.default} on ${row.id}`);
    }
    return made;
  }

  /**
   * D-61: an answer that took a candidate's recommendation as it stood, without a rule, is a precedent. When an
   * earlier precedent in the class is similar (scope, and the option taken), the two add up to a proposed rule,
   * written for the pattern; the owner confirms it with one tap (decision.rule always). Returns the proposal.
   */
  private notePrecedent(row: DecisionRow, brief: DecisionBrief, option: string | null): RuleProposal | null {
    this.store.db.prepare("UPDATE decisions SET precedent = 1 WHERE id = ?").run(row.id);
    const match = this.matchingPrecedent(row.class, brief, option, row.id);
    // A new free precedent: open briefs in the class that had none to pair with may pair with this one now.
    if (!match) { this.offerPrecedent(row.class, row.id); return null; }
    const plain = generalizeRule((JSON.parse(match.brief) as DecisionBrief).proposedRule!, brief.proposedRule!);
    const proposal: RuleProposal = { ...plain, from: [match.id, row.id], state: "proposed", written: "plain" };
    this.store.db.prepare("UPDATE decisions SET proposal = ? WHERE id = ?").run(JSON.stringify(proposal), row.id);
    this.store.noteThread(row.thread_id);
    this.rules.proposed(row.class, row.id, match.id, proposal.text);
    // Another open brief that was promised this precedent can't have it now: its promise is worked out again.
    this.repromise(match.id, row.id);
    return proposal;
  }

  /** An answer no longer a free precedent (it stopped counting, or backs a rule now): proposals and promises leaning on it go. */
  private releasePrecedent(id: string): void {
    this.repromise(id, null);
    for (const other of this.store.db.prepare("SELECT id, thread_id, proposal FROM decisions WHERE proposal IS NOT NULL AND id != ?").all(id) as { id: string; thread_id: string; proposal: string }[]) {
      const p = JSON.parse(other.proposal) as RuleProposal;
      if (p.state !== "proposed" || !p.from.includes(id)) continue;
      this.store.db.prepare("UPDATE decisions SET proposal = ? WHERE id = ?").run(JSON.stringify({ ...p, state: "dismissed" }), other.id);
      this.store.noteThread(other.thread_id);
    }
  }

  /** A thread about to be deleted takes its precedents with it: briefs promised them and proposals built on them let go first. */
  private releaseThreadPrecedents(threadId: string): void {
    for (const { id } of this.store.db.prepare("SELECT id FROM decisions WHERE thread_id = ? AND precedent = 1").all(threadId) as { id: string }[]) {
      this.store.db.prepare("UPDATE decisions SET precedent = 0 WHERE id = ?").run(id);
      this.releasePrecedent(id);
    }
  }

  /** Open briefs promised `precedentId` (it was used up, or stopped counting) have their promise worked out again. */
  private repromise(precedentId: string, exceptId: string | null): void {
    for (const other of this.store.db.prepare("SELECT * FROM decisions WHERE status = 'open' AND precedent_of = ? AND id != ?").all(precedentId, exceptId ?? "") as unknown as DecisionRow[]) {
      const b = JSON.parse(other.brief) as DecisionBrief;
      const next = other.candidate === 1 ? this.matchingPrecedent(other.class, b, b.options.find((o) => o.recommended)?.key ?? null, other.id) : undefined;
      this.store.db.prepare("UPDATE decisions SET precedent_of = ? WHERE id = ?").run(next?.id ?? null, other.id);
      this.store.noteThread(other.thread_id);
    }
  }

  /** Open candidate briefs in `cls` promised no precedent have their promise worked out again (one just became free). */
  private offerPrecedent(cls: string, precedentId: string): void {
    for (const other of this.store.db.prepare("SELECT * FROM decisions WHERE status = 'open' AND class = ? AND candidate = 1 AND precedent_of IS NULL AND id != ?").all(cls, precedentId) as unknown as DecisionRow[]) {
      const b = JSON.parse(other.brief) as DecisionBrief;
      const next = this.matchingPrecedent(other.class, b, b.options.find((o) => o.recommended)?.key ?? null, other.id);
      if (!next) continue;
      this.store.db.prepare("UPDATE decisions SET precedent_of = ? WHERE id = ?").run(next.id, other.id);
      this.store.noteThread(other.thread_id);
    }
  }

  /** Decisions already in a proposal (proposed, made or dismissed): each pair proposes once, so they pair with nothing else. */
  private usedPrecedents(): Set<string> {
    return new Set((this.store.db.prepare("SELECT proposal FROM decisions WHERE proposal IS NOT NULL").all() as { proposal: string }[]).flatMap((r) => (JSON.parse(r.proposal) as RuleProposal).from));
  }

  /**
   * The earlier precedent a brief pairs with (D-61), the same test the card's promise and the proposal use: same class,
   * similar scope, a similar option taken, and not already in a proposal (each pair proposes once).
   */
  private matchingPrecedent(cls: string, brief: DecisionBrief, option: string | null, exclude: string | null) {
    if (!brief.proposedRule) return undefined;
    const scope = parseProposedRule(brief.proposedRule).scope;
    const label = (b: DecisionBrief, key: string | null) => b.options.find((o) => o.key === key)?.label ?? "";
    const chose = label(brief, option);
    const used = this.usedPrecedents();
    return this.rules.precedents(cls, scope, exclude).find((p) => {
      if (used.has(p.id)) return false;
      const theirs = label(JSON.parse(p.brief) as DecisionBrief, p.answer_option);
      return similarOption(theirs, chose);
    });
  }

  /** A model writes the proposed rule for the pattern both approvals share (when one is configured); the plain one stays otherwise. */
  private async writeProposal(decisionId: string): Promise<void> {
    const writer = this.options.ruleWriter;
    const row = this.store.decision(decisionId);
    if (!writer || !row?.proposal) return;
    const proposal = JSON.parse(row.proposal) as RuleProposal;
    const briefs = proposal.from.map((id) => this.store.decision(id)).filter((d): d is DecisionRow => !!d).map((d) => JSON.parse(d.brief) as DecisionBrief);
    let text: string | null = null;
    try { text = await writer(briefs.map((b) => ({ ask: b.ask, proposedRule: b.proposedRule ?? "" }))); } catch (e) { console.warn("Writing a proposed rule failed", e); }
    if (!text) return;
    const { scope, action } = parseProposedRule(text);
    if (!scope || !action || scope === action) return;
    this.store.tx(() => {
      const now = this.store.decision(decisionId);
      if (!now?.proposal) return;
      const current = JSON.parse(now.proposal) as RuleProposal;
      if (current.state !== "proposed") return;
      this.store.db.prepare("UPDATE decisions SET proposal = ? WHERE id = ?").run(JSON.stringify({ ...current, text: oneLine(text!), scope, action, written: "model" }), decisionId);
      this.store.noteThread(now.thread_id);
    });
  }

  /** The board as it stands: its levels, with any class its reversals dropped (class_levels) at the lower level. */
  board(): Board {
    return this.rules.effectiveBoard(loadBoard());
  }

  decisionCheck(threadId: string, cls: string | null) {
    // The rules file may have changed off Loom (a new rule, a suspension): read it before saying what is allowed.
    this.store.tx(() => this.rules.importFile());
    const board = this.board();
    const open = this.store.openDecisions(threadId).map((d) => ({ id: d.id, class: d.class, ask: d.ask, created_at: d.created_at }));
    if (!cls) return { classes: board.classes, tripwires: board.tripwires, defaults: board.defaults, open };
    const entry = board.classes[cls];
    if (!entry) return { error: `Unknown class ${cls}`, classes: Object.keys(board.classes), open };
    const rules = this.rules.active(cls).map(publicRule);
    const demoted = this.rules.classLevel(cls);
    // Two active rules for the same class and scope: precedent conflicts, so the owner decides, and the brief names both.
    const conflicts = this.rules.conflicts(cls).map((group) => group.map((r) => r.id));
    const what = conflicts.length
      ? `Rules ${conflicts.map((g) => g.join(" and ")).join("; ")} cover the same scope: a precedent-conflict tripwire. If your case is in that scope, bring a brief with tripwire "precedent-conflict" that names both rules.`
      : entry.level === 5 ? "Decide it yourself; nothing to report." : entry.level === 4 ? "Decide it yourself, then say what you decided in your report, and log it with decision_log (a line in the owner's Decided for you, with how to undo it)." : entry.level === 3 ? "Bring a brief with your default. If the owner doesn't answer within the veto window of their active time, Loom runs the default: it wakes you to carry it out." : entry.level === 2 ? "Bring a brief with your recommendation; keep working on everything it doesn't block." : "The owner's call: bring a brief with the options side by side.";
    const cite = rules.some((r) => r.class === cls) ? " A standing rule whose scope covers your case literally is the authority: act on it, and log it with decision_log citing it (rule: its id). A near miss still asks; propose widening the scope in the brief." : "";
    // D-61: the owner's earlier approvals in this class, so a brief can cite them (and its card can say a second
    // similar approval proposes a rule) instead of arguing the case again.
    // One already in a proposal can't pair again, so it isn't offered to cite.
    const used = this.usedPrecedents();
    const precedents = this.rules.precedents(cls).filter((p) => !used.has(p.id)).slice(0, 10).map((p) => {
      const b = JSON.parse(p.brief) as DecisionBrief;
      return { id: p.id, ask: p.ask, scope: p.scope, chose: b.options.find((o) => o.key === p.answer_option)?.label ?? null, at: p.resolved_at ?? p.created_at };
    });
    const citePrecedents = precedents.length ? " Precedents are the owner's earlier approvals in this class that made no rule: if one matches your case, name it in your brief's precedents (approving a second similar call proposes a standing rule); a precedent alone isn't a rule, so still ask." : "";
    return {
      class: cls, ...entry, what: what + cite + citePrecedents, tripwires: board.tripwires, veto_window: board.defaults.veto_window ?? null, rules, precedents,
      ...(demoted ? { demoted: { level: demoted.level, board_level: demoted.board_level, why: demoted.why, since: demoted.changed_at } } : {}),
      ...(conflicts.length ? { tripwire: "precedent-conflict", conflicts } : {}),
      open,
    };
  }

  /** The weekly Delegation review: rules created, suspended and retired, classes demoted and restored, and recurring dissent. */
  review(since: number) {
    // An edit off Loom (a rule added or suspended in the file) is news for the review: read the file first.
    this.store.tx(() => this.rules.importFile());
    return this.rules.review(since);
  }

  /** The numbers of every decision on the ledger (D-<n>): the ids the desk turns into links. */
  decisionIds(): number[] {
    return (this.store.db.prepare("SELECT id FROM decisions").all() as { id: string }[]).map((r) => Number(r.id.slice(2))).filter(Number.isFinite).sort((a, b) => a - b);
  }

  /** One decision as the desk's brief page shows it: the brief, its revisions and outcome, and where it was raised and answered. */
  decisionDetail(id: string) {
    const row = this.store.decision(id);
    if (!row) return undefined;
    const named = (threadId: string | null) => {
      const thread = threadId ? this.store.thread(threadId) : undefined;
      return thread ? { id: thread.id, title: thread.title ?? null } : null;
    };
    const rule = row.rule_id ? this.rules.rule(row.rule_id) : undefined;
    return { ...briefPayload(row), rule: rule ? { id: rule.id, state: rule.state, scope: rule.scope, do: rule.action } : null, veto: row.status === "open" ? this.vetoClock.state(row) : null, raised_on: named(row.thread_id), decided_on: named(row.decided_in ?? (row.decided_by === "person-chat" ? row.thread_id : null)) };
  }

  private heartbeatOf(threadId: string): number | null {
    const run = this.store.activeRun(threadId);
    if (!run) return null;
    const beat = this.heartbeats.get(threadId);
    return beat?.runId === run.id ? beat.at : null;
  }

  private waitTarget(t: { kind: string; spec: string }): string {
    const s = JSON.parse(t.spec);
    switch (t.kind) {
      case "pr": return `PR #${s.number} ${s.until === "approved" ? "review" : s.until === "checks_done" ? "checks" : s.until}`;
      case "time": return new Date(s.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      case "thread": return this.store.thread(s.threadId)?.title ?? s.threadId;
      case "command": return s.command;
      case "url": return s.url;
      case "file": return s.path;
      case "fan_out": return `fan-out ${s.fanOutId}`;
      case "worker": return s.threadId ? this.store.thread(s.threadId)?.title ?? s.threadId : `${s.project}/${s.task}`;
      default: throw new Error("Unknown wait kind");
    }
  }

  detail(threadId: string) {
    const thread = this.store.thread(threadId);
    if (!thread) return undefined;
    return {
      seq: this.store.highWater(),
      thread: this.threadPayload(thread),
      openedPrUrls: this.ledger.openedPrUrls(threadId),
      legacyPrCreates: this.ledger.legacyPrCreates(threadId),
      lastPrMergeAt: this.ledger.lastPrMergeAt(threadId),
      runs: this.store.runs(threadId).map(run => ({ ...run, ...(run.source === "wake" && missingAnswerRun(run.text) ? { answers_run_id: missingAnswerRun(run.text) } : {}), wake_cause: run.source === "wake" ? run.wake_cause ?? wakeCause(run.text) : null })),
      messages: (() => {
        const images = this.store.messageAttachments(threadId);
        return this.store.messages(threadId).map((m) => (images.has(m.id) ? { ...m, attachments: images.get(m.id) } : m));
      })(),
      items: this.store.items(threadId),
      requests: this.store.openRequests(threadId),
      handoff: this.handoffs.latest(threadId) ?? null,
      decisions: this.store.decisions(threadId).map((row) => {
        // The rule an answer made (or made and took back), so the answered brief can say "Saved as R-n".
        const rule = row.rule_id ? this.rules.rule(row.rule_id) : undefined;
        return { ...briefPayload(row), veto: row.status === "open" ? this.vetoClock.state(row) : null, rule: rule ? { id: rule.id, state: rule.state, scope: rule.scope, do: rule.action } : null };
      }),
      // Durable waits still open (wait_for): the agent is waiting on purpose and will be woken, not done.
      waits: this.triggers.list(threadId, "waiting").filter(t => !t.ask_id).map((t) => ({ id: t.id, kind: t.kind, note: t.note, text: describeTrigger(t), target: this.waitTarget(t), ...(t.kind === "pr" ? { prUrl: (() => { const s = JSON.parse(t.spec); return `https://github.com/${s.repo}/pull/${s.number}`; })() } : {}), due_at: t.kind === "time" ? Date.parse(JSON.parse(t.spec).at) : null, created_at: t.created_at, expires_at: t.expires_at, last_checked_at: t.last_checked_at, last_error: t.last_error, consecutive_errors: t.consecutive_errors, error_since: t.error_since })),
      // What the session still runs in the background, each with when it started (the ledger's own record).
      tasks: (() => {
        const open = new Map(this.ledger.rows(threadId).filter((r) => r.ended_at === null && r.kind !== "turn").map((r) => [r.ref, r]));
        const tasks: BackgroundTask[] = thread.background ? JSON.parse(thread.background) : [];
        return [...tasks.map((t) => ({ id: t.id, kind: t.kind, description: open.get(t.id)?.description ?? t.description, ambient: !!t.ambient, started_at: open.get(t.id)?.started_at ?? null })), ...this.fanOuts.background(threadId)];
      })(),
    };
  }

  /** The agent's handoff for its next session (loom.save_handoff). */
  saveHandoff(threadId: string, body: unknown): { ok: true; id: string; message: string } | { ok: false; code: string } {
    const thread = this.store.thread(threadId);
    if (!thread) return { ok: false, code: "not_found" };
    const input = (body ?? {}) as Record<string, unknown>;
    const part = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
    const summary = part("summary");
    if (!summary?.trim()) return { ok: false, code: "summary_required" };
    // Saved on the agent's own at a task's end (not for Loom's handoff turn): the next run starts fresh from it.
    // Nor the save a lead's fresh packet asked for (freshPacket): a task-done reset would close the session it was
    // just opened in (Codex review on #876). Any other save in that run is a task's end as usual.
    const asked = !!thread.native_session_id && this.handoffAsked.get(threadId) === thread.native_session_id;
    if (asked) this.handoffAsked.delete(threadId);
    const voluntary = this.store.activeRun(threadId)?.source !== "reset" && !thread.fresh && !asked && this.automatic(thread);
    const id = this.store.tx(() => {
      const saved = this.handoffs.save(threadId, thread.native_session_id, { summary, decisions: part("decisions"), next: part("next"), files: part("files") });
      if (voluntary) this.taskDone(thread);
      return saved;
    });
    return { ok: true, id, message: "Saved. The next session starts from it." };
  }

  /**
   * "Keep this session" (TGO-1108): no automatic fresh session for this thread (soft threshold, cold cache, task end,
   * budget) until it is switched back. A pending automatic mark is dropped; the owner's own Fresh start still runs.
   */
  keepSession(threadId: string, keep: boolean, signal?: AbortSignal): Promise<{ ok: true; keep: boolean } | { ok: false; code: string; message?: string }> {
    // In the thread's mailbox, after any dispatch already under way: it never lands between a reset's steps.
    // An asker that gave up while it waited (the desk's deadline) was told it failed: then it doesn't apply.
    return this.inMailbox(threadId, async () => signal?.aborted ? ABANDONED : this.keepSessionNow(threadId, keep));
  }

  private keepSessionNow(threadId: string, keep: boolean): { ok: true; keep: boolean } | { ok: false; code: string } {
    const thread = this.store.thread(threadId);
    if (!thread) return { ok: false, code: "not_found" };
    this.store.tx(() => {
      const pending = thread.fresh ? (JSON.parse(thread.fresh) as FreshReason) : null;
      this.store.updateThread(threadId, { fresh_opt_out: keep ? 1 : null, ...(keep && pending && pending.reason !== "owner" && pending.reason !== "worktree" ? { fresh: null } : {}) });
      // A handoff turn queued behind a hold (maintenance, no account free) goes now, not at a dispatch that might
      // come after Keep is switched off again.
      if (keep && pending?.reason !== "worktree") this.cancelQueuedResets(threadId);
    });
    this.ledger.event(threadId, "fresh-keep", keep ? "Keep this session: on (no automatic fresh session)" : "Keep this session: off", "");
    return { ok: true, keep };
  }

  /** Cancels a handoff turn still queued; when that empties the queue, a hold waiting for room is over too (Codex review on #840). */
  private cancelQueuedResets(threadId: string): void {
    const queued = this.store.queuedRuns(threadId);
    const resets = queued.filter((r) => r.source === "reset");
    if (!resets.length) return;
    for (const r of resets) this.endRunState(r.id, "canceled");
    if (resets.length < queued.length) return;
    if (this.store.thread(threadId)?.admission) this.store.updateThread(threadId, { admission: null, admission_until: null });
    const wait = this.waits.get(threadId);
    if (wait) { clearTimeout(wait); this.waits.delete(threadId); }
  }

  /**
   * A worker's task ended outside Loom (the desk saw its PR merge, TGO-1113): its next turn starts fresh, as when it
   * settles. Kept sessions, shadow mode and non-workers are left as they are; `marked` says whether a reset is due.
   */
  taskEnded(threadId: string, why: string, signal?: AbortSignal): Promise<{ ok: true; marked: boolean } | { ok: false; code: string; message?: string }> {
    return this.inMailbox(threadId, async () => {
      if (signal?.aborted) return ABANDONED;
      const thread = this.store.thread(threadId);
      if (!thread) return { ok: false, code: "not_found" };
      if (thread.role !== "worker") return { ok: true, marked: false };
      this.taskDone(thread);
      const marked = JSON.parse(this.store.thread(threadId)?.fresh ?? "null")?.reason === "task-done" && !thread.fresh;
      if (marked) this.ledger.event(threadId, "fresh-task-ended", `Task done (${why.slice(0, 200)}): the next turn starts a fresh session`, "");
      return { ok: true, marked };
    });
  }

  /** The owner's one-off Fresh start: the next turn opens a new session from what the thread carries. */
  freshStart(threadId: string, signal?: AbortSignal): Promise<{ ok: true; message: string } | { ok: false; code: string; message?: string }> {
    // In the thread's mailbox too: a turn whose dispatch is under way is running by the time this checks.
    return this.inMailbox(threadId, async () => signal?.aborted ? ABANDONED : this.freshStartNow(threadId));
  }

  private freshStartNow(threadId: string): { ok: true; message: string } | { ok: false; code: string; message?: string } {
    const thread = this.store.thread(threadId);
    if (!thread) return { ok: false, code: "not_found" };
    if (thread.fresh && JSON.parse(thread.fresh).reason === "worktree") return { ok: false, code: "busy", message: "This thread is already moving into a worktree; its fresh session follows the handoff" };
    if (this.freshPolicy.mode === "off") return { ok: false, code: "fresh_off", message: "Fresh sessions are switched off (LOOM_FRESH_SESSIONS=off)" };
    if (!this.optedIn(thread)) return { ok: false, code: "not_resettable", message: "This thread keeps its own session lifecycle" };
    if (!thread.native_session_id) return { ok: true, message: "No session yet: the next turn starts fresh anyway." };
    // Closing the session now would cut off its background work or open question, and the next turn would go to the
    // old session anyway: say so instead of promising a reset that comes later.
    if (!this.quiet(thread)) return { ok: false, code: "busy", message: "This session still has background work or an open question; Fresh start once it ends" };
    // Only a running turn can start background work or ask a question: refused now, nothing can stand between this
    // mark and the next turn.
    if (this.store.activeRun(threadId)) return { ok: false, code: "busy", message: "A turn is running; Fresh start once it ends" };
    this.store.tx(() => {
      this.store.updateThread(threadId, { fresh: JSON.stringify({ reason: "owner", context: this.usage.summary(threadId)?.tokens ?? 0, at: this.store.now(), previousSession: thread.native_session_id } satisfies FreshReason) });
      // Fresh start skips the handoff turn: one already queued (dispatch held by maintenance or admission) never runs.
      this.cancelQueuedResets(threadId);
    });
    this.ledger.event(threadId, "fresh-owner", "Fresh start asked: the next turn opens a new session", "");
    return { ok: true, message: "The next turn starts a fresh session." };
  }

  /** The thread's state as the session gets it back after a compaction or in a fresh session (carry.ts). */
  carry(threadId: string): string | undefined {
    const thread = this.store.thread(threadId);
    if (!thread) return undefined;
    const open = thread.ask ? (JSON.parse(thread.ask) as OpenAsk) : null;
    const ask = open?.kind === "pointer" ? null : open?.text ?? null;
    const tasks: BackgroundTask[] = thread.background ? JSON.parse(thread.background) : [];
    const lead = thread.parent_thread_id?.startsWith("loom:") ? this.store.thread(thread.parent_thread_id.slice(5)) : undefined;
    return renderCarry({
      thread: { id: thread.id, title: thread.title, role: thread.role, parent: thread.parent_thread_id, cwd: thread.cwd, branch: thread.worktree_branch, repo: thread.repo },
      children: this.store.threads().filter((t) => t.parent_thread_id === `loom:${threadId}` && t.status !== "stopped").map((t) => ({ id: t.id, title: t.title, status: t.status, role: t.role })),
      waits: this.triggers.list(threadId, "waiting").filter(t => !t.ask_id).map((t) => ({ id: t.id, text: describeTrigger(t), note: t.note, expires_at: t.expires_at })),
      briefs: this.store.decisions(threadId).filter((d) => d.status === "open").map((d) => {
        const brief = (() => { try { return JSON.parse(d.brief) as Partial<DecisionBrief>; } catch { return {}; } })();
        return {
          id: d.id, class: d.class, ask: d.ask, created_at: d.created_at, default: brief.default ?? null,
          ...(brief.standing ? { standing: String(brief.standing) } : {}), ...(brief.background ? { background: String(brief.background) } : {}),
          options: Array.isArray(brief.options) ? brief.options.map((o) => ({ key: String(o.key), label: String(o.label), ...(o.consequence ? { consequence: String(o.consequence) } : {}), ...(o.action ? { action: String(o.action) } : {}) })) : [],
        };
      }),
      ask,
      askTo: open?.to ?? null,
      denials: storeDenials(this.store, threadId),
      tasks: tasks.map((t) => ({ id: t.id, kind: t.kind, description: t.description, ambient: !!t.ambient })),
      owner: this.store.messages(threadId).filter((m) => m.role === "user" && !m.origin && !m.text.startsWith("✉️")).slice(-2).map((m) => ({ text: m.text, at: m.created_at })),
      memories: (this.options.memories ?? (this.memoryReader ??= atlasReader()))([threadId, ...(lead ? [lead.id] : [])], 12),
      lead: lead ? (() => { const h = this.handoffs.latest(lead.id); return h ? { id: lead.id, title: lead.title, body: h.body, at: h.created_at } : null; })() : null,
      now: this.store.now(),
    });
  }

  // Commands

  /**
   * Apply a command exactly once per commandId. A repeated commandId returns
   * the original result, or throws the original rejection.
   */
  async execute(command: Command): Promise<CommandResult> {
    const commandThread = "threadId" in command ? command.threadId : command.type === "answer" ? this.store.request(command.requestId)?.thread_id : command.type === "decision.answer" || command.type === "decision.reverse" || command.type === "decision.confirm" || command.type === "decision.rule" ? this.store.decision(command.decisionId)?.thread_id : undefined;
    const reclaim = commandThread && this.reclaiming.get(commandThread);
    if (reclaim) { await reclaim.catch(() => {}); return this.execute(command); }
    const prior = this.store.receipt(command.commandId);
    if (prior) {
      const result = JSON.parse(prior.result) as CommandResult & { code?: string; message?: string };
      if (!prior.accepted) throw new LoomCommandError(result.code ?? "rejected", result.message ?? "rejected");
      return result;
    }
    if (command.type === "submit" && !command.threadId && !command.sameTree && command.worktree && command.worktree !== "auto" && command.worktree !== "local") {
      const inFlight = this.preparing.get(command.commandId);
      if (inFlight) return inFlight;
      const started = this.prepareAndSubmit(command).finally(() => this.preparing.delete(command.commandId));
      this.preparing.set(command.commandId, started);
      return started;
    }
    if (command.type === "answer" || command.type === "interrupt" || command.type === "decision.request" || (command.type === "handoff.record" && command.kind === "human") || (command.type === "submit" && command.steer && command.threadId)) {
      const inFlight = this.preparing.get(command.commandId);
      if (inFlight) return inFlight;
      const delivery = this.commit(command).finally(() => this.preparing.delete(command.commandId));
      this.preparing.set(command.commandId, delivery);
      return delivery;
    }
    if (command.type === "delete") {
      const result = await this.inMailbox(command.threadId, () => this.commit(command));
      await this.worktrees?.reclaim(false, command.threadId);
      return result;
    }
    return this.commit(command);
  }

  /** A new thread in a fresh worktree: git runs outside the transaction, then the submit commits as usual. */
  private async prepareAndSubmit(original: Extract<Command, { type: "submit" }>): Promise<CommandResult> {
    let command = original;
    const threadId = randomUUID();
    let path: string;
    try {
      const repoPath = command.worktree === true || command.worktree === "worktree" ? command.repo ?? command.cwd : (command.worktree as { repoPath?: unknown } | null)?.repoPath;
      if (typeof repoPath !== "string" || !repoPath.trim()) throw new LoomCommandError("invalid", "worktree needs a repoPath");
      if (!this.options.createWorktree) throw new LoomCommandError("invalid", "This Loom can't make worktrees");
      if (!command.provider || !this.runtimes[command.provider]) throw new LoomCommandError("invalid", `Unknown provider ${command.provider}`);
      const made = await this.options.createWorktree(repoPath, threadId);
      path = made.path;
      command = { ...command, repo: made.repo ?? repoPath };
    } catch (error) {
      const failure =
        error instanceof LoomCommandError ? error : new LoomCommandError("worktree_failed", error instanceof Error ? error.message : String(error));
      this.store.tx(() =>
        this.store.writeReceipt(command.commandId, command.type, null, false, { code: failure.code, message: failure.message }),
      );
      throw failure;
    }
    return this.commit({ ...command, cwd: path }, threadId);
  }

  /** Image files written by the command being applied: removed again if its transaction rolls back. */
  private written: string[] = [];

  private async refuseReadyMerge(command: Command): Promise<void> {
    if (command.type !== "decision.request" && !(command.type === "handoff.record" && command.kind === "human")) return;
    const raw = (command.type === "decision.request" ? command.brief : command) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || raw.tripwire) return;
    if (raw.requestedAction !== "merge" && !(command.type === "decision.request" && raw.class === "merge-when-green")) return;
    try { if ((this.board().classes["merge-when-green"]?.level ?? 0) < 4) return; } catch { return; }
    if (!approvedWork(this.store, command.threadId, raw.buildInstruction)) return;
    const refs: PrRef[] = (Array.isArray(raw.assets) ? raw.assets : []).map(prAsset).filter((p): p is PrRef => p !== null);
    // Explicit PR assets identify this request; waits are only a fallback.
    for (const wait of refs.length ? [] : this.triggers.list(command.threadId, "waiting")) {
      if (wait.kind !== "pr") continue;
      try {
        const spec = JSON.parse(wait.spec);
        if (typeof spec?.repo === "string" && Number.isSafeInteger(spec.number) && spec.number > 0) refs.push({ repo: spec.repo, number: spec.number });
      } catch { /* A malformed historical row is unknown, never a reason to block an ask. */ }
    }
    for (const pr of refs) {
      let facts;
      try { facts = await (this.options.readMergeFacts ?? readMergeFacts)(pr); } catch { continue; }
      if (mergeReady(facts, Date.now())) throw new LoomCommandError("invalid", `PR #${pr.number} meets merge-when-green on recorded facts: merge it and log with decision_log`);
    }
  }

  private async commit(command: Command, newThreadId?: string): Promise<CommandResult> {
    let result: CommandResult;
    // Files this command wrote. The shared list is only used inside the synchronous transaction,
    // so a command awaiting a host can never remove another command's images.
    let written: string[] = [];
    try {
      if (command.type === "decision.request" || command.type === "handoff.record" && command.kind === "human") await this.refuseReadyMerge(command);
      if (command.type === "answer") await this.deliverAnswer(command);
      if (command.type === "interrupt") await this.deliverInterrupt(command);
      this.steering = null;
      this.written = [];
      let steer: LoomHost["steering"] = null;
      try {
        result = this.store.tx(() => {
          const r = this.apply(command, newThreadId);
          this.store.writeReceipt(command.commandId, command.type, r.threadId ?? null, true, r);
          return r;
        });
      } finally {
        written = this.written;
        steer = this.steering;
        this.written = [];
        this.steering = null;
      }
      if (steer) result = await this.deliverSteer(command.commandId, steer, result);
    } catch (error) {
      if (command.type === "interrupt") this.interruptsDelivered.delete(command.commandId);
      for (const path of written) this.options.attachments?.remove(path);
      if (error instanceof LoomCommandError) {
        this.store.tx(() =>
          this.store.writeReceipt(command.commandId, command.type, null, false, { code: error.code, message: error.message }),
        );
      }
      throw error;
    }
    if (command.type === "interrupt") this.interruptsDelivered.delete(command.commandId);
    await this.afterCommand(command, result);
    return result;
  }

  /** Wait for a remote host to accept an answer before closing its durable question. */
  /** Answers being delivered, by request: a second answer to the same question waits for the first. */
  private readonly answering = new Map<string, Promise<unknown>>();

  private async deliverAnswer(command: Extract<Command, { type: "answer" }>): Promise<void> {
    const earlier = this.answering.get(command.requestId);
    if (earlier) await earlier.catch(() => {});
    const delivery = this.deliverAnswerOnce(command);
    this.answering.set(command.requestId, delivery);
    try {
      await delivery;
    } finally {
      if (this.answering.get(command.requestId) === delivery) this.answering.delete(command.requestId);
    }
  }

  private async deliverAnswerOnce(command: Extract<Command, { type: "answer" }>): Promise<void> {
    const req = this.store.request(command.requestId);
    if (!req) throw new LoomCommandError("not_found", `No request ${command.requestId}`);
    if (req.status !== "open") throw new LoomCommandError("not_open", `Request is ${req.status}`);
    const session = this.sessions.get(req.thread_id);
    if (!session) throw new LoomCommandError("not_resumable", "The session that asked is gone");
    try {
      await session.respond(req.id, command.answer);
    } catch (error) {
      throw new LoomCommandError("not_delivered", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Stop reaches a live session before the command is recorded, so an accepted Stop always took effect.
   * A failure throws a plain error (no receipt): a retry with the same commandId tries again.
   */
  private async deliverInterrupt(command: Extract<Command, { type: "interrupt" }>): Promise<void> {
    const thread = this.store.thread(command.threadId);
    if (!thread) return; // apply() refuses it
    const active = this.store.activeRun(thread.id);
    if (command.runId && (!active || active.id !== command.runId)) return; // apply() refuses it
    const session = this.sessions.get(thread.id);
    if (!session) return;
    await session.interrupt();
    this.interruptsDelivered.add(command.commandId);
  }

  /** Stops already delivered to their session, by commandId, while their command is being recorded. */
  private readonly interruptsDelivered = new Set<string>();

  /** A steer recorded by the command just committed, still to be handed to the running turn. */
  private steering: { threadId: string; runId: string; messageId: string; text: string; images: TurnImage[] } | null = null;

  /**
   * Recorded first (delivery 'pending'), delivered after the commit, so the harness never sees an image
   * the transcript lacks. The message id is the steer id: the host ignores a repeat, so a delivery whose
   * outcome is unknown is retried safely. A definite refusal turns the message into a queued run.
   * Still unknown after the retries, it stays pending and recovery settles it from the host's own list.
   */
  private async deliverSteer(commandId: string | null, steer: NonNullable<LoomHost["steering"]>, result: CommandResult): Promise<CommandResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const live = this.sessions.get(steer.threadId);
        if (!live?.inject) throw new Error("The session is gone");
        await live.inject(steer.text, steer.images.length ? steer.images : undefined, steer.messageId);
        this.store.tx(() => this.store.setDelivery(steer.messageId, "delivered"));
        return result;
      } catch (error) {
        if (error instanceof HostOutcomeUnknown) continue;
        return this.store.tx(() => this.queueSteer(steer.threadId, steer.messageId, steer.text, commandId));
      }
    }
    return result;
  }

  /** A steer the running turn will never get becomes the thread's next run. */
  private queueSteer(threadId: string, messageId: string, text: string, commandId: string | null): CommandResult {
    const run = this.store.createRun(threadId, "user", text);
    const message = this.store.messages(threadId).find(message => message.id === messageId);
    if (message?.run_id) this.store.db.prepare("UPDATE decisions SET discussing_run=? WHERE status='open' AND discussing_run=?").run(run.id, message.run_id);
    this.store.moveMessageToRun(messageId, run.id);
    this.store.setDelivery(messageId, null);
    const queued: CommandResult = { threadId, runId: run.id, steered: false };
    if (commandId) this.store.replaceReceipt(commandId, queued);
    return queued;
  }

  private apply(command: Command, newThreadId?: string): CommandResult {
    const store = this.store;
    switch (command.type) {
      case "fan_out.create": {
        try { return this.fanOuts.create(command.threadId, command.input); } catch (e) { throw new LoomCommandError("invalid", String(e)); }
      }
      case "asks.rerecord": {
        if (command.dryRun !== undefined && typeof command.dryRun !== "boolean") throw new LoomCommandError("invalid", "dryRun must be a boolean");
        const asks: NonNullable<CommandResult["asks"]> = [];
        for (const thread of store.threads()) {
          // A thread without Loom's tools can't call loom.handoff: its closing-line ask stands.
          if (thread.status === "stopped" || !thread.ask || !this.loomTools(thread)) continue;
          const ask = JSON.parse(thread.ask) as OpenAsk;
          // The hand-off that opened this ask, not the latest one: a later mail turn can hand off by tool and leave it.
          const row = ask.runId ? store.db.prepare("SELECT record FROM turn_handoffs WHERE run_id=?").get(ask.runId) as { record: string } | undefined : undefined;
          const origin = row ? JSON.parse(row.record) as RecordedHandoff : null;
          if (ask.to || (ask.kind !== "unclear" && origin?.source === "tool" && origin.next)) continue;
          // One-shot, including retries with a new command id and coordinator restarts.
          if (store.runs(thread.id).some(run => run.source === "wake" && run.text === RERECORD_ASK_WAKE_TEXT)) continue;
          asks.push({ threadId: thread.id, title: thread.title, ask, queued: !command.dryRun });
          if (!command.dryRun) store.createRun(thread.id, "wake", RERECORD_ASK_WAKE_TEXT);
        }
        return { asks };
      }
      case "ask.resolve": {
        const row = askRow(store, command.askId);
        if (!row) throw new LoomCommandError("not_found", `No ask ${command.askId}`);
        if (!["done", "withdrawn"].includes(command.outcome) || !["person", "desk", "agent"].includes(command.by) || command.note !== undefined && typeof command.note !== "string") throw new LoomCommandError("invalid", "Invalid ask resolution");
        if (row.status !== "open") throw new LoomCommandError("not_open", `Ask ${row.id} is ${row.status}`);
        if ((command.revision !== undefined && command.revision !== row.revision) || (command.outcome === "done" && command.revision === undefined && row.revision > 1)) {
          throw new LoomCommandError("stale", `Ask ${row.id} was updated since you looked (revision ${row.revision}); read it again and answer that`);
        }
        if (command.step !== undefined) {
          if (command.outcome !== "done" || typeof command.step !== "string") throw new LoomCommandError("invalid", "A step requires done and a step number or text");
          const steps = row.steps ? JSON.parse(row.steps) as { text: string; done_at?: number; by?: string }[] : [];
          const index = /^\d+$/.test(command.step) ? Number(command.step) - 1 : steps.findIndex(s => s.text === command.step);
          const step = steps[index];
          if (!step) throw new LoomCommandError("invalid", "Unknown ask step");
          if (step.done_at === undefined) { step.done_at = store.now(); step.by = command.by; }
          store.db.prepare("UPDATE asks SET steps=?,updated_at=? WHERE id=?").run(JSON.stringify(steps), store.now(), row.id);
          if (!steps.every(s => s.done_at !== undefined)) {
            store.updateThread(row.thread, { ask: JSON.stringify(openAsk(askRow(store, row.id)!)) });
            return { threadId: row.thread };
          }
        }
        finishAsk(store, row.id, command.outcome, command.outcome === "withdrawn" ? "agent" : command.by, command.note);
        this.cancelLintWakes(row.thread);
        if (command.outcome === "withdrawn") return { threadId: row.thread };
        const run = store.createRun(row.thread, "wake", `Loom: Ask ${row.id} done: ${row.text}. Marked by ${command.by === "person" ? deskPerson()?.name ?? "person" : command.by} on the desk at ${new Date(store.now()).toISOString()}.${command.note ? ` ${command.note}` : ""}`);
        store.updateThread(row.thread, { settled_at: null });
        return { threadId: row.thread, runId: run.id };
      }
      case "handoff.record": {
        const run = store.activeRun(command.threadId);
        if (!run || (command.runId && command.runId !== run.id)) throw new LoomCommandError("invalid", "Handoff requires the active run");
        if (typeof command.text !== "string" || (command.waitingOn != null && typeof command.waitingOn !== "string") ||
          (command.to != null && typeof command.to !== "string") || (command.who != null && typeof command.who !== "string") ||
          (command.at !== undefined && !Number.isFinite(command.at)) ||
          (command.source !== undefined && command.source !== "tool")) throw new LoomCommandError("invalid", "Invalid handoff");
        if (command.messageId && !store.messages(command.threadId).some(m => m.id === command.messageId && m.run_id === run.id && m.role === "assistant")) throw new LoomCommandError("invalid", "Invalid handoff message");
        const next = command.kind !== undefined ? this.nextBy(command.threadId, command.kind, command.who ?? "") : this.nextByOwner(command);
        if (command.kind === "human" && !POINTER.test(command.text) && normalizeAsk(command.text).split(/\s+/).filter(Boolean).length < 4) throw new LoomCommandError("invalid", 'Human handoffs must name the action the owner takes in at least four words, e.g. "Watch the cut, then reply approved or name cuts to undo". A pointer to a decision brief is exempt.');
        let ask: AskSpec | undefined;
        try { if (next.owner === "you") ask = validateAsk(command.ask); } catch (e) { throw new LoomCommandError("invalid", String(e)); }
        if (ask?.resolves?.kind === "thread" && !store.thread(ask.resolves.ref.replace(/^loom:/, ""))) throw new LoomCommandError("invalid", "Ask target thread missing");
        this.saveTurnHandoff(command.threadId, { ...next, ...(ask ? { ask } : {}), text: command.text.slice(0, 200), messageId: command.messageId ?? null, runId: run.id, at: store.now(), source: "tool" });
        return { threadId: command.threadId, runId: run.id };
      }
      case "trigger.create": {
        if (command.kind === "fan_out") throw new LoomCommandError("invalid", "Use fan_out to create this wait");
        const thread = store.thread(command.threadId);
        if (thread?.session_profile && JSON.parse(thread.session_profile).loomTools === false) {
          throw new LoomCommandError("invalid", "Loom triggers are disabled for this thread");
        }
        try { return { threadId: command.threadId, triggerId: this.triggers.create(command.threadId, command.kind, command.spec, command.note, command.timeoutMinutes) }; }
        catch (e) { throw new LoomCommandError("invalid", String(e)); }
      }
      case "trigger.cancel": {
        try { this.triggers.cancel(command.triggerId); return { triggerId: command.triggerId }; }
        catch (e) { throw new LoomCommandError("invalid", String(e)); }
      }
      case "submit": {
        if (command.kind === "probe" || command.threadId && store.thread(command.threadId)?.kind === "probe") throw new LoomCommandError("invalid", "Probes are managed by fan_out");
        if (command.sameTree !== undefined && typeof command.sameTree !== "boolean") throw new LoomCommandError("invalid", "sameTree must be a boolean");
        let sharedParent: ThreadRow | undefined;
        if (command.sameTree) {
          if (command.threadId || command.role !== "worker" || command.worktree !== undefined) throw new LoomCommandError("invalid", "sameTree requires a new worker and cannot be combined with worktree");
          sharedParent = command.parentThreadId?.startsWith("loom:") ? store.thread(command.parentThreadId.slice(5)) : undefined;
          if (!sharedParent || sharedParent.kind !== "coding" || sharedParent.worktree_mode !== "worktree" || sharedParent.worktree_removed_at || !this.worktrees?.owns(sharedParent) || !existsSync(sharedParent.cwd)) throw new LoomCommandError("invalid", "sameTree requires a parent with an existing Loom build worktree");
        }
        if (command.accountsFrom !== undefined && command.accountsFrom !== "policy") throw new LoomCommandError("invalid", "accountsFrom must be policy");
        if (command.tier !== undefined && (typeof command.tier !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(command.tier))) throw new LoomCommandError("invalid", "Invalid tier");
        if (command.session !== undefined && !validSessionProfile(command.session)) throw new LoomCommandError("invalid", "Invalid session profile");
        if (command.context !== undefined && typeof command.context !== "string") throw new LoomCommandError("invalid", "Invalid context");
        const submitCwd = sharedParent?.cwd ?? command.cwd;
        const submitRepo = sharedParent?.repo ?? command.repo ?? submitCwd;
        let thread = command.threadId ? store.thread(command.threadId) : undefined;
        if (command.threadId && !thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        if (!thread) {
          if (!submitCwd || !command.provider) throw new LoomCommandError("invalid", "A new thread needs cwd and provider");
          if (!this.runtimes[command.provider]) throw new LoomCommandError("invalid", `Unknown provider ${command.provider}`);
          const { account, accounts } = this.placeNewThread(command.provider, command.account ?? null, command.accounts ?? null, command.accountsFrom, submitRepo);
          const title = command.title?.trim() || null;
          if (command.role !== undefined && !isThreadRole(command.role)) throw new LoomCommandError("invalid", `role must be one of ${THREAD_ROLES.join(", ")}`);
          thread = store.createThread({
            ...(newThreadId ? { id: newThreadId } : {}),
            ...(command.role ? { role: command.role } : {}),
            ...(command.parentThreadId ? { parentThreadId: command.parentThreadId } : {}),
            worktreeMode: sharedParent ? "worktree" : command.worktree === "auto" ? "auto" : command.worktree && command.worktree !== "local" ? "worktree" : "local",
            kind: command.kind ?? "coding",
            title,
            cwd: submitCwd,
            provider: command.provider,
            account,
            accounts,
            accountsSource: command.accountsFrom ?? null,
            repo: submitRepo,
            titleSource: title && !command.autoTitle ? "given" : "draft",
          });
        }
        if (sharedParent) store.updateThread(thread.id, { worktree_branch: sharedParent.worktree_branch });
        if (thread.status === "stopped") throw new LoomCommandError("stopped", "This thread was stopped");
        if (command.session !== undefined) {
          // A new profile without a model keeps the thread's: a session never switches models by omission.
          const model = command.session.model ?? (thread.session_profile ? (JSON.parse(thread.session_profile) as SessionProfile).model : undefined);
          store.updateThread(thread.id, { session_profile: JSON.stringify({ ...command.session, ...(model ? { model } : {}) }) });
          if (command.session.loomTools === false) this.triggers.cancelThread(thread.id);
          thread = store.thread(thread.id)!;
        }
        if (command.tier !== undefined) {
          const profile = thread.session_profile ? JSON.parse(thread.session_profile) : {};
          store.updateThread(thread.id, { session_profile: JSON.stringify({ ...profile, tier: command.tier }) });
          thread = store.thread(thread.id)!;
        }
        let images: DecodedImage[];
        try {
          images = decodeImages(command.attachments);
        } catch (error) {
          throw new LoomCommandError("invalid", error instanceof Error ? error.message : String(error));
        }
        if (images.length && !this.options.attachments) throw new LoomCommandError("invalid", "This Loom can't keep images");
        const origin = command.origin && (command.origin.kind === "peer" || command.origin.kind === "peer-out") ? command.origin : null;
        // The owner’s words answer an owner ask; addressed agent mail answers only that agent’s ask.
        // Clear the ask after capturing the briefs it carries below.
        // ...and an ask-lint correction about that ask that hasn't started is stale: the owner already answered.
        if (!origin) this.cancelLintWakes(thread.id);
        // ...and they are the owner at work: active time for level 3 veto windows.
        if (!origin) this.presence.beat(store.now(), "message");
        // Steered: into the running turn, when its harness takes that (delivered after the commit, in deliverSteer).
        const active = command.steer && command.session === undefined && command.context === undefined ? store.activeRun(thread.id) : undefined;
        const live = active && thread.status === "running" ? this.sessions.get(thread.id) : undefined;
        // Never into the handoff turn: it does no other work, so the words queue for the fresh session.
        if (active && active.source !== "reset" && live?.inject) {
          if (!origin) this.discussBriefs(thread.id, active.id);
          if (!origin && thread.ask) closeThreadAsk(store, thread.id, "answered", "person-chat");
          const steered = store.addMessage(thread.id, active.id, "user", command.text, origin ? { ...origin, inline: true } : null);
          if (origin) reconcileAgentAsks(store);
          // Linked to the message only: the run's own first message already went to the harness with its images.
          this.keepImages(thread.id, steered.id, null, images);
          store.setDelivery(steered.id, "pending", command.commandId);
          this.steering = { threadId: thread.id, runId: active.id, messageId: steered.id, text: [this.discussionNote(active.id), command.text].filter(Boolean).join("\n\n"), images: images.map(turnImage) };
          return { threadId: thread.id, runId: active.id, steered: true };
        }
        const run = store.createRun(thread.id, "user", command.text);
        if (!origin) this.discussBriefs(thread.id, run.id);
        if (!origin && thread.ask) closeThreadAsk(store, thread.id, "answered", "person-chat");
        if (command.context !== undefined) store.updateRun(run.id, { context: command.context });
        const message = store.addMessage(thread.id, run.id, "user", command.text, origin);
        // Echo identity lets clients reconcile an accepted submit even if its HTTP reply was lost.
        store.setDelivery(message.id, null, command.commandId);
        if (origin) reconcileAgentAsks(store);
        this.keepImages(thread.id, message.id, run.id, images);
        if (thread.settled_at) store.updateThread(thread.id, { settled_at: null });
        return { threadId: thread.id, runId: run.id, ...(command.steer ? { steered: false } : {}) };
      }
      case "answer": {
        const req = store.request(command.requestId);
        if (!req) throw new LoomCommandError("not_found", `No request ${command.requestId}`);
        // Checked again here: delivery happened outside this transaction.
        if (req.status !== "open") throw new LoomCommandError("not_open", `Request is ${req.status}`);
        store.resolveRequest(req.id, "answered", command.answer);
        this.settleRequestPointers(req.id);
        this.cancelLintWakes(req.thread_id);
        // Answering a prompt is the owner's word too.
        const open = store.thread(req.thread_id)?.ask;
        const pointer = open ? (JSON.parse(open) as OpenAsk).points_to === req.id : false;
        if (open) closeThreadAsk(store, req.thread_id, pointer ? "resolved" : "answered", pointer ? `record:${req.id}` : "person-chat");
        if (store.openRequests(req.thread_id).length === 0 && store.activeRun(req.thread_id)) {
          store.updateThread(req.thread_id, { status: "running" });
        }
        return { threadId: req.thread_id };
      }
      case "decision.request": {
        const thread = store.thread(command.threadId);
        if (!thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        if (thread.status === "stopped") throw new LoomCommandError("stopped", "This thread was stopped");
        if (thread.session_profile && JSON.parse(thread.session_profile).loomTools === false) throw new LoomCommandError("invalid", "Loom tools are disabled for this thread");
        this.rules.importFile();
        let board;
        try { board = this.board(); } catch (e) { throw new LoomCommandError("invalid", String(e)); }
        // A session started before briefs carried `about` has a tool without it: the thread's name stands in.
        const raw = command.brief && typeof command.brief === "object" ? command.brief as Record<string, unknown> : {};
        const about = typeof raw.about === "string" && raw.about.trim() ? raw.about : thread.title?.trim().split(/\s+/).slice(0, 8).join(" ");
        const { errors, level, candidate: eligible, brief } = lintBrief(about ? { ...raw, about } : command.brief, board);
        if (errors.length) throw new LoomCommandError("invalid", `The brief needs work: ${errors.join("; ")}`);
        const scope = brief.proposedRule ? parseProposedRule(brief.proposedRule).scope : null;
        // A standing rule for this exact scope already decides it: act and cite it (a precedent conflict still asks).
        // Every active rule that takes this scope in (the same scope, or a wider one containing it): one decides it;
        // several that say different things are a precedent conflict, the owner's to settle with all of them named.
        const covers = scope ? this.rules.active(brief.class).filter((r) => r.class === brief.class && scopeCovers(r.scope, scope)) : [];
        const disagree = covers.length > 1 && new Set(covers.map((r) => r.action.trim().toLowerCase())).size > 1;
        if (disagree && brief.tripwire !== "precedent-conflict") throw new LoomCommandError("invalid", `Standing rules ${covers.map((r) => r.id).join(" and ")} all take in "${scope}" but say different things: a precedent conflict. Bring the brief with tripwire "precedent-conflict" and name them.`);
        if (!disagree && covers.length && !brief.tripwire) {
          const rule = covers.find((r) => sameScope(r.scope, scope!)) ?? covers[0]!;
          throw new LoomCommandError("invalid", sameScope(rule.scope, scope!)
            ? `Standing rule ${rule.id} already covers "${rule.scope}": ${rule.action}. Act on it and log it with decision_log (rule: "${rule.id}").`
            : `Standing rule ${rule.id} covers "${rule.scope}", which takes in "${scope}": ${rule.action}. Act on it and log it with decision_log (rule: "${rule.id}", scope: "${scope}").`);
        }
        // A precedent conflict names the rules it settles: each option that keeps one says which.
        if (brief.tripwire === "precedent-conflict") {
          const named = brief.options.map((o) => o.rule).filter((r): r is string => typeof r === "string" && !!r.trim());
          const groups = this.rules.conflicts(brief.class);
          // The rules that take in this brief's scope and disagree are a conflict set too, whatever their own scopes.
          if (disagree && !groups.some((g) => g.length === covers.length && covers.every((r) => g.some((x) => x.id === r.id)))) groups.push(covers);
          // Every rule of one conflict group, each kept by exactly one option: the answer then settles all of them.
          const group = groups.find((g) => named.length === g.length && new Set(named).size === named.length && g.every((r) => named.includes(r.id)));
          // Only rules that really conflict (one class, one scope) can be settled by the answer.
          if (!group) throw new LoomCommandError("invalid", groups.length
            ? `The brief needs work: a precedent-conflict brief names every rule in the conflict, each kept by exactly one option (option.rule): ${groups.map((g) => g.map((r) => r.id).join(" and ")).join("; ")}`
            : `The brief needs work: no active ${brief.class} rules conflict (decision_check lists conflicts), so its options can't name rules to settle`);
        }
        // "Just this once" on an earlier brief: the owner said this scope is not to become a rule.
        const candidate = eligible && !(scope && this.rules.declined(brief.class, scope));
        // Asked once: a new brief of the same class replaces the open one rather than asking again.
        const prior = store.openDecisions(thread.id).find((d) => d.class === brief.class);
        if (prior) store.resolveDecision(prior.id, { status: "superseded" });
        const row = store.addDecision({ id: store.nextDecisionId(), thread_id: thread.id, run_id: store.activeRun(thread.id)?.id ?? null, class: brief.class, level, candidate: candidate ? 1 : 0, ask: brief.ask, brief: JSON.stringify(brief), supersedes: prior?.id ?? null });
        // A thread that pointed the owner at the old brief hears the new id, so it points at that one instead.
        const told = prior ? this.passOnResolved(prior, `it was replaced by decision ${row.id} (${row.ask}); point the owner at ${row.id} if they still need to answer`, false) : [];
        // D-61: a similar earlier approval means approving this one the same way proposes a rule; the card says so.
        const recommended = brief.options.find((o) => o.recommended)?.key ?? null;
        const precedent = candidate ? this.matchingPrecedent(brief.class, brief, recommended, row.id) : undefined;
        if (precedent) store.db.prepare("UPDATE decisions SET precedent_of = ? WHERE id = ?").run(precedent.id, row.id);
        return { threadId: thread.id, decisionId: row.id, level, candidate, superseded: prior?.id ?? null, ...(precedent ? { precedent: precedent.id } : {}), ...(told.length ? { told } : {}) };
      }
      case "decision.answer": {
        const row = store.decision(command.decisionId);
        if (!row) throw new LoomCommandError("not_found", `No decision ${command.decisionId}`);
        if (row.status !== "open") throw new LoomCommandError("not_open", `Decision is ${row.status}`);
        // The owner answers the revision they saw: one that changed since is refused, and nothing reaches the thread (TGO-1079).
        // Once a brief is revised, an answer has to say which revision it saw (Codex review on #811).
        const seen = typeof command.revision === "number" ? command.revision : row.revision === 1 ? 1 : null;
        if (seen !== row.revision) {
          const last = (JSON.parse(row.changes ?? "[]") as BriefChange[]).at(-1);
          throw new LoomCommandError("stale", `Decision ${row.id} was updated since you looked (revision ${row.revision}${last ? `: ${last.what}` : ""}); read it again and answer that`);
        }
        const thread = store.thread(row.thread_id)!;
        if (thread.status === "stopped") throw new LoomCommandError("stopped", "This thread was stopped");
        const brief = JSON.parse(row.brief) as DecisionBrief;
        const option = command.option ?? null, text = command.text?.trim() || null;
        if (option !== null && !brief.options.some((o) => o.key === option)) throw new LoomCommandError("invalid", `No option ${option} on ${row.id}`);
        if (option === null && !text) throw new LoomCommandError("invalid", "An answer needs an option or words");
        const followed = option !== null && brief.options.find((o) => o.recommended)?.key === option && !text;
        if (command.rule != null && !["always", "next-time", "once"].includes(command.rule)) throw new LoomCommandError("invalid", 'rule is "always", "next-time" or "once"');
        const rule = defaultRuleChoice(row.candidate === 1, followed, command.rule ?? null);
        const reason = command.reason?.trim() || null;
        this.presence.beat(store.now(), "answer");
        this.cancelLintWakes(row.thread_id);
        store.resolveDecision(row.id, { status: "answered", decided_by: "person", answer_option: option, answer_text: text, answer_reason: reason, followed_recommendation: option === null ? null : followed ? 1 : 0, rule_choice: rule });
        const made = this.learnFromAnswer(row, brief, { option, text, asItStands: asItStands(brief, option, !!text), rule, reason });
        // The owner's words, as a turn: the thread picks the work back up with the decision in hand.
        const { proposal, precedent } = store.decision(row.id)!;
        const words = answerText(row, brief, { option, text, reason, rule, made, proposal: proposal ? JSON.parse(proposal) as RuleProposal : null, precedent: precedent === 1 });
        const run = store.createRun(thread.id, "user", words);
        store.addMessage(thread.id, run.id, "user", words, null);
        if (thread.kind === "tango-agent") store.queueDecisionDelivery(run.id);
        if (thread.ask) closeThreadAsk(store, thread.id, "resolved", `record:${row.id}`);
        if (thread.settled_at) store.updateThread(thread.id, { settled_at: null });
        const chosen = brief.options.find((o) => o.key === option);
        const told = this.passOnResolved(row, chosen ? `the owner chose ${chosen.key} · ${chosen.label}${text ? ` (${text})` : ""}` : `the owner answered: ${text}`, true);
        return { threadId: thread.id, runId: run.id, decisionId: row.id, ...(made ? { rule: made.id } : {}), ...(told.length ? { told } : {}) };
      }
      case "decision.rule": {
        const row = store.decision(command.decisionId);
        if (!row) throw new LoomCommandError("not_found", `No decision ${command.decisionId}`);
        if (row.status !== "answered" || (row.decided_by !== "person" && row.decided_by !== "person-chat")) throw new LoomCommandError("not_answered", `Decision ${row.id} is ${row.status}: only a brief you answered can change how it counts`);
        if (!["always", "next-time", "once"].includes(command.rule)) throw new LoomCommandError("invalid", 'rule is "always", "next-time" or "once"');
        const brief = JSON.parse(row.brief) as DecisionBrief;
        const reason = command.reason?.trim() || row.answer_reason;
        let made: string | null = null;
        const proposal = row.proposal ? JSON.parse(row.proposal) as RuleProposal : null;
        const setProposal = (state: RuleProposal["state"]) => { if (proposal && proposal.state !== state) store.db.prepare("UPDATE decisions SET proposal = ? WHERE id = ?").run(JSON.stringify({ ...proposal, state }), row.id); };
        // The owner confirmed the proposal they saw: a rewrite since (the model's), a proposal set aside meanwhile, or an
        // earlier decision that no longer counts is refused, to be looked at again; never a different rule in its place.
        // Confirming a pending proposal needs the text the owner saw (a tab from before this check sends none: refused).
        if (command.rule === "always" && proposal?.state === "proposed" && command.proposal == null) throw new LoomCommandError("changed", `${row.id} has a proposed rule; confirm it with the text you saw (reload the desk): ${proposal.text}`);
        if (command.rule === "always" && command.proposal != null) {
          if (!proposal || proposal.state !== "proposed") throw new LoomCommandError("changed", `The proposed rule on ${row.id} was ${proposal?.state === "made" ? "already made" : "set aside"} meanwhile`);
          if (oneLine(command.proposal) !== oneLine(proposal.text)) throw new LoomCommandError("changed", `The proposed rule on ${row.id} was rewritten since you saw it: ${proposal.text}`);
        }
        if (command.rule === "always" && proposal?.state === "proposed") {
          const lapsed = proposal.from.filter((id) => id !== row.id && store.decision(id)?.precedent !== 1);
          if (lapsed.length) throw new LoomCommandError("changed", `${lapsed.join(" and ")} no longer counts as a precedent (its answer changed), so the proposal from ${proposal.from.join(" and ")} doesn't stand: say Always on ${row.id} to make its own rule`);
        }
        if (command.rule === "always" && proposal?.state === "proposed") {
          // A rule wider or narrower than the proposal that says otherwise came since the owner saw it: confirming would
          // leave the two in conflict, so it is refused, to be looked at again. (One for the same scope gives way, as ever.)
          const rival = this.rules.rival(row.class, proposal.scope, proposal.action);
          if (rival) throw new LoomCommandError("changed", `Standing rule ${rival.id} (${rival.scope}) overlaps "${proposal.scope}" now and says otherwise (${rival.action}): the proposed rule on ${row.id} would conflict with it`);
        }
        if (command.rule === "always" && proposal?.state === "proposed") {
          // D-61: the rule two similar approvals proposed, confirmed with one tap. Both decisions stand behind it.
          const rule = this.rules.create({ class: row.class, proposedRule: proposal.text, reason, decisionId: row.id, guard: loadBoard().classes[row.class]?.guard ?? null });
          for (const id of proposal.from) if (id !== row.id) {
            this.rules.addSource(rule.id, id);
            // The earlier approval backs the rule now: linked to it, no longer a free precedent.
            store.setDecisionRule(id, { rule_id: rule.id, rule_choice: "always" });
            store.db.prepare("UPDATE decisions SET precedent = 0 WHERE id = ?").run(id);
          }
          made = rule.id;
          setProposal("made");
        } else if (command.rule === "always") {
          // Already backing an active rule: nothing to do. Otherwise (no rule, or one this answer stopped backing) it
          // goes through create, which reuses a rule for the same ruling and adds this answer to its source.
          const current = row.rule_id ? this.rules.rule(row.rule_id) : undefined;
          if (!(current?.state === "active" && (JSON.parse(current.source) as string[]).includes(row.id))) {
            if (!canPromote(brief, asItStands(brief, row.answer_option, row.decided_by === "person" && !!row.answer_text))) throw new LoomCommandError("invalid", brief.tripwire ? `${row.id} hit a tripwire (${brief.tripwire}): it can't become a rule` : !brief.proposedRule ? `${row.id} proposed no rule` : `You didn't take ${row.id}'s recommendation as it stood, so its rule isn't what you decided`);
            // The rule this answer backed still stands on another's support, worded otherwise than this brief (a confirmed
            // proposal's general rule, its scope or its action): it rejoins that rule. (The same ruling goes through create.)
            const own = brief.proposedRule ? parseProposedRule(brief.proposedRule) : null;
            if (current?.state === "active" && own && !(sameScope(current.scope, own.scope) && current.action.trim().toLowerCase() === own.action.trim().toLowerCase())) { this.rules.addSource(current.id, row.id); made = current.id; }
            // A rule of another scope that overlaps this one and says otherwise: a new rule here would conflict with it.
            const rival = !made && own ? this.rules.rival(row.class, own.scope, own.action) : undefined;
            if (rival) throw new LoomCommandError("changed", `Standing rule ${rival.id} (${rival.scope}) overlaps "${own!.scope}" and says otherwise (${rival.action}): ${row.id} can't become a rule beside it`);
            // The rule this answer made before stands again only if its words now (an edit since) don't overlap another saying otherwise.
            const before = !made && row.rule_id ? this.rules.rule(row.rule_id) : undefined;
            const clash = before && before.state !== "active" ? this.rules.rival(row.class, before.scope, before.action) : undefined;
            if (clash) throw new LoomCommandError("changed", `Standing rule ${clash.id} (${clash.scope}) overlaps ${before!.id} (${before!.scope}) and says otherwise (${clash.action}): ${before!.id} can't stand again beside it`);
            // The rule this answer made before (and the owner took back) stands again: one decision, one rule.
            const revived = !made && row.rule_id ? this.rules.revive(row.rule_id, row.id) : null;
            if (revived && brief.proposedRule) this.rules.undecline(row.class, brief.proposedRule);
            made ??= revived?.id ?? this.rules.create({ class: row.class, proposedRule: brief.proposedRule!, reason, decisionId: row.id, guard: loadBoard().classes[row.class]?.guard ?? null }).id;
          }
        } else {
          // "Ask me next time" after "Just this once": the scope is a candidate again.
          if (command.rule === "next-time" && brief.proposedRule) this.rules.undecline(row.class, brief.proposedRule);
          if (row.rule_id) this.rules.withdraw(row.rule_id, command.rule === "once" ? "the owner said just this once" : "the owner said ask next time", row.id);
          // D-61: "Just this once" keeps the answer as a precedent; "Ask me next time" doesn't count it. Either way a
          // proposed rule is set aside (it isn't proposed again).
          const counts = command.rule === "once" && row.candidate === 1 && canPromote(brief, asItStands(brief, row.answer_option, row.decided_by === "person" && !!row.answer_text));
          store.db.prepare("UPDATE decisions SET precedent = ? WHERE id = ?").run(counts ? 1 : 0, row.id);
          setProposal("dismissed");
          // A proposal elsewhere that leaned on this answer no longer stands once it stops counting; nor does a promise.
          if (!counts) this.releasePrecedent(row.id);
          // It counts now (from Ask me next time): open briefs in the class with no precedent may pair with it.
          else if (row.precedent !== 1) this.offerPrecedent(row.class, row.id);
        }
        // A new reason on Always teaches the rule it backs, not only the ledger.
        if (command.rule === "always" && command.reason?.trim()) {
          const backed = made ?? row.rule_id;
          if (backed) this.rules.setReason(backed, command.reason.trim());
        }
        store.setDecisionRule(row.id, { rule_choice: command.rule, answer_reason: reason, ...(made ? { rule_id: made } : {}) });
        // A decision behind a rule is that rule's, not a precedent waiting for a second call: proposals and promises
        // elsewhere that leaned on it are set aside, as when it stops counting.
        if (command.rule === "always") {
          store.db.prepare("UPDATE decisions SET precedent = 0 WHERE id = ?").run(row.id);
          this.releasePrecedent(row.id);
        }
        // Whether the rule still stands: another approval can keep it active after this one stops backing it.
        const ruleId = made ?? row.rule_id;
        return { threadId: row.thread_id, decisionId: row.id, rule: made ?? (command.rule === "always" ? row.rule_id : null), ruleState: ruleId ? this.rules.rule(ruleId)?.state ?? null : null };
      }
      case "rules.keepAsPrecedents": {
        if (!Array.isArray(command.ruleIds) || !command.ruleIds.length || command.ruleIds.some((id) => typeof id !== "string")) throw new LoomCommandError("invalid", "ruleIds: the rules to keep as precedents");
        const kept = this.rules.keepAsPrecedents(command.ruleIds);
        return { kept } as CommandResult;
      }
      case "rule.retire": {
        if (!this.rules.rule(command.ruleId)) throw new LoomCommandError("not_found", `No rule ${command.ruleId}`);
        if (typeof command.reason !== "string" || !command.reason.trim()) throw new LoomCommandError("invalid", "Retirement requires a reason");
        this.rules.retire(command.ruleId, command.reason.trim());
        return {};
      }
      case "rule.update": {
        const rule = this.rules.rule(command.ruleId);
        if (!rule) throw new LoomCommandError("not_found", `No rule ${command.ruleId}`);
        if (!command.scope?.trim() && !command.do?.trim() && command.reason == null) throw new LoomCommandError("invalid", "Give a new scope, do or reason");
        // A revised rule may not land on another active one that says otherwise (same scope, or one taking in the other):
        // the two would stand in conflict. The owner settles that rule first.
        if (rule.state === "active") {
          const scope = command.scope?.trim() ? oneLine(command.scope) : rule.scope, action = command.do?.trim() ? oneLine(command.do) : rule.action;
          this.rules.importFile();
          const clash = this.rules.active(rule.class).find((r) => r.id !== rule.id && r.class === rule.class && (sameScope(r.scope, scope) || scopeCovers(r.scope, scope) || scopeCovers(scope, r.scope)) && r.action.trim().toLowerCase() !== action.trim().toLowerCase());
          if (clash) throw new LoomCommandError("invalid", `${rule.id} would conflict with ${clash.id} (${clash.scope}: ${clash.action}): retire or revise ${clash.id} first`);
        }
        this.rules.update(rule.id, { scope: command.scope, action: command.do, reason: command.reason });
        return {};
      }
      case "rules.reviewed": {
        if (!Array.isArray(command.ruleIds) || command.ruleIds.some((id) => typeof id !== "string")) throw new LoomCommandError("invalid", "ruleIds: the rule ids the review showed");
        this.rules.reviewed(command.ruleIds);
        return {};
      }
      case "thread.seen": {
        if (!Number.isFinite(command.at)) throw new LoomCommandError("invalid", "at: when the thread was seen");
        for (const row of this.discussingBriefs(command.threadId)) {
          const run = row.discussing_run ? store.run(row.discussing_run) : undefined;
          if (row.kept_at != null && run?.thread_id === command.threadId && run.ended_at != null && run.ended_at <= Math.min(command.at, store.now())) this.returnDiscussion(row);
        }
        return { threadId: command.threadId };
      }
      case "decision.keep": {
        const row = store.decision(command.decisionId);
        const actor = store.thread(command.threadId);
        if (!row || !actor) throw new LoomCommandError("not_found", "No decision or thread");
        if (actor.status === "stopped") throw new LoomCommandError("stopped", "This thread was stopped");
        if (!this.inBriefChain(actor, row)) throw new LoomCommandError("not_yours", "This brief is not in your chain");
        if (row.status !== "open" || (row.discussing_since == null && row.unaddressed_at == null)) throw new LoomCommandError("not_open", "This brief is not in discussion");
        if (!command.why?.trim()) throw new LoomCommandError("invalid", "why: explain why the owner's message was about something else");
        if (row.discussing_since != null) {
          store.db.prepare("UPDATE decisions SET kept_at=?, unaddressed_at=NULL WHERE id=?").run(store.now(), row.id);
          store.noteThread(row.thread_id);
        } else this.returnDiscussion(row);
        this.ledger.event(actor.id, "decision-keep", `Decision ${row.id} kept unchanged: ${command.why.trim()}`, row.id);
        return { threadId: row.thread_id, decisionId: row.id };
      }
      case "decision.update": {
        const row = store.decision(command.decisionId);
        const actor = store.thread(command.threadId);
        if (!row || !actor) throw new LoomCommandError("not_found", `No decision ${command.decisionId}`);
        if (actor.status === "stopped") throw new LoomCommandError("stopped", "This thread was stopped");
        if (!this.inBriefChain(actor, row)) throw new LoomCommandError("not_yours", `${row.id} isn't in this thread's chain: only the thread that raised it, its workers, or its lead or carrier can update it`);
        if (row.status !== "open") throw new LoomCommandError("not_open", `Decision ${row.id} is ${row.status}`);
        const why = typeof command.why === "string" ? command.why.trim() : "";
        if (!why) throw new LoomCommandError("invalid", "why: the new information that changes the brief");
        let board;
        try { board = this.board(); } catch (e) { throw new LoomCommandError("invalid", String(e)); }
        const revised = reviseBrief(JSON.parse(row.brief) as DecisionBrief, row.level, command.changes, board);
        if (revised.errors.length) throw new LoomCommandError("invalid", `The update needs work: ${revised.errors.join("; ")}`);
        // Still a promotion candidate as decision.request judges one: its proposed rule's scope wasn't declined ("just this once").
        const scope = revised.brief.proposedRule ? parseProposedRule(revised.brief.proposedRule).scope : null;
        revised.candidate = revised.candidate && !(scope && this.rules.declined(revised.brief.class, scope));
        const revision = row.revision + 1;
        // One FYI per material revision, to everyone carrying it and to the thread that raised it; not to the updater.
        // Who was told goes in the log, so the desk never tells a Loom thread a second time (Codex review on #811).
        const told: string[] = [];
        if (revised.material) {
          const raisedOn = store.thread(row.thread_id);
          const restarts = revised.level === 3 ? " Its veto window starts over." : "";
          const words = (own: boolean) => `Loom: ${own ? `your decision ${row.id}` : `decision ${row.id}, raised on "${raisedOn?.title ?? row.thread_id}",`} was updated by "${actor.title ?? actor.id}" (revision ${revision}): ${revised.what}. Why: ${why}${/[.!?]$/.test(why) ? "" : "."} It is still open as ${row.id}, now asking: ${revised.brief.ask}${restarts} ${own ? "Its answer arrives as a new turn, as before" : `Point the owner at ${row.id} as before`}; don't raise a new brief or restate it.`;
          const targets = this.carriersOf(row, true);
          // The thread that raised it hears its brief changed even if it was marked done: the brief is still open (Codex review on #811).
          if (raisedOn && raisedOn.id !== actor.id && raisedOn.settled_at && raisedOn.status !== "stopped") store.updateThread(raisedOn.id, { settled_at: null });
          const raiser = raisedOn ? store.thread(raisedOn.id) : undefined;
          if (raiser) targets.set(raiser.id, raiser);
          for (const thread of targets.values()) if (thread.id !== actor.id && this.tell(thread, words(thread.id === row.thread_id), row.thread_id)) told.push(thread.id);
        }
        const changes = [...(JSON.parse(row.changes ?? "[]") as BriefChange[]), { revision, at: store.now(), by: actor.id, by_title: actor.title, fields: revised.fields, what: revised.what, why, material: revised.material, told }];
        // A material change is a new question: a level 3 veto window starts over from it. A copy edit leaves the clock be.
        const windowFrom = revised.material || row.discussing_since != null ? store.now() : row.window_from;
        store.reviseDecision(row.id, { level: revised.level, candidate: revised.candidate ? 1 : 0, ask: revised.brief.ask, brief: JSON.stringify(revised.brief), revision, changes: JSON.stringify(changes), window_from: windowFrom });
        if (row.discussing_since != null) for (const carrier of this.carriersOf(row, true).keys()) store.noteThread(carrier);
        // The precedent the card promises follows the revised brief (its rule, recommendation, option labels).
        const recommended = revised.brief.options.find((o) => o.recommended)?.key ?? null;
        const promised = revised.candidate ? this.matchingPrecedent(revised.brief.class, revised.brief, recommended, row.id) : undefined;
        store.db.prepare("UPDATE decisions SET precedent_of = ? WHERE id = ?").run(promised?.id ?? null, row.id);
        return { threadId: row.thread_id, decisionId: row.id, revision, changed: revised.what, material: revised.material, level: revised.level, ...(told.length ? { told } : {}) };
      }
      case "decision.close": {
        const row = store.decision(command.decisionId);
        const actor = store.thread(command.threadId);
        if (!row || !actor) throw new LoomCommandError("not_found", `No decision ${command.decisionId}`);
        if (command.outcome !== "withdrawn" && command.outcome !== "moot" && command.outcome !== "answered-in-chat") throw new LoomCommandError("invalid", 'outcome is "withdrawn", "moot" or "answered-in-chat"');
        // Closing is open to the brief's whole chain (TGO-1079): the thread that raised it, its workers, its lead or
        // carrier, and a thread that named the id in its closing ask or words. The owner's answer may be given in any
        // of them (a lead that relayed the brief hears it in its own conversation; TGO-1110).
        // Recording the owner's answer is stricter than withdrawing: a thread that only mentioned the id in passing can't (its open ask must name it).
        if (!this.inBriefChain(actor, row, command.outcome === "answered-in-chat")) {
          throw new LoomCommandError("not_found", `${row.id} isn't in this thread's chain: only the thread that raised it, its workers, its lead or carrier, or a thread that named ${row.id} in its closing ask can close it`);
        }
        if (row.status !== "open") throw new LoomCommandError("not_open", `Decision is ${row.status}`);
        const brief = JSON.parse(row.brief) as DecisionBrief;
        const option = command.option ?? null;
        const note = command.note?.trim() || null;
        if (option !== null && !brief.options.some((o) => o.key === option)) throw new LoomCommandError("invalid", `No option ${option} on ${row.id}`);
        if (command.outcome === "answered-in-chat" && option === null && !note) throw new LoomCommandError("invalid", "Say what the owner decided: the option, or their answer in a note");
        if (command.outcome === "moot" && !note) throw new LoomCommandError("invalid", "note: the new information that makes it moot");
        if (command.outcome === "withdrawn" || command.outcome === "moot") {
          store.resolveDecision(row.id, { status: command.outcome, decided_by: "agent", answer_text: note });
          const by = actor.id === row.thread_id ? "the thread that raised it" : `"${actor.title ?? actor.id}"`;
          const told = this.passOnResolved(row, command.outcome === "moot" ? `${by} marked it moot: ${note}` : `${by} withdrew it${note ? `: ${note}` : ""}`, true, actor.id);
          // Closed from elsewhere in its chain: the thread that raised it hears so, and carries on with the new information.
          const raisedOn = store.thread(row.thread_id)!;
          // Its own ask naming it is over too, whoever closed it (the rebuild agrees: resolvedBetween).
          if (raisedOn.ask && this.namedId(row.id).test(raisedOn.ask)) closeThreadAsk(store, raisedOn.id, "resolved", `record:${row.id}`);
          if (actor.id !== raisedOn.id && raisedOn.status !== "stopped") {
            const words = `Loom: your decision ${row.id} (${row.ask}) was ${command.outcome === "moot" ? "marked moot" : "withdrawn"} by "${actor.title ?? actor.id}"${note ? `: ${note}` : ""}. Nothing goes ahead from it and the owner won't answer it; carry on with that in hand, and don't ask the owner about ${row.id} again.`;
            if (raisedOn.settled_at) store.updateThread(raisedOn.id, { settled_at: null });
            if (this.tell(store.thread(raisedOn.id)!, words, actor.id)) told.push(raisedOn.id);
          }
          return { threadId: row.thread_id, decisionId: row.id, ...(told.length ? { told } : {}) };
        }
        if (command.rule != null && !["always", "next-time", "once"].includes(command.rule)) throw new LoomCommandError("invalid", 'rule is "always", "next-time" or "once"');
        // In chat, the note is the agent's record of what the owner said; the option is what decides whether it was
        // the recommendation as it stood. The rule follows the same default as an answer on the desk.
        const followed = option !== null && brief.options.find((o) => o.recommended)?.key === option;
        const rule = defaultRuleChoice(row.candidate === 1, followed, command.rule ?? null);
        const reason = command.reason?.trim() || null;
        const elsewhere = actor.id !== row.thread_id;
        store.resolveDecision(row.id, { status: "answered", decided_by: "person-chat", decided_in: actor.id, answer_option: option, answer_text: note, answer_reason: reason, followed_recommendation: option === null ? null : followed ? 1 : 0, rule_choice: rule });
        // In chat the note records the answer; it doesn't change it.
        const made = this.learnFromAnswer(row, brief, { option, text: note, asItStands: asItStands(brief, option, false), rule, reason });
        const chosen = brief.options.find((o) => o.key === option);
        const said = `${chosen ? `${chosen.key} · ${chosen.label}` : ""}${chosen && note ? " — " : ""}${note ?? ""}`;
        const told = this.passOnResolved(row, `the owner answered it in ${elsewhere ? `"${actor.title ?? actor.id}"` : "that conversation"}${said ? `: ${said}` : ""}`, true, actor.id);
        // Answered in another thread: the thread that raised it hears the answer, as it would from the desk.
        const raisedOn = store.thread(row.thread_id)!;
        if (elsewhere && raisedOn.status !== "stopped" && !told.includes(raisedOn.id)) {
          if (raisedOn.ask && this.namedId(row.id).test(raisedOn.ask)) closeThreadAsk(store, raisedOn.id, "resolved", `record:${row.id}`);
          if (raisedOn.settled_at) store.updateThread(raisedOn.id, { settled_at: null });
          if (this.tell(store.thread(raisedOn.id)!, `Loom: your decision ${row.id} (${row.ask}) was answered by the owner in "${actor.title ?? actor.id}": ${said || "see that conversation"}. Carry it out, and don't ask the owner about ${row.id} again.`, actor.id)) told.push(raisedOn.id);
        }
        return { threadId: row.thread_id, decisionId: row.id, ...(made ? { rule: made.id } : {}), ...(told.length ? { told } : {}) };
      }
      case "decision.log": {
        const thread = store.thread(command.threadId);
        if (!thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        if (thread.status === "stopped") throw new LoomCommandError("stopped", "This thread was stopped");
        if (thread.session_profile && JSON.parse(thread.session_profile).loomTools === false) throw new LoomCommandError("invalid", "Loom tools are disabled for this thread");
        // A rule suspended (or added) in the file off Loom counts before this log is authorized.
        this.rules.importFile();
        let board;
        try { board = this.board(); } catch (e) { throw new LoomCommandError("invalid", String(e)); }
        const { errors, level, log } = lintLog(command, board, (id) => this.rules.rule(id));
        if (errors.length) throw new LoomCommandError("invalid", `Not logged: ${errors.join("; ")}`);
        // A rule in conflict with another for the same scope is no authority: the owner picks between them first.
        const conflict = log.rule ? this.rules.conflicts(log.class).find((group) => group.some((r) => r.id === log.rule)) : undefined;
        if (conflict) throw new LoomCommandError("invalid", `Not logged: ${conflict.map((r) => r.id).join(" and ")} cover the same scope, a precedent conflict. Bring a brief with tripwire "precedent-conflict" that names both rules.`);
        // Another rule that also takes in this case but says something else: a conflict too, the owner's to settle.
        const cited = log.rule ? this.rules.rule(log.rule) : undefined;
        const rival = cited && typeof command.scope === "string" ? this.rules.active(log.class).find((r) => r.class === log.class && r.id !== cited.id && scopeCovers(r.scope, command.scope!) && r.action.toLowerCase() !== cited.action.toLowerCase()) : undefined;
        if (rival) throw new LoomCommandError("invalid", `Not logged: ${rival.id} also takes in "${command.scope}" and says "${rival.action}", not "${cited!.action}": a precedent conflict. Bring a brief with tripwire "precedent-conflict" that names ${cited!.id} and ${rival.id}.`);
        const row = store.logDecision({ id: store.nextDecisionId(), thread_id: thread.id, run_id: store.activeRun(thread.id)?.id ?? null, class: log.class, level, ask: log.summary, undo: log.undo, ref: log.ref, rule_id: log.rule, dissent: log.dissent });
        if (log.rule) this.rules.use(log.rule);
        return { threadId: thread.id, decisionId: row.id, level, ...(log.rule ? { rule: log.rule } : {}) };
      }
      case "update.post":
      case "chapter.note": {
        const thread = store.thread(command.threadId);
        if (!thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        if (thread.session_profile && JSON.parse(thread.session_profile).loomTools === false) throw new LoomCommandError("invalid", "Loom tools are disabled for this thread");
        if (thread.kind === "probe") throw new LoomCommandError("invalid", "Probes do not publish catch-up updates");
        if (command.type === "chapter.note") {
          const { errors, note } = lintNote(command);
          if (errors.length) throw new LoomCommandError("invalid", `Not noted: ${errors.join("; ")}`);
          return { threadId: thread.id, noteId: this.catchup.addNote({ thread_id: thread.id, ...note }).id };
        }
        const { errors, update } = lintUpdate(command);
        if (update.supersedes && !this.catchup.update(update.supersedes)) errors.push(`supersedes: there is no update ${update.supersedes}`);
        if (errors.length) throw new LoomCommandError("invalid", `Not posted: ${errors.join("; ")}`);
        // It stands for this turn's words: seeing it on the desk covers them (the spec's covers_from..covers_to).
        const run = store.activeRun(thread.id);
        const row = this.catchup.addUpdate({ thread_id: thread.id, run_id: run?.id ?? null, ...update, covers_from: run?.started_at ?? null, covers_to: run ? store.now() : null });
        return { threadId: thread.id, updateId: row.id };
      }
      case "decision.confirm": {
        // "Fine by me" (catch-up): recorded for the learning loop, the opposite of a reversal. Wakes nothing.
        const row = store.decision(command.decisionId);
        if (!row) throw new LoomCommandError("not_found", `No decision ${command.decisionId}`);
        if (row.status !== "acted" && row.status !== "defaulted") throw new LoomCommandError("not_decided", `Decision ${row.id} is ${row.status}: only what was decided for you can be confirmed`);
        if (row.reversed_at !== null) throw new LoomCommandError("reversed", `Decision ${row.id} was already reversed`);
        if (row.confirmed_at === null) store.confirmDecision(row.id);
        return { threadId: row.thread_id, decisionId: row.id };
      }
      case "decision.reverse": {
        const row = store.decision(command.decisionId);
        if (!row) throw new LoomCommandError("not_found", `No decision ${command.decisionId}`);
        if (row.status !== "acted" && row.status !== "defaulted") throw new LoomCommandError("not_decided", `Decision ${row.id} is ${row.status}: only what was decided for you can be reversed`);
        if (row.reversed_at !== null) throw new LoomCommandError("reversed", `Decision ${row.id} was already reversed`);
        const note = command.note?.trim() || null;
        const thread = store.thread(row.thread_id)!;
        this.presence.beat(store.now(), "answer");
        // Phase 3: a reversal suspends the rule it was taken under at once, and counts against the class.
        const learn = (reversal: "undo" | "disagree") => this.rules.reversed(row, `${reversal === "undo" ? "Undo" : "\"I wouldn't have\""} on ${row.id}${note ? `: ${note}` : ""}`);
        if (!command.undo) {
          store.reverseDecision(row.id, { reversal: "disagree", reversal_note: note });
          const learned = learn("disagree");
          return { threadId: thread.id, decisionId: row.id, ...learned };
        }
        if (thread.status === "stopped") throw new LoomCommandError("stopped", "This thread was stopped; mark it \"I wouldn't have\" instead");
        store.reverseDecision(row.id, { reversal: "undo", reversal_note: note });
        const learned = learn("undo");
        // The owner's words, as a turn: the thread that did it puts it back.
        const words = undoText(row, note, learned.suspended);
        const run = store.createRun(thread.id, "user", words);
        store.addMessage(thread.id, run.id, "user", words, null);
        if (thread.settled_at) store.updateThread(thread.id, { settled_at: null });
        return { threadId: thread.id, runId: run.id, decisionId: row.id, ...learned };
      }
      case "move": {
        const thread = store.thread(command.threadId);
        if (!thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        const account = typeof command.account === "string" ? this.options.pool?.resolve(thread.provider, command.account) : null;
        const allowed = this.allowedAccounts(thread);
        if (!account || (allowed && !allowed.includes(account.name) && command.allow !== true)) {
          throw new LoomCommandError("invalid", "Unknown or disallowed account");
        }
        if (command.allow === true && allowed) store.updateThread(thread.id, { accounts_source: null, accounts: JSON.stringify([...new Set([...allowed, account.name])]) });
        store.setAccountMove(thread.id, account.name);
        store.updateThread(thread.id, { account: thread.account });
        return { threadId: thread.id };
      }
      case "rename": {
        const thread = store.thread(command.threadId);
        if (!thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        const title = typeof command.title === "string" ? command.title.trim() : "";
        if (!title) throw new LoomCommandError("invalid", "A title is required");
        store.updateThread(thread.id, { title: title.slice(0, 200), title_source: "owner" });
        return { threadId: thread.id };
      }
      case "role": {
        const thread = store.thread(command.threadId);
        if (!thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        if (!isThreadRole(command.role)) throw new LoomCommandError("invalid", `role must be one of ${THREAD_ROLES.join(", ")}`);
        const parent = command.parentThreadId === undefined ? thread.parent_thread_id : command.parentThreadId;
        if (parent === `loom:${thread.id}`) throw new LoomCommandError("invalid", "A thread can't own itself");
        store.updateThread(thread.id, { role: command.role, parent_thread_id: parent });
        return { threadId: thread.id };
      }
      case "settle.undo": {
        const thread = store.thread(command.threadId);
        if (!thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        if (!Number.isFinite(command.settledAt)) throw new LoomCommandError("invalid", "settledAt is required");
        if (thread.settled_at !== command.settledAt) return { threadId: thread.id };
        store.updateThread(thread.id, { settled_at: null });
        if (!thread.ask) reopenAsk(store, thread.id, command.settledAt);
        this.rebuildAsks(thread.id);
        return { threadId: thread.id };
      }
      case "clear":
      case "clear.undo":
      case "unsettle": {
        const thread = store.thread(command.threadId);
        if (!thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        if (command.type === "unsettle") store.updateThread(thread.id, { settled_at: null });
        else {
          if (!Number.isFinite(command.clearedAt)) throw new LoomCommandError("invalid", "clearedAt is required");
          if (command.type === "clear") {
            store.db.prepare("INSERT OR IGNORE INTO thread_clears (thread_id, cleared_at, at) VALUES (?, ?, ?)").run(thread.id, command.clearedAt, store.now());
            // Replay at the desk action cutoff, preserving handoffs completed during delivery.
            this.rebuildAsks(thread.id);
          } else {
            store.db.prepare("DELETE FROM thread_clears WHERE thread_id=? AND cleared_at=?").run(thread.id, command.clearedAt);
            if (!thread.ask) reopenAsk(store, thread.id);
            // Replay preserves every newer owner word, handoff and clear instead of overwriting a live ask; it arms the
            // reopened ask's resolution trigger afresh (Clear cancelled the old one; Codex review on #1031).
            this.rebuildAsks(thread.id);
          }
        }
        return { threadId: thread.id };
      }
      case "interrupt":
      case "settle":
      case "stop":
      case "delete": {
        const thread = store.thread(command.threadId);
        if (!thread) throw new LoomCommandError("not_found", `No thread ${command.threadId}`);
        const told: string[] = [];
        // A delivered Stop was checked against the active run before it went out (deliverInterrupt);
        // by now that turn may have ended because of it.
        if (command.type === "interrupt" && command.runId && !this.interruptsDelivered.has(command.commandId)) {
          const active = store.activeRun(thread.id);
          if (!active || active.id !== command.runId) throw new LoomCommandError("changed", "That turn already finished; nothing was stopped");
        }
        if (command.type === "settle") {
          if (command.settledAt !== undefined && !Number.isFinite(command.settledAt)) throw new LoomCommandError("invalid", "Invalid settledAt");
          const settledAt = command.settledAt ?? store.now();
          const ask = store.db.prepare("SELECT id FROM asks WHERE thread=? AND status='open' AND audience='owner'").get(thread.id) as { id: string } | undefined;
          if (ask) finishAsk(store, ask.id, "closed-by-done", "desk", `settle:${settledAt}`);
          store.updateThread(thread.id, { settled_at: settledAt });
          // A worker settled (it reported and is done, or its parent marked it done): its task is over, so a
          // follow-up from the parent starts a fresh session from the handoff instead of the whole transcript.
          if (thread.role === "worker") this.taskDone(thread);
        }
        if (command.type === "stop" || command.type === "delete") this.triggers.cancelThread(thread.id);
        if (command.type === "stop" || command.type === "delete") {
          // A carrier can disappear while its responsible turn is queued: return the other thread's brief.
          for (const row of this.discussingBriefs(thread.id)) {
            if (row.thread_id !== thread.id && row.discussing_run && store.run(row.discussing_run)?.thread_id === thread.id) this.returnDiscussion(row, true);
          }
        }
        if (command.type === "stop") {
          for (const run of store.runs(thread.id)) {
            if (run.status === "queued" || run.status === "running") {
              this.endRunState(run.id, "canceled");
              store.endAttempts(run.id, "canceled", null);
              this.ledger.end(thread.id, run.id, "cancelled");
            }
          }
          for (const req of store.openRequests(thread.id)) { store.resolveRequest(req.id, "expired", undefined); this.settleRequestPointers(req.id); }
          // A stopped thread can't act on an answer: its briefs leave the owner's desk with it.
          for (const d of store.openDecisions(thread.id)) {
            store.resolveDecision(d.id, { status: "withdrawn", decided_by: "stopped" });
            told.push(...this.passOnResolved(d, "the thread that raised it was stopped, so it is withdrawn", true));
          }
          store.updateThread(thread.id, { status: "stopped", admission: null, admission_until: null });
        }
        // Deleted, its briefs go with it: a thread pointing the owner at one stops waiting on it.
        if (command.type === "delete") for (const d of store.openDecisions(thread.id)) told.push(...this.passOnResolved(d, "the thread that raised it was deleted, so it is withdrawn", true));
        // The thread's image files go only once this commits (afterCommand), so a rollback leaves them.
        if (command.type === "delete") this.releaseThreadPrecedents(thread.id);
        if (command.type === "delete") store.deleteThread(thread.id, this.worktrees?.owns(thread) ?? false);
        return { threadId: thread.id, ...(told.length ? { told } : {}) };
      }
    }
  }

  /** Resolve the current policy, keeping its last good snapshot for fallback. */
  private allowedAccounts(thread: ThreadRow): string[] | null {
    const stored = thread.accounts ? JSON.parse(thread.accounts) as string[] : null;
    if (thread.accounts_source !== "policy") return stored;
    const resolved = this.policyAccounts.resolve(thread, this.options.pool);
    if (!resolved) return stored;
    if (!stored || stored.length !== resolved.length || resolved.some(name => !stored.includes(name))) {
      this.store.tx(() => this.store.updateThread(thread.id, { accounts: JSON.stringify(resolved) }));
    }
    return resolved;
  }

  private adoptPolicyAccounts(): void {
    let adopted = 0;
    this.store.tx(() => {
      for (const thread of this.store.threads()) {
        if (thread.status === "stopped" || thread.settled_at || thread.accounts_source || !thread.accounts) continue;
        const literal = [...new Set((JSON.parse(thread.accounts) as string[]).map(name => this.options.pool?.resolve(thread.provider, name)?.name ?? name))];
        const policy = this.policyAccounts.resolve(thread, this.options.pool);
        if (literal.length < 2 || !policy || literal.length !== policy.length || literal.some(name => !policy.includes(name))) continue;
        this.store.updateThread(thread.id, { accounts_source: "policy", accounts: JSON.stringify(policy) });
        adopted++;
      }
    });
    console.log(`[loom] adopted ${adopted} policy account sets`);
  }

  /**
   * Where a new thread starts and where it may go. Names and aliases resolve to
   * the pool's own names; an unknown one is refused rather than ignored, so a
   * typo can't quietly widen the set. The requested account is used when it is
   * allowed and has room; otherwise the highest-scoring allowed account.
   */
  private placeNewThread(provider: string, requested: string | null, allowed: string[] | null, source?: "policy", repo?: string): { account: string | null; accounts: string[] | null } {
    const pool = this.options.pool;
    if (!pool) return { account: requested, accounts: allowed };
    const canonical = (name: string) => {
      const found = pool.resolve(provider, name);
      if (!found) throw new LoomCommandError("invalid", `Unknown ${provider} account "${name}"`);
      return found.name;
    };
    if (source === "policy") allowed = this.policyAccounts.resolve({ provider, repo: repo ?? null }, pool) ?? allowed;
    const accounts = allowed?.length ? [...new Set(allowed.map(canonical))] : null;
    const wanted = requested ? canonical(requested) : null;
    // The placement is recorded once the command commits (afterCommand), so a refused submit leaves no phantom load.
    if (wanted && (!accounts || accounts.includes(wanted)) && pool.usable(provider, wanted)) return { account: wanted, accounts };
    return { account: pool.best(provider, { only: accounts })?.name ?? null, accounts };
  }

  private async afterCommand(command: Command, result: CommandResult): Promise<void> {
    switch (command.type) {
      case "fan_out.create":
        await this.fanOuts.tick();
        return;
      case "asks.rerecord":
        for (const ask of result.asks ?? []) if (ask.queued) await this.kick(ask.threadId);
        return;
      case "submit": {
        const placed = !command.threadId ? this.store.thread(result.threadId!) : undefined;
        if (placed?.account) this.options.pool?.placed(placed.provider, placed.account);
        this.nameThread(result.threadId!, command.text);
        await this.kick(result.threadId!);
        return;
      }
      case "move":
        await this.kick(command.threadId);
        return;
      case "rename":
      case "role":
        return;
      case "answer":
        await this.kick(result.threadId!);
        return;
      case "decision.answer":
        await this.kick(result.threadId!);
        for (const threadId of result.told ?? []) await this.kick(threadId);
        void this.writeProposal(result.decisionId!).catch(() => {});
        return;
      case "ask.resolve":
      case "decision.reverse":
        if (result.runId) await this.kick(result.threadId!);
        return;
      case "decision.close":
        void this.writeProposal(result.decisionId!).catch(() => {});
        for (const threadId of result.told ?? []) await this.kick(threadId);
        return;
      case "decision.update":
        for (const threadId of result.told ?? []) await this.kick(threadId);
        return;
      case "decision.request":
        for (const threadId of result.told ?? []) await this.kick(threadId);
        return;
      case "thread.seen":
      case "decision.keep":
      case "decision.log":
      case "decision.confirm":
      case "decision.rule":
      case "rules.reviewed":
      case "rule.retire":
      case "rule.update":
      case "rules.keepAsPrecedents":
      case "update.post":
      case "chapter.note":
        return;
      case "interrupt": {
        // A live session was interrupted before the receipt (deliverInterrupt).
        if (!this.sessions.has(command.threadId)) {
          const run = this.store.activeRun(command.threadId);
          if (run) this.store.tx(() => this.finishRun(run, "interrupted", null));
        }
        return;
      }
      case "trigger.cancel":
        await this.fanOuts.tick();
        return;
      case "stop":
        await this.fanOuts.tick();
        await this.closeSession(command.threadId);
        for (const threadId of result.told ?? []) await this.kick(threadId);
        return;
      case "delete":
        await this.fanOuts.tick();
        await this.closeSession(command.threadId);
        this.options.attachments?.removeThread(command.threadId);
        for (const threadId of result.told ?? []) await this.kick(threadId);
        return;
      case "settle":
        await this.leases.reconcile();
        return;
    }
  }

  /**
   * A new thread whose title is only a stand-in gets a short name from the
   * titler, in the background. It never replaces a title someone gave or a
   * rename that landed in the meantime.
   */
  private nameThread(threadId: string, text: string): void {
    const titler = this.options.titler;
    const thread = this.store.thread(threadId);
    if (!titler || !thread || thread.kind === "probe" || thread.title_source !== "draft" || this.store.runs(threadId).length !== 1) return;
    void titler(text, thread.provider === "codex" ? null : thread.account)
      .then((title) => {
        const now = this.store.thread(threadId);
        if (title && now && now.title_source === "draft") {
          this.store.tx(() => this.store.updateThread(threadId, { title, title_source: "generated" }));
        }
      })
      .catch(() => undefined);
  }

  /**
   * Another session as the owner knows it. A Loom session is named for its worktree (`loom-<id prefix>-…`):
   * its thread's title. A reply sent to a socket address (`uds:…`): the name that address last wrote under.
   */
  private peerName(name: string | undefined, address: string | undefined): string | undefined {
    const titleOf = (session: string | undefined) => {
      const prefix = /^loom-([0-9a-f]{8})/.exec(session ?? "")?.[1];
      const thread = prefix ? this.store.threads().find((t) => t.id.startsWith(prefix)) : undefined;
      return thread?.title?.trim() || undefined;
    };
    if (name && !name.startsWith("uds:")) return titleOf(name) ?? name;
    const known = address ? this.store.peerNameAt(address) : null;
    return (known && (titleOf(known) ?? known)) || name || address;
  }

  // Dispatch

  /** Start the thread's next queued run if nothing is running. Serialized per thread. */
  kick(threadId: string): Promise<void> {
    if (this.recovering || this.detaching) return Promise.resolve();
    const prev = this.mailboxes.get(threadId) ?? Promise.resolve();
    const next = prev.then(() => this.dispatch(threadId)).catch(() => {});
    this.mailboxes.set(threadId, next);
    return next;
  }

  private async applyAccountMove(threadId: string): Promise<void> {
    const target = this.store.pendingAccountMove(threadId);
    const thread = this.store.thread(threadId);
    if (!target || !thread || this.store.activeRun(threadId) || this.store.openRequests(threadId).length) return;
    const hadLive = this.sessions.has(threadId);
    await this.closeSession(threadId);
    // Its replacement opens on the next dispatch and takes the slot this host just freed: only when a live
    // host was really freed and a run is waiting to reopen it now.
    if (hadLive && this.store.nextQueuedRun(threadId)) this.replacing.set(threadId, Date.now());
    // A newer command may have arrived while closing the old session.
    const account = this.store.pendingAccountMove(threadId);
    const latest = this.store.thread(threadId);
    if (!account || !latest) return;
    const allowed = this.allowedAccounts(latest);
    if (allowed && !allowed.includes(account)) {
      this.store.endAccountMove(threadId);
      return;
    }
    this.movedAccounts.add(threadId);
    this.store.tx(() => {
      this.store.updateThread(threadId, { account });
      this.store.recordAccount(threadId, account, "move");
      this.store.endAccountMove(threadId);
    });
  }

  private async dispatch(threadId: string): Promise<void> {
    if (!this.fanOuts.canDispatch(threadId)) return;
    // The owner's own message waits out the grace, then goes ahead of the automatic runs maintenance still holds.
    if (this.maintenanceHolds(threadId)) return;
    if (this.maintenanceState().on) this.ownerFirst(threadId, this.ownerTurnAt(threadId));
    await this.applyAccountMove(threadId);
    await this.upgradeSession(threadId);
    let thread = this.store.thread(threadId);
    if (this.detaching || !thread || thread.status === "stopped") return;
    if (this.store.activeRun(threadId) || this.store.openRequests(threadId).length) return;
    const promotion = thread.fresh ? JSON.parse(thread.fresh) as FreshReason : null;
    // Never run queued work back in the checkout while a move is waiting for background work.
    if (promotion?.reason === "worktree" && promotion.worktree?.stage !== "handoff" && !this.quiet(thread)) return;
    let first = this.store.nextQueuedRun(threadId);
    if (!first) {
      // The retried run was stopped while it waited: nothing is held any more.
      if (thread.admission === "provider_busy") this.store.tx(() => this.store.updateThread(threadId, { admission: null, admission_until: null }));
      return;
    }
    // A turn the model turned away waits out its pause; the timer (or the next warmth pass after a restart) kicks it.
    if (thread.admission === "provider_busy" && thread.admission_until !== null && thread.admission_until > this.store.now()) {
      this.kickAt(threadId, thread.admission_until);
      return;
    }
    if (this.assistantTurn(threadId)) {
      this.ownerFirst(threadId, this.ownerTurnAt(threadId));
      first = this.store.nextQueuedRun(threadId)!;
    }
    // Backup pressure holds background work; conversational assistants remain responsive.
    // Local disk safety and provider/account limits still apply in admission.
    if (!this.assistantTurn(threadId) && recoveryPaused(this.options.recoveryHealthFile ?? process.env.LOOM_RECOVERY_HEALTH_FILE, this.store.now())) {
      this.store.tx(() => this.store.updateThread(threadId, { admission: "recovery_unhealthy", admission_until: null }));
      this.kickAt(threadId, this.store.now() + 30_000);
      return;
    }
    if (thread.admission === "recovery_unhealthy") {
      this.store.tx(() => this.store.updateThread(threadId, { admission: null, admission_until: null }));
    }
    // A handoff turn queued before fresh sessions were switched off, or before the profile opted out (no Loom tools to
    // save it with), or before the owner kept the session: no fresh session follows, so it never runs.
    if (first.source === "reset" && !(thread.fresh && JSON.parse(thread.fresh).reason === "worktree") && (this.freshMode(thread) !== "on" || !this.automatic(thread))) {
      this.store.tx(() => this.endRunState(first.id, "canceled"));
      return this.dispatch(threadId);
    }
    const gate = this.budgetGate(thread);
    if (gate === "hold") return;
    if (gate === "again") return this.dispatch(threadId);
    let run: RunRow = first;
    thread = this.store.tx(() => this.applyRoleModel(thread!));
    // An automatic turn waits out its settle window unless the owner's words are queued too.
    const settle = this.options.automaticSettleMs ?? 0;
    const due = run.created_at + settle - this.store.now();
    if (settle > 0 && due > 0 && this.store.queuedRuns(threadId).every((r) => this.foldable(r))) {
      setTimeout(() => { if (!this.detaching) void this.kick(threadId); }, due + 50).unref?.();
      return;
    }
    const wantedHash = sessionHash(thread.session_profile ? JSON.parse(thread.session_profile) : undefined, thread.role);
    if (this.sessions.has(threadId) && this.sessionHashes.get(threadId) !== wantedHash) {
      if (holdsWork(thread.background ? JSON.parse(thread.background) : null)) return; // the task's end kicks dispatch
      if (this.backgroundJustEnded(threadId)) {
        // Nothing else is due to kick this thread once the settle window passes: schedule it.
        const wait = (this.options.backgroundSettleMs ?? BACKGROUND_SETTLE_MS) + 1000;
        setTimeout(() => { if (!this.detaching) void this.kick(threadId); }, wait).unref?.();
        return;
      }
      await this.closeSession(threadId);
      this.replacing.set(threadId, Date.now());
    }
    // An idle live session on an account that has run low is closed first, so the turn starts elsewhere.
    const pool = this.options.pool;
    if (this.sessions.has(threadId) && pool && thread.account && !pool.usable(thread.provider, thread.account)) {
      await this.closeSession(threadId);
    }
    let packet: string | null;
    try { packet = await this.applyFresh(threadId, run, this.store.attempts(run.id).length > 0); }
    catch (error) {
      // Keep the durable move pending so a later turn retries, but never silently resume in the checkout.
      if (!thread.fresh || JSON.parse(thread.fresh).reason !== "worktree") throw error;
      const failure = toFailure(error);
      this.store.tx(() => {
        this.endRunState(run.id, "failed", JSON.stringify(failure));
        this.ledger.event(threadId, "worktree-promotion-failed", "Could not move into a worktree", failure.message);
        this.reportFailure(thread!, run, failure);
      });
      return;
    }
    const afterFresh = this.store.thread(threadId);
    if (!afterFresh || afterFresh.status === "stopped" || this.store.run(run.id)?.status !== "queued") return;
    if (!this.sessions.has(threadId) && !this.chooseAccount(afterFresh)) return;
    const current = this.store.thread(threadId)!;

    let installNote: string | null | undefined;
    let session: RuntimeSession;
    try {
      installNote = await this.worktrees?.restore(current);
      const opened = await this.ensureSession(current);
      if (!opened) return;
      session = opened;
    } catch (error) {
      this.store.tx(() => {
        const failure = toFailure(error);
        failure.message = redactProfile(failure.message, current.session_profile ? JSON.parse(current.session_profile) : undefined);
        // The head of the queue now: admission may have moved the owner's message ahead of `first` (Codex review on #807).
        const failed = this.store.nextQueuedRun(threadId) ?? first;
        this.endRunState(failed.id, "failed", JSON.stringify(failure));
        this.reportFailure(current, failed, failure);
      });
      return this.dispatch(threadId);
    }

    if (current.kind === "probe" && !this.fanOuts.canDispatch(threadId)) { await this.closeSession(threadId); return; }
    // Admission may have moved the owner's message to the front while the session opened.
    run = this.store.nextQueuedRun(threadId) ?? run;
    // A lead's turn starts with what the owner has already seen in its space, so it doesn't retell it (catch-up).
    // Read while the run is still queued: a Stop meanwhile ends it there, and nothing starts it after.
    const continuingTurn = this.store.attempts(run.id).length > 0 && !this.overloadRetry(run.id);
    const asks = !continuingTurn && current.role === "default";
    const seen = asks ? await this.seenPreamble(threadId, run.id) : null;
    if (asks && this.store.run(run.id)?.status !== "queued") return this.dispatch(threadId);
    // A move accepted while this dispatch was opening the session goes first: the run stays queued,
    // and the move's own kick (next in this thread's mailbox) applies it and then starts the run.
    const latest = this.store.thread(threadId);
    if (this.maintenanceHolds(threadId) || this.store.pendingAccountMove(threadId) || this.sessionHashes.get(threadId) !== sessionHash(latest?.session_profile ? JSON.parse(latest.session_profile) : undefined, latest?.role)) return;
    // A run that already had an attempt was cut off by a limit: the harness has its message, so it gets a continue.
    // Unless the session came back on a new native thread (Codex on an account without the transcript): then it
    // has none of it, and the run goes again in full, images included.
    const reopened = session.hello?.nativeSessionId;
    // A run the model turned away goes again in full, behind a note: the harness may not have kept a message it never ran.
    const retrying = this.overloadRetry(run.id);
    const continuing = !packet && !retrying && this.store.attempts(run.id).length > 0 && !(current.native_session_id && reopened && reopened !== current.native_session_id);
    this.store.tx(() => {
      // Automatic runs queued behind this one go in the same turn: one read of the context instead of several.
      if (this.foldable(run)) {
        const rest: RunRow[] = [];
        for (const r of this.store.queuedRuns(threadId)) { if (r.id === run.id) continue; if (!this.foldable(r)) break; rest.push(r); }
        if (rest.length) {
          run.text = [run.text, ...rest.map((r) => r.text)].join("\n\n---\n\n");
          // The surviving turn now owns the folded replies and their discussion obligations.
          for (const folded of rest) this.store.db.prepare("UPDATE decisions SET discussing_run=? WHERE discussing_run=?").run(run.id, folded.id);
          this.store.foldRuns(run.id, rest.map((r) => r.id), run.text);
        }
      }
      this.store.updateRun(run.id, { status: "running", started_at: this.store.now() });
      this.store.createAttempt(run, current.account, current.native_session_id);
      this.ledger.start(this.store.thread(threadId)!, "turn", run.id, "Running turn");
      this.store.updateThread(threadId, { status: "running", ...(this.store.thread(threadId)?.admission ? { admission: null, admission_until: null } : {}) });
    });
    // A continue resends no images: the harness's transcript already has them.
    const images = continuing ? [] : this.turnImages(run.id);
    const coolingNote = this.store.thread(threadId)?.cooling_note;
    const discussionNote = this.discussionNote(run.id);
    session.startTurn({ runId: run.id, text: (discussionNote ? discussionNote + "\n\n" : "") + (packet ? packet + "\n\n---\n\n" : "") + (coolingNote ? coolingNote + "\n\n" : "") + (installNote ?? "") + (seen ? seen + "\n\n" : "") + (continuing ? LIMIT_CONTINUE_NOTE : (retrying ? OVERLOAD_RETRY_NOTE + "\n\n" : "") + (run.context !== null ? run.context + "\n\n" : "") + run.text), ...(images.length ? { images } : {}) });
    if (coolingNote) this.store.tx(() => this.store.updateThread(threadId, { cooling_note: null }));
  }

  /** The seen block for a lead's turn: since its previous turn started (a first turn: the last day). Never throws. */
  private async seenPreamble(threadId: string, runId: string): Promise<string | null> {
    const brief = this.options.seenBrief;
    if (!brief) return null;
    const previous = this.store.db
      .prepare("SELECT MAX(started_at) AS at FROM runs WHERE thread_id = ? AND id != ? AND started_at IS NOT NULL")
      .get(threadId, runId) as { at: number | null } | undefined;
    const since = previous?.at ?? this.store.now() - 24 * 3600_000;
    try {
      return await brief(threadId, since);
    } catch {
      return null;
    }
  }

  /**
   * A run that may share a turn with its neighbours: a wake or another agent's mail, never started, with no
   * context or images of its own, and not an ask-lint correction (the owner's next words cancel those alone) or a
   * stall correction (its outcome is read by its exact text, so it keeps a turn of its own).
   */
  private foldable(run: RunRow): boolean {
    // The bot may already own this exact run id; folding it would orphan its delivery.
    if (this.store.db.prepare("SELECT 1 FROM decision_deliveries WHERE run_id=?").get(run.id)) return false;
    if (run.source !== "wake" && !(run.source === "user" && run.text.startsWith("✉️"))) return false;
    if (run.source === "wake" && (run.wake_cause ?? wakeCause(run.text)) === "corrective") return false;
    if (run.context !== null || this.store.attempts(run.id).length || this.store.runAttachments(run.id).length) return false;
    return !this.store.db.prepare("SELECT 1 FROM ask_lints WHERE wake_run_id = ?").get(run.id);
  }

  /**
   * Gives a thread its role's model as its first turn starts, unless it has a model of its own: the role is the one
   * it has then (a role changed while the turn waited counts), and a session is never moved to another model.
   */
  private applyRoleModel(thread: ThreadRow): ThreadRow {
    if (thread.kind === "probe") return thread;
    const profile: SessionProfile = thread.session_profile ? JSON.parse(thread.session_profile) : {};
    const key = profile.tier && Object.hasOwn(this.options.roleModels ?? {}, profile.tier) && this.options.roleModels?.[profile.tier] !== undefined ? profile.tier : thread.role;
    const tier = this.options.roleModels?.[key];
    if (!tier || profile.model || thread.native_session_id || this.store.runs(thread.id).some(r => r.status !== "queued")) return thread;
    const parse = (value: string | undefined) => {
      const match = value?.match(/^(.*)@(low|medium|high|xhigh|max)$/);
      return { model: match ? match[1] : value, effort: match?.[2] as SessionProfile["effort"] };
    };
    let { model, effort } = parse(tier);
    if (model === "codex" || model?.startsWith("codex:")) {
      model = model.slice("codex:".length) || undefined;
      if (thread.provider !== "codex") {
        // A session Codex can't honour (no tools, a remote MCP server) stays on Claude.
        const pick = !codexIncompatible(profile) && this.runtimes.codex && this.options.pool?.best("codex");
        if (pick) this.reroute(thread, "codex", pick.name);
        else ({ model, effort } = parse(ROLE_FALLBACK_MODELS[key]));
      }
    } else if (thread.provider === "codex") {
      const pick = this.runtimes.claude && this.options.pool?.best("claude");
      if (pick) this.reroute(thread, "claude", pick.name);
    }
    if (model || effort) this.store.updateThread(thread.id, { session_profile: JSON.stringify({ ...profile, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }) });
    return this.store.thread(thread.id)!;
  }

  /** Moves an unopened thread to another provider; the placement made when it was submitted moves with it. */
  private reroute(thread: ThreadRow, provider: string, account: string): void {
    if (thread.account) this.options.pool?.unplaced(thread.provider, thread.account);
    this.options.pool?.placed(provider, account);
    this.store.updateThread(thread.id, { provider, account, accounts: null, accounts_source: null });
  }

  /** Writes a message's images to disk and records them (inside the command's transaction). */
  private keepImages(threadId: string, messageId: string, runId: string | null, images: DecodedImage[]): void {
    const files = this.options.attachments;
    if (!files) return;
    for (const image of images) {
      const { id, path } = files.write(threadId, image);
      this.written.push(path);
      this.store.addAttachment({ id, threadId, messageId, runId, name: image.name, mimeType: image.mimeType, sizeBytes: image.bytes.length, path });
    }
  }

  /** A run's images, read back for its harness. A file that went missing is skipped, not fatal. */
  private turnImages(runId: string): TurnImage[] {
    return this.imagesOf(this.store.runAttachments(runId));
  }

  private imagesOf(rows: { mime_type: string; path: string }[]): TurnImage[] {
    const files = this.options.attachments;
    if (!files) return [];
    const images: TurnImage[] = [];
    for (const row of rows) {
      try {
        images.push({ mimeType: row.mime_type, data: files.read(row.path).toString("base64") });
      } catch {
        // Gone from disk: the turn goes on with the words.
      }
    }
    return images;
  }

  /** An image's bytes for a client, or undefined. */
  attachmentFile(id: string): { mimeType: string; name: string; bytes: Buffer } | undefined {
    const row = this.store.attachment(id);
    const files = this.options.attachments;
    if (!row || !files) return undefined;
    try {
      return { mimeType: row.mime_type, name: row.name, bytes: files.read(row.path) };
    } catch {
      return undefined;
    }
  }

  /**
   * Before a session opens, make sure the thread's account can take work, and
   * rebalance only cold caches, or move off unusable accounts. False means no account
   * can: the thread waits and tries again when the soonest one resets.
   */
  private chooseAccount(thread: ThreadRow): boolean {
    const pool = this.options.pool;
    if (!pool) return true;
    const only = this.allowedAccounts(thread);
    const usable = thread.account && (!only || only.includes(thread.account)) && pool.usable(thread.provider, thread.account);
    if (usable) {
      if (pool.balance.greedy || this.sessions.has(thread.id)) return true;
      const ended = this.store.runs(thread.id).reduce((last, run) => Math.max(last, run.ended_at ?? 0), 0);
      if (!ended || this.store.now() - ended <= pool.balance.cacheColdMs) return true;
      const best = pool.best(thread.provider, { only });
      const current = pool.score(thread.provider, thread.account!);
      if (!best || best.name === thread.account || (!current.guarded && pool.score(thread.provider, best.name).score < pool.balance.rebalanceRatio * current.score)) return true;
    }
    const pick = pool.pick(thread.provider, { only });
    if (!pick) {
      this.waitForCapacity(thread.id, pool.nextAvailableAt(thread.provider, only));
      return false;
    }
    if (pick.name !== thread.account && thread.native_session_id) this.movedAccounts.add(thread.id);
    if (pick.name !== thread.account) this.store.tx(() => {
      const last = this.store.runs(thread.id).flatMap((r) => this.store.attempts(r.id)).at(-1);
      const kind = last?.failure ? (JSON.parse(last.failure) as RuntimeFailure).kind : null;
      if (thread.account) this.store.recordAccount(thread.id, pick.name, usable ? "balance" : kind === "usage_limit" ? "limit" : kind === "auth" ? "auth" : "low");
      this.store.updateThread(thread.id, { account: pick.name });
    });
    return true;
  }

  private waitForCapacity(threadId: string, until: number | null): void {
    // Visible on the thread (snapshot and detail) so a hold is never silent: the 10/19 hold sat days from its reset.
    const thread = this.store.thread(threadId);
    if (thread && (thread.admission !== "account_limit" || thread.admission_until !== until)) {
      this.store.tx(() => this.store.updateThread(threadId, { admission: "account_limit", admission_until: until }));
      console.warn(`[loom] ${threadId} waiting for account room: no allowed account (${this.allowedAccounts(thread)?.join(", ") ?? thread.account ?? "any"}) can start work; retry at ${until ? new Date(until).toISOString() : "unknown"}`);
    }
    this.kickAt(threadId, Math.max(this.store.now() + 1_000, until ?? this.store.now() + CAPACITY_RETRY_MS));
  }

  /** Kicks the thread at `at`, unless a timer for it is already set. */
  private kickAt(threadId: string, at: number): void {
    if (this.waits.has(threadId)) return;
    const delay = Math.max(0, at - this.store.now());
    const timer = setTimeout(() => {
      this.waits.delete(threadId);
      void this.kick(threadId);
    }, Math.min(delay, 2 ** 31 - 1));
    timer.unref?.();
    this.waits.set(threadId, timer);
  }

  /** Whether the run's last attempt was turned away as overloaded: its next start is a retry. */
  private overloadRetry(runId: string): boolean {
    const failure = this.store.attempts(runId).at(-1)?.failure;
    return !!failure && (JSON.parse(failure) as RuntimeFailure).kind === "overloaded";
  }

  /**
   * The model turned a turn away (overloaded, at capacity). The run goes back in the queue on the same session and
   * account, held visibly until its next pause ends (OVERLOAD_RETRY_MS). True when the run was requeued; false once
   * its retries are spent, and the run fails and is reported as before.
   */
  private retryOverloaded(threadId: string, run: RunRow, failure: RuntimeFailure): boolean {
    if (failure.kind !== "overloaded") return false;
    const pauses = this.options.overloadRetryMs ?? OVERLOAD_RETRY_MS;
    const tries = this.store.attempts(run.id).filter((a) => a.failure && (JSON.parse(a.failure) as RuntimeFailure).kind === "overloaded").length;
    if (tries >= pauses.length) return false;
    const until = this.store.now() + pauses[tries]!;
    this.store.tx(() => {
      this.store.endAttempts(run.id, "failed", JSON.stringify(failure));
      this.ledger.end(threadId, run.id, "cancelled");
      this.store.updateRun(run.id, { status: "queued", failure: JSON.stringify(failure), started_at: null, ended_at: null });
      for (const req of this.store.openRequests(threadId)) { this.store.resolveRequest(req.id, "expired", undefined); this.settleRequestPointers(req.id); }
      this.store.updateThread(threadId, { status: "idle", admission: "provider_busy", admission_until: until });
    });
    console.warn(`[loom] ${threadId} model at capacity (${failure.message}); retry ${tries + 1} of ${pauses.length} at ${new Date(until).toISOString()}`);
    this.kickAt(threadId, until);
    return true;
  }

  /**
   * A turn hit its account's limit, or the account can't make calls at all (signed out, or new terms
   * to accept). With a pool, the account cools down until its reset (an hour for an auth failure), the
   * run goes back in the queue, and the next dispatch moves the thread to the account with the most
   * room. True when the run was requeued.
   */
  private moveOffLimit(threadId: string, run: RunRow, failure: RuntimeFailure): boolean {
    const pool = this.options.pool;
    const thread = this.store.thread(threadId);
    if (!pool || !thread?.account || (failure.kind !== "usage_limit" && failure.kind !== "auth")) return false;
    pool.coolDown(thread.provider, thread.account, failure.resetAt);
    if (this.store.attempts(run.id).length >= MAX_LIMIT_MOVES) return false;
    this.store.tx(() => {
      this.store.endAttempts(run.id, "failed", JSON.stringify(failure));
      this.ledger.end(threadId, run.id, "cancelled");
      this.store.updateRun(run.id, { status: "queued", failure: JSON.stringify(failure), started_at: null, ended_at: null });
      for (const req of this.store.openRequests(threadId)) { this.store.resolveRequest(req.id, "expired", undefined); this.settleRequestPointers(req.id); }
      this.store.updateThread(threadId, { status: "idle" });
    });
    // The native session continues on the next account, so this one must stop driving it first.
    void this.closeSession(threadId).then(() => this.kick(threadId));
    return true;
  }

  private ensureSession(thread: ThreadRow, attachOnly = false, reason?: "warm" | "move"): Promise<RuntimeSession | null> {
    const cooling = this.cooling.get(thread.id);
    if (cooling) return cooling.then(() => {
      const current = this.store.thread(thread.id);
      return current ? this.ensureSession(current, attachOnly, reason) : null;
    });
    const live = this.sessions.get(thread.id);
    if (live) return Promise.resolve(live);
    const pending = this.opening.get(thread.id);
    if (pending) return pending;
    const runtime = this.runtimes[thread.provider];
    if (!runtime) return Promise.reject(new Error(`No runtime for provider ${thread.provider}`));
    const generation = (this.generations.get(thread.id) ?? 0) + 1;
    this.generations.set(thread.id, generation);
    const open = attachOnly ? runtime.attach?.bind(runtime) : runtime.open.bind(runtime);
    if (!open) return Promise.resolve(null);
    let connected: RuntimeSession | null = null;
    const started = performance.now();
    const connect = async () => {
      if (!attachOnly && this.maintenanceHolds(thread.id) && !this.store.activeRun(thread.id)) return null;
      // A move swaps one host for another: it never counts against the limit (a refused replacement would
      // leave the thread with no host at all, as the 10/17 deploy did to 12 threads).
      if (!attachOnly && reason !== "move" && !this.takeReplacement(thread.id) && !await this.admit(thread.id)) return null;
      if (!attachOnly && this.maintenanceHolds(thread.id) && !this.store.activeRun(thread.id)) return null;
      return open(
        { threadId: thread.id, cwd: thread.cwd, account: thread.account, nativeSessionId: thread.native_session_id, role: thread.role, kind: thread.kind, worktreeMode: thread.worktree_mode, session: thread.session_profile ? JSON.parse(thread.session_profile) : undefined },
        (event, seq) => {
          if (this.generations.get(thread.id) !== generation) return;
          this.applyRuntimeEvent(thread.id, event, seq);
          if (seq !== undefined) connected?.acknowledge?.(seq);
        },
      );
    };
    const opening = (attachOnly ? connect() : this.withWarmth(connect, () => this.assistantTurn(thread.id)))
      .then(async (session) => {
        if (!session) return null;
        if (thread.kind === "probe" && !this.fanOuts.canDispatch(thread.id)) {
          await session.close().catch(() => {});
          return null;
        }
        // Maintenance began while this host was opening: nothing may start, so don't leave an idle host behind.
        if (!attachOnly && this.maintenanceHolds(thread.id) && !this.store.activeRun(thread.id)) {
          await session.close().catch(() => {});
          return null;
        }
        if (!attachOnly) this.store.db.prepare("INSERT INTO host_opens (threadId, reason, ms, at) VALUES (?, ?, ?, ?)")
          .run(thread.id, reason ?? (this.movedAccounts.has(thread.id) || this.store.hostMove(thread.id) ? "move" : thread.native_session_id ? "resume" : "new"), performance.now() - started, this.store.now());
        if (!attachOnly) this.movedAccounts.delete(thread.id);
        connected = session;
        this.sessions.set(thread.id, session);
        this.sessionHashes.set(thread.id, session.hello?.sessionProfileHash ?? (attachOnly ? profileHash() : sessionHash(thread.session_profile ? JSON.parse(thread.session_profile) : undefined, thread.role)));
        if (!attachOnly) this.store.tx(() => this.store.updateThread(thread.id, { cooled_at: null, admission: null, admission_until: null }));
        if (session.hello) {
          const current = this.store.thread(thread.id)!;
          if (current.host_release !== session.hello!.release || current.host_instance_id !== session.hello!.instanceId) this.ledger.event(thread.id, "release", `Host release ${session.hello!.release}`, session.hello!.instanceId);
          this.store.tx(() => this.store.updateThread(thread.id, {
            host_release: session.hello!.release,
            ...(session.hello!.background ? { background: session.hello!.background.length ? JSON.stringify(session.hello!.background) : null } : {}),
            host_instance_id: session.hello!.instanceId,
            host_seq: current.host_instance_id === session.hello!.instanceId ? current.host_seq : 0,
          }));
        }
        await session.activate?.(this.store.thread(thread.id)!.host_seq);
        if (!attachOnly && this.maintenanceHolds(thread.id) && !this.store.activeRun(thread.id)) {
          await this.closeSession(thread.id);
          return null;
        }
        if (session.hello?.ended && this.sessions.get(thread.id) === session) this.sessions.delete(thread.id);
        return session;
      })
      .catch((error) => {
        if (this.sessions.get(thread.id) === connected) this.sessions.delete(thread.id);
        connected?.detach?.();
        throw error;
      })
      .finally(() => this.opening.delete(thread.id));
    this.opening.set(thread.id, opening);
    return opening;
  }

  private async closeSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    this.generations.set(threadId, (this.generations.get(threadId) ?? 0) + 1);
    if (session) await session.close().catch(() => {});
    this.clearBackground(threadId);
    // On stop/delete, owner state authorizes cleanup; release moves keep thread leases alive.
    await this.leases.reconcile();
  }

  /** No session, no background work: closing the harness stops its tasks. */
  private clearBackground(threadId: string): void {
    if (!this.recovering) for (const row of this.ledger.rows(threadId)) if (row.kind !== "turn" && row.ended_at === null) this.ledger.end(threadId, row.ref, "cancelled");
    if (this.store.thread(threadId)?.background) this.store.tx(() => this.store.updateThread(threadId, { background: null }));
  }

  /** Detach coordinator resources while leaving remote hosts running. */
  async detachAll(): Promise<void> {
    this.detaching = true;
    this.triggers.close();
    this.fanOuts.close();
    this.vetoClock.close();
    this.askClock.close();
    clearInterval(this.rulesTimer);
    clearInterval(this.warmthTimer);
    clearInterval(this.upgradeTimer);
    clearInterval(this.worktreeTimer);
    clearInterval(this.leaseTimer);
    for (const timer of this.waits.values()) clearTimeout(timer);
    for (const timer of this.budgetTimers.values()) clearTimeout(timer);
    for (const timer of this.graceKicks.values()) clearTimeout(timer);
    this.waits.clear();
    await Promise.allSettled([...this.opening.values()]);
    await Promise.all([...this.mailboxes.values()]);
    for (const [id, session] of this.sessions) {
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      session.detach?.();
    }
    this.sessions.clear();
    await this.ledger.drain();
    await this.diskPass?.catch(() => {});
    await this.leases.drain();
  }

  /** Explicitly close every live session. */
  async closeAll(): Promise<void> {
    this.diskClosing = true;
    this.triggers.close();
    this.fanOuts.close();
    this.vetoClock.close();
    this.askClock.close();
    clearInterval(this.rulesTimer);
    clearInterval(this.warmthTimer);
    clearInterval(this.upgradeTimer);
    clearInterval(this.worktreeTimer);
    clearInterval(this.leaseTimer);
    for (const timer of this.waits.values()) clearTimeout(timer);
    for (const timer of this.budgetTimers.values()) clearTimeout(timer);
    for (const timer of this.graceKicks.values()) clearTimeout(timer);
    this.waits.clear();
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
    await this.ledger.drain();
    await this.diskPass?.catch(() => {});
    await this.leases.drain();
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  // Runtime events

  private applyRuntimeEvent(threadId: string, event: RuntimeEvent, seq?: number): void {
    const thread = this.store.thread(threadId);
    if (!thread) return;
    if (seq === undefined || event.type === "message.delta") return this.onRuntimeEvent(threadId, event);
    // A wake's run id goes to the host only once the run is committed, so the host never adopts an id
    // that a rolled-back transaction took away.
    const binds: (() => void)[] = [];
    this.postCommit = binds;
    try {
      this.store.tx(() => {
        if (seq <= thread.host_seq) {
          if (event.type === "wake.started" && event.wakeId && thread.host_instance_id) {
            const runId = this.store.hostWake(threadId, thread.host_instance_id, event.wakeId);
            if (runId) binds.push(() => event.bind(runId));
          }
          return;
        }
        this.onRuntimeEvent(threadId, event);
        this.store.updateThread(threadId, { host_seq: seq });
      });
    } finally {
      this.postCommit = null;
    }
    for (const bind of binds) bind();
  }

  /** Set while a host event's transaction is open: work for the host waits until it commits. */
  private postCommit: (() => void)[] | null = null;

  private onRuntimeEvent(threadId: string, event: RuntimeEvent): void {
    const store = this.store;
    switch (event.type) {
      case "host.heartbeat": {
        if (store.activeRun(threadId)?.id !== event.runId) break;
        this.heartbeats.set(threadId, { runId: event.runId, at: event.at });
        store.tx(() => store.touchThread(threadId));
        break;
      }
      case "session.native":
        store.tx(() => {
          store.updateThread(threadId, { native_session_id: event.nativeSessionId });
          const run = store.activeRun(threadId);
          if (run) store.setAttemptNativeSession(run.id, event.nativeSessionId);
        });
        this.freshStarted(threadId, event.nativeSessionId);
        return;
      case "message.delta":
        if (store.thread(threadId)?.kind === "probe") this.fanOuts.capture(threadId, event.text);
        this.publish({ threadId, type: "delta", runId: event.runId, text: event.text });
        return;
      case "message.completed":
        store.tx(() => store.addMessage(threadId, event.runId, "assistant", event.text, null, undefined, event.phase, event.messageId));
        return;
      case "message.phase":
        store.tx(() => store.setMessagePhase(threadId, event.runId, event.messageIds, event.phase));
        return;
      case "worktree.promote": {
        const thread = store.thread(threadId)!;
        if (process.env.LOOM_AUTO_PROMOTE === "off" || thread.worktree_mode !== "auto" || thread.kind !== "coding" || !this.loomTools(thread) || store.activeRun(threadId)?.id !== event.runId || (thread.fresh && JSON.parse(thread.fresh).reason === "worktree")) return;
        const fresh: FreshReason = { reason: "worktree", context: this.usage.summary(threadId)?.tokens ?? 0, at: store.now(), previousSession: thread.native_session_id, worktree: { stage: "handoff", previousCwd: thread.cwd } };
        store.updateThread(threadId, { fresh: JSON.stringify(fresh) });
        const handoff = store.createRun(threadId, "reset", HANDOFF_PROMPT.replace("this session's context is large", "this thread is moving into its own worktree"));
        // Saving comes before queued mail or owner turns, without discarding either.
        store.db.prepare("UPDATE runs SET position = (SELECT MIN(position) - 1 FROM runs WHERE thread_id = ?) WHERE id = ?").run(threadId, handoff.id);
        this.ledger.event(threadId, "worktree-promotion", "Moving this thread into its own worktree", "The triggering edit was denied; saving the old session first.");
        // Finish the current turn at the denied edit, then let the queued save run in the old session.
        const stop = () => { void this.sessions.get(threadId)?.interrupt().catch(error => console.warn("Promotion interrupt failed", error)); };
        if (this.postCommit) this.postCommit.push(stop); else queueMicrotask(stop);
        return;
      }
      case "tool.denied":
        store.db.prepare("INSERT OR IGNORE INTO tool_denials (thread_id,run_id,item_id,tool,source,at) VALUES (?,?,?,?,?,?)").run(threadId, event.runId, event.itemId, event.name, event.source ?? null, store.now());
        return;
      case "tool.updated":
        this.ledger.tool(store.thread(threadId)!, event);
        store.tx(() =>
          store.upsertItem({
            id: event.itemId,
            threadId,
            runId: event.runId,
            kind: "tool",
            name: event.name,
            input: event.input ?? null,
            output: event.output ?? null,
            status: event.status,
          }),
        );
        return;
      case "request.opened":
        store.tx(() => {
          store.openRequest(threadId, event.runId, event.kind, event.payload, event.requestId);
          store.updateThread(threadId, { status: "waiting" });
        });
        return;
      case "turn.completed": {
        const run = store.run(event.runId);
        if (run) store.tx(() => this.finishRun(run, "completed", null));
        void this.kick(threadId);
        return;
      }
      case "peer.message": {
        // Read from the transcript, possibly more than once: filed once per native message id.
        if (store.hasOriginMail(threadId, event.messageId)) return;
        // One read from history (a resumed session rescans its transcript) belongs to no run of now.
        const run = event.at && event.at < store.now() - 60_000 ? undefined : store.activeRun(threadId);
        // Named as the owner knows them: a Loom session's thread title, not its session name or socket.
        const name = this.peerName(event.name, event.address);
        const origin: MessageOrigin =
          event.direction === "in"
            ? { kind: "peer", mailId: event.messageId, inline: event.inline, ...(name ? { name } : {}), ...(event.address ? { from: event.address } : {}) }
            : { kind: "peer-out", mailId: event.messageId, inline: true, ...(name ? { name } : {}), ...(event.address ? { to: event.address } : {}) };
        store.tx(() => {
          store.addMessage(threadId, run?.id ?? null, "user", event.text, origin, event.at);
          reconcileAgentAsks(store);
        });
        return;
      }
      case "background.changed": {
        store.tx(() => this.ledger.background(store.thread(threadId)!, event.tasks));
        const background = event.tasks.length ? JSON.stringify(event.tasks) : null;
        // The harness tells the thread a task finished in a wake turn that starts a moment later.
        // Any task finishing (work or a watcher) wakes the agent a moment later: that moment isn't a safe point.
        const was = store.thread(threadId)?.background ?? null;
        if (taskEnded(was ? JSON.parse(was) : null, event.tasks)) this.backgroundEndedAt.set(threadId, Date.now());
        if ((store.thread(threadId)?.background ?? null) !== background) store.tx(() => store.updateThread(threadId, { background }));
        void this.kick(threadId);
        return;
      }
      case "context.observed": {
        const runId = typeof event.runId === "string" && store.run(event.runId) ? event.runId : null;
        this.usage.record(threadId, runId, event);
        return;
      }
      case "context.compacted": {
        const k = (n: number) => `${Math.round(n / 1000)}k`;
        this.ledger.event(threadId, "compacted", `Compacted (${event.trigger}): context ${k(event.preTokens)}${event.postTokens !== undefined ? ` → ${k(event.postTokens)}` : ""}`, "");
        return;
      }
      case "usage.observed": {
        const thread = store.thread(threadId);
        if (thread?.account) this.options.pool?.observe(thread.provider, thread.account, event);
        return;
      }
      case "turn.failed": {
        const run = store.run(event.runId);
        const probe = store.thread(threadId)?.kind === "probe";
        if (run && run.status === "running" && ((!probe || event.failure.kind === "usage_limit") && this.moveOffLimit(threadId, run, event.failure) || !probe && this.retryOverloaded(threadId, run, event.failure))) return;
        const status = event.failure.kind === "interrupted" ? "interrupted" : "failed";
        if (run) store.tx(() => this.finishRun(run, status, event.failure));
        if (!HOLD_QUEUE_ON.has(event.failure.kind) || store.pendingAccountMove(threadId)) void this.kick(threadId);
        return;
      }
      case "wake.started": {
        const run = store.tx(() => {
          const thread = store.thread(threadId)!;
          const r = store.createRun(threadId, "wake", event.text);
          store.updateRun(r.id, { status: "running", started_at: store.now() });
          store.createAttempt(r, thread.account, thread.native_session_id);
          this.ledger.start(thread, "turn", r.id, "Running turn");
          store.updateThread(threadId, { status: "running" });
          if (event.wakeId && thread.host_instance_id) store.bindHostWake(threadId, thread.host_instance_id, event.wakeId, r.id);
          // A wake another session's message started is that message's turn, as a mail-started user turn is (Codex review
          // on #931). The message is filed just before, with no run: read from the store, so a restart between the two keeps it.
          // Bounded by the last turn that actually started, not runs still queued behind it.
          if (event.text === PEER_WAKE_TEXT) {
            const since = (store.db.prepare("SELECT MAX(started_at) AS at FROM runs WHERE thread_id = ? AND id != ? AND started_at IS NOT NULL").get(threadId, r.id) as { at: number | null }).at ?? 0;
            store.db.prepare(`UPDATE messages SET run_id = ? WHERE thread_id = ? AND run_id IS NULL AND role = 'user' AND created_at >= ?
              AND json_extract(origin, '$.kind') = 'peer' AND json_extract(origin, '$.inline') = 0`).run(r.id, threadId, since);
          }
          return r;
        });
        if (this.postCommit) this.postCommit.push(() => event.bind(run.id));
        else event.bind(run.id);
        return;
      }
      case "session.ended": {
        this.sessions.delete(threadId);
        // An unexpected end: its background work is lost, not cancelled, and the thread is told what.
        const lost = this.recovering ? [] : this.ledger.rows(threadId).filter((row) => row.kind !== "turn" && row.ended_at === null);
        for (const row of lost) this.ledger.end(threadId, row.ref, "lost");
        this.clearBackground(threadId);
        if (lost.length && !store.activeRun(threadId) && store.thread(threadId)?.status !== "stopped" && store.thread(threadId)?.native_session_id) {
          store.tx(() => store.createRun(threadId, "continue",
            `Loom: your session ended unexpectedly and its background work stopped:\n${lost.map((r) => `Lost ${r.kind}: ${r.description} (${r.ref}).`).join("\n")}\nRe-start what you still need.`));
        }
        const failure = event.failure ?? { kind: "crashed" as const, message: "The harness process ended" };
        const run = store.activeRun(threadId);
        if (run && (this.moveOffLimit(threadId, run, failure) || this.retryOverloaded(threadId, run, failure))) return;
        if (run) store.tx(() => this.finishRun(run, "failed", failure));
        store.tx(() => {
          for (const req of store.openRequests(threadId)) { store.resolveRequest(req.id, "expired", undefined); this.settleRequestPointers(req.id); }
        });
        if (!event.failure || !HOLD_QUEUE_ON.has(event.failure.kind) || store.pendingAccountMove(threadId)) void this.kick(threadId);
        return;
      }
    }
  }

  /** End a run even when it never started, returning any brief its owner reply put in discussion. */
  private endRunState(runId: string, status: "completed" | "interrupted" | "failed" | "canceled", failure?: string | null): void {
    for (const row of this.store.db.prepare("SELECT * FROM decisions WHERE status='open' AND discussing_run=? AND kept_at IS NULL").all(runId) as unknown as DecisionRow[]) this.returnDiscussion(row, true);
    this.store.updateRun(runId, { status, ...(failure === undefined ? {} : { failure }), ended_at: this.store.now() });
  }

  private finishRun(run: RunRow, status: "completed" | "interrupted" | "failed", failure: RuntimeFailure | null): void {
    const store = this.store;
    if (run.status !== "running") return;
    const failureJson = failure ? JSON.stringify(failure) : null;
    this.endRunState(run.id, status, failureJson);
    queueMicrotask(() => { if (!this.detaching) void this.leases.reconcile().catch(error => console.warn("Run resource cleanup failed", error)); });
    this.catchup.closeRun(run.id, store.now());
    store.endAttempts(run.id, status, failureJson);
    this.ledger.end(run.thread_id, run.id, status === "completed" ? "done" : "cancelled");
    const owned = store.thread(run.thread_id);
    if (status === "completed" && owned && this.worktrees?.owns(owned)) void this.ledger.checkpoint(owned);
    for (const req of store.openRequests(run.thread_id)) { store.resolveRequest(req.id, "expired", undefined); this.settleRequestPointers(req.id); }
    const thread = store.thread(run.thread_id);
    if (thread && thread.status !== "stopped") store.updateThread(run.thread_id, { status: "idle" });
    if (thread?.kind === "probe") return;
    if (status === "completed" && thread) { this.checkMissingAnswer(thread, run); this.recordAsk(thread, run); reconcileAgentAsks(store); }
    if (status === "failed" && thread && failure) this.reportFailure(thread, run, failure);
    if (thread) this.planFresh(thread, run, status);
  }

  /** A narrow, one-shot backstop for an owner question answered only with a Next line. */
  private checkMissingAnswer(thread: ThreadRow, run: RunRow): void {
    if (thread.status === "stopped" || !this.loomTools(thread) || run.source !== "user") return;
    const messages = this.store.messages(thread.id).filter(message => message.run_id === run.id);
    const question = messages.filter(message => message.role === "user" && !message.origin && /[?？]/u.test(message.text)).at(-1);
    if (!question) return;
    // Count all visible messages after the question, including an answer sent before a separate closing line.
    const visible = messages.slice(messages.indexOf(question) + 1).filter(message => message.role === "assistant").map(message => message.text).join("\n").trim();
    if (visible && !/^(?:\*\*)?Next\s*[—–-][^\r\n]*$/iu.test(visible)) return;
    // The completion transaction and running-status gate make this idempotent on event replay.
    // A corrective wake has source wake, so it cannot queue another missing-answer wake.
    this.store.createRun(thread.id, "wake", `${MISSING_ANSWER_WAKE_PREFIX} (run ${run.id}) The owner asked: ${JSON.stringify(question.text)}\nWrite the answer now in visible reply text. An unchanged open ask only suppresses repeated nudges; it does not suppress this answer. Do not claim an earlier answer was lost in delivery. Record who acts next with loom.handoff as usual.`);
  }

  private reportFailure(thread: ThreadRow, run: RunRow, failure: RuntimeFailure): void {
    if (thread.role !== "worker" && thread.role !== "ops" && thread.kind !== "tango-job") return;
    const lead = this.ownerFacingLead(thread);
    if (!lead || lead.status === "stopped" || lead.settled_at !== null) return;
    const text = `Loom: ${thread.title ?? thread.id} failed (${failure.kind}): ${failure.message}. Worker run: ${run.id}. Address: loom:${thread.id}. Take responsibility for resolving this failure and report the outcome.`;
    const report = this.store.createRun(lead.id, "wake", text);
    this.store.addMessage(lead.id, report.id, "user", text, { kind: "peer", from: `loom:${thread.id}`, to: `loom:${lead.id}`, mailId: `failure:${run.id}`, name: thread.title ?? thread.id });
    this.store.updateThread(lead.id, { settled_at: null });
    const wake = () => { void this.kick(lead.id); };
    if (this.postCommit) this.postCommit.push(wake);
    else queueMicrotask(wake);
  }

  /** Whether a thread may be reset at all: a coding thread (Loom tools on) with nothing running in its session. */
  private resettable(thread: ThreadRow): boolean {
    return !!thread.native_session_id && this.automatic(thread) && this.quiet(thread);
  }

  /** A task ended (a handoff at its end, a worker settled): the next turn starts fresh. Shadow mode only says so. */
  private taskDone(thread: ThreadRow): void {
    const mode = this.freshMode(thread);
    if (mode === "off" || thread.fresh || !thread.native_session_id || !this.automatic(thread)) return;
    const context = this.usage.summary(thread.id)?.tokens ?? 0;
    if (mode === "shadow") return this.shadow(thread.id, context, "task-done");
    this.store.updateThread(thread.id, { fresh: JSON.stringify({ reason: "task-done", context, at: this.store.now(), previousSession: thread.native_session_id } satisfies FreshReason) });
  }

  /** The fresh-session mode for this thread (fresh.ts freshModeFor): LOOM_FRESH_SESSIONS=workers is on only for workers. */
  private freshMode(thread: ThreadRow): "off" | "shadow" | "on" {
    return freshModeFor(this.freshPolicy.mode, thread.role);
  }

  /** Whether Loom may reset a thread on its own: a coding thread whose owner hasn't kept the session. */
  private automatic(thread: ThreadRow): boolean {
    return this.optedIn(thread) && !thread.fresh_opt_out;
  }

  /** A coding thread: an isolated profile (Loom tools off) keeps its own lifecycle. */
  private loomTools(thread: ThreadRow): boolean {
    return !(thread.session_profile && (JSON.parse(thread.session_profile) as SessionProfile).loomTools === false);
  }

  private optedIn(thread: ThreadRow): boolean {
    return thread.status !== "stopped" && !(thread.session_profile && (JSON.parse(thread.session_profile) as SessionProfile).loomTools === false);
  }

  /** Nothing in the session that closing it would cut off: no background task, no open question. */
  private quiet(thread: ThreadRow): boolean {
    const tasks = thread.background ? (JSON.parse(thread.background) as BackgroundTask[]) : [];
    // A task that just ended still owes its completion wake: closing the session now would lose it.
    return tasks.length === 0 && this.store.openRequests(thread.id).length === 0 && !this.backgroundJustEnded(thread.id);
  }

  /**
   * After a run (fresh.ts): past the soft threshold, the session gets one handoff turn, then the thread starts fresh.
   * The handoff turn ending (whatever its outcome) is what marks the thread fresh. Shadow mode only logs it.
   */
  private planFresh(thread: ThreadRow, run: RunRow, status: "completed" | "interrupted" | "failed"): void {
    // The packet's ask for a handoff lasts its own run: a later save in that session is a task's end again (#876).
    this.handoffAsked.delete(thread.id);
    const pending = thread.fresh ? JSON.parse(thread.fresh) as FreshReason : null;
    if (pending?.reason === "worktree") {
      if (run.source === "reset" && pending.worktree?.stage === "handoff") {
        pending.worktree.stage = "ready";
        pending.previousSession = thread.native_session_id;
        this.store.updateThread(thread.id, { fresh: JSON.stringify(pending) });
        this.store.createRun(thread.id, "continue", "Continue the interrupted task in your own worktree. The triggering edit was denied; retry it here after reading the handoff.");
      }
      return;
    }
    const mode = this.freshMode(thread);
    if (mode === "off") return;
    if (run.source === "reset") {
      // A handoff turn that compacted the session (Claude's own auto-compact) leaves nothing a fresh session would save.
      const context = this.usage.summary(thread.id)?.tokens ?? 0;
      if (mode === "on" && !thread.fresh && this.automatic(thread) && context > this.softFor(thread)) this.store.updateThread(thread.id, { fresh: JSON.stringify({ reason: "soft-threshold", context, at: this.store.now(), previousSession: thread.native_session_id } satisfies FreshReason) });
      return;
    }
    if (this.budgetSeam(thread)) return;
    if (status !== "completed" || thread.fresh || !this.resettable(thread)) return;
    const context = this.usage.summary(thread.id)?.tokens ?? 0;
    if (context <= this.softFor(thread)) return;
    // Queued runs go first (each would carry the same large context once more); the last one's end decides.
    if (this.store.queuedRuns(thread.id).length) return;
    if (mode === "shadow") return this.shadow(thread.id, context, "soft-threshold");
    this.store.createRun(thread.id, "reset", HANDOFF_PROMPT);
  }

  /**
   * Past 80% of today's budget, the thread starts fresh at its next seam (the next turn), once a budget day: the
   * crossing does it, not the level, so later turns that day resume as usual. True when it marked (or, in shadow
   * mode, logged) the reset.
   */
  private budgetSeam(thread: ThreadRow): boolean {
    const budget = this.budgetOf(thread);
    const day = dayStart(this.store.now());
    if (!budget.limit || budget.share < BUDGET_FRESH_AT || thread.budget_fresh_day === day) return false;
    if (thread.fresh || !this.resettable(thread)) return false;
    this.store.updateThread(thread.id, { budget_fresh_day: day });
    const context = this.usage.summary(thread.id)?.tokens ?? 0;
    if (this.freshMode(thread) === "shadow") { this.shadow(thread.id, context, "budget"); return true; }
    this.store.updateThread(thread.id, { fresh: JSON.stringify({ reason: "budget", context, at: this.store.now(), previousSession: thread.native_session_id } satisfies FreshReason) });
    return true;
  }

  /**
   * The soft threshold for this thread: halved while its account has under a quarter of its weekly quota left, so
   * context shrinks before the start floor stops everything (the pool-level guard).
   */
  private softFor(thread: ThreadRow): number {
    const soft = this.freshPolicy.soft;
    const pool = this.options.pool;
    if (!pool || !thread.account) return soft;
    const windows = pool.capacityWindows(thread.provider, thread.account);
    return windows.fresh && windows.weekly && windows.weekly.left < 25 ? Math.round(soft / 2) : soft;
  }

  /** The session whose fresh packet asked the lead for a handoff (freshPacket): its first save isn't a task's end. In
   *  memory: a restart before that save only costs one extra fresh session. */
  private readonly handoffAsked = new Map<string, string>();

  /** One would-be reset per session and reason: on mode would act on the first, so later turns aren't more resets. */
  private shadow(threadId: string, context: number, reason: FreshReason["reason"]): void {
    const key = `${this.store.thread(threadId)?.native_session_id ?? ""}:${reason}`;
    if (this.shadowed.get(threadId) === key) return;
    this.shadowed.set(threadId, key);
    this.ledger.event(threadId, "fresh-shadow", `Would start a fresh session (${reason}, context ${Math.round(context / 1000)}k)`, "");
  }

  /**
   * Before a run opens its session (fresh.ts): a cold cache past the idle minimum starts fresh too, and a thread
   * marked fresh drops its native session. Returns the packet the new session's first turn starts with.
   */
  private async applyFresh(threadId: string, run: RunRow, continuing: boolean): Promise<string | null> {
    const policy = this.freshPolicy;
    let thread = this.store.thread(threadId);
    if (!thread) return null;
    const mode = this.freshMode(thread);
    // Switched off: a mark left from before is obsolete, never carried out later from stale state.
    if (mode === "off" && !(thread.fresh && JSON.parse(thread.fresh).reason === "worktree")) {
      if (thread.fresh) this.store.tx(() => this.store.updateThread(threadId, { fresh: null }));
      return null;
    }
    // Queue admission may put the owner's turn ahead of the save. Keep that turn in the
    // guarded old session; only the completed save can advance the durable move.
    if (thread.fresh && JSON.parse(thread.fresh).worktree?.stage === "handoff") return null;
    if (run.source === "reset" || (continuing && !(thread.fresh && JSON.parse(thread.fresh).reason === "worktree"))) return null;
    let fresh = thread.fresh ? (JSON.parse(thread.fresh) as FreshReason) : null;
    // A pending mark is checked again: a profile that opted out since cancels it, and so does a kept session unless
    // the owner asked for this one; work started since defers it.
    if (fresh && (!this.optedIn(thread) || (thread.fresh_opt_out && fresh.reason !== "owner" && fresh.reason !== "worktree"))) {
      this.store.tx(() => this.store.updateThread(threadId, { fresh: null }));
      return null;
    }
    if (fresh && !this.quiet(thread)) return null;
    if (!fresh && this.resettable(thread)) {
      const last = this.usage.summary(threadId);
      if (last && last.tokens > policy.idleMin && this.store.now() - last.at > policy.idleMs) {
        if (mode === "shadow") this.shadow(threadId, last.tokens, "cold-cache");
        else fresh = { reason: "cold-cache", context: last.tokens, at: this.store.now(), previousSession: thread.native_session_id };
      }
    }
    // The owner's own Fresh start runs in shadow mode too: it is a choice, not a policy being tried.
    if (!fresh) return null;
    // An automatic mark this mode won't carry out (a worker moved to another role, or the mode turned down) is
    // dropped, so it can't block shadow observations or reset the session much later.
    if (mode !== "on" && fresh.reason !== "owner" && fresh.reason !== "worktree") {
      if (thread.fresh) this.store.tx(() => this.store.updateThread(threadId, { fresh: null }));
      return null;
    }
    // The mark stays until the turn starts (freshStarted): a dispatch that stops short (no account free) rebuilds it.
    if (this.sessions.has(threadId)) await this.closeSession(threadId);
    if (fresh.reason === "worktree" && fresh.worktree?.stage === "ready") {
      if (!this.options.createWorktree) throw new Error("This Loom cannot promote worktrees");
      const dirty = (await git(["status", "--short", "--untracked-files=normal"], { cwd: thread.cwd })).stdout.trim();
      const made = await this.options.createWorktree(thread.cwd, threadId, { fromHead: true });
      fresh.worktree = { ...fresh.worktree, stage: "moved", dirty };
      this.store.tx(() => {
        this.store.updateThread(threadId, { cwd: made.path, repo: made.repo ?? thread!.repo ?? thread!.cwd, worktree_branch: made.branch ?? `loom/${threadId.replace(/-/g, "").slice(0, 8)}`, worktree_mode: "worktree", fresh: JSON.stringify(fresh) });
        this.ledger.event(threadId, "worktree-promoted", "Continued in its own worktree", dirty ? `Uncommitted checkout changes were left behind:\n${dirty}` : "The original checkout was clean.");
      });
    }
    const mark = fresh;
    this.store.tx(() => this.store.updateThread(threadId, { native_session_id: null, fresh: JSON.stringify(mark) }));
    thread = this.store.thread(threadId)!;
    const handoff = this.handoffs.latest(threadId);
    const transcript = thread.provider !== "codex" && fresh.previousSession && this.options.claudeProjectsDir ? join(this.options.claudeProjectsDir, projectSlug(fresh.worktree?.previousCwd ?? thread.cwd), `${fresh.previousSession}.jsonl`) : null;
    const saved = handoff && handoff.native_session_id === fresh.previousSession ? handoff : null;
    // Replies the handoff doesn't cover (all of them without one, or turns a deferred reset let run after it) say
    // what the previous session did and decided since.
    const replies = this.store.messages(threadId).filter((m) => m.role === "assistant" && (!saved || m.created_at > saved.created_at)).slice(-3).map((m) => ({ text: m.text, at: m.created_at }));
    const lead = !saved && this.store.threads().some((t) => t.parent_thread_id === `loom:${threadId}` && t.status !== "stopped");
    // Bound to the session the packet opens (freshStarted), not this run: admission can put another run first.
    if (lead) this.handoffAsked.set(threadId, PACKET_PENDING);
    else this.handoffAsked.delete(threadId);
    return freshPacket({ fresh, carry: this.carry(threadId) ?? "", handoff: saved, replies, transcript, lead });
  }

  /**
   * A new native session reported in with the packet: the mark is spent, and the timeline says why. Not before: a
   * first turn the session host never took leaves the mark, so the next dispatch rebuilds the packet.
   */
  private freshStarted(threadId: string, nativeSessionId: string): void {
    const raw = this.store.thread(threadId)?.fresh;
    if (!raw) return;
    const fresh = JSON.parse(raw) as FreshReason;
    if (nativeSessionId === fresh.previousSession || (fresh.reason === "worktree" && fresh.worktree?.stage !== "moved")) return;
    if (this.handoffAsked.get(threadId) === PACKET_PENDING) this.handoffAsked.set(threadId, nativeSessionId);
    this.store.tx(() => {
      this.store.updateThread(threadId, { fresh: null });
      this.ledger.event(threadId, "fresh", describeFresh(fresh), fresh.previousSession ?? "");
    });
  }

  /**
   * Rebuilds every thread's open ask from its history, by the same rules the live path follows: the owner's own
   * words (or an answer to a prompt) close it; each completed turn's closing hand-off opens, replaces or closes it.
   * Run at startup: threads from before the record existed get their ask, and a missed update heals. Returns how
   * many threads changed.
   */
  rebuildAsks(threadId?: string): number {
    const store = this.store;
    let changed = 0;
    store.tx(() => {
      for (const thread of threadId ? [store.thread(threadId)!] : store.threads()) {
        let legacyRun: string | undefined;
        try { legacyRun = thread.ask ? (JSON.parse(thread.ask) as OpenAsk).runId : undefined; } catch { /* rebuild repairs malformed records */ }
        const runs = new Map(store.runs(thread.id).map((run) => [run.id, run]));
        const messages = store.messages(thread.id);
        // Each completed run's last assistant message is its closing word.
        const closing = new Map<string, string>();
        for (const message of messages) if (message.role === "assistant" && message.run_id && runs.get(message.run_id)?.status === "completed") closing.set(message.run_id, message.id);
        const events: Array<{ at: number; kind: "owner" | "clear" } | { at: number; kind: "close"; message: (typeof messages)[number] } | { at: number; kind: "ledger"; row: LedgerClosure }> = [];
        for (const message of messages) {
          if (message.role === "user" && !message.origin) events.push({ at: message.created_at, kind: "owner" });
          // At the turn's completion, when the live path reads it (owner words that landed between its last message
          // and its completion come first there too; Codex review on #690).
          else if (message.role === "assistant" && message.run_id && closing.get(message.run_id) === message.id) events.push({ at: runs.get(message.run_id)!.ended_at ?? message.created_at, kind: "close", message });
        }
        for (const run of runs.values()) {
          if (run.status !== "completed" || closing.has(run.id)) continue;
          const saved = store.db.prepare("SELECT record FROM turn_handoffs WHERE run_id=?").get(run.id) as { record: string } | undefined;
          if (!saved) continue;
          const record = JSON.parse(saved.record) as RecordedHandoff;
          events.push({ at: run.ended_at ?? record.at, kind: "close", message: { id: record.messageId ?? "", thread_id: thread.id, run_id: run.id, role: "assistant", text: "", created_at: record.at } });
        }
        for (const req of store.requests(thread.id)) {
          if (req.status !== "answered" || !req.resolved_at) continue;
          // An answer always comes before its own turn ends; one recovery committed late carries the restart time.
          const end = req.run_id ? runs.get(req.run_id)?.ended_at : null;
          events.push({ at: end ? Math.min(req.resolved_at, end) : req.resolved_at, kind: "owner" });
        }
        for (const clear of store.db.prepare("SELECT cleared_at FROM thread_clears WHERE thread_id=?").all(thread.id) as { cleared_at: number }[]) events.push({ at: clear.cleared_at, kind: "clear" });
        // The ledger's own closures (ask.resolve, the due clock, a resolution trigger) are in no message: replayed at
        // their time, so a later hand-off renewing the same words opens a new ask, as it did live (Codex review on #1031).
        for (const row of store.db.prepare("SELECT run_id, norm, status, resolved_by, resolved_at FROM asks WHERE thread=? AND status != 'open' AND resolved_at IS NOT NULL").all(thread.id) as LedgerClosure[]) events.push({ at: row.resolved_at, kind: "ledger", row });
        // On a tie the owner's word precedes the handoff, a ledger closure too (it was recorded before that turn
        // ended); Clear follows it (the owner cleared what they saw).
        const rank = (e: (typeof events)[number]) => e.kind === "owner" ? -2 : e.kind === "ledger" ? -1 : e.kind === "clear" ? 1 : 0;
        events.sort((a, b) => a.at - b.at || rank(a) - rank(b));
        let ask: OpenAsk | null = null;
        // A decision another thread raised, settling after an ask that named it opened (at its turn's end), cleared that
        // ask then (passOnResolved): replayed in order, before each later hand-off reads the ask (Codex review on #931).
        let opened = 0;
        let closed: { status: Exclude<AskStatus, "open">; by: string | null } = { status: "withdrawn", by: "agent" };
        const retire = (until: number) => {
          const decision = ask && thread.status !== "stopped" ? this.resolvedBetween(ask.text, opened, until) : null;
          if (decision) { ask = null; closed = { status: "resolved", by: `record:${decision}` }; }
        };
        for (const event of events) {
          retire(event.at);
          if (event.kind === "ledger") {
            // Provenance, as recordAskRow finds it: the row this replayed ask would record to.
            if (ask && ask.runId === event.row.run_id && normalizeAsk(ask.text) === event.row.norm) { ask = null; closed = { status: event.row.status, by: event.row.resolved_by }; }
          }
          else if (event.kind !== "close") {
            if (ask) closed = event.kind === "owner" ? { status: "answered", by: "person-chat" } : { status: "closed-by-done", by: "desk" };
            ask = null;
          }
          else {
            const saved = store.db.prepare("SELECT record FROM turn_handoffs WHERE run_id=?").get(event.message.run_id!) as { record: string } | undefined;
            const handoff = saved ? JSON.parse(saved.record) as RecordedHandoff : closingHandoff(event.message.text, true);
            const run = runs.get(event.message.run_id!)!;
            if (handoff && !(handoff as RecordedHandoff).noClosingLine) {
              const after = this.askAfter(thread, ask, handoff, run, saved ? (handoff as RecordedHandoff).at : event.message.created_at, saved ? (handoff as RecordedHandoff).messageId ?? event.message.id : event.message.id, legacyRun === run.id);
              if (ask && !after.ask) closed = { status: "withdrawn", by: "agent" };
              ask = after.ask;
              if (after.opened) opened = event.at;
            }
          }
        }
        // A pointer at a decision that has since closed stays closed after a restart, as the live path leaves it; an ask for another agent is never linted (recordAsk).
        if (ask && !ask.to) {
          const kind = ask.spec?.kind ?? ask.kind;
          // Legacy prose still uses the old classifier; a declared pointer names its ledger target.
          const ledger = store.db.prepare("SELECT kind, points_to FROM asks WHERE thread=? AND run_id=? AND norm=? ORDER BY rowid DESC LIMIT 1").get(thread.id, ask.runId, normalizeAsk(ask.text)) as { kind: string; points_to: string | null } | undefined;
          const target = kind === "pointer" ? ledger?.points_to : !kind || kind === "unclear" ? (classifyAsk(ask.text, null).kind === "pointer" ? ask.text : null) : null;
          if (target && this.settledPointer(target)) ask = null;
        }
        retire(Infinity);
        if (ask) ask = recordAskRow(store, thread, ask, ask.spec, false, true);
        if (ask) this.armAskResolution(thread.id, ask);
        else closeThreadAsk(store, thread.id, closed.status, closed.by);
        const next = ask ? JSON.stringify(ask) : null;
        if ((thread.ask ?? null) !== next) {
          store.updateThread(thread.id, { ask: next });
          changed++;
        }
      }
    });
    changed += reconcileAgentAsks(store);
    return changed;
  }

  /** The mail that started a run, when another agent's mail (or Loom's own word, `tell`) did; null otherwise. */
  private startingMail(run: RunRow): MessageOrigin | null {
    // A wake run counts only when another session's message started it (a peer wake, or a run made for that message,
    // as a worker's failure report is): mail arriving inline during a background wake didn't start that turn.
    if (run.source !== "user" && run.source !== "wake") return null;
    const first = this.store.messages(run.thread_id).find((message) => message.run_id === run.id && message.role === "user");
    if (run.source === "wake" && run.text !== PEER_WAKE_TEXT && first?.text !== run.text) return null;
    if (!first?.origin) return null;
    try {
      const origin = JSON.parse(first.origin) as MessageOrigin;
      return origin.kind === "peer" ? origin : null;
    } catch {
      return null;
    }
  }

  /**
   * Who acts next, as the hand-off labels it: a kind of actor and who, by id. Loom never reads it from the words, and
   * no pronoun stands in for anyone (D-244). A human is the desk's person only by their id or name (people.ts); any
   * other human is someone the thread waits on. An agent is this thread itself (loom:<its id>) or one it can address.
   */
  private nextBy(threadId: string, kind: NextKind, who: string): Pick<RecordedHandoff, "owner" | "waitingOn" | "audience" | "next"> {
    const name = who.trim(), next = { kind, who: name };
    if (!NEXT_KINDS.includes(kind)) throw new LoomCommandError("invalid", `kind is one of ${NEXT_KINDS.join(", ")}`);
    if (kind === "nobody") return { owner: "none", waitingOn: null, next };
    if (!name) throw new LoomCommandError("invalid", `kind "${kind}" needs \`who\`: ${WHO_HELP}`);
    if (kind === "human") return isDeskPerson(name) ? { owner: "you", waitingOn: null, audience: null, next } : { owner: "waiting", waitingOn: name, next };
    if (kind === "system") return { owner: "waiting", waitingOn: name, next };
    if (name === `loom:${threadId}`) return { owner: "me", waitingOn: null, next };
    const audience = this.agentAddressed(threadId, name);
    if (!audience) throw new LoomCommandError("invalid", `Loom doesn't know the agent ${JSON.stringify(name)}: ${WHO_HELP}`);
    return { owner: "you", waitingOn: null, audience, next };
  }

  /** The older hand-off form (owner you/me/waiting/none), from sessions started before `kind` and `who`. */
  private nextByOwner(command: Extract<Command, { type: "handoff.record" }>): Pick<RecordedHandoff, "owner" | "waitingOn" | "audience"> {
    if (!["you", "me", "waiting", "none", "agent"].includes(command.owner ?? "")) throw new LoomCommandError("invalid", "Invalid handoff");
    if (command.owner === "agent") {
      const audience = command.to ? this.agentAddressed(command.threadId, command.to) : null;
      if (!audience) throw new LoomCommandError("invalid", `owner "agent" needs \`to\`: ${WHO_HELP}`);
      return { owner: "you", waitingOn: null, audience };
    }
    if (command.to) throw new LoomCommandError("invalid", '`to` goes with owner "agent" only');
    const named = command.waitingOn?.trim() ?? "";
    const owner = command.owner === "waiting" && (/^(you|user|the user|owner|the owner)$/i.test(named) || isDeskPerson(named)) ? "you" : command.owner!;
    return { owner, waitingOn: command.waitingOn ?? null, ...(owner === "you" ? { audience: null } : {}) };
  }

  /**
   * The agent a hand-off names (owner "agent", `to`), when the address is one Loom knows: another Loom thread
   * (loom:<id>), or a sender this thread has had mail from. Null otherwise: an unknown address is refused, not guessed.
   */
  private agentAddressed(threadId: string, to: string): { to: string; toAddress: string } | null {
    const address = to.trim();
    const heard = this.store.db.prepare("SELECT json_extract(origin, '$.name') AS name FROM messages WHERE thread_id = ? AND origin IS NOT NULL AND json_extract(origin, '$.kind') = 'peer' AND json_extract(origin, '$.from') = ? ORDER BY rowid DESC LIMIT 1").get(threadId, address) as { name: string | null } | undefined;
    if (heard) return { to: heard.name || address, toAddress: address };
    const target = address.startsWith("loom:") ? this.store.thread(address.slice(5)) : undefined;
    return target && target.id !== threadId ? { to: target.title ?? address, toAddress: address } : null;
  }

  /**
   * Only a tool hand-off naming the desk person opens an owner ask (D-353). Prose may retire an ask,
   * but never opens or replaces one. Startup retains an existing legacy ask until its corrective wake.
   * Agent hand-offs preserve an unrelated owner's ask, except the explicit re-record wake which reassigns it.
   * Mail-started turns retain the owner's ask when handing off elsewhere (the 10/19 rule).
   */
  private askAfter(thread: ThreadRow, open: OpenAsk | null, handoff: Handoff, run: RunRow, at: number, messageId: string, retainLegacy = false): { ask: OpenAsk | null; opened: boolean } {
    if (handoff.owner === "you") {
      const record = handoff as Partial<RecordedHandoff>;
      // The desk person by the tool: kind human, an agent's audience, or the older owner "you" form (no next).
      const named = record.source === "tool" && (!!record.audience || !record.next || record.next.kind === "human");
      // A thread without Loom's tools can't call loom.handoff: its closing line is still how it asks.
      if (!named && this.loomTools(thread) && !retainLegacy) return { ask: open, opened: false };
      const audience = record.audience ?? null;
      if (!audience && open && !open.to) {
        if (sameAsk(open.text, handoff.text)) return { ask: { ...open, ...(record.ask ? { spec: record.ask } : {}) }, opened: false };
        if (run.source === "wake" && (run.wake_cause ?? wakeCause(run.text)) === "corrective" && run.text !== RERECORD_ASK_WAKE_TEXT) return { ask: open, opened: false };
      }
      // Mail may not displace an unrelated owner ask. A migration wake explicitly reassigns the legacy ask.
      if (audience && open && !open.to && run.text !== RERECORD_ASK_WAKE_TEXT) return { ask: open, opened: false };
      return { ask: { text: handoff.text, at, messageId, runId: run.id, who: record.next?.who, ...(record.ask ? { spec: record.ask } : {}), ...(audience ?? {}) }, opened: true };
    }
    if (open && !open.to && this.startingMail(run)) return { ask: open, opened: false };
    return { ask: null, opened: false };
  }

  /**
   * A "me" hand-off, or a turn missing the tool hand-off, with nothing behind it (no queued turn, armed wait, background task, open request or running
   * worker) would sit as Idle forever. Loom wakes the thread once with the reason (`wokeAt`); when that wake ends the
   * same way, the hand-off is `stuck` and no further wake goes (desk-status.md, "Finished and Stuck"). The completion
   * kicks the queued wake.
   */
  private stalled(thread: ThreadRow, run: RunRow, handoff: RecordedHandoff): void {
    if ((!handoff.missingTool && handoff.owner !== "me") || thread.status === "stopped" || !this.optedIn(thread)) return;
    const tasks = thread.background ? (JSON.parse(thread.background) as BackgroundTask[]) : [];
    const workers = this.store.threads().some((t) => t.parent_thread_id === `loom:${thread.id}` && (t.status === "running" || this.store.queuedRuns(t.id).length > 0));
    if (this.store.queuedRuns(thread.id).length || this.store.hasPendingWait(thread.id) || tasks.length || this.store.openRequests(thread.id).length || workers) return;
    if (run.source === "wake" && STALL_WAKE_TEXTS.has(run.text)) handoff.stuck = true;
    else if (!handoff.wokeAt) {
      this.store.createRun(thread.id, "wake", handoff.missingTool ? MISSING_HANDOFF_WAKE_TEXT : STALL_WAKE_TEXT);
      handoff.wokeAt = this.store.now();
    }
  }

  /**
   * A hand-off to another Loom thread arms the wait the agent would otherwise have to remember: Loom wakes this thread
   * when that one settles. Only an owned worker's pending waits keep it working between turns; a parent's own work
   * never arms a wait here. When the other thread isn't working on anything, or its own wait is on this thread (it wakes
   * when this one settles), no wait is armed: the first case wakes this thread once with the reason, as a "me"
   * hand-off with nothing behind it does. A hand-off naming its thread only in words wakes once to ask for the address.
   */
  private awaitAgent(thread: ThreadRow, run: RunRow, handoff: RecordedHandoff): void {
    if (thread.status === "stopped" || !this.optedIn(thread)) return;
    const named = handoff.owner === "waiting" ? handoff.waitingOn ?? "" : "";
    // The closing line splits at its first colon, so "waiting on the lead (loom:1a2b3c4d): …" leaves the id in the text.
    // Only a hand-off that gives the next move to another thread arms anything: "none" or "me" naming a thread
    // ("report sent to loom:…") stays as it was.
    const address = handoff.owner === "you" ? handoff.audience?.toAddress : handoff.owner === "waiting" ? `${named}:${handoff.text}`.match(/\bloom:([0-9a-f][0-9a-f-]{7,35})\b/i)?.[0] : undefined;
    let stall: string | null = null;
    if (address?.startsWith("loom:")) {
      const id = address.slice(5).toLowerCase();
      const matches = this.store.threads().filter((t) => t.id !== thread.id && t.id.startsWith(id));
      const target = matches.length === 1 ? matches[0]! : undefined;
      if (!target || target.status === "stopped" || thread.parent_thread_id === `loom:${target.id}`) return;
      // A wait already aimed there, or a chain of waits from the other thread leading back here (B waits on C, C on
      // this one), arms nothing: the new wait would close the loop and every thread in it would wait until timeout.
      const edges = this.triggers.list(undefined, "waiting").filter((t) => t.kind === "worker" || t.kind === "thread").map((t) => [t.thread_id, JSON.parse(t.spec).threadId as string] as const);
      if (edges.some(([from, to]) => from === thread.id && to === target.id)) return;
      const reached = new Set([target.id]);
      for (let frontier = [target.id]; frontier.length;) frontier = edges.filter(([from, to]) => frontier.includes(from) && !reached.has(to) && reached.add(to)).map(([, to]) => to);
      if (reached.has(thread.id)) return;
      // Reporting the result of this automatic wait is not another request to watch the same thread.
      if (run.source === "wake" && this.triggers.list(thread.id).some(t => t.kind === "worker" && t.status === "fired" && JSON.parse(t.spec).threadId === target.id && run.text.includes(`Loom: the trigger you set fired: waiting for worker ${target.id}. Your note: ${t.note}.`))) return;
      if (this.store.activeRun(target.id) || this.store.queuedRuns(target.id).length || (target.parent_thread_id === `loom:${thread.id}` && this.store.hasPendingWait(target.id))) {
        try {
          this.triggers.create(thread.id, "worker", { threadId: target.id }, `Armed by Loom from your hand-off to ${target.title ?? address}: ${handoff.text}`);
        } catch { /* a thread Loom can't wait on leaves the hand-off as it was */ }
        return;
      }
      stall = AGENT_STALL_WAKE_TEXT;
    } else if (handoff.source === "closing-line" && /\b(thread|lead|worker|coordinator|manager)\b/i.test(named)) {
      if (this.store.queuedRuns(thread.id).length || this.store.hasPendingWait(thread.id) || this.store.openRequests(thread.id).length) return;
      stall = UNADDRESSED_WAKE_TEXT;
    }
    if (!stall) return;
    if (run.source === "wake" && STALL_WAKE_TEXTS.has(run.text)) handoff.stuck = true;
    else if (!handoff.wokeAt) {
      this.store.createRun(thread.id, "wake", stall);
      handoff.wokeAt = this.store.now();
    }
  }

  /** Startup repair is idempotent and never cancels an explicitly requested wait. */
  reconcileAgentHandoffs(): { asks: number; waits: number } {
    return this.store.tx(() => {
      const asks = reconcileAgentAsks(this.store);
      let waits = 0;
      for (const wait of this.triggers.list(undefined, "waiting")) {
        if (wait.kind !== "worker" || wait.ask_id || !wait.note.startsWith("Armed by Loom from your hand-off to ")) continue;
        const waiter = this.store.thread(wait.thread_id);
        const target = this.store.thread(JSON.parse(wait.spec).threadId);
        if (!waiter || !target) continue;
        const parent = waiter.parent_thread_id === `loom:${target.id}`;
        const idlePeer = target.parent_thread_id !== `loom:${waiter.id}` && !this.store.activeRun(target.id) && !this.store.queuedRuns(target.id).length;
        if (parent || idlePeer) { this.triggers.cancel(wait.id); waits++; }
      }
      return { asks, waits };
    });
  }

  private saveTurnHandoff(threadId: string, record: RecordedHandoff): void {
    this.store.db.prepare("INSERT INTO turn_handoffs (run_id,thread_id,record) VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET record=excluded.record").run(record.runId, threadId, JSON.stringify(record));
    this.store.touchThread(threadId);
  }

  private latestTurnHandoff(threadId: string): RecordedHandoff | null {
    const row = this.store.db.prepare("SELECT record FROM turn_handoffs WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(threadId) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : null;
  }

  private armAskResolution(threadId: string, ask: OpenAsk): void {
    if (!ask.id || !ask.resolves || ask.resolves.trigger_id) return;
    const trigger = this.triggers.create(threadId, ask.resolves.kind, resolveSpec(ask.resolves), `Resolve ask ${ask.id}: ${ask.text}`, 10080);
    this.store.db.prepare("UPDATE triggers SET ask_id=? WHERE id=?").run(ask.id, trigger);
    ask.resolves.trigger_id = trigger;
    this.store.db.prepare("UPDATE asks SET resolves=? WHERE id=?").run(JSON.stringify(ask.resolves), ask.id);
  }

  private recordAsk(thread: ThreadRow, run: RunRow): void {
    const last = this.store.messages(run.thread_id).filter((message) => message.role === "assistant" && message.run_id === run.id).at(-1);
    const saved = this.store.db.prepare("SELECT record FROM turn_handoffs WHERE run_id=?").get(run.id) as { record: string } | undefined;
    // The context-saving turn (fresh.ts HANDOFF_PROMPT) asks only for loom.save_handoff: it isn't a turn missing its hand-off.
    if (run.source === "reset" && !saved) return;
    const parsed = last ? closingHandoff(last.text, true) : null;
    const handoff: RecordedHandoff = saved ? JSON.parse(saved.record) : {
      ...(parsed ?? { owner: "me", text: "No tool hand-off recorded" }),
      messageId: last?.id ?? null, runId: run.id, at: last?.created_at ?? this.store.now(), source: "closing-line",
      missingTool: true,
      ...(parsed ? {} : { noClosingLine: true }),
    };
    if (!handoff.messageId && last) handoff.messageId = last.id;
    this.awaitAgent(thread, run, handoff);
    this.stalled(thread, run, handoff);
    this.saveTurnHandoff(thread.id, handoff);
    const open = thread.ask ? (JSON.parse(thread.ask) as OpenAsk) : null;
    let { ask, opened } = !saved && !parsed ? { ask: open, opened: false } : this.askAfter(thread, open, handoff, run, handoff.at, handoff.messageId ?? "");
    const beforeRevision = open?.revision;
    if (ask) ask = recordAskRow(this.store, thread, ask, ask.spec);
    const revised = ask?.id === open?.id && ask?.revision !== beforeRevision;
    // An unchanged re-record is a repeat; a declaration or edit of the same row is a revision.
    if (saved && open && ask && !ask.to && !opened && !revised && sameAsk(open.text, handoff.text)) {
      addAskLint(this.store.db, { thread_id: thread.id, run_id: run.id, message_id: handoff.messageId, kind: "repeat", declared_kind: ask.kind, ask_id: ask.id, reason: "same ask as the open one", ask: handoff.text, norm: normalizeAsk(handoff.text), woke: 0, wake_run_id: null, created_at: this.store.now() });
    }
    // Even a replacement refused by the corrective guard may point at a settled brief.
    if (!opened && ask && saved && handoff.owner === "you" && !handoff.audience && !sameAsk(ask.text, handoff.text) && POINTER.test(handoff.text)) {
      this.lintAsk(thread, run, { text: handoff.text, at: handoff.at, messageId: handoff.messageId ?? "", runId: run.id });
    }
    if (ask && saved && handoff.ask?.kind === "unclear" && this.loomTools(thread) && !ask.to &&
      run.wake_cause !== "corrective" && wakeCause(run.text) !== "corrective" && mayWake(this.store.db, thread.id, run.id, normalizeAsk(ask.text), ask.id)) {
      const wake = this.store.createRun(thread.id, "wake", UNCLEAR_ASK_WAKE_TEXT);
      addAskLint(this.store.db, { thread_id: thread.id, run_id: run.id, message_id: ask.messageId, kind: "unclear", declared_kind: "unclear", ask_id: ask.id, reason: "missing declared kind", ask: ask.text, norm: normalizeAsk(ask.text), woke: 1, wake_run_id: wake.id, created_at: this.store.now() });
    }
    if (ask && (opened || revised) && !ask.to && this.lintAsk(thread, run, ask) === "settled") {
      if (ask.id) finishAsk(this.store, ask.id, "resolved", `record:${ask.points_to ?? ask.text.match(/\bD-\d+\b/i)?.[0].toUpperCase()}`);
      ask = null;
    }
    if (ask) this.armAskResolution(thread.id, ask);
    else closeThreadAsk(this.store, thread.id, "withdrawn", "agent");
    const next = ask ? JSON.stringify(ask) : null;
    if ((this.store.thread(thread.id)?.ask ?? null) !== next) this.store.updateThread(run.thread_id, { ask: next });
  }

  /**
   * The ask lint (ask-lint.ts, TGO-1074): reads what kind of ask a tool hand-off makes, on threads with Loom's
   * tools, and records it. A decision or a verification queues one corrective wake (the turn's completion
   * kicks it); the ask still opens as it always did. Runs before the ask is replaced, so the open one is `previous`.
   */
  /** Cancels this thread's queued ask-lint wakes (the owner spoke since): they correct an ask that is now answered. */
  private cancelLintWakes(threadId: string): void {
    const rows = this.store.db.prepare("SELECT wake_run_id AS id FROM ask_lints WHERE thread_id = ? AND wake_run_id IS NOT NULL").all(threadId) as { id: string }[];
    for (const { id } of rows) {
      const run = this.store.run(id);
      if (run?.status === "queued") this.endRunState(id, "canceled");
    }
  }

  /**
   * Whether a decision named in the ask settled after the ask opened and by `until`. The thread's own brief counts:
   * a worker's "resolve D-309" its lead marked moot stays cleared after a restart (owner, 10/21).
   */
  private resolvedBetween(text: string, opened: number, until: number): string | null {
    const ids = [...new Set([...text.matchAll(/\bD-(\d+)\b/gi)].map((m) => `D-${m[1]}`))];
    return ids.find((id) => {
      const row = this.store.decision(id);
      return !!row && row.status !== "open" && row.resolved_at != null && row.resolved_at > opened && row.resolved_at <= until;
    }) ?? null;
  }

  /**
   * When every decision a pointer names (D-n) is already closed, the corrective that says so, with each outcome; else null.
   * A replaced brief points at the one that replaced it, which is what to name instead.
   */
  private settledPointer(text: string): string | null {
    const ids = [...new Set([...text.matchAll(/\bD-(\d+)\b/gi)].map((m) => `D-${m[1]}`))];
    if (!ids.length) return null;
    const rows = ids.map((id) => this.store.decision(id));
    if (rows.some((row) => !row || row.status === "open")) return null;
    const how = rows.map((row) => {
      const r = row!;
      const outcome = (d: DecisionRow) => {
        const brief = JSON.parse(d.brief) as DecisionBrief;
        const option = d.answer_option ? brief.options.find((o) => o.key === d.answer_option) : undefined;
        const chose = d.answer_option ? ` (chose ${d.answer_option}${option ? `: ${option.label}` : ""})` : "";
        return `${chose}${d.answer_text ? `: "${d.answer_text.slice(0, 160)}"` : ""}`;
      };
      if (r.status === "superseded") {
        // Follow the chain to the brief that replaced it last: that one is open (name it) or closed (say how).
        let last = r;
        for (let hops = 0; hops < 50 && last.status === "superseded"; hops++) {
          const next = this.store.db.prepare("SELECT * FROM decisions WHERE supersedes = ?").get(last.id) as DecisionRow | undefined;
          if (!next) break;
          last = next;
        }
        if (last.id === r.id) return `${r.id} was replaced`;
        if (last.status === "open") return `${r.id} was replaced; the open decision is now ${last.id}, so name that one instead`;
        return `${r.id} was replaced by ${last.id}, which is settled too (${last.status})${outcome(last)}`;
      }
      const who = r.decided_by === "person-chat" ? "the owner answered it in chat on its own thread" : r.decided_by === "person" ? "the owner answered it" : r.decided_by === "default" ? "its default ran" : `it was ${r.status}`;
      return `${r.id} is settled: ${who}${outcome(r)}`;
    });
    return `Loom: your closing "Next — you" points at a decision that is already closed. ${how.join("; ")}. Don't ask the owner about it again; carry on from the outcome, and name only decisions that are still open.`;
  }

  private lintAsk(thread: ThreadRow, run: RunRow, ask: OpenAsk): "settled" | void {
    if (!ask.text || (thread.session_profile && JSON.parse(thread.session_profile).loomTools === false)) return;
    const previous = thread.ask ? (JSON.parse(thread.ask) as OpenAsk).text : null;
    const lint = ask.kind ? classifyDeclaredAsk(ask.text, ask.kind) : classifyAsk(ask.text, previous);
    const norm = normalizeAsk(ask.text);
    let board = null;
    try { board = loadBoard(); } catch { /* No board: the lint stays on, as its default. */ }
    // A pointer to a decision that has already settled (answered in chat on its own thread, defaulted, withdrawn…) is
    // stale: the owner would be told to answer something that's done. Clear the ask and tell the thread how it went.
    const settled = ask.kind === "pointer" ? (ask.points_to ? this.settledPointer(ask.points_to) : null) : !ask.kind && lint.kind === "pointer" ? this.settledPointer(ask.text) : null;
    const wake = settled ?? askLintWake(lint.kind, ask.text);
    // A settled-pointer correction carries the outcome the thread needs to carry on, so it isn't held back by the
    // "never twice in a row" guard (that guard stops nagging); it still goes once per ask (Codex review on #826).
    const toldBefore = settled ? !!this.store.db.prepare("SELECT 1 FROM ask_lints WHERE thread_id = ? AND norm = ? AND woke = 1").get(thread.id, norm) : false;
    const send = !!wake && askLintOn(board) && thread.status !== "stopped" && (settled ? !toldBefore : mayWake(this.store.db, thread.id, run.id, norm, ask.id));
    const wakeRun = send ? this.store.createRun(thread.id, "wake", wake!) : null;
    addAskLint(this.store.db, { thread_id: thread.id, run_id: run.id, message_id: ask.messageId, kind: lint.kind, declared_kind: ask.kind, ask_id: ask.id, reason: settled ? "points at a closed decision" : lint.reason, ask: ask.text, norm, woke: wakeRun ? 1 : 0, wake_run_id: wakeRun?.id ?? null, created_at: this.store.now() });
    // Cleared only when the thread hears the outcome (now, or already for this ask); with the lint off it stays open.
    if (settled && (wakeRun || toldBefore)) return "settled";
  }

  // Recovery

  /** Reattach living hosts before deciding which runs were interrupted. */
  async recover(): Promise<{ interrupted: number; continued: number }> {
    this.recovering = true;
    const attached = new Set<string>();
    const recoveryNotes = new Map<string, string>();
    const answers = new Map<string, RuntimeSession["hello"]>();
    const recoveryRequests = new Map(this.store.threads().map((thread) => [thread.id, this.store.openRequests(thread.id)]));
    try {
      // Include hosts whose thread was deleted while the old coordinator was dying.
      for (const runtime of Object.values(this.runtimes)) {
        let foundHosts: { threadId: string }[] = [];
        try { foundHosts = await runtime.discover?.() ?? []; } catch (error) { console.warn("Host discovery failed", error); }
        for (const found of foundHosts) {
          try {
            const thread = this.store.thread(found.threadId);
            if (!thread || thread.status === "stopped") {
              const session = await runtime.attach?.({ threadId: found.threadId, cwd: thread?.cwd ?? "/", account: thread?.account ?? null, nativeSessionId: thread?.native_session_id ?? null }, () => {});
              await session?.close();
            }
          } catch (error) { console.warn("Orphan host recovery failed", found.threadId, error); }
        }
      }
      for (const thread of this.store.threads()) {
        if (thread.status === "stopped") continue;
        try {
          let session: RuntimeSession | null = null;
          try { session = await this.ensureSession(thread, true); } catch { /* A host that died during replay uses normal interruption recovery. */ }
          if (session) {
            answers.set(thread.id, session.hello);
            const active = this.store.activeRun(thread.id);
            if (!active || session.hello?.activeRunId !== null) attached.add(thread.id);
          }
          else {
            await this.runtimes[thread.provider]?.drainPending?.(thread.id,
              (event, seq) => this.applyRuntimeEvent(thread.id, event, seq), thread.host_seq, thread.host_instance_id);
          }
        } catch (error) { console.warn("Session recovery failed", thread.id, error); }
      }
      for (const thread of this.store.threads()) if (!attached.has(thread.id)) recoveryNotes.set(thread.id, await this.ledger.recover(thread));
    } finally {
      this.recovering = false;
    }
    let interrupted = 0;
    let continued = 0;
    const toKick: string[] = [];
    const redeliver: { threadId: string; runId: string; messageId: string; text: string; commandId: string | null }[] = [];
    this.store.tx(() => {
      for (const thread of this.store.threads()) {
        const hello = answers.get(thread.id);
        for (const steer of this.store.pendingSteers(thread.id)) {
          if (hello?.injectedSteers?.includes(steer.id)) this.store.setDelivery(steer.id, "delivered");
          else if (attached.has(thread.id) && steer.run_id && this.store.activeRun(thread.id)?.id === steer.run_id) redeliver.push({ threadId: thread.id, runId: steer.run_id, messageId: steer.id, text: steer.text, commandId: steer.command_id });
          else this.queueSteer(thread.id, steer.id, steer.text, steer.command_id);
        }
        for (const req of recoveryRequests.get(thread.id) ?? []) {
          if (hello?.answeredRequests?.includes(req.id)) {
            this.store.resolveRequest(req.id, "answered", req.answer === null ? hello.answeredAnswers?.[req.id] : JSON.parse(req.answer));
            this.settleRequestPointers(req.id);
          }
        }
        if (attached.has(thread.id)) {
          if (thread.status === "waiting" && !this.store.openRequests(thread.id).length && this.store.activeRun(thread.id)) this.store.updateThread(thread.id, { status: "running" });
          if (!this.store.activeRun(thread.id) && this.store.nextQueuedRun(thread.id)) toKick.push(thread.id);
          continue;
        }
        this.ledger.lose(thread.id);
        const active = this.store.activeRun(thread.id);
        if (active) {
          this.finishRun(active, "interrupted", { kind: "interrupted", message: "Loom restarted" });
          interrupted++;
        }
        for (const req of this.store.openRequests(thread.id)) { this.store.resolveRequest(req.id, "expired", undefined); this.settleRequestPointers(req.id); }
        if (thread.status === "running" || thread.status === "waiting") this.store.updateThread(thread.id, { status: "idle" });
        if (thread.background) this.store.updateThread(thread.id, { background: null });
        if (thread.kind !== "probe" && (active || recoveryNotes.get(thread.id)) && thread.native_session_id && thread.status !== "stopped" && this.continueChain(thread.id) < MAX_CONTINUE_CHAIN) {
          this.store.createRun(thread.id, "continue", RESTART_NOTE + (recoveryNotes.get(thread.id) ?? ""));
          continued++;
        }
        if (thread.status !== "stopped" && this.store.nextQueuedRun(thread.id)) toKick.push(thread.id);
      }
    });
    // Steers a reattached turn may not have: the host ignores ones it already has.
    for (const steer of redeliver) {
      const images = this.imagesOf(this.store.attachmentsOfMessage(steer.messageId));
      await this.deliverSteer(steer.commandId, { ...steer, images }, { threadId: steer.threadId, runId: steer.runId, steered: true });
    }
    await this.leases.reconcile();
    await Promise.all(toKick.map((id) => this.kick(id)));
    await this.checkUpgrades();
    return { interrupted, continued };
  }

  /** How many automatic continues end the thread's run history. */
  private continueChain(threadId: string): number {
    let n = 0;
    for (const run of this.store.runs(threadId).reverse()) {
      if (run.source !== "continue") break;
      n++;
    }
    return n;
  }
}

function toFailure(error: unknown): RuntimeFailure {
  return { kind: "other", message: error instanceof Error ? error.message : String(error) };
}

function turnImage(image: DecodedImage): TurnImage {
  return { mimeType: image.mimeType, data: image.bytes.toString("base64") };
}

/** Rule changes that come from the owner's own answers: kept out of "Decided for you" (it lists what agents decided). */
const OWNER_RULE_EVENTS = new Set(["rule-created", "rule-reaffirmed", "rule-withdrawn", "rule-restored", "rule-superseded", "rule-proposed"]);

/** A decision as clients see it: the row with its brief parsed. */
function briefPayload(row: DecisionRow) {
  const { brief, changes, ...rest } = row;
  return { ...rest, brief: JSON.parse(brief) as DecisionBrief, changes: JSON.parse(changes ?? "[]") as BriefChange[] };
}


function storeDenials(store: LoomStore, threadId: string): { tool: string; source: string | null; at: number; run: string }[] {
  return store.db.prepare("SELECT tool, source, at, run_id AS run FROM tool_denials WHERE thread_id=? ORDER BY at DESC LIMIT 8").all(threadId) as { tool: string; source: string | null; at: number; run: string }[];
}
