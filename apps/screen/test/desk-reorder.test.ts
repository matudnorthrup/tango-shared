import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { dropIndex, settleOffset, shiftFor } from '../public/desk/reorder.js';

// The drag math behind every reorderable list: where a held row lands, how the rows it passes make
// room, and where it settles. Rows of uneven height, stacked with no gap.
const heights = [40, 60, 40, 50];
const tops = [0, 40, 100, 140];

describe('reorder drag', () => {
  it('lands where its middle passes the other rows’ middles', () => {
    expect(dropIndex(tops, heights, 0, 0)).toBe(0);
    expect(dropIndex(tops, heights, 0, 49)).toBe(0); // middle 69, row 1's middle is 70
    expect(dropIndex(tops, heights, 0, 51)).toBe(1);
    expect(dropIndex(tops, heights, 0, 500)).toBe(3);
    expect(dropIndex(tops, heights, 3, -500)).toBe(0);
    expect(dropIndex(tops, heights, 2, -21)).toBe(2); // middle 99: still below row 1's middle (70)
    expect(dropIndex(tops, heights, 2, -51)).toBe(1); // middle 69: past row 1's, not row 0's (20)
  });

  it('the passed rows slide by the held row’s height, toward where it came from', () => {
    // Row 0 held over slot 2: rows 1 and 2 move up, row 3 stays.
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2, 40))).toEqual([0, -40, -40, 0]);
    // Row 3 held over slot 1: rows 1 and 2 move down.
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1, 50))).toEqual([0, 50, 50, 0]);
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 2, 2, 40))).toEqual([0, 0, 0, 0]);
  });

  it('settles with its new top where the rows it passed left room', () => {
    // Row 0 (40 tall) to slot 2: its bottom meets row 2's old bottom (140), so its top is 100.
    expect(settleOffset(tops, heights, 0, 2)).toBe(100);
    // Row 3 to slot 1: its top takes row 1's old top.
    expect(settleOffset(tops, heights, 3, 1)).toBe(-100);
    expect(settleOffset(tops, heights, 1, 1)).toBe(0);
  });
});
