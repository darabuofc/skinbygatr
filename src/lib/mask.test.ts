import { describe, expect, it } from 'vitest';
import {
  bezierAt, defaultMask, insertIndex, MAX_MASK_FEATHER, MAX_MASK_POINTS, maskKey, maskPathData, maskSegments, sanitizeMask,
} from './mask';
import type { Mask, MaskPoint, Pt, Quad } from './types';

const NO_FLIP = { h: false, v: false };
const square = (smooth: boolean): MaskPoint[] =>
  ([[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]] as Pt[]).map((p) => ({ p, smooth }));
const mask = (points: MaskPoint[], feather = 0, invert = false): Mask => ({ points, feather, invert });

describe('sanitizeMask for picture masks', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  it('keeps a PNG data URL with no points', () => {
    expect(sanitizeMask({ image: png, feather: 0.01, invert: true })).toEqual({ points: [], feather: 0.01, invert: true, image: png });
  });
  it('rejects anything else, including other URLs and scripts', () => {
    expect(sanitizeMask({ image: 'https://example.com/a.png' })).toBeNull();
    expect(sanitizeMask({ image: 'data:text/html;base64,AAAA' })).toBeNull();
    expect(sanitizeMask({ image: png + '"><script>' })).toBeNull();
  });
});

describe('sanitizeMask', () => {
  it('keeps a valid outline, clamping points and feather', () => {
    const m = sanitizeMask({ points: [{ p: [0, 0] }, { p: [9, 0.5], smooth: true }, { p: [0.5, -3] }], feather: 5, invert: 'yes' })!;
    expect(m.points.map((x) => x.p)).toEqual([[0, 0], [1.25, 0.5], [0.5, -0.25]]);
    expect(m.points.map((x) => x.smooth)).toEqual([false, true, false]);
    expect(m.feather).toBe(MAX_MASK_FEATHER);
    expect(m.invert).toBe(false);
  });

  it('drops broken points, and the mask when fewer than three are left', () => {
    expect(sanitizeMask({ points: [{ p: [0, 0] }, { p: [1, NaN] }, { p: 'x' }, null, { p: [1, 1] }] })).toBeNull();
    expect(sanitizeMask({ points: 'none' })).toBeNull();
    expect(sanitizeMask(null)).toBeNull();
  });

  it(`keeps at most ${MAX_MASK_POINTS} points`, () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ p: [Math.cos(i), Math.sin(i)] }));
    expect(sanitizeMask({ points })!.points).toHaveLength(MAX_MASK_POINTS);
  });
});

describe('defaultMask', () => {
  it('starts as a smooth oval inside the panel, following its perspective', () => {
    const q: Quad = [[0.1, 0.1], [0.5, 0.15], [0.55, 0.8], [0.05, 0.75]];
    const m = defaultMask(q);
    expect(m.points).toHaveLength(8);
    expect(m.points.every((p) => p.smooth)).toBe(true);
    for (const { p } of m.points) {
      expect(p[0]).toBeGreaterThan(0.05);
      expect(p[0]).toBeLessThan(0.55);
      expect(p[1]).toBeGreaterThan(0.1);
      expect(p[1]).toBeLessThan(0.8);
    }
  });
});

describe('maskSegments', () => {
  it('runs through every point and closes the outline', () => {
    const pts = square(true);
    const segs = maskSegments(pts);
    expect(segs).toHaveLength(4);
    segs.forEach((s, i) => {
      expect(s.from).toEqual(pts[i].p);
      expect(s.to).toEqual(pts[(i + 1) % 4].p);
      expect(bezierAt(s, 0)).toEqual(s.from);
      expect(bezierAt(s, 1)[0]).toBeCloseTo(s.to[0], 9);
    });
  });

  it('draws straight edges between corner points', () => {
    const s = maskSegments(square(false))[0];
    expect(s.c1).toEqual(s.from);
    expect(s.c2).toEqual(s.to);
    expect(bezierAt(s, 0.5)[1]).toBeCloseTo(0.2, 9);
  });

  it('curves smoothly through a smooth point: tangents in and out line up', () => {
    const segs = maskSegments(square(true));
    // Point 1 is the end of segment 0 and the start of segment 1.
    const inDir = [segs[0].to[0] - segs[0].c2[0], segs[0].to[1] - segs[0].c2[1]];
    const outDir = [segs[1].c1[0] - segs[1].from[0], segs[1].c1[1] - segs[1].from[1]];
    expect(inDir[0] * outDir[1] - inDir[1] * outDir[0]).toBeCloseTo(0, 9);
    expect(inDir[0] * outDir[0] + inDir[1] * outDir[1]).toBeGreaterThan(0);
    // And the curve bulges outward past the straight edge.
    expect(bezierAt(segs[0], 0.5)[1]).toBeLessThan(0.2);
  });
});

describe('insertIndex', () => {
  it('puts a click on an edge between that edge’s two points', () => {
    const pts = square(false);
    expect(insertIndex(pts, [0.5, 0.21])).toBe(1);
    expect(insertIndex(pts, [0.79, 0.5])).toBe(2);
    expect(insertIndex(pts, [0.5, 0.79])).toBe(3);
    expect(insertIndex(pts, [0.21, 0.5])).toBe(4);
  });
});

describe('mask outline output', () => {
  it('mirrors the outline on a flipped output', () => {
    const m = mask(square(false));
    expect(maskPathData(m, 100, 100, NO_FLIP).startsWith('M20.0 20.0')).toBe(true);
    expect(maskPathData(m, 100, 100, { h: true, v: false }).startsWith('M80.0 20.0')).toBe(true);
  });

  it('changes the cache key whenever the bitmap would change', () => {
    const m = mask(square(true), 0.01);
    const k = maskKey(m, 960, 540, NO_FLIP);
    expect(maskKey(m, 960, 540, NO_FLIP)).toBe(k);
    expect(maskKey({ ...m, feather: 0.02 }, 960, 540, NO_FLIP)).not.toBe(k);
    expect(maskKey({ ...m, invert: true }, 960, 540, NO_FLIP)).not.toBe(k);
    expect(maskKey(m, 960, 540, { h: true, v: false })).not.toBe(k);
    expect(maskKey(m, 640, 360, NO_FLIP)).not.toBe(k);
    expect(maskKey({ ...m, points: square(false) }, 960, 540, NO_FLIP)).not.toBe(k);
    const moved = { ...m, points: m.points.map((p, i) => (i ? p : { ...p, p: [0.21, 0.2] as Pt })) };
    expect(maskKey(moved, 960, 540, NO_FLIP)).not.toBe(k);
  });
});
