// The pause pill's logic (voice pause mode), kept free of the DOM so it can be tested.
// The voice operator publishes the pill (POST /api/desk/pause); screens get it as `pause`
// events. See apps/tango-voice/src/live/pause-mode.ts.

export function blankPause() {
  return { id: null, active: false, since: null, waiting: 0, still: false, updatedAt: 0 };
}

/** What the pill shows, or null when the operator isn't paused. */
export function pauseView(card, pending = false) {
  if (!card || !card.active) return null;
  const waiting = Math.max(0, Number(card.waiting) || 0);
  const label = `${card.still ? 'Still paused' : 'Paused'} · ${waiting} waiting`;
  return {
    label: pending ? 'Resuming…' : label,
    waiting,
    still: !!card.still,
    title: `The voice operator is holding ${waiting === 1 ? '1 update' : `${waiting} updates`} and staying quiet. Tap to resume, or say “Yankee, I’m back”.`,
    canResume: !!card.id && !pending,
  };
}
