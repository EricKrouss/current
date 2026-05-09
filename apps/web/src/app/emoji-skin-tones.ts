import type { EmojiEntry } from './emoji-catalog';

export type EmojiToneId = 'default' | 'light' | 'medium-light' | 'medium' | 'medium-dark' | 'dark' | 'mixed';

export type EmojiToneVariant = {
  emoji: string;
  name: string;
  toneId: EmojiToneId;
  label: string;
};

export type EmojiToneGroup = {
  baseEmoji: string;
  baseName: string;
  variants: EmojiToneVariant[];
};

export type EmojiToneIndex = {
  groupsByBase: Map<string, EmojiToneGroup>;
  hiddenToneEmojis: Set<string>;
};

const SKIN_TONE_MODIFIERS = ['🏻', '🏼', '🏽', '🏾', '🏿'] as const;
const SKIN_TONE_PATTERN = /[🏻🏼🏽🏾🏿]/gu;
const TONE_BY_MODIFIER = new Map<string, EmojiToneId>([
  ['🏻', 'light'],
  ['🏼', 'medium-light'],
  ['🏽', 'medium'],
  ['🏾', 'medium-dark'],
  ['🏿', 'dark'],
]);
const TONE_LABELS: Record<EmojiToneId, string> = {
  default: 'Default',
  light: 'Light skin tone',
  'medium-light': 'Medium-light skin tone',
  medium: 'Medium skin tone',
  'medium-dark': 'Medium-dark skin tone',
  dark: 'Dark skin tone',
  mixed: 'Mixed skin tones',
};
const TONE_ORDER: EmojiToneId[] = ['default', 'light', 'medium-light', 'medium', 'medium-dark', 'dark', 'mixed'];

export function stripEmojiSkinTone(emoji: string): string {
  return emoji.replace(SKIN_TONE_PATTERN, '');
}

export function hasEmojiSkinTone(emoji: string): boolean {
  return SKIN_TONE_MODIFIERS.some((modifier) => emoji.includes(modifier));
}

function getEmojiToneId(emoji: string): EmojiToneId {
  const tones = new Set<EmojiToneId>();
  for (const modifier of SKIN_TONE_MODIFIERS) {
    if (emoji.includes(modifier)) {
      tones.add(TONE_BY_MODIFIER.get(modifier) ?? 'mixed');
    }
  }

  if (tones.size === 0) {
    return 'default';
  }

  if (tones.size === 1) {
    return [...tones][0] ?? 'mixed';
  }

  return 'mixed';
}

function getToneLabel(entry: EmojiEntry, toneId: EmojiToneId): string {
  if (toneId !== 'mixed') {
    return TONE_LABELS[toneId];
  }

  const skinToneLabel = entry.name.split(':').at(-1)?.trim();
  return skinToneLabel && skinToneLabel.includes('skin tone') ? skinToneLabel : TONE_LABELS.mixed;
}

function toToneVariant(entry: EmojiEntry): EmojiToneVariant {
  const toneId = getEmojiToneId(entry.emoji);
  return {
    emoji: entry.emoji,
    name: entry.name,
    toneId,
    label: getToneLabel(entry, toneId),
  };
}

export function buildEmojiToneIndex(catalog: EmojiEntry[]): EmojiToneIndex {
  const buckets = new Map<string, EmojiEntry[]>();
  for (const entry of catalog) {
    const baseEmoji = stripEmojiSkinTone(entry.emoji);
    const bucket = buckets.get(baseEmoji) ?? [];
    bucket.push(entry);
    buckets.set(baseEmoji, bucket);
  }

  const groupsByBase = new Map<string, EmojiToneGroup>();
  const hiddenToneEmojis = new Set<string>();

  for (const [baseEmoji, entries] of buckets) {
    if (!entries.some((entry) => hasEmojiSkinTone(entry.emoji))) {
      continue;
    }

    const representative = entries.find((entry) => entry.emoji === baseEmoji) ?? entries[0];
    const variants = entries
      .map(toToneVariant)
      .sort((left, right) => TONE_ORDER.indexOf(left.toneId) - TONE_ORDER.indexOf(right.toneId));

    groupsByBase.set(baseEmoji, {
      baseEmoji,
      baseName: representative?.name ?? baseEmoji,
      variants,
    });

    for (const entry of entries) {
      if (entry.emoji !== representative?.emoji) {
        hiddenToneEmojis.add(entry.emoji);
      }
    }
  }

  return {
    groupsByBase,
    hiddenToneEmojis,
  };
}

export function shouldShowEmojiEntry(entry: EmojiEntry, toneIndex: EmojiToneIndex): boolean {
  return !toneIndex.hiddenToneEmojis.has(entry.emoji);
}

export function getEmojiToneGroupForEntry(entry: EmojiEntry, toneIndex: EmojiToneIndex): EmojiToneGroup | null {
  return toneIndex.groupsByBase.get(stripEmojiSkinTone(entry.emoji)) ?? null;
}

export function getPreferredEmojiForEntry(
  entry: EmojiEntry,
  toneIndex: EmojiToneIndex,
  defaults: Record<string, string>,
): string {
  const group = getEmojiToneGroupForEntry(entry, toneIndex);
  if (!group) {
    return entry.emoji;
  }

  const savedDefault = defaults[group.baseEmoji];
  if (savedDefault && group.variants.some((variant) => variant.emoji === savedDefault)) {
    return savedDefault;
  }

  return group.variants.find((variant) => variant.toneId === 'default')?.emoji ?? group.variants[0]?.emoji ?? entry.emoji;
}
