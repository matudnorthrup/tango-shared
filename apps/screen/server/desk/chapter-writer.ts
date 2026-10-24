import { ownerTitle, readLayout, readTriage, type ChapterLayout } from './collapse.js';
import { asksOwner, type ChapterTriage } from './triage.js';
import type { ChapterWriteInput, ChapterWriter } from './updates.js';
import { fit, jargonWords, plainWords } from '../../public/desk/plain-words.js';

// A space's chapter headline and status (docs/specs/catch-up.md "The chapter"): one cheap model call over its update
// lines, the pattern the coordinator's status write used. The same call groups the smaller Shipped lines by theme and
// writes every highlight's short title in the owner's language (collapse.ts reads both). Without a model (or when it fails) the lines themselves
// make a plain headline and status, so a chapter is never blank.

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** What the card holds the prose to (updates.ts ownerHeadline, ownerStatus): the writer is asked again once when it runs over. */
const HEADLINE_WORDS = 35;
const STATUS_WORDS = 40;
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
/** Over the card's limits: more than two sentences, or too many words. */
export function overLimit(text: string, max: number): boolean {
  return wordCount(text) > max || fit(text, 2, Number.MAX_SAFE_INTEGER) !== text.trim();
}
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

const DONE = /\b(ship(ped|s)?|staged|done|approved|merged|deployed|released|launched|landed|finished|complete(d)?|selected|chosen|chose|picked|confirmed|accepted|resolved|set up|is live|went live|now live|is in place)\b/i;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'its', 'are', 'was', 'now', 'one', 'two', 'should', 'stage', 'make', 'ship', 'approve', 'merge', 'what', 'which', 'when', 'than', 'then', 'have', 'has']);
/** A word without its ending, so "deploy" and "deployed", "ship" and "shipped" match. */
const IRREGULAR: Record<string, string> = { chosen: 'choose', chose: 'choose' };
const stem = (w: string) => (IRREGULAR[w] ?? w).replace(/(?:ing|ed|es|e|s|d)$/, '').replace(/([b-df-hj-np-tv-z])\1$/, '$1');
const STOP_STEMS = new Set([...STOP].map(stem));
const keyWords = (text: string) =>
  new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).map(stem).filter((w) => w.length > 1 && !STOP_STEMS.has(w)));
/**
 * The open ask a headline calls done ("The Test 2 holdout rule is staged" while "Stage the Test 2 holdout rule?" still
 * waits on the owner): a sentence with a done word that shares two key words with an open needs line, or its one key word
 * when that is all it names ("Approve launch?"). Null when none.
 */
export function claimsDone(headline: string, open: Array<{ kind: string; title: string }>): string | null {
  const asks = open.filter((u) => u.kind === 'needs');
  const waits = (text: string) => /\b(wait(s|ing)?|needs? you|your (call|answer|ok)|for you to)\b/i.test(text);
  // Sentence by sentence, so "the flag shipped; the rule waits on you" is fine. A sentence that says something waits is
  // read clause by clause, without its waiting clauses; a subject coordinated by a plain "and" ("the customer admin
  // dashboard" in "the customer admin dashboard and API are deployed, while the launch waits on you") joins the clause
  // whose plural verb ("are", "were", "have", "both") it shares, so it keeps its verb. A clause with its own verb
  // ("dashboard continues and the API shipped") doesn't: a verb of its own, or a last word in -ed, marks a clause.
  const VERB = /\b(?:is|was|has|had|does|did|can|could|will|would|may|might|must|shall|should|gets?|got|goes|went|keeps?|kept|stays?|remains?|continues?|runs?|ran|works?|moves?|starts?|stops?|looks?|seems?|holds?|says|said|takes?|took|makes?|made|fails?|breaks?|broke)\b/i;
  const subject = (c: string) => !DONE.test(c) && !waits(c) && !VERB.test(c) && !/\w+ed\s*$/i.test(c);
  // The subject it joins to can run any length: only its plural verb ties the two.
  const shared = (c: string) => /^(?:[\w-]+\s+)+?(?:are|were|have|both)\b/i.test(c.trim());
  const clauses = headline.split(/(?<=[.!?;])\s+/).flatMap((s) => {
    if (!waits(s)) return [s];
    // The split keeps its joins: only a plain "and" (no comma, no "but" or "while") can join a subject to its verb.
    const bits = s.split(/(,?\s+(?:and|but|while)\s+)/);
    const parts = bits.filter((_, i) => i % 2 === 0);
    const joins = bits.filter((_, i) => i % 2 === 1);
    // A third subject ("the dashboard and the API and workers are deployed") joins one already joined only when it reads
    // as a noun phrase: it opens with a determiner ("The dashboard widgets"), or none of its words could be a verb of its
    // own (an -s or -ed ending: "Dashboard advances"), since the verb list can't name them all. "The dashboard advances"
    // still joins: over-flagging only costs a rewrite, while missing an open ask calls it done.
    const bare = (c: string) =>
      /^\s*(?:the|a|an|our|your|its|their|this|that|these|those|all|both|each|every)\s/i.test(c) ||
      !c.trim().split(/\s+/).some((w) => /(?:[^s]s|ed)$/i.test(w));
    const joined = new Set<number>();
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!/^\s+and\s+$/.test(joins[i]!) || !subject(parts[i]!) || !shared(parts[i + 1]!) || (joined.has(i + 1) && !bare(parts[i]!))) continue;
      parts.splice(i, 2, `${parts[i]} and ${parts[i + 1]}`);
      joined.add(i);
    }
    return parts.filter((c) => !waits(c));
  });
  for (const clause of clauses) {
    if (!DONE.test(clause)) continue;
    const said = keyWords(clause);
    const ask = asks.find((u) => {
      const keys = [...keyWords(u.title)];
      return keys.length > 0 && keys.filter((w) => said.has(w)).length >= Math.min(2, keys.length);
    });
    if (ask) return ask.title;
  }
  return null;
}

/**
 * The answered ask prose still says waits on the owner ("Two things wait on you: stage the Test 2 holdout rule…" after
 * they answered it): a sentence that says something waits and shares two key words with an answered needs line (its one
 * key word when that is all it names). Null when none. Prose written before the answer reads this way until it's
 * rewritten; updates.ts chapters() serves the plain version meanwhile.
 */
export function stillAsks(text: string, answered: Array<{ title: string }>): string | null {
  const waits = (t: string) => /\b(wait(s|ing)?|needs? you|your (call|answer|ok|pick)|for you to)\b/i.test(t);
  for (const sentence of text.split(/(?<=[.!?;])\s+/)) {
    if (!waits(sentence)) continue;
    const said = keyWords(sentence);
    const hit = answered.find((u) => {
      const keys = [...keyWords(u.title)];
      return keys.length > 0 && keys.filter((w) => said.has(w)).length >= Math.min(2, keys.length);
    });
    if (hit) return hit.title;
  }
  return null;
}

/**
 * A clause that says something waits on the owner ("still awaits your merge", "needs a fix picked", "your four design
 * calls", "until you pick visibility", "three launch steps are yours").
 */
const ASKS = /\b(a?wait(s|ing)?\b|needs? you\b|for you to\b|until you\b|you (still )?(need|have) to\b|(is|are) yours\b|your (call|answer|ok|pick|merge|approval|review|go-ahead|confirm\w*)\b|your (\w+[\s-]+){1,3}(calls|questions|decisions|answers|picks|steps|sign-?ins?)\b|needs? (a|an|your)\b[\w\s'-]{0,30}\b(pick(ed)?|choice|call|decision|answer|approval|merge|review)\b)/i;

/**
 * A claim in prose that something waits on the owner with no open needs line behind it ("three fixes still await your
 * merge" when nothing open asks for a merge): such a claim was true once and was carried forward. A clause that says
 * something waits must share a key word, beyond its waiting words and counts, with an open needs line's title. Null when
 * every such clause is backed.
 */
const ASK_WORDS = /\b(?:a?wait\w*|still|needs?|things?|items?|two|three|four|five|six|several|few|some|pick(?:ed)?|calls?|answers?|questions?|decisions?|steps?|review|go-ahead|until|yours?|next)\b/gi;
export function unbackedAsk(text: string, open: Array<{ kind: string; title: string; detail?: string | null }>): string | null {
  const asks = open.filter((u) => u.kind === 'needs');
  const clauses = text.split(/(?<=[.!?;:])\s+|,\s*(?:and|but|while)?\s*|\s+(?:and|but|while)\s+(?=\S+\s+(?:still\s+)?(?:a?wait|needs?)\b)/i);
  for (const clause of clauses) {
    if (!clause || !ASKS.test(clause)) continue;
    // What the clause names, without its waiting words or counts: "Two things wait on you:" names nothing to back.
    const said = keyWords(clause.replace(ASK_WORDS, ' '));
    if (said.size === 0) continue;
    const backed = asks.some((u) => {
      const keys = [...keyWords(u.title)];
      return keys.some((w) => said.has(w));
    });
    if (!backed) return clause.trim();
  }
  return null;
}

/** The plain version: what needs the owner, then what shipped, from the lines alone. */
export function plainChapter(input: ChapterWriteInput): { headline: string; status: string; plain: true } {
  // Handled before the writer got to it is news too: open lines first, then what was handled. In the owner's words:
  // no commit prefixes or release hashes.
  const lines = [...input.open, ...input.handled.map((u) => ({ ...u, moment: false, detail: null }))].map((u) => ({ ...u, title: ownerTitle(u.title) }));
  const needs = input.open.filter((u) => u.kind === 'needs');
  const failed = lines.filter((u) => u.kind === 'failed');
  const shipped = lines.filter((u) => u.kind === 'shipped');
  const top = lines.find((u) => u.moment) ?? lines[0];
  const others = lines.filter((u) => u.kind !== 'needs');
  const news = others.find((u) => u.moment) ?? others[0];
  // What waits on the owner is the desk's half of the headline (Chapter.waits, from the records): this is the rest.
  const headline = [
    failed.length ? `${failed.length === 1 ? failed[0]!.title.replace(/\.$/, '') : `${failed.length} failures`}.` : '',
    shipped.length ? `${shipped.length === 1 ? shipped[0]!.title.replace(/\.$/, '') : `${shipped.length} things finished`}.` : '',
  ].filter(Boolean).join(' ') || (news ? `${news.title.replace(/\.$/, '')}.` : needs.length ? '' : 'Nothing new.');
  // Where it stands from the top news; the old status only when there is none.
  const status = `${(top ? `${top.title.replace(/\.$/, '')}.` : '') || input.previous.status?.split(/\s*Next:/)[0]?.trim() || 'Quiet.'}${input.milestone ? ` Next: ${input.milestone}` : ''}`;
  return { headline: clip(headline, 300), status: clip(status, 300), plain: true };
}

type OpenLine = ChapterWriteInput['open'][number];
/** A line the sort may never call noise (triage.ts isProtected): an open brief, or a failure. */
const guarded = (u: OpenLine) => u.source === 'auto:brief' || !!u.brief || u.kind === 'failed';

/**
 * The writer's sort of Needs you, kept only where it may apply: chores and answered asks are open needs lines that
 * aren't briefs or failures, an answer is a newer line it was given, asks are open news lines, a repeat group is two
 * or more open needs lines. A line goes to one place at most (chores, then answered, then repeats). Null when empty.
 */
export function writtenTriage(raw: unknown, input: Pick<ChapterWriteInput, 'open'> & { handled?: ChapterWriteInput['handled'] }): ChapterTriage | null {
  const read = readTriage(raw);
  if (!read) return null;
  const open = new Map(input.open.map((u) => [u.id, u]));
  const later = new Map<number, number>([...input.open.map((u) => [u.id, u.at] as const), ...(input.handled ?? []).filter((u) => typeof u.id === 'number').map((u) => [u.id!, u.at] as const)]);
  const hideable = (id: number) => {
    const u = open.get(id);
    return !!u && u.kind === 'needs' && !guarded(u);
  };
  const taken = new Set<number>();
  const chores = read.chores.filter((id) => hideable(id) && !taken.has(id) && taken.add(id));
  const answered = Object.fromEntries(Object.entries(read.answered).filter(([key, by]) => {
    const id = Number(key);
    const at = later.get(by);
    if (!hideable(id) || taken.has(id) || by === id || at === undefined || at <= open.get(id)!.at) return false;
    return !!taken.add(id);
  }));
  const same = read.same.map((g) => g.filter((id) => open.get(id)?.kind === 'needs' && !taken.has(id))).filter((g) => g.length > 1);
  for (const g of same) for (const id of g) taken.add(id);
  // A repeat group can't share a line with another (the first holds it).
  const seen = new Set<number>();
  const groups = same.map((g) => g.filter((id) => !seen.has(id) && !!seen.add(id))).filter((g) => g.length > 1);
  const asks = read.asks.filter((id) => ['fyi', 'shipped', 'decided'].includes(open.get(id)?.kind ?? '') && asksOwner(open.get(id)!.title));
  const triage = { chores, asks, same: groups, answered };
  return chores.length || asks.length || groups.length || Object.keys(answered).length ? triage : null;
}

/** The writer's grouping, titles and sort, kept only for lines it was given; null when it gave none. */
export function writtenLayout(parsed: { groups?: unknown; milestone?: unknown; titles?: unknown; triage?: unknown }, input: Pick<ChapterWriteInput, 'open'> & { handled?: ChapterWriteInput['handled'] }): ChapterLayout | null {
  const ids = new Set(input.open.map((u) => u.id));
  const triage = writtenTriage(parsed.triage, input);
  const layout = readLayout(JSON.stringify({ groups: parsed.groups, milestone: parsed.milestone, titles: parsed.titles }));
  if (!layout) return triage ? { groups: [], milestone: null, titles: {}, triage } : null;
  const groups = layout.groups
    .map((g, i) => ({ i, title: clip(g.title.replace(/\s+/g, ' ').trim(), 80), ids: g.ids.filter((id) => ids.has(id)) }))
    .filter((g) => g.title && g.ids.length);
  const titles = Object.fromEntries(
    Object.entries(layout.titles)
      .filter(([id, t]) => ids.has(Number(id)) && t.trim())
      .map(([id, t]) => [id, clip(t.replace(/\s+/g, ' ').trim(), 140)]),
  );
  const milestone = groups.findIndex((g) => g.i === layout.milestone);
  if (!groups.length && !Object.keys(titles).length && !triage) return null;
  return { groups: groups.map(({ title, ids }) => ({ title, ids })), milestone: milestone >= 0 ? milestone : null, titles, ...(triage ? { triage } : {}) };
}

export function createChapterWriter(options: { apiKey: string; model: string; baseUrl?: string; timeoutMs?: number }): ChapterWriter {
  const url = `${(options.baseUrl ?? 'https://ollama.com/v1').replace(/\/$/, '')}/chat/completions`;
  return async (input) => {
    if (!options.apiKey) return plainChapter(input);
    // Where a line came from, for the sort: an open brief, a thread's recorded status, a lead's post, or another source.
    const origin = (u: { source?: string; brief?: boolean }) => (u.source === 'auto:brief' || u.brief ? 'brief' : u.source === 'auto:status' ? 'status' : u.source === 'lead' ? 'lead' : u.source?.startsWith('auto:') ? u.source.slice(5) : null);
    const line = (u: { id?: number; kind: string; title: string; detail?: string | null; moment?: boolean; outcome?: string | null; at: number; source?: string; brief?: boolean; conversation?: string; standing?: string; background?: string }) =>
      `- ${u.id !== undefined ? `line ${u.id}: ` : ''}[${u.kind}${u.moment ? ', moment' : ''}${u.source?.startsWith('auto:') ? ', auto' : ''}${origin(u) ? `, ${origin(u)}` : ''}] ${u.conversation ? `(from ${JSON.stringify(u.conversation)}) ` : ''}${u.title}${u.standing ? ` — where it stands: ${clip(u.standing, 300)}` : ''}${u.background ? ` — background: ${clip(u.background, 300)}` : ''}${u.detail ? ` (${clip(u.detail, 200)})` : ''}${u.outcome ? ` → owner: ${u.outcome}` : ''} (${iso(u.at)})`;
    const prompt = [
      `Write the owner's catch-up for “${input.name}” from its update lines below.`,
      'headline: at most two sentences and 35 words on what happened since they last caught up, from their side, what matters most first (a failure, what shipped). Say what is true now: anything under "Handled lately" is done, so never say it still waits on them.',
      'The desk itself starts the headline with what waits on the owner, from its records ("Waiting on you: …"). Never say what waits on them, what they need to approve, confirm or decide, or how many asks are open: write only the rest. When nothing else happened, the headline is an empty string.',
      'status: where it stands now in one sentence, then "Next: …" in one short sentence (use the milestone when there is one); at most 40 words in all. Written as if the open lines were handled.',
      'An open needs line is not done: never describe what it asks for as shipped, staged, approved or done; say it waits on them.',
      'Describe the effect the owner notices, never the internal mechanism or its name: "rules you make yourself no longer show up as decided for you", not "owner-rule, second-call rule" or "leave Decided for you".',
      'Never write a reference id anywhere (decision ids like D-12, rule ids like R-3, E-4, PR numbers like #864, issue keys like TGO-1105) or a link: the owner does not track them. Name the thing in words ("the Catch me up fix for answered asks", "the merge rule for capped PRs").',
      'Every title and headline clause names the project or feature it is about. A fix says what problem it fixes. A needs title says what the owner decides, such as "Publish the Ridge Loop ride video in HD?".',
      'No ticket, PR or version numbers; no v2/v6, phase N, round N or step N labels; no internal code names, file names or acronyms unless the owner would recognize them.',
      'groups: the smaller shipped lines (not moments) clustered by theme, each {"title": a few owner-language words naming what changed, "ids": [line ids]}. Every smaller shipped line in exactly one group; at most 6 groups.',
      'milestone: the index of the one group the owner will notice most (a feature they can try), or null.',
      'titles: for every moment and every line marked auto, a short title by line id, at most 8 words, the way a headline reads ("Stop Catch me up showing answered asks?", "Leads now carry their workers\' asks"). No commit prefixes like "feat(desk):", no release hashes or PIDs. The line keeps its full text as detail.',
      'Only the lines below are true now. An ask that was answered, superseded or handled is gone.',
      'Plain text, no markdown. Never invent anything the lines do not say.',
      'triage: sort the open lines for the owner\'s Needs you list. Each line\'s tag says where it came from: "brief" (an open decision brief), "status" (what a conversation\'s own status said, recorded by the desk), "lead" (a project lead\'s post), or another automatic source. Leave a list empty when unsure: a line left alone still shows.',
      'triage.chores: ids of open needs lines that are an agent\'s own bookkeeping the owner cannot act on: reconciling, dispatching or checkpointing its own work, a scheduled check that completed, "still open", a status report that asks the owner nothing. Examples: "reconcile the missing source worktree with the cutover backup record before authorizing further implementation", "reconcile the missing source\'s preservation status before work resumes", "(studio lead): dispatch reconciliation of the watcher\'s sender identity and stale release documentation", "05:30 scheduled check complete, degraded receipt verified for exact 14 aliases", "still open.". Not a chore: anything that asks the owner to decide, approve, confirm, sign in, merge, upload, pay or reply, however it is worded. Never a line tagged brief, never a failed line.',
      'triage.asks: ids of open fyi, shipped or decided lines whose words ask the owner to do or decide something now, such as "three PRs need your merge" or "the experiment card is in Slack, waiting for your Confirm". The line itself must address the owner ("your", "you", or a question to them). Not a line that reports work done, proposed, cleared or live ("Scrolling fix merged, deployed and live", "Build order for promotion ideas proposed", "Notification tests cleared to start this week"), and not one about what an agent will do next. When unsure, leave it out.',
      'triage.same: groups of open needs line ids that ask the owner for the same single action in different words, from any conversation, such as "The Test 2 holdout experiment card is in Slack, waiting for your Confirm.", "Confirm the Test 2 card in Slack (link 4) before it expires" and "confirm the existing Test 2 create-experiment card in Slack". Not lines that are only about the same project or feature.',
      'triage.answered: an open needs line that a newer line (open or under Handled lately, later by its time) shows was done, answered or no longer applies, as {"<needs line id>": <newer line id>}. Examples: "Sign in to claude.ai" answered by a later "the claude.ai account works again"; "Upload Ridge Loop privately?" answered by a later "Ridge Loop is uploaded, private". Only when the newer line plainly settles it, never because time passed. Never a line tagged brief.',
      'The sort only labels lines for the owner: it changes nothing that waits on them. Every open needs line still waits on the owner.',
      'Reply with JSON only: {"headline": string, "status": string, "groups": [{"title": string, "ids": [number]}], "milestone": number | null, "titles": {"<id>": string}, "triage": {"chores": [number], "asks": [number], "same": [[number]], "answered": {"<id>": number}}}.',
      '',
      `Now: ${iso(input.now)}`,
      input.milestone ? `The lead's milestone: ${input.milestone}` : '',
      '',
      'Open lines (the chapter):',
      input.open.map(line).join('\n') || '(none)',
      '',
      'Handled lately:',
      input.handled.map(line).join('\n') || '(none)',
    ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
    const ask = async (messages: Array<{ role: string; content: string }>) => {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          messages,
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const raw = body.choices?.[0]?.message?.content ?? '';
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { headline?: unknown; status?: unknown; groups?: unknown; milestone?: unknown; titles?: unknown; triage?: unknown };
      const headline = String(parsed.headline ?? '').replace(/\s+/g, ' ').trim();
      const status = String(parsed.status ?? '').replace(/\s+/g, ' ').trim();
      // An empty headline is fine: what waits on the owner is the desk's half, and it may be all there is.
      if (!status) throw new Error('empty chapter');
      return { raw, parsed, headline, status };
    };
    try {
      const messages = [
        { role: 'system', content: 'You write terse, factual catch-ups for a busy owner. Reply with JSON only.' },
        { role: 'user', content: prompt },
      ];
      let out = await ask(messages);
      // The guards and the plain version read the open lines as the facts have them: the sort only labels (R-21).
      // The first answer's sort stands for the whole call (a rewrite is asked to leave it unchanged).
      const triage = writtenTriage(out.parsed.triage, input);
      const sorted = input;
      // Too long for the card: asked once more to write short, so the card cuts only as a last resort.
      if (overLimit(out.headline, HEADLINE_WORDS) || overLimit(out.status, STATUS_WORDS)) {
        const again = await ask([
          ...messages,
          { role: 'assistant', content: out.raw },
          { role: 'user', content: `Too long. Rewrite the headline in at most two sentences and ${HEADLINE_WORDS} words, and the status in one sentence plus "Next: …", at most ${STATUS_WORDS} words. Same JSON, everything else unchanged.` },
        ]).catch(() => null);
        if (again) out = again;
      }
      // A pending ask told as done: asked once more; still so, the plain headline stands in.
      const done = claimsDone(out.headline, sorted.open);
      if (done) {
        const again = await ask([
          ...messages,
          { role: 'assistant', content: out.raw },
          { role: 'user', content: `The headline calls “${done}” done, but it still waits on the owner. Rewrite the headline so it no longer calls that done; leave out what waits on them, which the desk says itself. Same JSON, same limits, everything else unchanged.` },
        ]).catch(() => null);
        if (again && !claimsDone(again.headline, sorted.open)) out = again;
        else out = { ...out, headline: plainChapter(sorted).headline };
      }
      // A wait no open line asks for (carried from an older chapter, or made up): asked once more; still so, plain.
      const unbacked = unbackedAsk(out.headline, sorted.open) ?? unbackedAsk(out.status, sorted.open);
      if (unbacked) {
        const again = await ask([
          ...messages,
          { role: 'assistant', content: out.raw },
          { role: 'user', content: `“${unbacked}” says something waits on the owner, but no open needs line asks for it, so it is no longer true. Rewrite the headline and status from the open lines only. Same JSON, same limits, everything else unchanged.` },
        ]).catch(() => null);
        if (again && !unbackedAsk(again.headline, sorted.open) && !unbackedAsk(again.status, sorted.open)) out = again;
        else {
          const plain = plainChapter(sorted);
          out = { ...out, ...(unbackedAsk(out.headline, sorted.open) ? { headline: plain.headline } : {}), ...(unbackedAsk(out.status, sorted.open) ? { status: plain.status } : {}) };
        }
      }
      const jargon = (value: typeof out) => {
        const layout = writtenLayout(value.parsed, input);
        return jargonWords([value.headline, value.status, ...Object.values(layout?.titles ?? {}), ...(layout?.groups.map((g) => g.title) ?? [])].join(' '));
      };
      const offending = jargon(out);
      if (offending.length) {
        const again = await ask([...messages, { role: 'assistant', content: out.raw },
          { role: 'user', content: `Remove internal labels and hashes: ${offending.join(', ')}. Name the feature, its problem and the owner's decision in plain words. Same JSON and limits.` }]).catch(() => null);
        // The rewrite is checked again for pending asks told as done or waits no line asks for;
        // failing that, the checked headline and status stay and only the titles and groups are taken.
        const factual = (value: NonNullable<typeof again>) => !claimsDone(value.headline, sorted.open)
          && !unbackedAsk(value.headline, sorted.open) && !unbackedAsk(value.status, sorted.open);
        if (again) out = factual(again) ? again : { ...again, headline: out.headline, status: out.status };
        if (jargon(out).length) {
          const plain = plainChapter(sorted);
          const layout = writtenLayout(out.parsed, input);
          out = { ...out, headline: jargonWords(out.headline).length ? plain.headline : out.headline,
            status: jargonWords(out.status).length ? plain.status : out.status,
            parsed: { ...out.parsed, milestone: layout?.milestone ?? null, groups: layout?.groups.map((g) => ({ ...g, title: jargonWords(g.title).length ? plainWords(input.open.find((u) => g.ids.includes(u.id))?.title ?? '') : g.title })), titles: Object.fromEntries(input.open.map((u) => [u.id,
              jargonWords(layout?.titles[u.id] ?? '').length ? plainWords(u.title) : layout?.titles[u.id] ?? plainWords(u.title)])) } };
        }
      }
      const layout = writtenLayout({ ...out.parsed, triage: null }, input);
      return { headline: clip(out.headline, 400), status: clip(out.status, 400), layout: triage ? { ...(layout ?? { groups: [], milestone: null, titles: {} }), triage } : layout };
    } catch {
      return plainChapter(input);
    }
  };
}
