// Voice summaries and arrival windows, independent of the browser and its clock.
import { draftView } from '../draft-model.js';
import { pauseView } from '../pause-model.js';

export function freshCaption(arrival, now, duration = 6000) {
  return arrival && now >= arrival.at && now - arrival.at < duration ? arrival.line : null;
}

export function confirmToOpen(draft, seen) {
  return draft?.active && draft.status === 'confirm' && draft.id && !seen.includes(draft.id) ? draft.id : null;
}

export function voiceLine(state, arrival, now) {
  const pause = pauseView(state.pause, state.pausePending);
  if (pause) return { kind: 'paused', pause, text: `${pause.still ? 'Still paused' : 'Paused'} · ${pause.waiting} waiting` };
  const draft = draftView(state.draft, now);
  if (draft) {
    if (draft.status === 'confirm') return { kind: 'confirm', text: draft.question ? 'One question before sending' : `Send to ${draft.to || 'agent'}?` };
    if (state.draft.active && ['listening', 'compiling'].includes(draft.status)) return { kind: 'drafting', to: draft.to || 'agent', text: `Drafting to ${draft.to || 'agent'}` };
    return { kind: 'draft', text: draft.title };
  }
  if (!state.operator.live) return null;
  const caption = freshCaption(arrival, now);
  if (caption) return { kind: 'caption', caption, agentName: caption.speaker === 'owner' ? null : caption.name || 'Agent' };
  const { status, agentName } = state.operator;
  if (status === 'speaking') return { kind: 'speaking', agentName: agentName || 'Agent', text: `${agentName || 'Agent'} is speaking…` };
  return { kind: status === 'thinking' ? 'thinking' : 'listening', text: status === 'thinking' ? 'Thinking…' : 'Listening' };
}
