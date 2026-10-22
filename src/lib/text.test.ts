import { describe, expect, it } from 'vitest';
import { defaultLabel, fitScale, labelCanvasSize, labelKey, panelAspect } from './text';
import type { Pt } from './types';

/** Axis-aligned size of a w × h box rotated by deg. */
function rotatedBox(w: number, h: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  return [w * c + h * s, w * s + h * c];
}

describe('panelAspect', () => {
  it('is width over height for a rectangle', () => {
    expect(panelAspect([[0, 0], [400, 0], [400, 100], [0, 100]])).toBeCloseTo(4);
  });

  it('averages opposite edges of a keystoned panel', () => {
    const q: [Pt, Pt, Pt, Pt] = [[50, 0], [250, 0], [300, 200], [0, 200]];
    expect(panelAspect(q)).toBeCloseTo(250 / Math.hypot(50, 200));
  });

  it('falls back to square for a collapsed panel', () => {
    expect(panelAspect([[0, 0], [0, 0], [0, 0], [0, 0]])).toBe(1);
  });
});

describe('fitScale', () => {
  it('sets text height to the chosen share of the panel when it fits', () => {
    const k = fitScale(100, 50, 0, 1000, 500, 0.2);
    expect(50 * k).toBeCloseTo(100);
  });

  it('keeps the rotated text inside the panel at any angle', () => {
    for (const deg of [0, 30, 45, 90, -90, 135, 180]) {
      const k = fitScale(800, 110, deg, 1024, 256, 1);
      const [w, h] = rotatedBox(800 * k, 110 * k, deg);
      expect(w).toBeLessThanOrEqual(1024 * 0.9 + 1e-6);
      expect(h).toBeLessThanOrEqual(256 * 0.9 + 1e-6);
    }
  });

  it('treats a quarter turn either way the same', () => {
    expect(fitScale(300, 110, 90, 400, 1024, 0.5)).toBeCloseTo(fitScale(300, 110, -90, 400, 1024, 0.5));
  });

  it('measures size across the text, so a sideways label on a tall panel uses its width', () => {
    const k = fitScale(10, 100, 90, 300, 3000, 0.5);
    expect(100 * k).toBeCloseTo(150);
  });

  it('returns 0 for empty text', () => {
    expect(fitScale(0, 110, 0, 100, 100, 0.5)).toBe(0);
  });
});

describe('label bitmap', () => {
  it('keeps the panel shape with 1024 on the long side', () => {
    expect(labelCanvasSize(4)).toEqual([1024, 256]);
    expect(labelCanvasSize(0.5)).toEqual([512, 1024]);
    expect(labelCanvasSize(100)[1]).toBe(64);
  });

  it('only needs a redraw when the label or the rounded shape changes', () => {
    const l = { ...defaultLabel(), text: 'HELLO' };
    expect(labelKey(l, 2.01)).toBe(labelKey(l, 1.99));
    expect(labelKey(l, 2)).not.toBe(labelKey(l, 2.2));
    expect(labelKey(l, 2)).not.toBe(labelKey({ ...l, rotation: 90 }, 2));
    expect(labelKey(l, 2)).toBe(labelKey({ ...l, pulse: true }, 2));
  });
});
