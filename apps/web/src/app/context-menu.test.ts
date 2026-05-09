import { describe, expect, it } from 'vitest';
import { clampMenuPosition } from './context-menu';

describe('clampMenuPosition', () => {
  it('keeps an in-bounds menu at the pointer position', () => {
    expect(
      clampMenuPosition({
        x: 120,
        y: 90,
        width: 220,
        height: 280,
        viewportWidth: 900,
        viewportHeight: 700,
      }),
    ).toEqual({ x: 120, y: 90 });
  });

  it('clamps overflowing menus inside the viewport', () => {
    expect(
      clampMenuPosition({
        x: 860,
        y: 660,
        width: 220,
        height: 180,
        viewportWidth: 900,
        viewportHeight: 700,
      }),
    ).toEqual({ x: 672, y: 512 });
  });

  it('keeps menus away from the viewport edge margin', () => {
    expect(
      clampMenuPosition({
        x: -20,
        y: 2,
        width: 220,
        height: 180,
        viewportWidth: 900,
        viewportHeight: 700,
      }),
    ).toEqual({ x: 8, y: 8 });
  });
});
