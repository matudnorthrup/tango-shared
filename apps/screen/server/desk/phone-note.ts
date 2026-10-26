import { createDraftCompiler, resolveDraftDestination, type DraftCompiler, type DraftContext, type DraftDestination } from '@tango/tango-voice/live/draft-mode';
import { loadOperatorProfiles, selectOperatorProfile, resolveProfileAgents } from '@tango/tango-voice/live/operator-profile';
import { createCodexResponsesCaller } from '@tango/tango-voice/live/responses-caller';
import type { DeskCore } from './core.js';

export interface PhoneNoteRequest { text?: string; noteId: string; answer?: string }
export interface PhoneNoteResult { status: 'sent' | 'ask' | 'held'; say: string; itemId?: string }
interface Note extends PhoneNoteRequest { text: string; phase: 'routing' | 'awaiting' | 'delivering' | 'done'; question?: string; expiresAt?: number; message?: string; result?: PhoneNoteResult }
export interface PhoneNoteRuntime { context: DraftContext; compile: DraftCompiler }
export interface PhoneNoteDelivery { ok: boolean; itemId?: string; notDelivered?: boolean }
export interface PhoneNoteDeps {
  core: DeskCore;
  runtime(): Promise<PhoneNoteRuntime>;
  deliver(destination: DraftDestination, message: string, commandId: string): Promise<PhoneNoteDelivery>;
  timeoutMs?: number;
  canStartAgent?: boolean;
  canStartRepo?: boolean;
}
/** Spoken receipts use destination fields, never the visual card label. */
export function phoneNoteReceipt(destination: DraftDestination): string {
  const speak = (text: string) => text.replace(/·/g, ',').replace(/\s+/g, ' ').trim().slice(0, 180);
  const name = speak(destination.name);
  const title = destination.title ? speak(destination.title) : '';
  const detail = title ? `: ${title}` : '';
  switch (destination.kind) {
    case 'new_loom': return `Started a ${speak(destination.repo || 'coding')} thread${detail}.`;
    case 'new_thread': return `Sent to ${name}, new thread${detail}.`;
    case 'thread':
    case 'item': return `Sent to ${name}${title ? `, thread${detail}` : ''}.`;
    case 'home': return `Sent to ${name}.`;
  }
}

export function parsePhoneNote(body: unknown): PhoneNoteRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.noteId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(b.noteId)) return null;
  const valid = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 16000;
  if (b.answer !== undefined) {
    if (!valid(b.answer) || (b.text !== undefined && !valid(b.text))) return null;
    return { noteId: b.noteId, answer: (b.answer as string).trim() };
  }
  return valid(b.text) ? { text: (b.text as string).trim(), noteId: b.noteId } : null;
}

/** Subscription only: loading a missing/invalid profile fails closed, never onto an API key. */
export async function phoneNoteRuntime(core: DeskCore, repos: string[]): Promise<PhoneNoteRuntime> {
  const profile = selectOperatorProfile(loadOperatorProfiles(), process.env.SCREEN_VOICE_OPERATOR);
  if (profile.auth !== 'codex' && !profile.auth.startsWith('codex:')) throw new Error('Phone notes require the ChatGPT subscription route');
  const { agents } = resolveProfileAgents(profile);
  const rows = core.items().filter(item => item.disposition === 'active' && item.replyable && !item.id.startsWith('phone:'));
  const byHandle = new Map(rows.map((item, i) => [`i${i + 1}`, item]));
  const context: DraftContext = {
    input: { agents, tasks: [], threads: [], transcript: [], now: Date.now(), startPlace: null, loomRepos: repos,
      desk: { items: [...byHandle].map(([handle, item]) => ({ handle, agentName: item.agentName, place: item.place, about: item.summary?.about ?? null, step: item.nextStep, line: (item.ask ?? item.summary?.gist ?? '').slice(0, 80), threadId: item.threadId })) } },
    // All existing conversations use the desk reply command, including agent home chapters.
    resolveItem: handle => { const row = byHandle.get(handle); return row ? { id: row.id, agentId: row.agentId, agentName: row.agentName, place: row.place, threadId: row.threadId, isAgent: false } : null; },
  };
  return { context, compile: createDraftCompiler(createCodexResponsesCaller({ codexHome: profile.auth.startsWith('codex:') ? profile.auth.slice(6) : undefined }), { people: profile.people }) };
}

/** Durable receipts precede side effects. A restart or an uncertain send can never replay delivery. */
export class PhoneNotes {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<PhoneNoteResult>>();
  constructor(private readonly deps: PhoneNoteDeps) {
    // Resume interrupted requests as held drafts; never replay an uncertain side effect.
    for (const key of deps.core.store.markerKeys('phone-note:')) {
      const note = this.read(key.slice('phone-note:'.length));
      if (note?.phase === 'awaiting') this.arm(note);
      else if (note && note.phase !== 'done') this.hold(note, note.phase === 'delivering');
    }
  }
  /** Stop timers when the service is disposed; durable deadlines survive recreation. */
  close(): void { for (const timer of this.pending.values()) clearTimeout(timer); this.pending.clear(); }
  private arm(note: Note): void {
    const remaining = (note.expiresAt ?? 0) - Date.now();
    if (remaining <= 0) { this.hold(note); return; }
    const timer = setTimeout(() => {
      this.pending.delete(note.noteId);
      const fresh = this.read(note.noteId);
      if (fresh?.phase === 'awaiting') this.hold(fresh);
    }, remaining);
    timer.unref?.(); this.pending.set(note.noteId, timer);
  }
  private unresolved(note: Note, question = "Who's it for?"): PhoneNoteResult {
    if (note.answer) return this.hold(note);
    note.phase = 'awaiting'; note.question = question.replace(/\s+/g, ' ').trim().slice(0, 240) || "Who's it for?";
    note.expiresAt = Date.now() + 120000;
    note.result = { status: 'ask', say: note.question }; this.write(note); this.arm(note);
    return note.result;
  }
  private read(id: string): Note | null { const raw = this.deps.core.store.marker(`phone-note:${id}`); return raw ? JSON.parse(raw) as Note : null; }
  private write(note: Note) { this.deps.core.store.setMarker(`phone-note:${note.noteId}`, JSON.stringify(note)); }
  private originalText(note: Note): string { return note.text + (note.answer ? `\n\nClarification: ${note.answer}` : ''); }
  private hold(note: Note, uncertain = false): PhoneNoteResult {
    clearTimeout(this.pending.get(note.noteId)); this.pending.delete(note.noteId);
    const core = this.deps.core; const itemId = `phone:${note.noteId}`; const at = Date.now();
    const say = uncertain ? 'Saved it on the desk; delivery is unconfirmed. Check before sending again.' : 'Saved it on the desk; pick where it goes there.';
    core.ensureItem({ id: itemId, source: 'system', kind: 'thread', conversationKey: itemId, agentId: 'phone-note', agentName: 'Phone note', place: 'Phone note', createdAt: at, facts: { openAsk: { text: uncertain ? 'Check delivery before sending again' : 'Choose a destination for this phone note', at: at + 1, kind: 'do' }, phoneNote: { noteId: note.noteId, text: note.message || this.originalText(note), uncertain } } }, 'owner');
    core.recordMessage(itemId, { messageId: `${itemId}:text`, author: 'owner', at, text: this.originalText(note) });
    core.recordMessage(itemId, { messageId: `${itemId}:held`, author: 'agent', at: at + 1, text: say });
    core.settle(itemId, { activity: { what: 'phone note held', at: at + 1 }, summarize: false });
    const result: PhoneNoteResult = { status: 'held', say, itemId };
    note.result = result;
    if (!uncertain) note.phase = 'done';
    this.write(note); return result;
  }
  private finishHeld(note: Note): void {
    const core = this.deps.core; const id = `phone:${note.noteId}`;
    const item = core.store.item(id); if (!item || !note.result) return;
    const at = Date.now();
    core.recordMessage(id, { messageId: `${id}:sent`, author: 'agent', at, text: note.result.say });
    core.setFacts(id, { openAsk: null, phoneNote: { noteId: note.noteId, text: note.message || this.originalText(note), uncertain: false, sent: note.result.say } },
      { summary: item.summary ? { ...item.summary, gist: note.result.say, paragraph: null, whatsNew: null, ask: null, step: 'fyi', options: [] } : null });
    core.settle(id, { done: true, summarize: false });
  }
  async choices(): Promise<Array<{ key: string; destination: DraftDestination }>> {
    const { context } = await this.deps.runtime();
    const items = (context.input.desk?.items ?? []).flatMap(item => {
      const ref = context.resolveItem(item.handle);
      return ref ? [{ key: `item:${ref.id}`, destination: { kind: 'item' as const, itemId: ref.id, agentId: ref.agentId, name: ref.agentName, label: `${ref.agentName}: ${ref.place ?? 'conversation'}` } }] : [];
    });
    return [...items,
      ...(this.deps.canStartAgent === false ? [] : context.input.agents).map(agent => ({ key: `agent:${agent.id}`, destination: { kind: 'new_thread' as const, agentId: agent.id, name: agent.name, label: `${agent.name}: new thread` } })),
      ...(this.deps.canStartRepo === false ? [] : context.input.loomRepos ?? []).map(repo => ({ key: `repo:${repo}`, destination: { kind: 'new_loom' as const, agentId: 'loom', name: 'Loom', repo, label: `${repo}: new coding thread` } }))];
  }
  async sendHeld(id: string, key: string): Promise<PhoneNoteResult | null> {
    const note = this.read(id);
    if (!note || note.phase !== 'done' || note.result?.status !== 'held') return null;
    const choice = (await this.choices()).find(choice => choice.key === key);
    if (!choice) return null;
    // Choices loads asynchronously; recheck the receipt before taking the send lock.
    const fresh = this.read(id);
    if (fresh?.phase !== 'done' || fresh.result?.status !== 'held') return null;
    note.phase = 'delivering'; this.write(note);
    const sent = await this.deps.deliver(choice.destination, note.message || this.originalText(note), `phone-${id}`).catch((): PhoneNoteDelivery => ({ ok: false }));
    if (!sent.ok) return this.hold(note, !sent.notDelivered);
    note.phase = 'done'; note.result = { status: 'sent', say: phoneNoteReceipt(choice.destination) }; this.write(note);
    this.finishHeld(note);
    return note.result;
  }
  submit(request: PhoneNoteRequest): Promise<PhoneNoteResult> {
    const running = this.running.get(request.noteId); if (running) return running;
    const saved = this.read(request.noteId);
    let note: Note;
    if (saved) {
      if (saved.phase !== 'awaiting' || !request.answer) return Promise.resolve(saved.result ?? this.hold(saved, saved.phase === 'delivering'));
      if (Date.now() >= (saved.expiresAt ?? 0)) return Promise.resolve(this.hold(saved));
      clearTimeout(this.pending.get(saved.noteId)); this.pending.delete(saved.noteId);
      note = { ...saved, answer: request.answer, message: undefined, phase: 'routing', result: undefined }; this.write(note);
    } else {
      if (request.answer || !request.text) return Promise.resolve({ status: 'held', say: 'That note is unavailable. Please dictate a new note.' });
      note = { ...request, text: request.text, phase: 'routing' }; this.write(note);
    }
    const work = this.run(note).finally(() => this.running.delete(note.noteId));
    this.running.set(note.noteId, work); return work;
  }
  private async run(note: Note): Promise<PhoneNoteResult> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<PhoneNoteResult>(resolve => { timer = setTimeout(() => { expired = true; resolve(this.hold(note, note.phase === 'delivering')); }, this.deps.timeoutMs ?? 14000); });
    const work = (async (): Promise<PhoneNoteResult> => {
      try {
        const { context, compile } = await this.deps.runtime();
        if (expired) return note.result!;
        const clarifications = note.answer ? [{ question: note.question || "Who's it for?", answer: note.answer }] : [];
        const result = await compile({ ...context.input, fragments: [note.text], clarifications });
        if (expired) return note.result!;
        note.message = result.message.trim();
        // A model-selected agent must be named by the owner. Topic-only routing stays held.
        const spoken = ` ${[note.text, note.answer ?? ''].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
        const named = context.input.agents.find(agent => agent.id === result.agentId && [agent.name, ...(agent.aliases ?? [])].some(name => spoken.includes(` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `)));
        if (result.item && !context.resolveItem(result.item)) return this.unresolved(note);
        if (result.agentId && !result.item && !named) return this.unresolved(note);
        if (result.threadId && !result.item && !(context.input.desk?.items ?? []).some(item => item.threadId === result.threadId && item.agentName === named?.name)) return this.unresolved(note);
        const { destination } = resolveDraftDestination(result, context, { agents: context.input.agents, startSpeech: note.text, fragments: [note.text], clarifications, newLoom: false, newThread: false, targetItem: null, target: null });
        if (!destination || (result.newLoomRepo && destination.kind !== 'new_loom') || result.questions.length || !note.message) return this.unresolved(note, result.questions[0]);
        note.phase = 'delivering'; this.write(note);
        const sent = await this.deps.deliver(destination, note.message, `phone-${note.noteId}`);
        if (!sent.ok) return this.hold(note, !sent.notDelivered);
        note.phase = 'done';
        note.result = { status: 'sent', say: phoneNoteReceipt(destination), ...(sent.itemId ? { itemId: sent.itemId } : {}) };
        this.write(note);
        if (expired) this.finishHeld(note);
        return note.result;
      } catch { return expired ? note.result! : this.hold(note, note.phase === 'delivering'); }
    })();
    try { return await Promise.race([timeout, work]); } finally { clearTimeout(timer!); }
  }
}
