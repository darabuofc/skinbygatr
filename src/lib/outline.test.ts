import { describe, expect, it } from 'vitest';
import { buildStrip, defaultOutline, outlinePath, outlinePhase, sanitizeOutline, stripHalf, stripKey, STRIP_STRIDE } from './outline';
import { defaultMask } from './mask';
import { meshFromQuad } from './mesh';
import type { Quad } from './types';

const SQUARE: Quad = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
const NO_FLIP = { h: false, v: false };

describe('sanitizeOutline', () => {
  it('rejects non-objects', () => {
    expect(sanitizeOutline(null)).toBeNull();
    expect(sanitizeOutline('x')).toBeNull();
  });

  it('clamps numbers and falls back on bad choices', () => {
    const o = sanitizeOutline({ on: true, style: 'lasers', color: 'red', width: 999, glow: -1, speed: NaN, runners: 99, length: 0, band: 'x', sync: 3 })!;
    expect(o.on).toBe(true);
    expect(o.style).toBe('chase');
    expect(o.color).toBe('c1');
    expect(o.width).toBe(40);
    expect(o.glow).toBe(0);
    expect(o.speed).toBe(defaultOutline().speed);
    expect(o.runners).toBe(8);
    expect(o.length).toBe(0.05);
    expect(o.band).toBe('none');
    expect(o.sync).toBe(0);
  });

  it('keeps valid colours and is off unless explicitly on', () => {
    expect(sanitizeOutline({ color: '#00FFd5' })!.color).toBe('#00FFd5');
    expect(sanitizeOutline({ color: 'c2' })!.color).toBe('c2');
    expect(sanitizeOutline({})!.on).toBe(false);
  });
});

describe('outlinePhase', () => {
  it('runs at the speed in laps per second, backwards when reversed', () => {
    const o = { ...defaultOutline(), speed: 0.5 };
    expect(outlinePhase(o, 4, 120, 4)).toBeCloseTo(2);
    expect(outlinePhase({ ...o, reverse: true }, 4, 120, 4)).toBeCloseTo(-2);
  });

  it('locks to the tempo: one lap per bar at 120 BPM takes two seconds', () => {
    const o = { ...defaultOutline(), sync: 1 };
    expect(outlinePhase(o, 2, 120, 4)).toBeCloseTo(1);
    expect(outlinePhase({ ...o, sync: 4 }, 8, 120, 4)).toBeCloseTo(1);
  });
});

describe('outlinePath', () => {
  it('uses the corners without a mask or mesh', () => {
    expect(outlinePath({ corners: SQUARE }, NO_FLIP)).toEqual(SQUARE);
  });

  it('mirrors for a flipped output', () => {
    const p = outlinePath({ corners: SQUARE }, { h: true, v: false });
    expect(p[0][0]).toBeCloseTo(0.8);
    expect(p[0][1]).toBeCloseTo(0.2);
  });

  it('follows the mask curve, smoothly sampled', () => {
    const mask = defaultMask(SQUARE, 8);
    const path = outlinePath({ corners: SQUARE, mask }, NO_FLIP);
    expect(path.length).toBe(8 * 16);
    // Smooth curve passes through the first mask point.
    expect(path[0][0]).toBeCloseTo(mask.points[0].p[0]);
  });

  it('ignores picture masks and walks the mesh rim when there is a mesh', () => {
    const mask = { points: [], feather: 0, invert: false, image: 'data:image/png;base64,AAAA' };
    expect(outlinePath({ corners: SQUARE, mask }, NO_FLIP)).toEqual(SQUARE);
    const rim = outlinePath({ corners: SQUARE, mesh: meshFromQuad(SQUARE, 3, 3) }, NO_FLIP);
    expect(rim.length).toBe(96);
    for (const [x, y] of rim) {
      expect(x).toBeGreaterThanOrEqual(0.2 - 1e-6); expect(x).toBeLessThanOrEqual(0.8 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(0.2 - 1e-6); expect(y).toBeLessThanOrEqual(0.8 + 1e-6);
    }
  });
});

describe('buildStrip', () => {
  it('closes the loop with two vertices per point plus a repeat of the first', () => {
    const s = buildStrip(SQUARE, 1000, 1000, 10)!;
    expect(s.count).toBe((4 + 1) * 2);
    expect(s.verts.length).toBe(s.count * STRIP_STRIDE);
  });

  it('runs s from 0 to 1 by pixel length and puts the sides ±half apart', () => {
    const s = buildStrip(SQUARE, 1000, 1000, 10)!;
    const v = (i: number) => Array.from(s.verts.slice(i * STRIP_STRIDE, (i + 1) * STRIP_STRIDE));
    expect(v(0)[2]).toBe(0);
    expect(v(1)[2]).toBe(0);
    expect(v(2)[2]).toBeCloseTo(0.25);
    expect(v(8)[2]).toBeCloseTo(1);
    expect([v(0)[3], v(1)[3]]).toEqual([-1, 1]);
    // First corner at (200, 200) px: its two sides are about 2 × 10 × 1.41 px apart along the diagonal.
    const dx = (v(1)[0] - v(0)[0]) * 500, dy = (v(1)[1] - v(0)[1]) * 500;
    expect(Math.hypot(dx, dy)).toBeCloseTo(2 * 10 * Math.SQRT2, 0);
  });

  it('has nothing to draw for a degenerate path', () => {
    expect(buildStrip([[0.5, 0.5]], 100, 100, 5)).toBeNull();
    expect(buildStrip([[0.5, 0.5], [0.5, 0.5]], 100, 100, 5)).toBeNull();
  });
});

describe('stripKey', () => {
  it('changes with geometry, size, flip and line width, not with animation settings', () => {
    const h = stripHalf(defaultOutline(), 1080);
    const base = stripKey({ corners: SQUARE }, NO_FLIP, 1920, 1080, h);
    expect(stripKey({ corners: SQUARE }, NO_FLIP, 1920, 1080, h)).toBe(base);
    expect(stripKey({ corners: SQUARE }, { h: true, v: false }, 1920, 1080, h)).not.toBe(base);
    expect(stripKey({ corners: SQUARE }, NO_FLIP, 1280, 720, h)).not.toBe(base);
    expect(stripKey({ corners: SQUARE }, NO_FLIP, 1920, 1080, stripHalf({ ...defaultOutline(), width: 20 }, 1080))).not.toBe(base);
    expect(stripKey({ corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }, NO_FLIP, 1920, 1080, h)).not.toBe(base);
  });
});
