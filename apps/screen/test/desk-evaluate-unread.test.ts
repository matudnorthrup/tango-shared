import { describe, expect, it } from 'vitest';
import { predict } from '../public/desk/optimistic.js';
import { initialAttention, reduceAttention } from '../server/desk/attention.js';
import { deskStatus } from '../server/desk/status.js';

describe('opening only reads words', () => {
  it.each(['active', 'snoozed', 'parked', 'done'] as const)('%s keeps placement and pill', disposition => {
    const item = { id: 'a', seen: 'new' as const, disposition, facts: { openAsk: { text: 'Choose', at: 100 } } };
    const before = { ...item, status: deskStatus(item, 200) };
    const predicted = predict('seen', before, { via: 'viewed' });
    expect(predicted).toMatchObject({ seen: 'seen', disposition, status: { pill: before.status.pill, countsForOwner: before.status.countsForOwner, unread: false } });
    const attention = { ...initialAttention('a', 100), disposition, seen: 'new' as const };
    const read = reduceAttention(attention, { itemId: 'a', at: 200, type: 'seen', actor: 'owner', payload: { via: 'viewed' } } as never);
    expect(read).toMatchObject({ disposition, seen: 'seen' });
    expect(deskStatus({ ...item, seen: read.seen }, 200).pill).toBe(before.status.pill);
  });
});
