import { PILLS, LIVE_STATES, WAITING_REASONS, type Pill, type WaitingReason } from './status.js';
import { UPDATE_KINDS, type UpdateKind } from './updates.js';
import { COMMAND_TYPES, type CommandType } from './types.js';

/** Classification describes existing voice behavior; it never grants a new action. */
export type VoicePolicy = { policy: 'knock' | 'when asked' } | { policy: 'silent'; reason: string };
type Receipt = { source: 'server' } | { source: 'fixed'; sentence: string };
type CommandPolicy = VoicePolicy & { receipt: Receipt };
const asked = { policy: 'when asked' } as const;
const knock = { policy: 'knock' } as const;
const fixed = (sentence: string): CommandPolicy => ({ ...asked, receipt: { source: 'fixed', sentence } });
const silent = (reason: string): CommandPolicy => ({ policy: 'silent', reason, receipt: { source: 'server' } });

export const VOICE_PILLS = {
  needs: knock, failed: knock, working: asked, waiting: asked, stuck: asked,
  finished: asked, idle: asked, unknown: asked,
} satisfies Record<Pill, VoicePolicy>;
export const VOICE_KINDS = {
  needs: knock, failed: knock, decided: asked, shipped: asked, fyi: asked,
} satisfies Record<UpdateKind, VoicePolicy>;
export const VOICE_WAITING_REASONS = {
  queued: asked, disk_low: asked, recovery_unhealthy: asked, memory: asked,
  host_cap: asked, account_limit: asked, provider_busy: asked, budget: asked,
  maintenance: asked, waiting_for_room: asked,
} satisfies Record<WaitingReason, VoicePolicy>;
/** Discussion (including the brief-page pill and delivered receipt) is a working-row annotation: the agent owes the next move, with no owner knock. */
export const VOICE_DISCUSSION: VoicePolicy = asked;
/** Inline message delivery receipts are read on request; none creates a new owner knock. */
export const VOICE_OWNER_RECEIPTS = { sending: asked, delivered: asked, queued: asked, 'picked-up': asked, failed: asked, uncertain: asked };
export const VOICE_COMMANDS = {
  'ask.resolve': silent('The ask card records completion; voice wiring is separate.'),
  seen: fixed('Marked seen; it stays in the rotation'),
  unseen: fixed('Marked unread'),
  viewed: silent('Opening a screen is visual bookkeeping, not a spoken command.'),
  heard: silent('Listening marks a line heard without a separate spoken receipt.'),
  briefed: silent('The spoken briefing itself is the receipt.'),
  done: fixed('Marked done (and stopped the job when requested)'),
  reopen: fixed('Reopened'), snooze: fixed('Snoozed until the requested time or trigger'),
  park: fixed('Parked'), pickup: fixed('Picked back up'),
  reply: fixed('Sent the message'), answer: fixed('Answered the selected option'),
  respond: fixed('Answered the question'), approve: fixed('Recorded the approval choice'),
  dismiss: fixed('Dismissed the question'), retry: fixed('Retrying it'),
  undo: fixed('Undid the last voice desk change'), sweep: fixed('The sweep result summary'),
  pin: fixed('Pinned or Unpinned'), rename: fixed('Renamed the conversation'),
  project: fixed('Filed under the selected project'),
  stop: fixed('Stopped the turn that was running; the conversation stays open for the next message'),
  label: silent('Legacy labels have no voice command.'),
  tag: silent('Desk stage and type tags have no voice command.'),
  watch: silent('Desk watch configuration has no voice command.'),
  role: silent('Thread role configuration has no voice command.'),
  space: silent('Desk space configuration has no voice command.'),
  run: silent('System run controls use their separate interface.'),
  pause: silent('System pause controls use their separate interface.'),
  keep: silent('System keep controls use their separate interface.'),
  fresh: silent('System fresh controls use their separate interface.'),
  raise: silent('System raise controls use their separate interface.'),
} satisfies Record<CommandType, CommandPolicy>;

/** Silent bookkeeping commands are still sent by voice; desk-only controls are not. */
export const VOICE_CLIENT_COMMANDS = [
  'seen', 'unseen', 'heard', 'briefed', 'done', 'reopen', 'snooze', 'park', 'pickup',
  'reply', 'answer', 'respond', 'approve', 'dismiss', 'retry', 'sweep', 'stop', 'pin',
  'rename', 'project', 'undo',
] as const satisfies readonly CommandType[];

export function deskVoiceContract() {
  return {
    pills: PILLS, live: LIVE_STATES, kinds: UPDATE_KINDS,
    commands: COMMAND_TYPES, waitingReasons: WAITING_REASONS,
    voiceCommands: VOICE_CLIENT_COMMANDS,
    policies: { discussion: VOICE_DISCUSSION, ownerReceipts: VOICE_OWNER_RECEIPTS, pills: VOICE_PILLS, kinds: VOICE_KINDS, commands: VOICE_COMMANDS, waitingReasons: VOICE_WAITING_REASONS },
  };
}

/** Browser navigator is single-command and never inherits the operator's wider authority. */
export const NAVIGATOR_VOICE_COMMANDS = ['seen', 'unseen', 'snooze', 'done', 'pin'] as const satisfies readonly CommandType[];

/** Browser composer Focus is local audio state, not an approval or a new desk command. */
export const COMPOSER_VOICE = {
  focus: { policy: 'silent', reason: 'Opt-in spoken replies; resets when the session ends.' },
  dictation: { policy: 'silent', reason: 'Uses only the existing reply or Start work submission.' },
} as const satisfies Record<string, VoicePolicy>;
