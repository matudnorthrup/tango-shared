// The Draft card's logic (voice draft mode), kept free of the DOM so it can be tested.
// The voice operator publishes the card (POST /api/desk/draft); screens get it as `draft`
// events. See apps/tango-voice/src/live/draft-mode.ts.

/** How long a sent / cancelled card stays up if the operator never clears it. */
export const DRAFT_LINGER_MS = 15_000;

export function blankDraft() {
  return { id: null, active: false, target: null, fragments: [], compiled: null, question: null, note: null, status: 'listening', undoUntil: null, updatedAt: 0 };
}

/** The draft card when it belongs to this desk item (its Conversation view shows it in the reply box), else null. */
export function draftForItem(card, itemId) {
  if (!card || !itemId || card.target?.itemId !== itemId) return null;
  return card;
}

/**
 * What the card shows, or null when nothing should. An unsent card left behind by an ended
 * session (a note) stays until dismissed; a plain sent / cancelled card lingers briefly.
 */
export function draftView(card, now = Date.now()) {
  if (!card) return null;
  const closed = card.status === 'sent' || card.status === 'cancelled';
  if (!card.active && !closed) return null;
  if (!card.active && closed && !card.note && now - (card.updatedAt || 0) > DRAFT_LINGER_MS) return null;
  const who = card.target?.name || null;
  const to = card.target?.label || who;
  const fragments = card.fragments || [];
  let title;
  const undoable = card.status === 'sending' && !!card.undoUntil && now < card.undoUntil;
  if (undoable) title = who ? `Sending to ${who}` : 'Sending';
  else if (card.status === 'sending') title = who ? `Sending to ${who}…` : 'Sending…';
  else if (card.status === 'sent') title = who ? `Sent to ${who}` : 'Sent';
  else if (card.status === 'cancelled') title = card.note ? 'Unsent draft' : 'Draft discarded';
  else if (card.status === 'compiling') title = who ? `Drafting for ${who} · tidying it up…` : 'Tidying up your draft…';
  else if (card.status === 'confirm' && card.question) title = 'One question before sending';
  else if (card.status === 'confirm') title = 'Ready to send';
  else title = who ? `Drafting for ${who}` : 'Drafting…';
  const confirm = card.active && card.status === 'confirm';
  return {
    title,
    status: card.status,
    to: to || null,
    // The running text: every fragment in order, the newest highlighted.
    earlier: fragments.slice(0, -1),
    newest: fragments.length ? fragments[fragments.length - 1] : null,
    compiled: card.compiled || null,
    question: card.question || null,
    note: card.note || null,
    canSend: confirm && !!card.compiled && !card.question,
    // A draft on its way can't be called back, except during its undo window.
    canCancel: !!card.active && card.status !== 'sending',
    canUndo: !!card.active && undoable,
    undoSeconds: undoable ? Math.max(1, Math.ceil((card.undoUntil - now) / 1000)) : 0,
    canDismiss: !card.active && closed,
    hint: confirm
      ? card.question
        ? 'Answer out loud.'
        : 'Say “yes” to send, or say what to change (“no, to Victor”, “also add…”).'
      : undoable
        ? 'Say “undo” to keep editing.'
        : card.active
          ? 'Take your time. Say “I’m done” to send it.'
          : null,
    empty: card.active && fragments.length === 0 && !card.compiled,
  };
}

