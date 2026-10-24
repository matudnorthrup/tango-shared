import { optionRow } from '../../public/desk/brief-model.js';
import type { PushSender } from '../apns.js';
import type { DeskCore } from './core.js';
import { DeskDevices } from './devices.js';
import type { DeskItem, PendingRequest } from './types.js';

export function decisionPayload(item: DeskItem, pending: PendingRequest) {
  const brief = pending.brief;
  if (!brief || !/^D-\d+$/.test(brief.id) || pending.requestId !== `decision:${brief.id}` || !Number.isInteger(brief.revision)) return null;
  const question = pending.questions.find(q => q.id === 'decision');
  if (!question || question.multiSelect || question.options.length < 1) return null;
  const options = question.options.map((o, index) => {
    const row = optionRow(o, brief, index);
    return { key: row.key ?? String.fromCharCode(65 + index), label: row.title, answer: o.label };
  });
  const locked = !!brief.tripwire || brief.level === 1;
  const payload = {
    aps: { alert: { title: locked ? 'Decision needs you' : brief.about || item.summary?.title || item.place || item.agentName,
      body: locked ? 'Unlock to read and answer.' : `${question.question}\n${options.map(o => `${o.key} · ${o.label}`).join('\n')}\nTap to open.` },
      category: `decision-${options.length}${locked ? '-locked' : ''}`, sound: 'default', 'thread-id': brief.id },
    openedAt: pending.at, itemId: item.id, requestId: pending.requestId, decisionId: brief.id, revision: brief.revision!, options,
  };
  // Preserve complete answer strings and revision. Oversized briefs still get an Open-only alert.
  if (options.length > 3 || Buffer.byteLength(JSON.stringify(payload)) > 4000 || options.some((o, i) => o.key !== String.fromCharCode(65 + i))) {
    payload.aps.alert.title = payload.aps.alert.title.slice(0, 120);
    payload.aps.alert.body = locked ? 'Unlock to read and answer.' : 'A decision needs you. Open the desk to read all options.';
    payload.aps.category = locked ? 'decision-open-locked' : 'decision-open';
    payload.options = [];
  }
  return payload;
}

/** Only the counted row pushes: source rows with carriedBy and non-counting mirrors never notify. */
export function pendingPushes(items: DeskItem[]) {
  const result = new Map<string, NonNullable<ReturnType<typeof decisionPayload>>>();
  for (const item of items) {
    if (item.hidden || item.disposition !== 'active') continue;
    const candidates = [
      ...(!item.facts.carriedBy && item.facts.pending?.brief ? [item.facts.pending] : []),
      ...(item.facts.carried ?? []).filter(c => c.counts).map(c => c.pending),
    ];
    for (const pending of candidates) {
      // A pending copy attached only as a non-counting carried brief is a mirror, too.
      if (item.facts.carried?.some(c => c.pending.requestId === pending.requestId && !c.counts)) continue;
      const payload = decisionPayload(item, pending);
      if (payload) result.set(payload.decisionId, payload);
    }
  }
  return [...result.values()];
}

export class DeskPush {
  private running = false;
  private closed = false;
  close(): void { this.closed = true; }
  constructor(private readonly core: Pick<DeskCore, 'items'>, private readonly devices: DeskDevices,
    private readonly sender: PushSender | null, private readonly log: (event: string, data?: Record<string, unknown>) => void) {}
  async sync(): Promise<void> {
    if (!this.sender || this.running || this.closed) return;
    this.running = true;
    try {
      for (const payload of pendingPushes(this.core.items())) {
        for (const device of this.devices.all()) {
          if (this.closed) return;
          if (payload.openedAt < device.registeredAt || device.bundleId !== this.sender.bundleId || this.devices.sent(device, payload.decisionId, payload.revision)) continue;
          // Re-check after every await: an answered or revised brief must not reach the next device.
          if (!pendingPushes(this.core.items()).some(p => p.decisionId === payload.decisionId && p.revision === payload.revision)) break;
          try {
            const result = await this.sender.send(device, { ...payload, deskId: this.devices.id }, payload.decisionId);
            if (this.closed) return;
            if (result.status === 410 || result.reason === 'BadDeviceToken') this.devices.drop(device);
            else if (result.status === 200) this.devices.mark(device, payload.decisionId, payload.revision);
            else this.log('desk.push.error', { status: result.status, reason: result.reason });
          } catch { if (!this.closed) this.log('desk.push.error', { reason: 'transport failure' }); }
        }
      }
    } catch { if (!this.closed) this.log('desk.push.error', { reason: 'delivery scan failed' }); }
    finally { this.running = false; }
  }
}
