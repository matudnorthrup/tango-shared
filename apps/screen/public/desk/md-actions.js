// What a rendered message's buttons do, wherever markdown shows (the Conversation view, the
// coordinator's answers, a search transcript): a code block's Wrap, Copy and Start. And Start on a
// handoff brief in a Links list: a doc an agent wrote for the next agent opens Start work with it.
// Either way the new thread joins the project it came from.

import { storageSet } from './util.js';

/** Copies text, falling back to a hidden textarea where the async clipboard is unavailable (plain http). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** Opens Start work on top: a message sheet or a panel over the page steps aside so the new sheet is the one in front. */
function startWith(store, prompt, projectId) {
  if (store.state.sheet) store.closeSheet();
  if (store.state.convoFlyout) store.set({ convoFlyout: null });
  store.openStartWork({ prompt, projectId });
}

/**
 * A code block's toolbar: Wrap toggles that block's line wrapping (remembered for the next ones); Copy copies its text;
 * Start opens Start work with the block as the prompt, in `projectId` when the message belongs to a project.
 * Returns whether the click was a toolbar button's.
 */
export function onCodeButton(event, store, projectId = null) {
  const button = event.target.closest?.('[data-code]');
  const block = button?.closest('.md-code');
  if (!block) return false;
  event.stopPropagation();
  if (button.dataset.code === 'wrap') {
    const wrap = !block.classList.contains('wrap');
    block.classList.toggle('wrap', wrap);
    button.setAttribute('aria-pressed', String(wrap));
    storageSet('codeWrap', wrap ? '1' : '');
    return true;
  }
  if (button.dataset.code === 'start') {
    if (store) startWith(store, block.querySelector('code')?.textContent ?? '', projectId);
    return true;
  }
  copyText(block.querySelector('code')?.textContent ?? '').then((ok) => {
    if (!ok) return;
    button.classList.add('copied');
    setTimeout(() => button.classList.remove('copied'), 1400);
  });
  return true;
}

const HANDOFF = /hand-?off/i;
const TEXT_DOC = /\.(md|markdown|txt)$/i;

/** A link to a handoff brief: the agent called it one ("Camera handoff"), or its file is named so (handoff-*.md). */
export function isHandoff(artifact) {
  if (!artifact?.url || artifact.kind === 'pr' || artifact.kind === 'ci' || artifact.kind === 'preview') return false;
  let file = '';
  try {
    file = decodeURIComponent(new URL(artifact.url).pathname.split('/').pop() || '');
  } catch {
    return false;
  }
  return HANDOFF.test(artifact.label || '') || HANDOFF.test(file);
}

/** The prompt a handoff starts with: the brief itself when it could be read, else a pointer to it. */
export function handoffPrompt(artifact, text = '') {
  const brief = String(text || '').trim();
  if (brief) return `${brief}\n\n(Handoff brief: ${artifact.url})`;
  return `Read the handoff brief at ${artifact.url} and take it from there. It says what you own, where things stand and what to do first.`;
}

/**
 * Start on a handoff: Start work opens at once, pointing at the brief; once the brief (a text file on the artifact
 * host) is read, it becomes the prompt, but only in that same sheet and only while its prompt is still the pointer,
 * so a slow read never overwrites another sheet or the owner's edits (Codex review on #558).
 */
export async function startFromHandoff(store, artifact, projectId = null) {
  const pointer = handoffPrompt(artifact);
  startWith(store, pointer, projectId);
  const sheet = store.state.startWork?.commandId;
  if (!TEXT_DOC.test(new URL(artifact.url).pathname)) return;
  let text = '';
  try {
    const res = await fetch(artifact.url, { credentials: 'omit' });
    if (res.ok) text = await res.text();
  } catch {
    return; // another origin, or the artifact host is down: the pointer will do
  }
  const sw = store.state.startWork;
  if (!text.trim() || !sw || sw.commandId !== sheet || sw.sending || sw.form.prompt !== pointer) return;
  store.setStartField('prompt', handoffPrompt(artifact, text));
}
