import { describe, expect, it } from 'vitest';
import { EMOJI_CATALOG } from './emoji-catalog';

describe('emoji catalog', () => {
  it('includes the full Unicode emoji-test catalog shape used by the modal', () => {
    const emojis = new Set(EMOJI_CATALOG.map((entry) => entry.emoji));

    expect(EMOJI_CATALOG.length).toBeGreaterThan(3_000);
    expect(emojis.has('😀')).toBe(true);
    expect(emojis.has('👍🏿')).toBe(true);
    expect(emojis.has('🇺🇸')).toBe(true);
    expect(emojis.has('🏳️‍🌈')).toBe(true);
    expect(emojis.has('👨‍👩‍👧‍👦')).toBe(true);
    expect(emojis.has('🧑‍💻')).toBe(true);
  });
});
