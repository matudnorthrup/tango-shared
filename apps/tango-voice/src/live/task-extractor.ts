import type { AgentDescriptor } from './agent-backend.js';
import type { ResponsesCaller } from './responses-caller.js';
import { addresseeNames, namesSomeone, UNSURE_REASON } from './addressee.js';
import { nameFixer, type KnownPerson } from './known-names.js';

export type { KnownPerson } from './known-names.js';
// ── draft mode hook (draft-mode.ts) ──
import { draftRouterLines, parseDraftAction, type DraftAction, type DraftRouterContext } from './draft-mode.js';
import { nextRouterLines, parseNextOp, type NextOp } from './next-up.js';
import type { CatchupOp } from './catchup-walk.js';

// GPT-Live client delegation carries no task text, only an ID and a timeline
// offset. The operator reconstructs intent from the transcript with a small
// structured-output model call (only when it can't resolve the target itself).

export type OperatorAction =
  | { type: 'dispatch'; agentId: string; message: string; threadId?: string; newThreadTitle?: string; threadOptions?: string[] }
  | { type: 'reply'; taskId: string; message: string }
  | { type: 'status' }
  | { type: 'readback'; taskId?: string }
  | { type: 'remind' }
  /** A word in a catch-up walk (catchup-walk.ts): next, skip, pick an option, Fine by me, Accept, what's left. */
  | { type: 'catchup'; walk: CatchupOp }
  /** Next up (next-up.ts): open the oldest item waiting on the owner (advance), or read the queue (list). */
  | { type: 'next'; op: NextOp }
  /** `target`: what to click / go to / type into on a prototype; `text`: what to type (fill). */
  | { type: 'screen'; op: ScreenOp; agentId?: string; scene?: string; target?: string; text?: string }
  | ({ type: 'desk'; op: DeskOp; item?: string } & DeskOpArgs)
  /** Search by voice: the desk's search, its top hits read out (an open after it picks one). */
  | { type: 'search'; query: string }
  /** Capacity, spoken: the tightest account, the week left, a disk warning. */
  | { type: 'capacity' }
  /** The system, spoken ("what's broken?"): the System page's status line and its open incidents. */
  | { type: 'system' }
  /** A project's lifecycle by name: snooze (until a time or trigger), park, wake, finish. */
  /** `confirmed`: the owner said yes to "Finish X?" (finish asks first). */
  | ({ type: 'project'; op: ProjectOp; project: string; confirmed?: boolean } & Pick<DeskOpArgs, 'until' | 'trigger'>)
  /** Undo the last change voice made on the desk. */
  | { type: 'undo' }
  | DraftAction // draft mode hook (draft-mode.ts)
  /** Where it goes isn't clear: the operator asks the owner this one short question and sends nothing. */
  | { type: 'ask'; question: string; reason?: string }
  | { type: 'none'; reason: string };

/**
 * Desk items (docs/specs/agent-desk.md): read (tell the owner what it is), open (its
 * Conversation view), reply (the owner's words into its conversation), and the
 * attention commands: seen, done, snooze, park, pickup, answer (one of its spelled-out
 * options), retry (a failed turn), sweep (pick up or finish in the weekly sweep). respond answers
 * a Loom thread's pending questions (one answer per question); approve answers its approval.
 */
export type DeskOp =
  | 'read'
  | 'stands'
  | 'open'
  | 'reply'
  | 'seen'
  | 'unseen'
  | 'done'
  | 'reopen'
  | 'snooze'
  | 'park'
  | 'pickup'
  | 'answer'
  | 'respond'
  | 'approve'
  | 'dismiss'
  | 'retry'
  | 'stop'
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'project'
  | 'account'
  | 'sweep';
export const DESK_OPS: readonly DeskOp[] = ['read', 'stands', 'open', 'reply', 'seen', 'unseen', 'done', 'reopen', 'snooze', 'park', 'pickup', 'answer', 'respond', 'approve', 'dismiss', 'retry', 'stop', 'pin', 'unpin', 'rename', 'project', 'account', 'sweep'];
export type ProjectOp = 'snooze' | 'park' | 'wake' | 'finish';
const PROJECT_OPS: readonly ProjectOp[] = ['snooze', 'park', 'wake', 'finish'];
export const APPROVAL_CHOICES = ['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel'] as const;

export interface DeskOpArgs {
  /** reply: the owner's words; rename: the new title. */
  message?: string;
  /** answer: the option's text; project: the project's name; account: the account's name. */
  option?: string;
  /** snooze: an ISO time. */
  until?: string;
  /** snooze: until the desk screen is in use again, or until the agent posts. */
  trigger?: 'desk' | 'agent_posts';
  /** done: also stop the background job running in the conversation. */
  stopJob?: boolean;
  /** sweep */
  decision?: 'keep' | 'drop';
  /** respond: one entry per answered question (q1, q2…), the option's label or the owner's own words. */
  answers?: Array<{ question: string; answer: string }>;
  /** approve: the decision the owner gave. */
  approval?: (typeof APPROVAL_CHOICES)[number];
}

export interface ExtractorDeskItem {
  /** Short handle the extractor answers with (i1, i2, …). */
  handle: string;
  agentName: string;
  place: string | null;
  /** What the conversation is for, in a few words (matched when the user names a topic). */
  about?: string | null;
  step: string;
  /** The ask, else the gist (≤ 80 chars). */
  line: string;
  /** Discord thread for thread items, to send answers there. */
  threadId: string | null;
  /** The space (project) the item is filed under, and whether it is that space's lead. */
  space?: string | null;
  lead?: boolean;
  /** Pinned to the top of the Inbox; a turn running right now (what stop interrupts). */
  pinned?: boolean;
  running?: boolean;
  options?: string[];
  /** A Loom thread's pending questions (answer with respond), each with a handle (q1, q2…). */
  questions?: Array<{ handle: string; header: string; question: string; options: string[]; multiSelect: boolean }>;
  /** Its pending question may be skipped unanswered (Loom allows that only for some). */
  dismissible?: boolean;
  /** A Loom thread's pending approval: what it is for and the decisions offered (answer with approve). */
  approval?: { detail: string; options: Array<{ decision: string; label: string }> };
}

/** The owner's desk (active view): every open conversation across agents and Loom. */
export interface ExtractorDesk {
  items: ExtractorDeskItem[];
  /** Handle of the item in the Conversation view right now ("this one"), if any. */
  focused?: string;
  /** Handle of the item discussed last ("that one"), if any. */
  lastDiscussed?: string;
  /** What a voice search just read out, in order (handles h1, h2…; done or archived ones are not in items). */
  searchHits?: Array<{ handle: string; title: string; agentName: string; archived: boolean; done: boolean }>;
  /** The open projects (spaces) by name, for moving a thread into one or acting on a project. */
  projects?: string[];
  /** The last desk change voice made, which "undo that" reverses. */
  undoable?: string;
}

/**
 * show: an agent's staged scene. board: the desk board (the home view). screen: the Screen view
 * for the conversation in focus. The rest go to the page that is showing.
 */
export type ScreenOp =
  | 'show'
  | 'board'
  | 'screen'
  | 'next'
  | 'step_back'
  | 'play'
  | 'pause'
  | 'scroll_down'
  | 'scroll_up'
  | 'scroll_top'
  | 'scroll_bottom'
  // The Conversation view of the conversation in focus.
  | 'conversation'
  // The Prototype view: open it, and drive the page on it.
  | 'prototype'
  | 'click'
  | 'fill'
  | 'go_to'
  | 'page_back'
  // The desk's pages: an Inbox tab, a page's own view, a row by number or name, a project, an agent, Capacity, and back up.
  | 'list_tab'
  | 'list_view'
  | 'list_inbox'
  | 'open_row'
  | 'list_project'
  | 'list_up'
  | 'list_projects'
  | 'list_agents'
  | 'list_agent'
  | 'list_capacity'
  | 'list_system';
const SCREEN_OPS: readonly ScreenOp[] = ['list_capacity', 'list_system', 'show', 'board', 'screen', 'next', 'step_back', 'play', 'pause', 'scroll_down', 'scroll_up', 'scroll_top', 'scroll_bottom', 'conversation', 'prototype', 'click', 'fill', 'go_to', 'page_back', 'list_tab', 'list_view', 'list_inbox', 'open_row', 'list_project', 'list_up', 'list_projects', 'list_agents', 'list_agent'];
/** Ops that take a target in `option` (a label, a tab, a row, a project). */
const TARGET_OPS: ReadonlySet<ScreenOp> = new Set(['click', 'go_to', 'fill', 'list_tab', 'list_view', 'open_row', 'list_project', 'list_agent']);
/** Ops that act on the prototype page on screen (they need the Prototype view up). */
export const PROTOTYPE_PAGE_OPS: ReadonlySet<ScreenOp> = new Set(['click', 'fill', 'go_to', 'page_back']);

export interface ExtractorScreenScene {
  /** Short handle (S1, S2…) for a staged scene, so show can name exactly which one. */
  handle?: string;
  agentName: string;
  title: string;
  summary: string;
  choices: string[];
}

/** The prototype on screen (Prototype view), with what its page reports through the navigation bridge. */
export interface ExtractorPrototype {
  title: string;
  agentName: string;
  /** Uploaded pages can be driven; a dev-server URL only clicked by hand. */
  drivable: boolean;
  path?: string;
  pageTitle?: string;
  /** Clickables, the ones in view first. */
  targets?: Array<{ label: string; kind: string; inView: boolean }>;
  headings?: string[];
  fields?: string[];
  scrollPercent?: number;
}

/** The List on screen: its tabs, the project it is inside, and its rows numbered as they render. */
export interface ExtractorList {
  place?: { page: string; name: string };
  agents?: string[];
  /** Whether the List is what's up (else a conversation, screen or prototype covers it). */
  showing: boolean;
  tab: string;
  tabs: Array<{ name: string; count: number }>;
  /** The views of the page on screen when it isn't the Inbox (a space's or agent's Overview, Jobs, Workers…), and the one it's on. */
  views?: Array<{ name: string; count: number }>;
  view?: string;
  project: string | null;
  projects: string[];
  rows: Array<{ kind: 'project' | 'agent' | 'item'; title: string; where: string }>;
}

/** What the user can see, so "the middle one" and "put Malibu's back up" resolve. */
export interface ExtractorScreen {
  showing?: ExtractorScreenScene;
  /** The Prototype view is up with this prototype. */
  prototype?: ExtractorPrototype;
  /** Titles of the prototypes the conversation in focus has (what "show me the prototype" opens). */
  prototypesAvailable?: string[];
  staged: ExtractorScreenScene[];
  /** The desk's page on screen (the Inbox, a space, an index), as the screen the user looks at shows it. */
  list?: ExtractorList;
  /** A position the user said ("the second one"), resolved against the showing scene's choices. */
  pointedAt?: { words: string; label: string };
}

const ORDINALS: Array<[RegExp, (count: number) => number]> = [
  [/\b(first|1st|number one|option one|top one)\b/i, () => 0],
  [/\b(second|2nd|number two|option two)\b/i, () => 1],
  [/\b(third|3rd|number three|option three)\b/i, () => 2],
  [/\b(fourth|4th|number four|option four)\b/i, () => 3],
  [/\b(middle)\b/i, (count) => (count % 2 === 1 ? (count - 1) / 2 : -1)],
  [/\b(last|bottom one)\b/i, (count) => count - 1],
];

/** "Let's go with the second one" → the second choice's label, when exactly one position is named. */
export function resolvePointedChoice(speech: string, choices: string[]): { words: string; label: string } | undefined {
  if (choices.length < 2) return undefined;
  const hits = ORDINALS.map(([pattern, index]) => {
    const match = pattern.exec(speech);
    return match ? { words: match[1]!, index: index(choices.length) } : null;
  }).filter((hit): hit is { words: string; index: number } => hit !== null && hit.index >= 0 && hit.index < choices.length);
  if (hits.length !== 1) return undefined;
  return { words: hits[0]!.words, label: choices[hits[0]!.index]! };
}

export interface ExtractorThread {
  id: string;
  title: string;
  agentName: string;
  /** e.g. "20 minutes ago" */
  lastActive: string;
}

export interface ExtractorTask {
  id: string;
  agentName: string;
  request: string;
  status: 'running' | 'waiting_user' | 'done';
  lastUpdate?: string;
  threadTitle?: string;
}

export interface ExtractorInput {
  agents: AgentDescriptor[];
  tasks: ExtractorTask[];
  /** Recent conversation, oldest first, e.g. "User: …" / "Operator: …". */
  transcript: string[];
  /** User speech since the previous delegation. */
  latestUserSpeech: string;
  /** The voice model's own summary of what it is delegating, when the route provides one. */
  delegationPrompt?: string;
  /** Recently active threads under the agents' channels, most recent first. */
  threads?: ExtractorThread[];
  /** The thread the conversation is currently about, if any. */
  currentThread?: ExtractorThread;
  /** Present when a screen is connected. */
  screen?: ExtractorScreen;
  /** Present when the desk is available. */
  desk?: ExtractorDesk;
  /** Wall-clock time, so "snooze it till 3" can become an ISO time. */
  now?: number;
  /** The chief of staff's agent id: an agent like any other (never a default when it's unclear who should take something). */
  defaultAgentId?: string;
  /** Where a new thread starts when the user doesn't say (the screen's place, as the desk's + button reads it). */
  startPlace?: string;
  /** Draft mode hook (draft-mode.ts): whether a draft is open. */
  draft?: DraftRouterContext;
  /** People the owner mentions (operator profile), so their names reach agents spelled right. */
  people?: KnownPerson[];
  /** How long the owner, and anyone, had been silent before the latest speech (ms; null: first speech). */
  quiet?: { ownerMs: number | null; anyMs: number | null };
}

export type TaskExtractor = (input: ExtractorInput) => Promise<OperatorAction[]>;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['addressed', 'actions'],
  properties: {
    addressed: { type: 'string', enum: ['yes', 'unsure', 'no'], description: 'Whether the latest user speech was meant for the operator (or an agent through it).' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'agent_id', 'task_id', 'message', 'thread_id', 'new_thread_title', 'thread_options', 'screen_op', 'desk_op', 'item', 'option', 'until', 'trigger', 'stop_job', 'decision', 'answers', 'approval', 'draft_op', 'next_op', 'project_op'],
        properties: {
          type: { type: 'string', enum: ['dispatch', 'reply', 'status', 'readback', 'remind', 'next', 'screen', 'desk', 'search', 'capacity', 'system', 'project', 'undo', 'draft', 'ask', 'none'] },
          project_op: { type: 'string', enum: ['', ...PROJECT_OPS], description: 'For project: snooze / park / wake / finish the project named in option. Else empty.' },
          next_op: { type: 'string', enum: ['', 'advance', 'list'], description: 'For next: advance (open the oldest item waiting on the user) or list (say what is waiting). Else empty.' },
          // draft mode hook (draft-mode.ts)
          draft_op: { type: 'string', enum: ['', 'start', 'finish', 'cancel', 'unfinished'], description: 'For draft: start / finish / cancel a dictated draft, or unfinished next to a send that sounds cut off. Else empty.' },
          desk_op: { type: 'string', enum: ['', ...DESK_OPS], description: 'For desk: what to do with the item, else empty.' },
          item: { type: 'string', description: 'For desk: the item handle (i1, i2, …); for screen show: a scene handle (S1…). Else empty.' },
          option: { type: 'string', description: 'For screen list_tab / list_view / open_row / list_project / list_agent: the tab, the view, the row (its number, or its title), the project or the agent, as listed. For screen click / go_to / fill: the on-page target (a clickable, heading, or field label as listed). For desk answer: the option text exactly as listed. For desk project and for project: the project name as listed. For desk account: the account name as said. Else empty.' },
          until: { type: 'string', description: 'For desk snooze to a time: an ISO 8601 time with offset. Else empty.' },
          trigger: { type: 'string', enum: ['', 'desk', 'agent_posts'], description: 'For desk snooze without a time: desk ("until I\'m at my desk") or agent_posts ("until they post"). Else empty.' },
          stop_job: { type: 'string', enum: ['', 'yes', 'no'], description: 'For desk done when the user said whether to stop the running job. Else empty.' },
          decision: { type: 'string', enum: ['', 'keep', 'drop'], description: 'For desk sweep: keep = pick up, drop = done. Else empty.' },
          answers: {
            type: 'array',
            description: 'For desk respond: one entry per question the user answered (question = its handle q1, q2…; answer = the option label exactly as listed, or the user\'s own words). Several entries for one multi-select question pick several. Else empty.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['question', 'answer'],
              properties: { question: { type: 'string' }, answer: { type: 'string' } },
            },
          },
          approval: { type: 'string', enum: ['', ...APPROVAL_CHOICES], description: 'For desk approve: the decision the user gave. Else empty.' },
          screen_op: { type: 'string', enum: ['', ...SCREEN_OPS], description: 'For screen: what to do, else empty.' },
          agent_id: { type: 'string', description: 'Agent id for dispatch or screen show, else empty.' },
          task_id: { type: 'string', description: 'Existing task id for reply or readback, else empty.' },
          message: { type: 'string', description: 'Task text for the agent, reply text, for desk rename the new title, for search the words to search for, reason for none, for ask the one short question to ask the user, for draft start the message content already said, or for screen fill the text to type (else empty).' },
          thread_id: { type: 'string', description: 'For dispatch into an existing thread: its id. Else empty.' },
          new_thread_title: { type: 'string', description: 'For dispatch into a new thread: a short title. Else empty.' },
          thread_options: { type: 'array', items: { type: 'string' }, description: 'For dispatch when it is genuinely unclear whether it belongs in the main channel or an existing thread: up to two candidate thread ids (thread_id empty). The user is asked. Else empty.' },
        },
      },
    },
  },
} as const;

/** The Prototype view as the router sees it: the page's clickables (in view first), headings, fields. */
function describeList(list: ExtractorList): string[] {
  return [
    `The desk's page${list.showing ? ' is on screen' : ' is behind what is on screen'}: Inbox tab "${list.tab}"${list.project ? `, inside the project "${list.project}" (breadcrumb: Projects › ${list.project})` : ''}.`,
    ...(list.place ? [`Current place: ${list.place.page} “${list.place.name}”. Agents: ${(list.agents || []).join(', ')}.`] : []),
    `Inbox tabs: ${list.tabs.map((tab) => `"${tab.name}" (${tab.count})`).join(', ')}`,
    ...(list.views?.length ? [`Views of this page (on "${list.view ?? ''}"): ${list.views.map((view) => `"${view.name}" (${view.count})`).join(', ')}`] : []),
    ...(list.projects.length ? [`Projects: ${list.projects.map((name) => `"${name}"`).join(', ')}`] : []),
    `Rows in order:${list.rows.length ? '' : ' (none)'}`,
    ...list.rows.map((row, index) => `  ${index + 1}. ${row.kind === 'project' ? 'project ' : ''}"${row.title}"${row.where && row.kind === 'item' ? ` (${row.where})` : ''}`),
  ];
}

function describePrototype(prototype: ExtractorPrototype): string[] {
  const lines = [
    `Prototype view is up: ${prototype.agentName}'s "${prototype.title}"${prototype.drivable ? '' : ' (a dev server: the user clicks it by hand; click/fill/go_to/scroll do not work on it)'}${prototype.path ? `, on page ${prototype.path}${prototype.pageTitle ? ` "${prototype.pageTitle}"` : ''}` : ''}${prototype.scrollPercent !== undefined ? `, scrolled ${prototype.scrollPercent}%` : ''}.`,
  ];
  if (!prototype.drivable) return lines;
  const targets = prototype.targets ?? [];
  const inView = targets.filter((target) => target.inView);
  const below = targets.filter((target) => !target.inView);
  const list = (items: typeof targets) => items.map((target) => `"${target.label}"${target.kind === 'button' ? '' : ` (${target.kind})`}`).join(', ');
  if (inView.length) lines.push(`Clickable in view: ${list(inView)}`);
  if (below.length) lines.push(`Clickable further down: ${list(below)}`);
  if (prototype.headings?.length) lines.push(`Sections: ${prototype.headings.map((heading) => `"${heading}"`).join(', ')}`);
  if (prototype.fields?.length) lines.push(`Fields: ${prototype.fields.map((field) => `"${field}"`).join(', ')}`);
  if (!targets.length && !prototype.headings?.length) lines.push('(The page has not reported what is on it yet.)');
  return lines;
}

export function buildExtractorPrompt(input: ExtractorInput): string {
  const agents = input.agents
    .map((agent) => `- ${agent.id}: ${agent.name}${agent.aliases?.length ? ` (also "${agent.aliases.join('", "')}")` : ''} — ${agent.role}`)
    .join('\n');
  const tasks = input.tasks.length
    ? input.tasks
        .map((task) => `- ${task.id} [${task.status}] ${task.agentName}${task.threadTitle ? ` in thread "${task.threadTitle}"` : ''}: "${task.request}"${task.lastUpdate ? ` — last said: "${task.lastUpdate}"` : ''}`)
        .join('\n')
    : '(none)';
  const threads = input.threads?.length
    ? input.threads.map((thread) => `- ${thread.id}: "${thread.title}" (${thread.agentName}, active ${thread.lastActive})`).join('\n')
    : '(none)';
  const describeScene = (scene: ExtractorScreenScene) =>
    `${scene.handle ? `${scene.handle} ` : ''}${scene.agentName}: "${scene.title || scene.summary}"${scene.title ? ` (${scene.summary})` : ''}${scene.choices.length ? ` — choices in order: ${scene.choices.map((choice, index) => `${index + 1}. ${choice}`).join('; ')}` : ''}`;
  const screen = input.screen
    ? [
        '',
        `Screen: ${input.screen.showing ? `showing ${describeScene(input.screen.showing)}` : 'showing the desk'}`,
        `Staged scenes:\n${input.screen.staged.length ? input.screen.staged.map((scene) => `- ${describeScene(scene)}`).join('\n') : '(none)'}`,
        ...(input.screen.pointedAt
          ? [`The user's "${input.screen.pointedAt.words}" refers to the on-screen choice "${input.screen.pointedAt.label}". If they are picking, use exactly that label.`]
          : []),
        ...(input.screen.prototype ? describePrototype(input.screen.prototype) : []),
        ...(input.screen.list ? describeList(input.screen.list) : []),
        ...(!input.screen.prototype && input.screen.prototypesAvailable?.length
          ? [`Prototypes for the conversation in focus (screen_op prototype opens the newest): ${input.screen.prototypesAvailable.map((title) => `"${title}"`).join(', ')}`]
          : []),
      ]
    : [];
  const desk = input.desk;
  const deskLines = desk
    ? [
        '',
        `Desk (the user's active conversations across agents and Loom coding threads, as on the screen${desk.focused ? `; ${desk.focused} is open in the Conversation view` : ''}${desk.lastDiscussed ? `; ${desk.lastDiscussed} was discussed last` : ''}):`,
        ...(desk.items.length
          ? desk.items.map(
              (item) =>
                [
                  `- ${item.handle}: ${item.agentName}${item.place ? ` · "${item.place}"` : ''}${item.space ? ` [space: ${item.space}${item.lead ? ', its lead' : ''}]` : ''}${item.about && item.about !== item.place ? ` (about: ${item.about})` : ''} [${item.step}]${item.dismissible ? ' [can skip]' : ''}${item.pinned ? ' [pinned]' : ''}${item.running ? ' [running]' : ''}${item.threadId ? ` thread=${item.threadId}` : ''}: ${item.questions?.length || item.approval ? 'waiting on the user' : item.line}${!item.questions?.length && !item.approval && item.options?.length ? ` (options: ${item.options.map((option) => `"${option}"`).join(', ')})` : ''}`,
                  ...(item.questions ?? []).map(
                    (question) =>
                      `    ${question.handle}${question.header ? ` [${question.header}]` : ''}: ${question.question}${question.options.length ? ` (options: ${question.options.map((option) => `"${option}"`).join(', ')})` : ''}${question.multiSelect ? ' (multi-select)' : ''}`,
                  ),
                  ...(item.approval ? [`    approval: ${item.approval.detail} (decisions: ${item.approval.options.map((option) => `${option.decision} = "${option.label}"`).join(', ')})`] : []),
                ].join('\n'),
            )
          : ['(empty)']),
        ...(desk.searchHits?.length
          ? [
              'Search results just read to the user, in order (desk ops take these handles too; "the first one" right after the search means h1):',
              ...desk.searchHits.map((hit) => `- ${hit.handle}: ${hit.agentName} · "${hit.title}"${hit.archived ? ' (archived: it can only be read)' : hit.done ? ' (done)' : ''}`),
            ]
          : []),
        ...(desk.projects?.length ? [`Projects (spaces): ${desk.projects.map((name) => `"${name}"`).join(', ')}`] : []),
        ...(desk.undoable ? [`Last desk change voice made (what "undo that" reverses): ${desk.undoable}`] : []),
      ]
    : [];
  return [
    'You route requests in a live voice conversation between a user and an operator who delegates work to a team of agents.',
    'The voice model just asked for backend help. Decide what the user wants done, using the latest user speech in context.',
    ...(input.now ? [`Now: ${new Date(input.now).toString()}`] : []),
    '',
    `Agents:\n${agents}`,
    '',
    ...(input.people?.length
      ? [
          `People the user mentions (speech-to-text garbles their names; write them exactly like this, and read a near-miss as the name when it fits):\n${input.people
            .map((person) => `- ${person.name}${person.note ? ` (${person.note})` : ''}${person.heardAs?.length ? `, heard as "${person.heardAs.join('", "')}"` : ''}`)
            .join('\n')}`,
          '',
        ]
      : []),
    `Open tasks:\n${tasks}`,
    '',
    `Active threads:\n${threads}`,
    ...(input.currentThread ? [`Current thread: ${input.currentThread.id} "${input.currentThread.title}" (${input.currentThread.agentName})`] : []),
    ...screen,
    ...deskLines,
    '',
    `Recent conversation:\n${input.transcript.join('\n') || '(empty)'}`,
    '',
    ...(input.quiet ? [`Before it, the user had been silent ${quietText(input.quiet.ownerMs)} (anyone: ${quietText(input.quiet.anyMs)}).`] : []),
    `Latest user speech: "${input.latestUserSpeech}"`,
    ...(input.delegationPrompt ? [`Voice model's description of the request: "${input.delegationPrompt}"`] : []),
    '',
    'Actions:',
    '- dispatch: new work for an agent. Use the agent the user names; if none is named, use the one agent that plainly fits by role or by an open conversation. Write the message as a clear standalone instruction to that agent. One action per agent.',
    '- ask: where it goes is unclear (no agent or thread named and none plainly fits, or two places fit equally): don\'t guess and never fall back to the chief of staff or any default agent. message = one short spoken question with your best guess first ("Watson, or a coding thread in tango?", "Which Tango Voice thread: the lead or the regression sweep?"). Nothing is sent until they answer; their answer comes back as new speech with your question in the conversation.',
    '- Pass on what the user asked, not limits of your own: never tell an agent it can\'t or shouldn\'t use a tool, a file, a folder or an account ("don\'t assume you can access the folder"), and add no restrictions, conditions or approval steps the user didn\'t say ("don\'t make other changes without checking with me", "do not place an order"). Keep every limit the user does say ("but don\'t order anything"). Each agent knows its own tools and its own confirmation rules; if the user points at something ("it\'s in my Downloads folder"), tell the agent where to look.',
    '- Keep what the user spelled out letter by letter, and their numbers, exactly as said: "Y O T E space G T" is "YOTE GT", never a word it sounds like.',
    '- Starting a new coding thread ("new Loom thread in tango", "start a coding thread for acme") is never dispatch: it is draft start with agent_id "loom" (see draft).',
    '- Speech not meant for the operator is none, even though the voice model asked: words to someone in the room ("Riley, what sounds good for dinner?"), a device, video or TV talking ("search for ThinkOnYourDevice and enter the passkey"), or reps counted out loud. Use reason "not for the operator": nobody asked an agent for anything.',
    '- reply: the user is answering a question an agent asked, giving feedback, approving, or adding to an existing task. Use that task_id and pass the user\'s words as the message. Only for a task listed in Open tasks.',
    '- agent_id is always one of the listed agents; never a repo or project name.',
    '- Never dispatch a second task that repeats or extends a running task for the same agent; use reply on that task instead. The voice model may hand you the same request twice.',
    '- "Open tasks" is the only record of what was sent. If the request is not in Open tasks, dispatch it.',
    '- status: the user asks what is pending, what came back, whether anything new came in, or for the next update.',
    '- readback: the user wants the full text, the exact wording, or something read word for word ("read me the whole thing", "what exactly did the draft say"). Set task_id to the task it is about, or leave it empty for the last thing the operator relayed.',
    '- remind: the user asks to be caught up or for a full rundown of what they still need to do ("catch me up", "what\'s on my desk", "remind me what I need to do"): the operator reads the desk briefing.',
    ...(desk
      ? [
          ...nextRouterLines(),
          'Desk (acting on the items listed under Desk; these are not messages to agents):',
          '- desk with desk_op done: the item is handled ("mark that done", "that one\'s done", "done with the Foxtrot one"). If the user said whether to stop a running job too, set stop_job yes or no.',
          '- desk_op seen: "seen", "I\'ve seen it", "mark it (as) read", "leave it": it stays in the rotation, no longer new.',
          '- desk_op snooze: out of the rotation until a time ("snooze it till 3", "remind me tomorrow morning": until = an ISO time computed from Now), or until a trigger: "until I\'m at my desk" → trigger desk; "until they post / reply / answer" → trigger agent_posts. A bare "snooze it" with no time or trigger → trigger agent_posts.',
          '- desk_op park: indefinitely ("park it", "later", "come back to that sometime"). pickup: bring a parked or snoozed item back ("pick that back up", "unpark it").',
          '- desk_op answer: the user picks one of an item\'s listed options ("go with option two", "the Brand K") → option = that option\'s exact text. Only for items that list options.',
          '- desk_op respond: the user answers a Loom item\'s listed questions (q1, q2… under the item). answers = one entry per question they answered: question = its handle, answer = the option label exactly as listed when their words match one ("the second one" = the second option; "the recommended one" = the label marked (Recommended)), else their own words. Never invent answers for questions they did not address. Prefer respond over reply and answer for Loom items with questions.',
          '- desk_op approve: only for an item that lists an approval (an "approval:" line under it); a yes to a question asked in the item\'s text is desk_op reply. The user approves or declines a Loom item\'s listed approval → approval = the decision with the scope they said: plain "yes", "approve", "allow it" → accept; "for this session", "for now", "this time", "just this time", "just this once", "this once", "only once" → acceptForSession; "always", "from now on", "every time", "don\'t ask again" → acceptAlways; "no" → decline; "cancel" → cancel. Never pick a broader scope than they said; if their scope is not listed, still give the decision they asked for (the operator asks them).',
          '- desk_op retry: re-run a failed item ("try it again", "retry that").',
          '- desk_op stop: interrupt the turn running in a conversation right now ("stop that", "stop it", "hold it, Sierra", "cancel what the voice fix thread is doing"). The conversation stays open; it is not done. Only for an item marked [running] or the one in focus; "stop that", "stop it" or "stop this thread" with a conversation in focus is that conversation (leave item empty), never a question.',
          '- desk_op project with option = a project name exactly as listed under Projects: file the conversation under that project ("move this to the Tango Voice project", "put the headlight thread in Bike"). "Out of its project" / "no project" → option "none". A project that is not listed: use ask (voice can\'t create projects).',
          '- desk_op reopen: bring a done conversation back ("reopen it", "that wasn\'t done"). A done one is usually the one in focus or just marked done. To reopen a done thread that is not listed, search for it first.',
          '- desk_op pin / unpin: pin a conversation to the top of the Inbox or take the pin off ("pin this", "unpin the bounty thread").',
          '- desk_op rename with message = the new title ("rename this to Shed vents", "call that thread Pinecrest trip").',
          '- desk_op unseen: mark it unread, to come back to ("mark it unread", "keep that one for later", "mark it new"). Not park: it stays in the rotation.',
          ...(desk.items.some((item) => item.dismissible) ? ['- desk_op dismiss: skip the pending question of an item marked [can skip] without answering it ("skip that question", "dismiss it", "never mind that question"). Only those items; any other question needs an answer.'] : []),
          '- desk_op stands: say where a conversation stands, from its card ("where does the headlight thread stand?", "how\'s the voice fix going?"). "Where does <project> stand" is stands on that project\'s item marked as its lead. Use read instead when they want to hear its messages.',
          '- desk_op account with option = the account name as said, every word of it ("acme team", not "acme"): move a Loom thread to another account ("move this to the acme account", "run that on my work Claude"). Only when the user names an account; never pick one.',
          '- undo (type undo): reverse the last desk change voice made ("undo that", "undo", "put it back"). Only that one change; nothing else.',
          '- search with message = the words to look for: find conversations, done and archived ones too ("find the thread about the reconnect bug", "search for shed vents", "which thread talked about the Pinecrest trip?"). The top results are read out; "open the second one" right after is desk_op open on h2.',
          '- capacity: how much room the accounts have ("how\'s capacity", "how much Claude is left this week?", "are we near the limit?"). screen_op list_capacity opens the Capacity page instead ("show capacity", "open the capacity page"): a page to look at, nothing spoken.',
          '- system: what is broken or failing behind the scenes ("what\'s broken?", "is anything down?", "any problems with the jobs?", "is the system ok?"). screen_op list_system opens the System page instead ("show the system page", "open system"): nothing spoken.',
          '- project with project_op and option = a project name as listed under Projects: act on the whole project. snooze (until = an ISO time; "until I\'m at my desk" → trigger desk; "until they post" → trigger agent_posts), park ("park the board game project"), wake ("wake up Bike", "bring the board game back"), finish ("finish the board game project", "the Bike project is done": its open threads are marked done after the user confirms). One conversation in a project is a desk op, not this.',
          '- desk_op sweep: in the weekly sweep, pick up (decision keep: back to Active) or finish (decision drop: Done) an item.',
          '- desk_op read: the user asks what an item is about or wants to hear it ("what\'s this one?", "what did Foxtrot need?"). open: show its conversation on the screen without working on it ("show me the Malibu one"). Picking a conversation to work on ("let\'s talk about X", "okay, X", "pull up X", "open X") is a draft start (see draft), not open.',
          '- desk_op reply: the user\'s words go into the item\'s own conversation (message = their words). Always for Loom items: these are coding threads in Loom, not agents, and no agent (not the chief of staff) can act for them. The part before "·" in a Loom item\'s place (like "tango") is a repo, not an agent.',
          '- A Loom thread\'s title is a name the user calls it by, even when it sounds like a role ("Captain Nautilus", "Release Notes Desk"): "tell Captain Nautilus …" is desk_op reply to that item, never a dispatch to the chief of staff or any agent.',
          '- "Loom" plus a thread\'s name ("ask the Loom bounties thread…", "tell the Loom voice fix thread…", "tell Loom scenario updates…") is always desk_op reply on that Loom item, never a dispatch to an agent, even if an agent was discussed a moment ago.',
          '- Answering an agent\'s desk item ("tell Foxtrot to revert it", "yes, order the Brand K" right after hearing it) is a dispatch to that agent with thread_id set to the item\'s thread when it lists one (or a reply on a matching open task).',
          '- Answering or following up on what a Loom item just said, without naming anyone ("yes, pay them", "should we pay it now or next week?", "when did we decide that?" right after hearing it) is desk_op reply on that item with the user\'s words. The Loom thread holds that context; no agent, not the chief of staff, can answer for it. Only a named agent ("have Watson check …") makes it a dispatch.',
          '- Spaces: an item marked [space: X] is filed under the project X. The user can name any thread in a space by its title or topic, not only the space\'s lead. A space\'s name alone ("tell Tango Voice to…", "ask the board game…") does NOT mean its lead: when several items in that space could be meant, use ask naming two or three of them; only when exactly one item is in that space does its name reach it. "The X lead" means the item marked as its lead.',
          '- Match the item the user names by its agent and place, not by words that happen to appear in another item\'s line. "This one" is the item in the Conversation view if there is one; "that one" is the item discussed last; otherwise match agent and topic. Several items at once are one desk action per item.',
          '- Acknowledging an update that asked nothing ("thanks", "sounds good", "got it") is desk_op seen on the item just relayed or discussed. If the agent asked the user something, "sounds good" or "yes" answers it: that is a reply (or dispatch) to the agent.',
          '- Leave item empty only when the user clearly means the item in the Conversation view or the one just discussed.',
        ]
      : []),
    ...(input.screen
      ? [
          'Screen (the user can see a screen: the desk board, one conversation, an agent\'s staged scene, or a live prototype to click through):',
          '- screen with screen_op show: the user wants to see an agent\'s staged scene ("show me Malibu\'s macros", "put the speaker list back up"). Set agent_id, and set item to the scene\'s handle (S1, S2…) when one staged scene matches what they mean. When they want to see work that no staged scene covers, do not use show: dispatch to the agent asking it to put that on the screen.',
          '- screen_op board: the desk\'s home view, the Inbox, over whatever covers it ("show the list", "back to the board", "go home", "clear the screen"). Inside a project, "back to the list" or "up" is list_up instead. "Go back" or "back" is list_up (one step back: a screen to its thread), never board; in the Prototype view it is page_back.',
          '- screen_op screen: the staged scene for the conversation in focus ("show the screen", "show me what they put up").',
          '- screen_op next / step_back: move a step guide or slideshow that is showing ("next step", "go back a step"). play / pause: a video that is showing ("play it", "pause").',
          '- screen_op scroll_down / scroll_up / scroll_top / scroll_bottom: scroll whatever is on the screen ("scroll down", "keep going", "back to the top"). A follow-up like "more" or "again" right after a scroll repeats it.',
          '- screen_op conversation: the Conversation view of the conversation in focus ("back to the conversation", "show me the thread", "go to the conversation view").',
          '- screen_op prototype: open the live, clickable prototype for the conversation in focus ("show me the prototype", "let me try it", "open the mockup so I can click around"). It is a different view from the staged screen: "show the screen" is screen_op screen.',
          ...(input.screen.list
            ? [
                'The desk\'s pages, by voice (the rows, tabs and views are listed under Screen):',
                '- screen_op list_tab with option = the Inbox tab\'s name exactly as listed ("show me Watching", "go to the Snoozed tab", "switch to History"). Also from a conversation: it brings the List back up on that tab.',
                '- screen_op list_view with option = a view of the page on screen exactly as listed under "Views of this page" ("show me the workers", "the Jobs view", "show me what\'s done here"). A name that is one of this page\'s views is list_view, not list_tab.',
                '- screen_op list_inbox: the Inbox itself ("go to the inbox", "my inbox", "back to the inbox"), from any page.',
                '- screen_op open_row with option = the row\'s number as listed ("open the third one" → "3", "the top one" → "1", "the last one" → the last number) or, for a row named by its words, its title exactly as listed. A row that is a project opens the project. For "the second one in Watching", first list_tab Watching, then open_row "2": the numbers are read again after the tab changes.',
                '- screen_op list_project with option = a project\'s name as listed under Projects ("open the Voice project", "go into Tango Desk").',
                '- screen_op list_projects: open the Projects index. list_agents: open the Agents index. list_agent with option = the agent name: open its page. list_capacity: open the Capacity page (the System page\'s Capacity tab). list_system: open the System page.',
                '- screen_op list_up: one step back: from a staged screen to its conversation (in the Prototype view a plain "go back" stays page_back), from a conversation to its current place, else up from a project or agent to its index ("go back", "back", "back to the list", "up a level", "out of this project", "the breadcrumb"). Keep the current place. Over a screen, a named List ("back to the list", "show the list") is board, not list_up: only a plain back is one step.',
                '- A position ("the second one", "number four") while the desk\'s page is on screen and no scene with choices is up means a row: open_row, not a pick (right after a search was read out, it means that search result instead). Naming a conversation by its agent or topic stays desk_op open / a draft start.',
              ]
            : []),
          ...(input.screen.prototype
            ? [
                'While the Prototype view is up, the user drives the page by voice:',
                '- screen_op click with option = the clickable\'s label exactly as listed ("click Continue", "hit sign up", "open the pricing tab", "tap the second plan" → the matching label). Prefer the ones in view. If nothing listed matches, still set option to their words.',
                '- screen_op go_to with option = a listed section or heading ("go to pricing", "jump to the FAQ").',
                '- screen_op fill with option = the field and message = the text to type ("type owner@example.test in the email box", "search for diesel").',
                '- screen_op page_back: the previous page inside the prototype ("go back", "back a page", "previous page"). Only "back to the board" or "go home" means screen_op board here.',
                '- Feedback about the prototype ("the button should be green", "tell them the header is too big", "this step is confusing") is not a page op: it is a message for whoever built it, with their words: a reply on that agent\'s open task when one is listed for this work, otherwise desk_op reply on the item in focus (always for Loom items).',
              ]
            : []),
          '- Picking one of the on-screen choices ("the middle one", "go with the Sony") is a reply on that agent\'s most recent task, with the exact choice label in the message. If that agent has no task, dispatch the pick to it.',
        ]
      : []),
    'Threads (dispatch only):',
    '- Set new_thread_title when the user asks to start or open a new thread; keep the title short and specific.',
    '- Set thread_id only when the user names an existing thread ("the speaker thread"), says "in that thread" or "in the same thread", or is directly answering what was just relayed from the current thread. A shared topic is not enough: "ask Sierra for the Bike\'s VIN" goes to the main channel even when a Bike thread exists. Only pick a thread that is active today or that the user names explicitly.',
    '- "In our chat", "in the main channel", "top level", "directly", or "not in a thread" means the main channel: leave both empty.',
    '- Torn between the main channel and an existing thread (or between two threads), because the request fits a thread\'s topic but the user did not say where: leave thread_id empty and set thread_options to the candidate thread ids (at most two). The user is asked "main chat, or the … thread?". Use it only for new work that plausibly belongs in a specific thread, never when they named a place.',
    '- Otherwise leave thread_id, new_thread_title and thread_options empty: the work goes to the agent\'s main channel.',
    '- none: nothing for the agents: chit-chat, thinking out loud, describing plans or worries without asking for help.',
    '- The voice model only asks you when it believes an agent is needed. A follow-up or clarifying question about an open or recent task\'s topic ("so is it the rear one?") is a reply on that task, not none.',
    '- Right after an agent\'s answer was relayed, the user responding to it (agreeing, pushing back, building on it, "you\'re right", "that explains it differently", a thought it sparked) is a reply on that task with the user\'s words, even with no question in it: they are talking with that agent, and it is not thinking out loud. Only a short acknowledgement ("thanks", "got it") is none.',
    ...(input.defaultAgentId
      ? [
          `- ${input.agents.find((agent) => agent.id === input.defaultAgentId)?.name ?? input.defaultAgentId} (${input.defaultAgentId}) is the chief of staff: dispatch to it when the user names it or asks for its kind of judgment across agents ("what should I tackle first?"). It is never a default: when it is unclear who or which thread should take something, use ask.`,
        ]
      : []),
    'New threads:',
    `- Where a new thread starts when the user names no agent and no repo (the screen's place, as the desk's + button reads it): ${input.startPlace ?? 'nothing settles it'}.`,
    '- "Start / open / kick off a new thread (about X)" without an agent or repo named is draft start with agent_id "new" and message = the task already said, word for word: the screen\'s place settles where it goes, or the user is asked. Never dispatch it: not to the chief of staff, not to any agent the user did not name, and never with a repo or project as agent_id.',
    '- A new thread with a named agent ("start a new thread with Sierra about …") is dispatch to that agent with new_thread_title.',
    ...draftRouterLines(input.draft), // draft mode hook (draft-mode.ts)
    'Only dispatch when the user actually asks for something to be done or found out. When unsure, choose none; the operator can ask.',
    'Return every action implied by the latest user speech, in order.',
    '',
    'addressed: was the latest speech meant for the operator (or an agent through it)? The operator is always listening, so it also hears speech not said to it: people nearby or on the phone, someone thinking aloud, singing, a TV.',
    '- yes: a request, a command, an answer to something the operator or an agent asked, dictation, or a reply in an exchange that is going on.',
    '- no: plainly not for the operator (words to someone else, singing, a TV, counting reps out loud mid-set ("seven, eight, nine"), a stray fragment). The only action is none with reason "not for the operator".',
    '- A lone "mm", "uh" or "hmm" is no, unless it answers a yes-or-no question the operator or an agent just asked.',
    '- Reporting a finished set or a workout result ("twenty calf raises", "sixty pounds, ten reps", "did all my kettlebell swings") is yes: it is for the fitness agent, named or not.',
    '- unsure: it could be either. Still return the actions it would need if it was meant for the operator: the operator asks "For me?" and does them only on a yes.',
    '- Naming the operator (Yankee) or an agent means yes. In the middle of an exchange (the user spoke to the operator in the last minute, or the operator just asked something) lean yes. After a long quiet (two minutes or more) lean unsure, unless the speech is plainly a request to the operator ("can you…", "have Sierra…", "go to the next one") or answers something on screen.',
    '- A remark with no request in it ("thanks, John", "it\'s really good, isn\'t it", "I feel like our system is brittle") is no, or unsure when it might be meant for an agent; never a dispatch on its own. A response to the answer an agent just gave is yes (a reply on that task).',
  ].join('\n');
}

interface RawAction {
  type: string;
  agent_id?: string;
  task_id?: string;
  message?: string;
  thread_id?: string;
  new_thread_title?: string;
  thread_options?: string[];
  screen_op?: string;
  desk_op?: string;
  item?: string;
  option?: string;
  until?: string;
  trigger?: string;
  stop_job?: string;
  decision?: string;
  answers?: Array<{ question?: string; answer: string }>;
  approval?: string;
  draft_op?: string;
  next_op?: string;
  project_op?: string;
}

/** Older names for screen ops (inbox-era prompts and replays). */
const SCREEN_OP_ALIASES: Record<string, ScreenOp> = { dashboard: 'board', back: 'board', home: 'board', goto: 'go_to', type: 'fill' };

function quietText(ms: number | null): string {
  if (ms === null) return 'since the call started';
  const seconds = Math.round(ms / 1000);
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** `named`: the speech calls the operator or an agent by name, so it was meant for the operator whatever the router said. */
export function parseExtractorOutput(raw: string, options: { named?: boolean } = {}): OperatorAction[] {
  const parsed = JSON.parse(raw) as { addressed?: string; actions: RawAction[] };
  if (options.named) return parsed.actions.map(parseAction);
  // Not for the operator: nothing is done, whatever else came back. Unsure: the work rides with a marker; the operator asks first.
  if (parsed.addressed === 'no') return [{ type: 'none', reason: 'not for the operator' }];
  const actions = parsed.actions.map(parseAction);
  if (parsed.addressed === 'unsure' && actions.some((action) => action.type !== 'none')) return [...actions, { type: 'none', reason: UNSURE_REASON }];
  return actions;
}

function parseAction(action: RawAction): OperatorAction {
  switch (action.type) {
    case 'dispatch':
      return {
        type: 'dispatch',
        agentId: action.agent_id ?? '',
        message: action.message ?? '',
        ...(action.thread_id ? { threadId: action.thread_id } : {}),
        ...(action.new_thread_title ? { newThreadTitle: action.new_thread_title } : {}),
        ...(!action.thread_id && !action.new_thread_title && action.thread_options?.length ? { threadOptions: action.thread_options.filter(Boolean).slice(0, 2) } : {}),
      };
    case 'readback':
      return { type: 'readback', ...(action.task_id ? { taskId: action.task_id } : {}) };
    case 'remind':
      return { type: 'remind' };
    case 'next': {
      const op = parseNextOp(action.next_op);
      return op ? { type: 'next', op } : { type: 'none', reason: `unclear next action "${action.next_op ?? ''}"` };
    }
    case 'desk': {
      const op = DESK_OPS.find((candidate) => candidate === action.desk_op);
      if (!op) return { type: 'none', reason: `unclear desk action "${action.desk_op ?? ''}" on "${action.item ?? ''}"` };
      return {
        type: 'desk',
        op,
        ...(action.item ? { item: action.item } : {}),
        ...(action.message ? { message: action.message } : {}),
        ...(action.option ? { option: action.option } : {}),
        ...(action.until ? { until: action.until } : {}),
        ...(action.trigger === 'desk' || action.trigger === 'agent_posts' ? { trigger: action.trigger } : {}),
        ...(action.stop_job === 'yes' ? { stopJob: true } : action.stop_job === 'no' ? { stopJob: false } : {}),
        ...(action.decision === 'keep' || action.decision === 'drop' ? { decision: action.decision } : {}),
        ...(Array.isArray(action.answers) && action.answers.length
          ? { answers: action.answers.filter((entry) => entry && typeof entry.answer === 'string' && entry.answer.trim()).map((entry) => ({ question: String(entry.question ?? ''), answer: entry.answer.trim() })) }
          : {}),
        ...((APPROVAL_CHOICES as readonly string[]).includes(action.approval ?? '') ? { approval: action.approval as DeskOpArgs['approval'] } : {}),
      };
    }
    case 'screen': {
      const name = action.screen_op ?? '';
      const op = SCREEN_OPS.find((candidate) => candidate === name) ?? SCREEN_OP_ALIASES[name];
      if (!op) return { type: 'none', reason: `unknown screen op "${name}"` };
      return {
        type: 'screen',
        op,
        ...(action.agent_id ? { agentId: action.agent_id } : {}),
        ...(op === 'show' && action.item ? { scene: action.item } : {}),
        ...(TARGET_OPS.has(op) && (action.option || action.item) ? { target: (action.option || action.item)!.trim() } : {}),
        ...(op === 'fill' && action.message ? { text: action.message } : {}),
      };
    }
    case 'reply':
      return { type: 'reply', taskId: action.task_id ?? '', message: action.message ?? '' };
    case 'status':
      return { type: 'status' };
    case 'search':
      return action.message?.trim() ? { type: 'search', query: action.message.trim() } : { type: 'none', reason: 'nothing to search for' };
    case 'capacity':
      return { type: 'capacity' };
    case 'system':
      return { type: 'system' };
    case 'undo':
      return { type: 'undo' };
    case 'project': {
      const op = PROJECT_OPS.find((candidate) => candidate === action.project_op);
      if (!op || !action.option?.trim()) return { type: 'none', reason: `unclear project action "${action.project_op ?? ''}" on "${action.option ?? ''}"` };
      return {
        type: 'project',
        op,
        project: action.option.trim(),
        ...(action.until ? { until: action.until } : {}),
        ...(action.trigger === 'desk' || action.trigger === 'agent_posts' ? { trigger: action.trigger } : {}),
      };
    }
    case 'draft': // draft mode hook (draft-mode.ts)
      return parseDraftAction(action.draft_op, action.agent_id, action.message, action.item);
    case 'ask':
      return action.message?.trim() ? { type: 'ask', question: action.message.trim() } : { type: 'none', reason: 'unclear where it goes' };
    default:
      return { type: 'none', reason: action.message ?? '' };
  }
}

/** Swaps each known misspelling of a person's name for the name in the text agents get ("Zedd" → "Zed"). */
export function fixHeardNames(actions: OperatorAction[], people: KnownPerson[] | undefined): OperatorAction[] {
  if (!people?.some((person) => person.heardAs?.length)) return actions;
  const fix = nameFixer(people);
  const heard = new Set(people.flatMap((person) => (person.heardAs ?? []).map((spelling) => spelling.trim().toLowerCase())));
  return actions.map((action) => {
    // A draft's words are fixed once, when the draft compiler writes the message.
    if (action.type === 'draft') return action;
    const fixed = { ...action } as Record<string, unknown>;
    // Agent-facing text only: a screen fill's text is typed into a page as said.
    for (const key of ['message', 'newThreadTitle']) if (typeof fixed[key] === 'string') fixed[key] = fix(fixed[key] as string);
    // A free-form answer to a Loom question; an answer that is only a heard spelling may be a listed option label, kept exact.
    if (Array.isArray(fixed.answers)) fixed.answers = (fixed.answers as Array<{ question: string; answer: string }>).map((entry) => (heard.has(entry.answer.trim().toLowerCase()) ? entry : { ...entry, answer: fix(entry.answer) }));
    return fixed as OperatorAction;
  });
}

export function createTaskExtractor(call: ResponsesCaller, options: { people?: KnownPerson[] } = {}): TaskExtractor {
  return async (input) => {
    const people = input.people ?? options.people;
    const actions = parseExtractorOutput(
      await call({
        instructions: 'Route the request. Reply with JSON only.',
        input: [{ role: 'user', text: buildExtractorPrompt({ ...input, ...(people?.length ? { people } : {}) }) }],
        schema: { name: 'operator_actions', schema: SCHEMA as unknown as Record<string, unknown> },
      }),
      // The voice model's own description stands in for speech whose transcript hasn't arrived.
      { named: namesSomeone(input.latestUserSpeech || input.delegationPrompt || '', addresseeNames(input.agents)) },
    );
    return fixHeardNames(actions, people);
  };
}

/** Condenses a long agent reply into a few spoken sentences, keeping any question for the user. */
export function createVoiceSummarizer(call: ResponsesCaller) {
  return async (_agentId: string, text: string, question?: string): Promise<string> => {
    try {
      // Without the question, "condense" keeps what sounds important, not what was asked (live test 10/07).
      const asked = question?.trim()
        ? 'at most six short sentences, plain speech, no markdown, no URLs. The user asked the question below: answer every part of it first, using the reply\'s own facts and numbers, then add only what they need to act. '
        : 'at most four short sentences, plain speech, no markdown, no URLs. ';
      const spoken = await call({
        instructions:
          'Condense this agent reply for someone listening by voice: ' +
          asked +
          'Keep the key facts, numbers, and decisions. If the reply asks the user something, end with that question; otherwise, if it offers to do something next ("say the word and I\'ll search your Downloads folder", a "Next" line), end with that offer.',
        input: [{ role: 'user', text: `${question?.trim() ? `Question: ${question.trim()}\n\nReply:\n` : ''}${text.slice(0, 12_000)}` }],
      });
      return spoken.trim() || text.slice(0, 1500);
    } catch {
      return text.slice(0, 1500);
    }
  };
}

/** What the screen picker sees when a conversation opens: its latest messages and the screens that could apply. */
export interface ScreenPickInput {
  place: string | null;
  agentName: string;
  now: number;
  messages: Array<{ author: 'owner' | 'agent' | 'other'; text: string; at: number }>;
  screens: Array<{ id: string; title: string; summary: string; updatedAt: number; fromThisConversation: boolean }>;
}

/** A screen id to show, or null for the conversation; `reason` for the trace. */
export type ScreenPicker = (input: ScreenPickInput) => Promise<{ pick: string | null; reason: string }>;

const SCREEN_PICK_INSTRUCTIONS = [
  'The owner is opening a conversation with one of their AI agents, usually to reply to it. Decide what their screen should show: one of the listed screens, or the conversation itself.',
  'Pick a screen only when it is what the conversation is about right now: what the latest messages discuss, ask about, or ask the owner to look at (a mockup under review, a comparison being decided, a chart the question is about).',
  'Relevance matters more than recency: an older screen still counts when the latest messages are about it, and a newer one doesn\'t when the talk has moved on.',
  'A screen from another conversation counts only when the latest messages are clearly about it.',
  'When the conversation has moved past every screen, or you are unsure, choose the conversation.',
  'Answer with JSON: {"pick": "<screen id>" or "conversation", "reason": "<one short sentence>"}.',
].join('\n');

function ago(now: number, at: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

export function buildScreenPickPrompt(input: ScreenPickInput): string {
  const messages = input.messages
    .slice(-6)
    .map((message) => `${message.author === 'owner' ? 'Owner' : message.author === 'agent' ? input.agentName : 'Someone'} (${ago(input.now, message.at)}): ${message.text.replace(/\s+/g, ' ').slice(0, 700)}`)
    .join('\n');
  const screens = input.screens
    .map((screen) => `- id ${screen.id}: "${screen.title}"${screen.summary && screen.summary !== screen.title ? ` (${screen.summary.slice(0, 160)})` : ''}, staged ${ago(input.now, screen.updatedAt)}, ${screen.fromThisConversation ? 'from this conversation' : 'from another conversation'}`)
    .join('\n');
  return `Conversation with ${input.agentName}${input.place ? ` in "${input.place}"` : ''}.\n\nLatest messages, oldest first:\n${messages || '(none)'}\n\nScreens:\n${screens}`;
}

export function createScreenPicker(call: ResponsesCaller): ScreenPicker {
  return async (input) => {
    const raw = await call({
      instructions: SCREEN_PICK_INSTRUCTIONS,
      input: [{ role: 'user', text: buildScreenPickPrompt(input) }],
      schema: {
        name: 'screen_pick',
        schema: { type: 'object', additionalProperties: false, required: ['pick', 'reason'], properties: { pick: { type: 'string' }, reason: { type: 'string' } } },
      },
    });
    return parseScreenPick(raw, input);
  };
}

/** The model's answer, validated: only a listed screen id counts as a screen. */
export function parseScreenPick(raw: string, input: ScreenPickInput): { pick: string | null; reason: string } {
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { pick?: unknown; reason?: unknown };
  const pick = typeof parsed.pick === 'string' ? parsed.pick.trim() : '';
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : '';
  return { pick: input.screens.some((screen) => screen.id === pick) ? pick : null, reason };
}

/** Words that put a request in the agent's main channel, whatever the router picked. */
const MAIN_CHANNEL_CUE = /\b(?:(?:in|to) (?:our|the|your|my) (?:main )?(?:chat|channel|dm)|main channel|top[- ]level|not in (?:a|the|that) thread|outside (?:the|that|a) thread)\b/i;

/**
 * "Ask Sierra to print the VIN in our chat": a dispatch the router sent into an existing thread goes
 * to the main channel instead when the user's words say so. A thread they name in the same breath wins.
 */
export function keepMainChannel(speech: string, actions: OperatorAction[]): OperatorAction[] {
  if (!MAIN_CHANNEL_CUE.test(speech)) return actions;
  // "…not in that thread", "instead of the thread" say where it should NOT go; any other "thread" names one.
  const rest = speech.replace(MAIN_CHANNEL_CUE, '').replace(/\b(?:not|instead of|rather than|outside|out of) (?:in |into )?(?:a|the|that|this|any) (?:\w+ )?thread\b/gi, '');
  if (/\bthread\b/i.test(rest)) return actions;
  // Several requests in one breath: the cue can't be tied to one of them, so the router's choice stands.
  if (actions.filter((action) => action.type === 'dispatch').length !== 1) return actions;
  return actions.map((action) => {
    if (action.type !== 'dispatch' || (!action.threadId && !action.newThreadTitle && !action.threadOptions)) return action;
    const { threadId: _thread, newThreadTitle: _title, threadOptions: _options, ...rest } = action;
    return rest;
  });
}

/** A Loom coding thread's desk id. */
export const isCodingItemId = (id: string | null | undefined): boolean => !!id && /^loom:/.test(id);

/** "Loom" or "coding thread": the user means a coding thread, whichever runs it. */
const CODING_CUE = /\b(?:loom|coding thread)\b/i;
const CODING_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', 'on', 'with', 'thread', 'loom']);

function titleWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !CODING_STOP.has(word));
}

/**
 * "Ask the Loom testing bounties thread why…": the user said Loom and named a Loom thread on the desk, so
 * the request goes to that thread, whatever agent the router picked. The first dispatch to an agent
 * the user did not name becomes a desk reply on the matching item. The match is on the item's title
 * (its place after "·", without a "bug:"-style prefix): the best one wins when it shares at least two
 * words with what was said, and a tie is no match.
 */
/** "Don't tell Captain Nautilus", "not the Captain Nautilus thread": the user ruled that thread out by name. */
function negatedTitle(speech: string, place: string): boolean {
  const title = (place.includes(' · ') ? place.slice(place.indexOf(' · ') + 3) : place).replace(/^[a-z]{2,10}:\s*/i, '');
  const first = titleWords(title)[0];
  if (!first) return false;
  // The negation has to govern the name: "don't tell / not / never ask (the) <title>", not "I'm not sure, tell <title>".
  return new RegExp(`\\b(?:don'?t|do not|not|never)\\s+(?:(?:tell|ask|send (?:it|this|that) to|message|ping|bother|include|update|let|have|remind)\\s+)?(?:the\\s+)?${first.replace(/[^a-z0-9]/g, '')}\\b`, 'i').test(speech.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' '));
}

/** A "don't / isn't / cannot / not / never / no / anything but / except" anywhere in a sentence that names `word`, before or after it. */
function negatedNear(speech: string, word: string): boolean {
  return speech
    .toLowerCase()
    .split(/[.!?;]+/)
    .some((sentence) => {
      const clean = sentence.replace(/[^a-z0-9' ]+/g, ' ');
      return new RegExp(`\\b${word}\\b`).test(clean) && /\b(?:\w+n't|(?:do|does|did|is|are|was|were|ca|wo|should|would|could|have|has|had)nt|cannot|not|never|no|except|(?:anything|everything|anyone|anybody) but|other than|instead of)\b/.test(clean);
    });
}

/**
 * Speech that addresses a one-word title, not just mentions it. Either it opens a sentence as a vocative
 * ("Please wait. Lighthouse, post it", not the appositive "Lighthouse, the monitor, is up"), or a clause opens with an addressing verb aimed at it ("tell Lighthouse …",
 * "can you ask the Loom Lighthouse thread …"). Clause-opening keeps nouns out ("the latest ask Lighthouse made", "the message
 * it sent") and the verbs are ones rarely anything else: not "have" ("Have notifications stopped?"). A possessive isn't an address, nor
 * "tell X from Y"; "let" only as "let X know". Text after a colon may be reported, so it stays in its clause.
 */
function addressesOneWord(speech: string, word: string): boolean {
  const markers = 'okay|ok|please|yankee|hey|alright|so|now';
  const lead = `^(?:(?:${markers}|can you|could you|would you|will you|go)\\s+)*`;
  const direct = new RegExp(`${lead}(?:(?:tell|ask|remind|ping|message|send (?:it|this|that) to)\\s+${word}\\b(?!'s|\\s+from\\b)|let\\s+${word}\\s+know\\b)`);
  const thread = new RegExp(
    `${lead}(?:(?:tell|ask|remind|message|ping|update|send (?:it|this|that) to)\\s+(?:the\\s+)?(?:(?:loom)\\s+)?${word}\\s+(?:(?:loom|coding)\\s+)?thread\\b|let\\s+(?:the\\s+)?(?:(?:loom)\\s+)?${word}\\s+(?:(?:loom|coding)\\s+)?thread\\s+know\\b)`,
  );
  return speech
    .toLowerCase()
    .split(/[.!?;]+/)
    // Not the owner's own command: reported text before the name ("the note says: wait, then tell Lighthouse …").
    .filter((sentence) => {
      // The last mention covers them all ("Lighthouse is up, but should I … tell Lighthouse?").
      let at = -1;
      for (const match of sentence.matchAll(new RegExp(`\\b${word}\\b`, 'g'))) at = match.index ?? at;
      const before = at >= 0 ? sentence.slice(0, at) : sentence;
      return (
        !/\b(?:says|said|reads|wrote|writes|quote|quoted|quoting)\b/.test(before) &&
        // The owner as subject is a plan or a question ("I will wait and then tell …", "should I … tell …").
        !/\b(?:i|we|i'll|we'll|i'm|we're|i'd|we'd|i've|we've|let's)\b/.test(before)
      );
    })
    .some(
      (sentence) =>
        new RegExp(`^\\s*(?:(?:${markers})\\s*,?\\s*)*${word}\\s*[,:](?!\\s*(?:the|a|an|our|my|its|your|this|that)\\b)`).test(sentence) ||
        sentence
          // Commas only: "and" / "then" carry the subject over ("Sierra will wait and then tell …").
          .split(',')
          .map((clause) => clause.replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim())
          .some((clause) => direct.test(clause) || thread.test(clause)),
    );
}

/** The longest run of `title` words said consecutively, in order. */
function longestRun(title: string[], said: string[]): number {
  let best = 0;
  for (let i = 0; i < said.length; i++) {
    for (let j = 0; j < title.length; j++) {
      let k = 0;
      while (i + k < said.length && j + k < title.length && said[i + k] === title[j + k]) k++;
      best = Math.max(best, k);
    }
  }
  return best;
}

export function preferNamedLoom(
  speech: string,
  actions: OperatorAction[],
  items: Array<{ handle: string; id: string | undefined; place: string | null }>,
  agents: Array<{ id: string; names: string[] }>,
): OperatorAction[] {
  // Without "Loom" said, only a thread named outright counts (most of its title, at least two words):
  // a role-sounding thread title was once read as the chief of staff.
  const cued = CODING_CUE.test(speech);
  // Several requests in one breath: the Loom name can't be tied to one of them, so the router's choice stands.
  if (actions.filter((action) => action.type === 'dispatch').length !== 1) return actions;
  // "Don't send this to Loom", "not Loom": the user ruled Loom out.
  if (/\b(?:don'?t|do not|not|never)\b(?:\s+\w+){0,4}?\s+(?:to\s+|in\s+)?(?:the\s+)?(?:loom|coding thread)\b/i.test(speech)) return actions;
  const said = new Set(titleWords(speech));
  const saidInOrder = titleWords(speech);
  const scored = items
    .filter((item) => isCodingItemId(item.id) && item.place)
    .map((item) => {
      const place = item.place!;
      const title = (place.includes(' · ') ? place.slice(place.indexOf(' · ') + 3) : place).replace(/^[a-z]{2,10}:\s*/i, '');
      const words = [...new Set(titleWords(title))];
      const hits = words.filter((word) => said.has(word)).length;
      // Uncued, the title must be said as a phrase (its words together, in order), not just its words scattered
      // ("budget more memory" never names "Memory Budget"; Codex review on #444).
      const run = cued ? hits : longestRun(titleWords(title), saidInOrder);
      // A one-word title ("Compass") is a name too when it is distinctive (6+ letters) and said the way a name is:
      // right after "tell / ask / ping / message / let / have / remind", or opening the sentence ("Compass, …").
      const single =
        words.length === 1 &&
        words[0]!.length >= 6 &&
        hits === 1 &&
        addressesOneWord(speech, words[0]!) &&
        // Conservative: any negation in a sentence that names it ("don't have someone update …", "the … thread is not
        // the right place") leaves it to the router.
        !negatedNear(speech, words[0]!);
      return { item, hits, enough: (hits >= 2 || single) && (cued || ((run >= 2 || single) && run / Math.max(1, words.length) >= 0.6)) };
    })
    .filter((entry) => entry.enough && (cued || !negatedTitle(speech, entry.item.place!)))
    .sort((a, b) => b.hits - a.hits);
  if (scored.length === 0 || (scored.length > 1 && scored[0]!.hits === scored[1]!.hits)) return actions;
  const target = scored[0]!.item;
  // Already going to that coding item (or any coding item, Loom): nothing to correct.
  const loomHandles = new Set(items.filter((item) => isCodingItemId(item.id)).map((item) => item.handle));
  if (actions.some((action) => action.type === 'desk' && action.item && loomHandles.has(action.item))) return actions;
  const escape = (text: string) => text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // An agent named anywhere counts as addressed ("can Sierra review the Loom … thread?"), except a
  // stray name glued on the front by the transcript ("Sierra. Uh, can you ask the Loom … thread").
  const addressed = (agentId: string) =>
    (agents.find((agent) => agent.id === agentId)?.names ?? [agentId]).some((name) => {
      // Stray only when filler follows ("Sierra uh, can you…"); "Sierra, please review…" addresses her.
      const lower = speech.toLowerCase().replace(new RegExp(`^\\W*${escape(name)}\\W+(?:uh|um|so|oh|ok|okay|hmm)\\b`), '');
      return new RegExp(`\\b${escape(name)}\\b`).test(lower);
    });
  const index = actions.findIndex((action) => action.type === 'dispatch' && !addressed(action.agentId));
  if (index < 0) return actions;
  const dispatch = actions[index] as Extract<OperatorAction, { type: 'dispatch' }>;
  const reply: OperatorAction = { type: 'desk', op: 'reply', item: target.handle, message: dispatch.message };
  return actions.map((action, at) => (at === index ? reply : action));
}
