import { describe, expect, it } from 'vitest';
import { ownerReceipts } from '../server/desk/owner-receipts.js';
import type { DeskEvent, DeskMessage } from '../server/desk/types.js';
const owner = (id: string, at: number, text = 'Continue', meta = {}): DeskMessage => ({ messageId: id, itemId: 'i', author: 'owner', at, text, meta });
const accepted = (id: string, at: number, text = 'Continue'): DeskEvent => ({ seq: at, at, itemId: 'i', actor: 'owner', type: 'source.owner_posted', commandId: id, undoesSeq: null, payload: { text, startedAt: at - 10 } });

describe('durable unanswered owner receipts', () => {
  it('shows idle sends before the source echo and reconciles by command identity', () => {
    const events = [accepted('c1', 30)];
    expect(ownerReceipts([], events, 10).ownerReceipts).toMatchObject([{ commandId: 'c1', text: 'Continue', status: 'delivered' }]);
    const messages = [owner('m1', 25, 'Continue', { commandId: 'c1', queued: true })];
    expect(ownerReceipts(messages, events, 10).ownerReceipts).toMatchObject([{ messageId: 'm1', commandId: 'c1', status: 'queued' }]);
    messages[0].meta = { commandId: 'c1', queued: false, runStartedAt: 35 };
    expect(ownerReceipts(messages, events, 10).ownerReceipts[0].status).toBe('picked-up');
    expect(ownerReceipts(messages, events, 40)).toEqual({ ownerReceipts: [], receiptCommandIds: ['c1'] });
  });
  it('keeps both rapid identical sends and pairs legacy echoes one-to-one', () => {
    const events = [accepted('c1', 30), accepted('c2', 40)];
    const messages = [owner('m1', 25), owner('m2', 35)];
    expect(ownerReceipts(messages, events, 10).ownerReceipts.map(r => [r.messageId, r.commandId])).toEqual([['m1', 'c1'], ['m2', 'c2']]);
  });
  it('never labels a mid-turn message picked up from the old run, or hides queued words behind that run’s reply', () => {
    expect(ownerReceipts([owner('m', 20, 'Next', { runStartedAt: 10 })], [], 5).ownerReceipts[0].status).toBe('delivered');
    expect(ownerReceipts([owner('m', 20, 'Next', { queued: true })], [], 30).ownerReceipts[0].status).toBe('queued');
    expect(ownerReceipts([owner('m', 20, 'Next', { runStartedAt: 40 })], [], 30).ownerReceipts[0].status).toBe('picked-up');
  });
  it('includes exact Screen words and chosen options but excludes peer mail', () => {
    const screen = '[Screen] I tapped “Use compact” on “Layout”.';
    const messages = [owner('s', 20, screen), owner('a', 21, 'Decision D-4: A · Compact', { answers: 'D-4' }), owner('mail', 22, 'Check CI', { mail: { kind: 'in', peer: 'Worker' } })];
    expect(ownerReceipts(messages, [], 10).ownerReceipts.map(r => r.text)).toEqual([screen, 'Decision D-4: A · Compact']);
  });
  it('does not pair an unrelated identical message from before a send', () => {
    expect(ownerReceipts([owner('old', 5)], [accepted('c1', 30)], 10).ownerReceipts).toMatchObject([{ messageId: 'command:c1' }]);
  });
});

it('pairs an image-only legacy echo with its accepted placeholder exactly once', () => {
  const message = { ...owner('images', 25, ''), attachments: [{ url: '/one.png', name: 'one.png' }, { url: '/two.png', name: 'two.png' }] };
  const result = ownerReceipts([message], [accepted('c-images', 30, '(2 images)')], 10);
  expect(result.ownerReceipts).toEqual([{ messageId: 'images', commandId: 'c-images', at: 25, text: '(2 images)', status: 'delivered' }]);
});
