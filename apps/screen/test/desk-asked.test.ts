import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module, no types
import { askedOf } from '../public/desk/util.js';

describe('"You asked"', () => {
  const summary = { gist: 'Checked the oil vials.', ownerAsk: 'Research oil vials', at: 2_000 };

  it("is the summary's words when the summary covers the owner's last request", () => {
    expect(askedOf({ summary, facts: { lastOwnerRequest: { text: 'research vials for oil', at: 1_000 } } })).toBe('Research oil vials');
  });

  it("is the owner's own newest words while the summary still describes the request before", () => {
    const item = { summary, facts: { lastOwnerRequest: { text: 'Now make  it wider,\nas far back as you can', at: 3_000 } } };
    expect(askedOf(item)).toBe('Now make it wider, as far back as you can');
  });

  it('compares by when the desk filed the request, not when it was written', () => {
    const late = { text: 'and the rear speakers too', at: 1_500, filedAt: 2_500 };
    expect(askedOf({ summary, facts: { lastOwnerRequest: late } })).toBe('and the rear speakers too');
  });

  it('clips a long request, and skips an images-only one', () => {
    const long = 'word '.repeat(60).trim();
    expect(askedOf({ summary: null, facts: { lastOwnerRequest: { text: long, at: 3_000 } } })).toHaveLength(160);
    expect(askedOf({ summary, facts: { lastOwnerRequest: { text: '(2 images)', at: 3_000, images: 2, words: false } } })).toBe('Research oil vials');
  });

  it('keeps the summary saying there was no ask once it covers the request', () => {
    expect(askedOf({ summary: { ...summary, ownerAsk: null }, facts: { lastOwnerRequest: { text: 'thanks', at: 1_000 } } })).toBeNull();
    expect(askedOf({ summary: null, facts: {} })).toBeNull();
  });
});
