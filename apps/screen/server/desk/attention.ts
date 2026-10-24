import type { Attention, DeskEvent, NextStep, SnoozeTrigger, WritebackRecord } from './types.js';

// Owner attention as a pure reducer over desk_events: (state, event) → state.
// desk_attention is only a projection of this; replaying an item's events
// (minus the undone ones) rebuilds it exactly. Everything the reducer needs to
// decide is carried in the event payload (the step at the time of the activity,
// whether it was only an acknowledgment), so a replay never looks at today's
// facts.

export function initialAttention(itemId: string, at = 0): Attention {
  return {
    itemId,
    disposition: 'active',
    seen: 'new',
    snoozeUntil: null,
    snoozeTrigger: null,
    backFromSnooze: false,
    doneAt: null,
    writeback: null,
    updatedAt: at,
  };
}

const URGENT: readonly NextStep[] = ['your_move', 'failed'];

/** Ways the owner engages that count as seen only while the item is in the rotation. */
const PASSIVE_SEEN = new Set(['viewed', 'heard', 'briefed', 'post']);

function activeSeen(state: Attention, at: number): Attention {
  return { ...state, disposition: 'active', seen: 'seen', snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, doneAt: null, updatedAt: at };
}

/** Who acts as the owner: on the desk, a screen, by voice. */
const OWNER_ACTORS = new Set(['owner', 'screen', 'voice']);

/**
 * Putting a thread away yourself (Done, Park, Snooze) says you've read it: the summary was enough, so it
 * reads Ready, not Needs you (10/17). A rule, an agent, or the source settling it leaves what you've seen alone.
 */
function readIfOwner(state: Attention, actor: DeskEvent['actor'] | undefined): Attention['seen'] {
  return actor && OWNER_ACTORS.has(actor) ? 'seen' : state.seen;
}

function backAsNew(state: Attention, at: number): Attention {
  return { ...state, disposition: 'active', seen: 'new', snoozeUntil: null, snoozeTrigger: null, backFromSnooze: true, doneAt: null, updatedAt: at };
}

export function reduceAttention(state: Attention, event: Pick<DeskEvent, 'type' | 'at' | 'payload' | 'actor'>): Attention {
  const at = event.at;
  const p = event.payload;
  switch (event.type) {
    case 'source.created':
      // An item the owner started (they wrote first) is already seen.
      return { ...initialAttention(state.itemId, at), seen: p.by === 'owner' ? 'seen' : 'new' };

    case 'source.owner_posted':
      // Writing in the conversation is engagement anywhere, and picks a parked or finished one back up.
      // Covered up to when they wrote (the message's own time; the poll may file it much later).
      return { ...activeSeen(state, at), coveredUntil: Math.max(state.coveredUntil ?? 0, typeof p.at === 'number' ? p.at : at) };

    case 'seen': {
      const via = String(p.via ?? 'explicit');
      // Mark read (the desk's menus): read wherever it is, Snoozed, Parked or Done included; it stays there.
      if (via === 'read') return { ...state, seen: 'seen', backFromSnooze: false, ...(state.disposition === 'active' ? { updatedAt: at } : {}) };
      // A catch-up line seen (docs/specs/catch-up.md): the thread is covered up to that line's time, and reads seen
      // unless something newer came in after it.
      if (via === 'update') {
        const until = typeof p.until === 'number' ? p.until : at;
        const covered = { ...state, coveredUntil: Math.max(state.coveredUntil ?? 0, until) };
        // Newer by the messages' own times (`newest`, the thread's latest agent message when it was seen): activity is
        // filed when it's polled, so the attention clock runs later than what it covers.
        const newest = typeof p.newest === 'number' ? p.newest : state.updatedAt;
        if (state.disposition !== 'active' || state.seen === 'seen' || newest > until) return covered;
        return { ...covered, seen: 'seen', backFromSnooze: false };
      }
      if (PASSIVE_SEEN.has(via)) {
        // Hearing the agent's answer spoken covers everything posted up to now (see source.activity).
        const covered = via === 'heard' ? { coveredUntil: Math.max(state.coveredUntil ?? 0, at) } : {};
        // Looking at a snoozed or finished item (History, a catch-up) leaves it where it is.
        return { ...state, ...covered, seen: 'seen', backFromSnooze: false, ...(state.disposition === 'active' ? { updatedAt: at } : {}) };
      }
      // 👀 (explicit, or a reaction): keep it in my rotation.
      return activeSeen(state, at);
    }

    case 'unseen':
      // Mark unread: unread wherever it is; an active one is the owner's to read again (Needs you).
      return { ...state, seen: 'new', ...(state.disposition === 'active' ? { updatedAt: at } : {}) };

    case 'source.activity': {
      const step = p.step as NextStep | undefined;
      const urgent = step !== undefined && URGENT.includes(step);
      // The operator can speak an agent's answer before the poll files that Discord message (10/06):
      // posted before what the owner already heard or wrote, it isn't news. (Opening the item on the
      // desk doesn't count: the desk only showed what it had polled.)
      if (typeof p.at === 'number' && typeof state.coveredUntil === 'number' && p.at <= state.coveredUntil) return state;
      switch (state.disposition) {
        case 'done':
        case 'parked':
          // News reopens a finished or parked item; "thanks!" / "you're welcome" doesn't.
          return p.ackOnly === true ? state : { ...state, disposition: 'active', seen: 'new', doneAt: null, backFromSnooze: false, updatedAt: at };
        case 'snoozed':
          return state.snoozeTrigger === 'agent_posts' ? backAsNew(state, at) : state;
        case 'active':
          if (state.seen === 'new') return { ...state, updatedAt: at };
          return { ...state, seen: urgent ? 'new' : 'updated', updatedAt: at };
      }
      return state;
    }

    case 'source.step': {
      // The step turned urgent after the activity was filed (a late summary, watching went quiet).
      const to = p.to as NextStep | undefined;
      const from = p.from as NextStep | undefined;
      if (state.disposition !== 'active' || state.seen === 'new') return state;
      if (to && URGENT.includes(to) && !(from && URGENT.includes(from))) return { ...state, seen: 'new', updatedAt: at };
      return state;
    }

    case 'clear':
      return { ...state, seen: 'seen', backFromSnooze: false, coveredUntil: Math.max(state.coveredUntil ?? 0, at) };

    case 'chapter.superseded':
      return { ...state, disposition: 'done', snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, doneAt: at };

    case 'done':
    case 'sweep.drop':
    case 'source.done':
    case 'chapter.settled':
      return { ...state, disposition: 'done', seen: readIfOwner(state, event.actor), snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, doneAt: at, updatedAt: at };

    case 'reopen':
    case 'pickup':
    case 'sweep.keep':
      return activeSeen(state, at);

    case 'snooze': {
      const until = typeof p.until === 'number' ? p.until : null;
      const trigger = (p.trigger === 'desk' || p.trigger === 'agent_posts' ? p.trigger : null) as SnoozeTrigger | null;
      const seen = readIfOwner(state, event.actor);
      if (until === null && trigger === null) return { ...state, disposition: 'parked', seen, snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, updatedAt: at };
      return { ...state, disposition: 'snoozed', seen, snoozeUntil: until, snoozeTrigger: trigger, backFromSnooze: false, doneAt: null, updatedAt: at };
    }

    case 'park':
      return { ...state, disposition: 'parked', seen: readIfOwner(state, event.actor), snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, doneAt: null, updatedAt: at };

    case 'snooze.expired':
      // A local snooze firing, or T3's own snooze running out (the item may be "active" locally).
      // T3's snooze ending only matters while nothing local holds the item.
      if (p.reason === 'source') return state.disposition === 'active' ? backAsNew(state, at) : state;
      return state.disposition === 'snoozed' ? backAsNew(state, at) : state;

    case 'writeback':
      // Recorded apart from the decision: a failed write-back never undoes a local Done.
      return { ...state, writeback: p as unknown as WritebackRecord };

    default:
      return state;
  }
}

/** Replays an item's log, skipping undone events (and the undo markers themselves). */
export function replayAttention(itemId: string, events: Array<Pick<DeskEvent, 'seq' | 'type' | 'at' | 'payload' | 'actor' | 'undoesSeq'>>): Attention {
  const undone = new Set(events.filter((event) => event.type === 'undo' && event.undoesSeq !== null).map((event) => event.undoesSeq!));
  let state = initialAttention(itemId);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type === 'undo') continue;
    if (undone.has(event.seq)) {
      // Undoing "back from snooze" can't mean "snoozed again until a time that already passed" (the
      // next tick would bring it straight back): it stays in the rotation, snooze cleared, not New.
      if (event.type === 'snooze.expired' && event.payload.reason !== 'source' && state.disposition === 'snoozed') {
        state = { ...state, disposition: 'active', seen: 'seen', snoozeUntil: null, snoozeTrigger: null, backFromSnooze: false, updatedAt: event.at };
      }
      continue;
    }
    state = reduceAttention(state, event);
  }
  return state;
}
