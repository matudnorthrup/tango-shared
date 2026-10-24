// A decision brief's card in plain words (TGO-1080, the owner's v2 "rows" pick, R-12): what the pills say, the one
// summary line, the folded receipt and the option rows. No level numbers or board codes reach the card.

/** The board's tripwires (config/decisions/board.yaml), as the owner reads them. */
const TRIPWIRES = {
  identity: 'Needs your sign-in',
  money: 'Spends money',
  'external-in-name': 'Acts in your name',
  'security-privacy': 'Touches security or privacy',
  'one-way-no-copy': "Can't be undone",
  'precedent-conflict': 'Two of your rules conflict',
  surprise: 'Might surprise you',
};

/** Decision classes in plain words; an unknown class reads as its own words. */
const KINDS = {
  'continue-in-scope': 'Next step in approved work',
  'verify-own-change': 'Checking its own change',
  'ops-own-machine': 'Your own machines',
  'pr-housekeeping': 'PR housekeeping',
  'merge-when-green': 'Merging when green',
  'reviewer-choice': 'Choosing a reviewer',
  'product-choice-in-scope': 'Product choice in approved work',
  'delete-verified-copy': 'Deleting, with a verified copy kept',
  'design-direction': 'Design direction',
  'plan-approval': 'Plan approval',
  'ops-shared-prod': 'A system other people use',
  'creative-published': 'Creative work for publishing',
  'credentials-identity': 'Sign-ins and credentials',
  'act-on-behalf': 'Acting in your name',
  spend: 'Spending',
  'delete-no-copy': 'Deleting, with no copy',
};

const REACH = { private: 'only affects you', team: 'affects the team', public: 'reaches the public' };
const AFFECTS = { private: 'Only you', team: 'The team', public: 'The public' };

export function tripwireText(tripwire) {
  if (!tripwire) return null;
  return TRIPWIRES[tripwire] || `Needs you: ${String(tripwire).replace(/-/g, ' ')}`;
}

/** The classes the card names in its own words (a test holds this to the board). */
export const KIND_CLASSES = Object.keys(KINDS);

export function kindText(cls) {
  if (!cls) return null;
  return KINDS[cls] || `${cls[0].toUpperCase()}${cls.slice(1).replace(/-/g, ' ')}`;
}

/** Active time as words: "2h 11m", "25m", "a minute". */
export function activeLeft(ms) {
  if (typeof ms !== 'number') return null;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 2) return 'a minute';
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

/**
 * Who decides, as the card's status pill: a level 3 with a default counts down its veto window (active time),
 * a level 2 waits on the owner's answer, anything else is the owner's call. `fraction`: the window left, 0..1, of the
 * window Loom reports (the board's veto_window; 4 hours of active time by default).
 */
export function statusPill(brief, windowMs = brief.vetoWindowMs || 4 * 3_600_000) {
  if (brief.level === 3 && brief.defaultOption) {
    const left = activeLeft(brief.vetoLeftMs);
    const fraction = typeof brief.vetoLeftMs === 'number' ? Math.max(0, Math.min(1, brief.vetoLeftMs / windowMs)) : 1;
    return { kind: 'timer', text: left ? `Goes ahead in ${left} unless you say otherwise` : 'Goes ahead unless you say otherwise', fraction };
  }
  if (brief.level === 2) return { kind: 'wait', text: 'Recommend · waits for you' };
  return { kind: 'call', text: 'Your call' };
}

/** The due pill: the deadline's first clause ("Within about 1 h"), whole when short; the full text is in Details. */
export function dueText(deadline) {
  const text = String(deadline || '').trim();
  if (!text) return null;
  const clause = text.split(/[,;(]|\.\s|\s[—–-]\s/)[0].replace(/\.$/, '').trim();
  const head = clause.length >= 4 ? clause : text;
  return head.length > 48 ? `${head.slice(0, 47).trimEnd()}…` : head;
}

export { ago };

/** The one line under the ask: undo, reach, raised and updated, in that order. */
export function summaryLine(brief, at, now, age) {
  const parts = [brief.door === 'one-way' ? 'Hard to undo' : 'Reversible', REACH[brief.blast] || brief.blast];
  if (at) parts.push(`raised ${ago(at, now, age)}`);
  if (brief.updated?.at) parts.push(`updated ${ago(brief.updated.at, now, age)}`);
  return parts.filter(Boolean).join(' · ');
}

/** "12m ago", or "just now" under a minute (util.js age says "now"). */
const ago = (at, now, age) => {
  const a = age(at, now);
  return a === 'now' ? 'just now' : `${a} ago`;
};

const ordinal = (n) => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
};

/** Revised in place (TGO-1079): the pill's words, from the 2nd version on. */
export function revisionText(brief) {
  return brief.revision > 1 ? `Revised · ${ordinal(brief.revision)} version` : null;
}

/**
 * The folded receipt, as [label, value] rows: every fact the brief carries, in plain words. `from` and `carriedBy`
 * are the raising thread and the row that shows it where it counts (objects with a title), when they differ from here.
 */
export function receiptRows(brief, { at = null, now = Date.now(), age, here = null, carriedBy = null, defaultLabel = null } = {}) {
  const rows = [
    ['Decision', brief.id],
    ['Kind', kindText(brief.class)],
    ['Who decides', brief.level === 3 && brief.defaultOption ? 'Goes ahead unless you say otherwise' : brief.level === 2 ? 'Waits for you' : 'Your call'],
    ["If you don't answer", brief.level === 3 && brief.defaultOption ? `${defaultLabel || brief.defaultOption} goes ahead` : 'Nothing happens'],
    ['Undo', brief.door === 'one-way' ? 'Hard to undo' : 'Reversible'],
    ['Affects', AFFECTS[brief.blast] || brief.blast],
    ['Raised in', brief.from?.title || here || 'This thread'],
    ['Shown by', carriedBy?.title || (brief.from ? here || 'This thread' : 'This thread')],
    ['Raised', at ? ago(at, now, age) : null],
    ['Updated', brief.updated?.at ? ago(brief.updated.at, now, age) : 'Not since'],
    ['Version', brief.revision ? ordinal(brief.revision) : null],
    ['Confidence', brief.confidence],
    ['Needed by', brief.deadline],
    ['Needs you because', tripwireText(brief.tripwire)],
  ];
  return rows.filter(([, value]) => value);
}

/**
 * One option row from the brief's question option (source-loom briefLabel: "A · Label (Recommended)"): its key,
 * its own words, whether it's recommended, and whether it's the default that runs without an answer.
 */
export function optionRow(option, brief, index = null) {
  const label = option.label || '';
  // source-loom writes `${key} · ${label}`, in the brief's option order: the key at this position splits it exactly,
  // whatever it holds. An older desk without keys falls back to whatever precedes the first separator.
  const own = typeof index === 'number' ? brief?.optionKeys?.[index] : undefined;
  const match = own !== undefined && label.startsWith(`${own} · `) ? [label, own, label.slice(own.length + 3)] : /^(.+?) · (.*)$/.exec(label);
  const key = match ? match[1] : null;
  const rest = match ? match[2] : label;
  const recommended = /\s*\(recommended\)\s*$/i.test(rest);
  const title = rest.replace(/\s*\(recommended\)\s*$/i, '');
  const isDefault = !!(key && brief?.level === 3 && brief.defaultOption && brief.defaultOption === key);
  return { key, title, recommended, isDefault, consequence: option.description || '', label };
}

/** The asset tile's kind label ("pr" → "Pull request"). */
export function assetKind(kind) {
  return { pr: 'Pull request', doc: 'Doc', prototype: 'Prototype', preview: 'Preview', video: 'Video', screenshot: 'Screenshot', image: 'Image', report: 'Report', issue: 'Issue' }[kind] || (kind ? `${kind[0].toUpperCase()}${kind.slice(1)}` : 'Link');
}

/** Keep additional context, but omit a summary that repeats the ask. */
export function supportingSummary(ask, summary) {
  const text = (summary || '').replace(/^summary:\s*/i, '').trim();
  const normalize = value => (value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const detail = normalize(text);
  return detail && detail !== normalize(ask) ? text : null;
}
