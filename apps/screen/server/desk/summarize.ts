import { getDecisionShadow, type DecisionPrompt, type DecisionShadow } from '@tango/core';
import { acknowledgment } from '../inbox.js';
import { asksOwner, textSummary } from '../inbox-summarize.js';
import type { Author, DeskQuestion, DeskSummary } from './types.js';

// The summarizer contract (spec "Summarizer contract"): one call per changed
// item, Ollama's OpenAI-compatible API, JSON out, with a deterministic
// fallback so a dead model never blocks the desk. The model interprets; code
// validates. Options survive only if the agent actually spelled them out.

export interface DeskSummaryInput {
  /** The desk item, for the shadow log's pointer to what happened next. */
  itemId?: string;
  agentName: string;
  place: string | null;
  /** Oldest first; up to 20 are sent (the last 6 in full). */
  messages: Array<{ author: Author; text: string }>;
  /** The item's last summary: carries a decision raised before those messages forward. */
  /** The previous summary; `heard` is what the owner last heard (the last feed post's words), null when nothing has posted yet, absent when unknown. */
  previous?: { step: DeskSummary['step']; gist: string; ask: string | null; goal?: string | null; milestone?: string | null; questions?: DeskQuestion[]; ownerReplied?: boolean; heard?: string | null } | null;
  /** The agent's latest internal work notes (oldest first): progress its replies may not say yet. */
  workNotes?: Array<{ at: number; text: string }>;
  /**
   * A lead's workers' feed posts since the lead last posted (newest first): news the owner already heard from the
   * workers themselves, so the lead retelling it isn't news.
   */
  workersPosted?: Array<{ title: string; text: string }>;
  /** From the owner's rules file: "report" = a recurring report they skim, their move only on an explicit ask. */
  kind?: 'report' | null;
}

export type DeskSummaryOutput = Omit<DeskSummary, 'contentKey' | 'at'>;
export type DeskSummarizer = (input: DeskSummaryInput) => Promise<DeskSummaryOutput>;

/** "thanks!", "you're welcome", "👍": an acknowledgment that never reopens a finished item. */
export function isAckOnly(text: string): boolean {
  const clean = text.trim();
  if (!clean) return true;
  if (acknowledgment(clean) === 'done') return true;
  // The agent's side of the pleasantries.
  return clean.length <= 80 && !clean.includes('?') && /^(you'?re (very )?welcome|anytime|any time|my pleasure|no problem|np|glad (to|i could) help|happy to help|sure thing|of course)\b[\s!.,🙂😊👍]*/i.test(clean) && clean.split(/\s+/).length <= 8;
}

function lastAgentText(input: DeskSummaryInput): string {
  return [...input.messages].reverse().find((message) => message.author === 'agent')?.text ?? '';
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[*_`"'“”‘’]/g, '').replace(/\s+/g, ' ').trim();
}

/** Keeps only options whose words appear in the agent's last message: the model never invents choices. */
export function validOptions(options: unknown, lastAgent: string): string[] {
  if (!Array.isArray(options)) return [];
  const haystack = normalize(lastAgent);
  const kept: string[] = [];
  for (const option of options) {
    if (typeof option !== 'string') continue;
    const clean = option.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 120 || !haystack.includes(normalize(clean))) continue;
    if (!kept.some((existing) => normalize(existing) === normalize(clean))) kept.push(clean);
    if (kept.length >= 6) break;
  }
  return kept.length >= 2 ? kept : [];
}

/** A closing "Next — …" hand-off line, anywhere in a message (next-step.ts reads the same line). */
const HANDOFF_LINE = /^[ \t]*\*{0,2}[ \t]*Next[ \t]*[—–-]+[ \t]*(?:you|me|none|waiting on)\b/gim;

/**
 * A message cut to `max` characters for the transcript, keeping its end: agents close with the
 * "Next — you" line that says what the owner is asked, and a head-only cut dropped it from long
 * messages (live 10/18: cards listed a question from the body, not the ask). Keeps the head, then
 * the closing hand-off with the stretch before it, where a "the four decisions above" points
 * (Codex review on #729); with no hand-off, the last stretch.
 */
export function clipMessage(text: string, max: number): string {
  if (text.length <= max) return text;
  const handoff = [...text.matchAll(HANDOFF_LINE)].at(-1)?.index;
  const tailLength = Math.floor(max * (handoff !== undefined ? 0.7 : 0.4));
  const tailEnd = handoff !== undefined ? Math.min(text.length, handoff + Math.floor(max * 0.3)) : text.length;
  const tailStart = tailEnd - tailLength;
  // A hand-off early in the message: the head already reaches it.
  if (tailStart < max - tailLength) return text.slice(0, max);
  return `${text.slice(0, max - tailLength).trimEnd()}\n[…]\n${text.slice(tailStart, tailEnd).trim()}`;
}

/** The last question in a message, if it ends by asking one. */
function lastQuestion(text: string): string | null {
  if (!asksOwner(text)) return null;
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?]*\?/g);
  const question = sentences?.at(-1)?.trim();
  return question ? textSummary(question, 200) : null;
}

/** At most 8 words, no trailing punctuation except a question mark. */
export function shortTitle(text: string, maxWords = 8): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const title = words.slice(0, maxWords).join(' ').replace(/[.,;:!—-]+$/, '');
  return words.length > maxWords ? title.replace(/\?$/, '') : title;
}

export function fallbackSummary(input: DeskSummaryInput): DeskSummaryOutput {
  const agent = lastAgentText(input);
  const owner = [...input.messages].reverse().find((message) => message.author === 'owner')?.text ?? null;
  const asks = asksOwner(agent);
  const question = asks ? lastQuestion(agent) : null;
  // A dead model mustn't drop an open decision: it stays open unless the owner has written since.
  // A report thread carries only an explicit ask.
  const carried = !asks && input.previous?.step === 'your_move' && !input.previous.ownerReplied && (input.kind !== 'report' || !!input.previous.ask) && !input.messages.some((message) => message.author === 'owner');
  return {
    title: shortTitle(question ?? input.place ?? (owner ? textSummary(owner, 80) : textSummary(agent, 80))) || input.agentName,
    gist: textSummary(agent || input.messages.at(-1)?.text || '', 240) || '(no text)',
    paragraph: null,
    whatsNew: null,
    step: asks || carried ? 'your_move' : 'fyi',
    ask: carried ? input.previous!.ask : question,
    askKind: null,
    askDueAt: null,
    options: [],
    context: [],
    ownerAsk: owner ? textSummary(owner, 160) : null,
    watchUntil: null,
    ackOnly: agent ? isAckOnly(agent) : false,
    waitingOn: null,
    about: null,
    // A dead model keeps the conversation's goal and milestone; it only knows the one question it can see.
    goal: input.previous?.goal ?? null,
    milestone: input.previous?.milestone ?? null,
    questions: question ? [{ q: question, lean: null }] : carried ? (input.previous!.questions ?? []) : [],
    source: 'text',
  };
}

const PROMPT = [
  'You summarize one conversation between the owner and one of their AI agents for a desk board.',
  'Reply with JSON only, exactly these keys:',
  '{"title": string, "headline": string, "whatsNew": string|null, "routine": boolean, "about": string, "next": string|null, "gist": string, "paragraph": string, "step": "your_move"|"watching"|"fyi", "ask": string|null, "askKind": "decision"|"todo"|"soft"|null, "askDueAt": string|null, "options": string[], "context": string[], "ownerAsk": string|null, "watchUntil": string|null, "ackOnly": boolean, "waitingOn": {"who": string, "what": string, "kind": "person"|"agent"}|null, "goal": string|null, "milestone": string|null, "questions": [{"q": string, "lean": string|null}]}',
  'Write for a glance: the owner reads this card from across the room, in a second or two, often days after they last looked at this conversation and without remembering what it was about.',
  '- Plain words a smart non-engineer would say out loud. No ticket, PR, issue or version numbers; no file, function, branch, repo or model names; no internal code names or acronyms; no counts that don\'t change what the owner does. Those belong in context, if anywhere.',
  '- Say what a status means for the owner: "the fix is live", not "PR merged and deployed"; "nothing needs you", not "job healthy, reconciled into status"; "ready for you to read", not "published a 40-item research page".',
  '- Coding threads (the agent is "Loom", a coding assistant working in a repo): describe the product or the outcome the work is for, never the code.',
  'title: at most 6 words. When it is the owner\'s move, the move itself, starting with a verb ("Pick a paint color for the porch"); otherwise the outcome ("Checkout redesign wrapped up").',
  'headline: at most 8 words, a news headline for a feed of updates: what just happened or where the work stands now ("Screen prototype implementation underway", "Keyboard shortcuts and search working", "Ferry booked for Saturday"). Never an instruction or a question, even when it is the owner\'s move: the ask goes in next and ask. Do not repeat the conversation\'s name.',
  'whatsNew: what happened in the latest messages that the owner has not heard yet, in at most 12 plain words ("the fix is merged", "review found two problems", "ready for you to test"). Judge it against what the owner last heard: the "Owner last heard" line when given, else Earlier state. null when the latest messages only say where things stand again in other words, acknowledge or thank, pass on another conversation\'s news (anything in "Already posted by its workers" reached the owner from those workers: retelling it is not news, while this conversation\'s own decisions, new asks of the owner and results none of those posts mention are), or talk with another agent without moving this work on (a reply to another agent\'s mail that reports no progress of its own is not news; neither is a check that found nothing changed, or a run that has only started or is still going). With no Earlier state, or when the owner has heard nothing yet, what the conversation has done.',
  'routine: true when the latest messages are only a recurring or monitoring run (a scheduled check, sweep, scan, watch, wake-up or receipt) that: has started or is still running; finished clean, or with the same findings, gaps or holds the owner last heard; or was a late, stale or duplicate wake that found the work already done. A run is never news by itself having happened. false when the run found something the owner has not heard (a new problem, a new complaint, a new conflict, a change in what is waiting), failed, or needs the owner; false for any conversation that is not a recurring run.',
  'next: when step is your_move, what the owner does next, in 3 to 9 plain words starting with a verb, taken from the agent\'s own ask or "Next — you" line ("Approve this week\'s tester payouts", "Pick pixel art or low-poly", "Review and run the database script"). One action; when there are several, the first or most important. No links, paths, ids, file names or quotes. null when it is not the owner\'s move.',
  'about: at most 6 plain words naming what this conversation is for, so the owner recognizes it cold ("Spring garden planting plan", "Faster checkout for the web store"). Not the status.',
  'gist: ONE short sentence, under 110 characters: the single thing that matters NOW. The latest agent message matters most. Everything else goes in context; never restate the ask.',
  'paragraph: 2 or 3 plain sentences, under 330 characters, that the owner reads under the conversation\'s name in a list instead of a headline: what happened most recently, then, when it is the owner\'s move, exactly what they need to do or decide. Lead with what matters now. Say each point once (never restate a sentence in other words), no greeting, and do not repeat the conversation\'s name.',
  'step: is anything waiting on the owner right now? your_move when something is, even if the latest message asks no question:',
  '- a decision or choice the owner has not made yet, even one raised earlier and still open (e.g. the last message answers a side question but the main pick is still undecided);',
  '- something the agent says is the owner\'s to do (a sign-up to set up, a test to run, a reading to send back, something to approve, merge or buy);',
  '- work the owner asked for or is shaping, delivered for them to read or judge and not yet discussed by them: research, a page, doc, screen, PR, draft, design or plan (reviewing it is the owner\'s move, even when the agent was asked to wrap up or summarize it).',
  'fyi when nothing is expected of the owner: an errand reported done (uploaded, sent, fixed, configured, restarted), the work closed, the owner already acknowledged or settled it, or the agent says nothing needs the owner. A status report, briefing, digest, recap or check-in that says no decision or action is needed is fyi, even though it is new and readable: an update is not a deliverable. Optional extras offered "if you want" do not make it your_move.',
  'watching if nobody is active but the agent said an update is coming.',
  'Agents usually close with a hand-off line naming whose move it is: "Next — you: …", "Next — me: …", "Next — waiting on <who>: …" or "Next — none: done." The one ending the latest agent message is the agent\'s own word and outranks anything earlier in the conversation: "Next — you" is your_move, with that line as the ask (never "nothing needs you"); "Next — waiting on" a named party is waitingOn; "Next — me" with a later trigger is watching; "Next — none" is fyi.',
  'A your_move card always names what the owner does: if you cannot write a concrete ask or a review to do, it is not your_move. Only when the messages genuinely leave it unclear whether the owner must act, choose your_move.',
  'ask: the concrete question waiting on the owner: what the closing "Next — you" line of the latest agent message asks, else the one the last agent message asks, else an earlier one still open (from the transcript or Earlier state); else null.',
  'askKind: when step is your_move, what kind of ask it is. "decision": only the owner can give it and the agent cannot go on without it (a choice, an approval, a review or judgment, a sign-in, a yes or no, a question only they know the answer to). "todo": the agent is handing the owner an action in the world it cannot do itself (buy, order, call, install, test by hand, pay, pick something up) and its own part is done: nothing it does next waits on it. An action the agent\'s next step waits on (a setup step, a sign-in, a permission, an app setting, a restart, a test it will act on) is "decision", even when it is phrased as "do X". "soft": optional ("if you want"). null when it is not the owner\'s move.',
  'askDueAt: ISO 8601 time with the offset when the ask names a deadline ("before Oct 15", "by Friday", "expires tonight"; a day alone means 6 PM that day in the owner\'s local time given as Now); else null.',
  'options: ONLY options the agent spelled out ("A or B?", a numbered list), copied word for word; otherwise []. Never invent options.',
  'context: at most 4 short bullets the owner needs to answer. ownerAsk: what the owner asked for, else null.',
  'waitingOn: only when the latest agent message says the work is waiting on a named person other than the owner ("sent to Ana for review", "waiting on Bob\'s answer"): who = the name, what = what they owe; kind = "agent" when who is another AI agent, bot, automation or agent thread rather than a human (a "Desk", "Chief", "Codex", a monitor, "the Release Notes desk"), else "person". Then step is watching. Otherwise null.',
  'goal: one plain sentence (under 160 characters) on the long-running purpose of this whole conversation: what the owner and agent are ultimately trying to accomplish across many turns ("Find the cross-promotion ideas worth building to move players from one app to the other"). Not today\'s step. If Earlier state gives a goal, repeat it word for word unless the work has clearly changed direction. null only when the conversation is a one-off errand.',
  'milestone: one short phrase (under 100 characters) naming the near-term checkpoint being worked toward right now, e.g. "Get the fix through CI and review", "Pick a direction from round 3 of the prototypes", "Settle two questions, then file the idea". null when there is none.',
  'questions: the open questions or decisions waiting on the owner, in order. When the latest agent message closes with "Next — you", they are exactly what that line asks, one entry per separate ask in its order (when it points elsewhere, like "answer the four decisions in the proposal", the ones it points to), and nothing else: not other questions from the body of that message (a recap of other threads\' open items is not this thread\'s ask), and not Open questions from Earlier state. Otherwise: EVERY open question the latest agent messages ask, plus any listed as Open questions in Earlier state (the owner has not replied since those were asked) unless the newer messages settle them. q = the question in plain words (under 140 characters); lean = the agent\'s own recommendation for it in one short sentence, or null if it gave none. [] when it asks nothing. Never invent questions.',
  'Work notes, when given, are the agent\'s own internal progress notes (its working thoughts, not messages to the owner). When a note is newer than the agent\'s replies and shows the work has moved on (a blocker cleared, a new step under way, a plan dropped), describe where things stand now from it in title, gist and context. Ignore notes the replies have since overtaken. Never make an ask, a question, options or your_move from a note: only the agent\'s replies can ask the owner something.',
  'Earlier state, when given, is your previous summary of this conversation: an open decision or review in it is still the owner\'s move unless the newer messages settle it.',
  'watchUntil: ISO 8601 time with the offset if the agent said when it would check back or when its next update lands (read times like "at 6" in the owner\'s local time given as Now; a day alone, like "on October 14" or "tomorrow", means 6 PM that day); else null. ackOnly: true if the last agent message is only an acknowledgment ("you\'re welcome", "anytime").',
].join('\n');

/** "Tuesday, October 6, 2026, 2:05 PM PDT (America/Los_Angeles)": local time for the model to read "at 6" against. */
export function localNow(ms: number, timeZone: string): string {
  try {
    const text = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms));
    return `${text} (${timeZone}); ISO ${new Date(ms).toISOString()}`;
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Keep whole sentences up to `max` characters; a model that ignores the length rule still yields a card-sized gist. */
export function clipSentences(text: string, max: number): string {
  if (text.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = '';
  for (const sentence of sentences) {
    if ((out + sentence).trim().length > max) break;
    out += sentence;
  }
  return out.trim() || `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The owner's rule for this conversation, as a line ahead of the transcript. */
export const REPORT_HINT =
  'The owner marked this conversation as a recurring report they skim. It is your_move ONLY when the agent explicitly asks the owner for a decision or an action, or flags something urgent only the owner can do; a new briefing or update alone is fyi.';

function kindLine(input: DeskSummaryInput): string {
  return input.kind === 'report' ? `${REPORT_HINT}\n` : '';
}

/** The agent's latest work notes after the transcript, with how long ago each was written. */
export function notesBlock(input: DeskSummaryInput, now: () => number = Date.now): string {
  const notes = input.workNotes ?? [];
  if (!notes.length) return '';
  const ago = (at: number) => `${Math.max(0, Math.round((now() - at) / 60_000))} min ago`;
  return `\n\nWork notes (${input.agentName}'s internal progress notes, oldest first; not messages to the owner):\n${notes.map((note) => `- (${ago(note.at)}) ${note.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}`;
}

/** A lead's workers' posts since the lead last posted: what the owner already heard from them. */
export function workersBlock(input: DeskSummaryInput): string {
  const posts = input.workersPosted ?? [];
  if (!posts.length) return '';
  return `Already posted by its workers (the conversations ${input.agentName} manages; the owner read these from them directly, newest first):\n${posts.map((post) => `- ${post.title}: ${post.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}\n`;
}

/** The previous summary as one line ahead of the transcript, so a decision older than the last six messages isn't lost. */
function earlier(input: DeskSummaryInput): string {
  const previous = input.previous;
  if (!previous) return '';
  // What the owner last heard, when it isn't the earlier state itself: the last post's words, or nothing yet.
  const heard = previous.heard === null ? 'Owner last heard: nothing about this conversation yet.\n' : previous.heard && previous.heard !== previous.gist ? `Owner last heard (the last update posted to them): ${previous.heard}\n` : '';
  if (previous.ownerReplied) return `Earlier state (before the latest messages; the owner has replied since, so nothing from it is still waiting on them): ${previous.gist}${previous.goal ? ` Goal: ${previous.goal}` : ''}${previous.milestone ? ` Milestone: ${previous.milestone}` : ''}\n${heard}`;
  return `Earlier state (before the latest messages): ${previous.step}. ${previous.gist}${previous.ask ? ` Ask: ${previous.ask}` : ''}${previous.goal ? ` Goal: ${previous.goal}` : ''}${previous.milestone ? ` Milestone: ${previous.milestone}` : ''}${previous.questions?.length ? ` Open questions: ${previous.questions.map((q) => q.q).join(' | ')}` : ''}\n${heard}`;
}

export function createDeskSummarizer(options: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number; now?: () => number; timeZone?: string }): DeskSummarizer {
  const url = `${(options.baseUrl ?? 'https://ollama.com/v1').replace(/\/$/, '')}/chat/completions`;
  return async (input) => {
    if (!options.apiKey) return fallbackSummary(input);
    const sent = input.messages.slice(-20);
    const transcript = sent
      .map((message, index) => `${message.author === 'agent' ? input.agentName : message.author === 'owner' ? 'Owner' : 'Someone'}: ${clipMessage(message.text, index === sent.length - 1 ? 3000 : index >= sent.length - 6 ? 1500 : 500)}`)
      .join('\n\n');
    const where = input.place ? ` in "${input.place}"` : '';
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages: [
            { role: 'system', content: PROMPT },
            { role: 'user', content: `Now: ${localNow((options.now ?? Date.now)(), options.timeZone ?? 'America/Los_Angeles')}\n${kindLine(input)}${earlier(input)}${workersBlock(input)}Conversation with ${input.agentName}${where}:\n\n${transcript}${notesBlock(input, options.now ?? Date.now)}` },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = body.choices?.[0]?.message?.content ?? '';
      return parseModelSummary(raw, input);
    } catch {
      return fallbackSummary(input);
    }
  };
}

/**
 * The owner's next action as the row shows it: a few words starting with a verb. Anything that reads
 * like a link, path or id, or is too short or long to be a plain action, is dropped (null), never fixed up.
 */
export function cleanNext(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '');
  const words = text.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 12 || text.length > 90) return null;
  if (/https?:|www\.|[\\/]|#\d|`|\b[0-9a-f]{7,}\b|\.(sql|ts|js|md|json|ya?ml|py)\b/i.test(text)) return null;
  if (!/^[A-Z]/.test(text) && !/^[a-z]/.test(text)) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Validates a model reply against the contract; anything off falls back field by field. Exposed for tests. */
export function parseModelSummary(raw: string, input: DeskSummaryInput): DeskSummaryOutput {
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
  const gist = typeof parsed.gist === 'string' ? parsed.gist.replace(/\s+/g, ' ').trim() : '';
  if (!gist) throw new Error('empty gist');
  const agent = lastAgentText(input);
  const rawWaiting = parsed.waitingOn as Record<string, unknown> | null | undefined;
  const who = rawWaiting && typeof rawWaiting.who === 'string' ? rawWaiting.who.trim().slice(0, 80) : '';
  const what = rawWaiting && typeof rawWaiting.what === 'string' ? rawWaiting.what.trim().slice(0, 160) : '';
  // A wait naming the owner is their move, even if the model called it FYI.
  const kind = rawWaiting?.kind === 'agent' ? ('agent' as const) : undefined;
  const ownerWait = /^(you|the owner|owner|user)$/i.test(who) || (!!who && who.toLowerCase() === process.env.TANGO_OWNER_NAME?.trim().toLowerCase());
  const waitingOn = who && !ownerWait && !/^me$/i.test(who) ? { who, what: what || 'a reply', ...(kind ? { kind } : {}) } : null;
  // Waiting on a person is a flavor of watching.
  const modelStep = ownerWait ? 'your_move' : waitingOn ? 'watching' : parsed.step === 'your_move' || parsed.step === 'watching' ? parsed.step : 'fyi';
  // A report thread is the owner's move only on an explicit ask: a your_move with nothing to ask is an update.
  const step = !ownerWait && modelStep === 'your_move' && input.kind === 'report' && !(typeof parsed.ask === 'string' && parsed.ask.trim()) ? 'fyi' : modelStep;
  const watchUntil = typeof parsed.watchUntil === 'string' && Number.isFinite(Date.parse(parsed.watchUntil)) ? parsed.watchUntil : null;
  const str = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const rawTitle = typeof parsed.title === 'string' ? shortTitle(parsed.title) : '';
  const about = typeof parsed.about === 'string' ? shortTitle(parsed.about.replace(/\s+/g, ' ').trim(), 8) : '';
  return {
    title: rawTitle || fallbackSummary(input).title,
    about: about || null,
    headline: typeof parsed.headline === 'string' && parsed.headline.trim() ? shortTitle(parsed.headline.replace(/\s+/g, ' ').trim(), 10) : null,
    whatsNew: str(parsed.whatsNew, 120),
    routine: parsed.routine === true,
    next: step === 'your_move' ? cleanNext(parsed.next) : null,
    gist: clipSentences(gist, 180),
    paragraph: typeof parsed.paragraph === 'string' && parsed.paragraph.trim() ? clipSentences(parsed.paragraph.replace(/\s+/g, ' ').trim(), 420) : null,
    step,
    ask: step === 'your_move' ? str(parsed.ask, 300) || (ownerWait ? what || 'a reply' : null) : null,
    askKind: step === 'your_move' && (parsed.askKind === 'decision' || parsed.askKind === 'todo' || parsed.askKind === 'soft') ? parsed.askKind : null,
    askDueAt: step === 'your_move' && typeof parsed.askDueAt === 'string' && Number.isFinite(Date.parse(parsed.askDueAt)) ? parsed.askDueAt : null,
    // Any agent message in the window: a carried earlier choice keeps its options.
    options: step === 'your_move' ? validOptions(parsed.options, input.messages.filter((message) => message.author === 'agent').map((message) => message.text).join('\n')) : [],
    context: Array.isArray(parsed.context) ? parsed.context.filter((line): line is string => typeof line === 'string' && line.trim() !== '').slice(0, 4).map((line) => line.trim().slice(0, 200)) : [],
    ownerAsk: str(parsed.ownerAsk, 300),
    watchUntil,
    // The deterministic check first; the model's flag only adds to it.
    ackOnly: (agent ? isAckOnly(agent) : false) || parsed.ackOnly === true,
    waitingOn,
    goal: str(parsed.goal, 240) ?? input.previous?.goal ?? null,
    milestone: str(parsed.milestone, 160),
    questions: validQuestions(parsed.questions),
    source: 'model',
  };
}

/** The open questions as the model listed them: well-formed, bounded, at most 5. */
export function validQuestions(raw: unknown): DeskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: DeskQuestion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const q = typeof record.q === 'string' ? record.q.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
    if (!q) continue;
    const lean = typeof record.lean === 'string' && record.lean.trim() ? record.lean.replace(/\s+/g, ' ').trim().slice(0, 300) : null;
    out.push({ q, lean });
    if (out.length >= 5) break;
  }
  return out;
}

// ── shadow decision model ─────────────────────────────────────────────────
//
// Jev answers the step (and ack-only) beside the summarizer and logs both; the card always shows
// the summarizer's answer. Titles and gists stay with the LLM: a decision model writes no text.

/** The desk step as typed questions over the latest messages. Exposed for tests. */
export function deskStepDecisionPrompt(input: DeskSummaryInput): DecisionPrompt {
  const recent = input.messages.slice(-6).map((message) => ({
    from: message.author === 'agent' ? input.agentName : message.author === 'owner' ? 'Owner' : 'Someone',
    text: message.text.slice(0, 800),
  }));
  return {
    state: {
      conversation: `The owner and their AI agent ${input.agentName}${input.place ? ` in "${input.place}"` : ''}`,
      ...(input.kind === 'report' ? { owner_rule: REPORT_HINT } : {}),
      ...(input.previous ? { earlier_state: `${input.previous.step}: ${input.previous.gist}${input.previous.ask ? ` Ask: ${input.previous.ask}` : ''}` } : {}),
      messages: recent,
    },
    questions: {
      step: {
        type: 'choice',
        instructions: 'Is anything in this conversation waiting on the owner right now? A status update that says nothing is needed is fyi; only when it is genuinely unclear whether the owner must act, it is your_move. An open decision or review in the earlier state stays the owner\'s move unless newer messages settle it.',
        criteria: {
          your_move: 'Something waits on the owner: a decision or choice still open, something the agent says is theirs to do (set up, test, approve, buy), or work they asked for or are shaping delivered for them to read or judge and not discussed yet (research, a page, draft, design, plan or PR)',
          watching: 'Nobody needs the owner yet: the agent said an update is coming, or the work waits on another named person',
          fyi: 'Nothing is expected of the owner: an errand reported done, the work closed, the owner already settled or acknowledged it, the agent says nothing needs them, or a status report, briefing or recap that asks nothing of them (optional extras offered "if you want" do not count)',
        },
      },
      ackOnly: {
        type: 'binary',
        instructions: 'Is the last agent message only an acknowledgment or pleasantry ("you\'re welcome", "anytime"), with no new content?',
      },
    },
  };
}

/** Wraps a summarizer: model answers are shadowed by the decision model; fallbacks are not compared. */
export function withDecisionShadow(summarize: DeskSummarizer, shadow: DecisionShadow = getDecisionShadow()): DeskSummarizer {
  return async (input) => {
    const output = await summarize(input);
    if (output.source === 'model') {
      shadow.run({
        site: 'desk.step',
        prompt: deskStepDecisionPrompt(input),
        incumbent: { step: output.step, ackOnly: output.ackOnly },
        agree: (decisions, incumbent) => decisions.step === incumbent.step,
        compared: ['step'],
        meta: { itemId: input.itemId ?? null, agent: input.agentName },
        excerpt: lastAgentText(input),
      });
    }
    return output;
  };
}
