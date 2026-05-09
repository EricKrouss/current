import { describe, expect, it } from 'vitest';
import {
  buildEmojiToneIndex,
  getEmojiToneGroupForEntry,
  getPreferredEmojiForEntry,
  shouldShowEmojiEntry,
  stripEmojiSkinTone,
} from './emoji-skin-tones';
import type { EmojiEntry } from './emoji-catalog';

const catalog: EmojiEntry[] = [
  { emoji: '😀', name: 'grinning face', keywords: ['face'] },
  { emoji: '👍', name: 'thumbs up', keywords: ['hand'] },
  { emoji: '👍🏻', name: 'thumbs up: light skin tone', keywords: ['hand'] },
  { emoji: '👍🏽', name: 'thumbs up: medium skin tone', keywords: ['hand'] },
  { emoji: '👍🏿', name: 'thumbs up: dark skin tone', keywords: ['hand'] },
  { emoji: '🧑‍💻', name: 'technologist', keywords: ['person'] },
  { emoji: '🧑🏽‍💻', name: 'technologist: medium skin tone', keywords: ['person'] },
];

describe('emoji skin tone helpers', () => {
  it('normalizes skin tone variants to their base emoji', () => {
    expect(stripEmojiSkinTone('👍🏿')).toBe('👍');
    expect(stripEmojiSkinTone('🧑🏽‍💻')).toBe('🧑‍💻');
  });

  it('collapses tone variants and applies saved per-emoji defaults', () => {
    const toneIndex = buildEmojiToneIndex(catalog);
    const thumbsUp = catalog[1]!;
    const darkThumbsUp = catalog[4]!;

    expect(shouldShowEmojiEntry(thumbsUp, toneIndex)).toBe(true);
    expect(shouldShowEmojiEntry(darkThumbsUp, toneIndex)).toBe(false);
    expect(getEmojiToneGroupForEntry(thumbsUp, toneIndex)?.variants.map((variant) => variant.emoji)).toEqual([
      '👍',
      '👍🏻',
      '👍🏽',
      '👍🏿',
    ]);
    expect(getPreferredEmojiForEntry(thumbsUp, toneIndex, { '👍': '👍🏿' })).toBe('👍🏿');
  });
});
