import { loadApps } from './app-list.js';
import { appChoices, executeNavigator } from './navigator-context.js';

const api = path => new URL(`../api/desk/${path}`, import.meta.url);
export async function appVoiceRequest(path, body, signal) {
  const response = await fetch(api(path), { signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('Voice conversation unavailable.');
  return response.json();
}
const normalized = text => text.toLowerCase().replace(/[.!?]+$/, '').replace(/^tango\s+/, '').trim();
/** App navigation uses the navigator's id-only catalog and execution guard. Other words are dictation. */
export function appVoiceCommand(text, apps) {
  const match = /^(?:please\s+)?(?:go\s+to|show\s+me|switch\s+to|take\s+me\s+to|open)\s+(.+)$/i.exec(text.trim());
  if (!match) return null;
  const target = normalized(match[1]);
  const choices = appChoices(apps);
  const matches = choices.filter(c => normalized(c.label) === target || normalized(c.action.id) === target);
  return { context: { place: 'App', choices }, action: matches.length === 1 ? matches[0].action : null };
}

/** Adapter for the shared runtime: ordinary replies, local drafts and scoped reply captions. */
export function createAppVoiceAdapter({ app, itemId, caption, notify, request = appVoiceRequest, apps = loadApps, navigateApp, interval = 1500 }) {
  let draft = '', polling, disposed = false, generation = 0;
  const pending = new AbortController();
  const stopWatching = () => { ++generation; clearTimeout(polling); };
  const store = {
    state: { role: 'full', presentation: {}, voiceFocusItem: null },
    subscribe: () => () => {},
    set: value => Object.assign(store.state, value),
    draftFor: () => draft,
    setDraft: (_id, text) => { draft = text; caption({ speaker: 'owner', text }); },
    toast: notify,
    async sendReply(id) {
      const text = draft.trim();
      if (!text || disposed) return { status: 'failed' };
      const command = appVoiceCommand(text, await apps());
      if (disposed) return { status: 'failed' };
      if (command) {
        if (!command.action) { notify('No single matching app. Say its app name.'); return { status: 'failed' }; }
        const ok = await executeNavigator(null, { action: command.action }, command.context, { apps, ...(navigateApp ? { navigateApp } : {}) });
        return { status: ok ? 'sent' : 'failed' };
      }
      // Take the baseline before sending, so even a fast reply is a new message.
      const before = await request(`items/${encodeURIComponent(id)}`, undefined, pending.signal);
      if (disposed) return { status: 'failed' };
      const seen = new Set((before.messages || []).map(m => m.messageId));
      let result;
      try { result = await request('commands', { commandId: crypto.randomUUID(), type: 'reply', itemId: id, args: { text } }, pending.signal); }
      catch { notify('Delivery could not be confirmed. Check the conversation before sending again.'); return { status: 'failed', transport: true }; }
      if (disposed) return result;
      if (result.status !== 'sent') { notify(result.outcome?.delivery === 'unknown' ? 'Delivery could not be confirmed. Check the conversation before sending again.' : result.error || 'Reply was not sent.'); return result; }
      draft = ''; stopWatching(); const turn = generation, deadline = Date.now() + 10 * 60_000;
      const poll = async () => {
        if (disposed || turn !== generation) return;
        try {
          const detail = await request(`items/${encodeURIComponent(id)}`, undefined, pending.signal);
          if (disposed || turn !== generation) return;
          const reply = (detail.messages || []).filter(m => m.author === 'agent' && !seen.has(m.messageId)).at(-1);
          if (reply) { caption({ speaker: 'agent', name: detail.item?.agentName || app.name, text: reply.text }); return; }
        } catch { if (disposed) return; }
        if (Date.now() < deadline) polling = setTimeout(poll, interval);
        else notify('The reply is still pending. Open the conversation to follow it.');
      };
      void poll();
      return result;
    },
    dispose() { disposed = true; stopWatching(); pending.abort(); },
  };
  return store;
}
