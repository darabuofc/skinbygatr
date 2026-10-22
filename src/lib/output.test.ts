import { describe, expect, it } from 'vitest';
import { fitRect, MIRROR_BAR, mirrorRect, stageDelta } from './output';

describe('fitRect', () => {
  it('keeps the reference shape and centres it in the area', () => {
    const r = fitRect({ x: 0, y: 0, w: 1000, h: 1000 }, 1920, 1080);
    expect(r.w / r.h).toBeCloseTo(1920 / 1080, 6);
    expect(r.w).toBeCloseTo(1000, 6);
    expect(r.y).toBeCloseTo((1000 - r.h) / 2, 6);
  });
});

describe('mirrorRect', () => {
  it('takes the projector window shape, not the control window shape', () => {
    // A 4:3 projector previewed on a 16:10 laptop.
    const r = mirrorRect(1440, 900, 1024, 768, true);
    expect(r.w / r.h).toBeCloseTo(4 / 3, 6);
  });

  it('stays clear of the sidebar and the caption bar', () => {
    const r = mirrorRect(1440, 900, 1920, 1080, true);
    expect(r.x).toBeGreaterThanOrEqual(340);
    expect(r.x + r.w).toBeLessThanOrEqual(1440);
    expect(r.y + r.h).toBeLessThanOrEqual(900 - MIRROR_BAR + 1e-6);
  });

  it('uses the whole window when the sidebar is hidden', () => {
    const shown = mirrorRect(1440, 900, 1920, 1080, true);
    const hidden = mirrorRect(1440, 900, 1920, 1080, false);
    expect(hidden.w).toBeGreaterThan(shown.w);
    expect(hidden.x).toBeLessThan(340);
  });

  it('survives a projector window that reports no size yet', () => {
    const r = mirrorRect(1440, 900, 0, 0, true);
    expect(Number.isFinite(r.w) && Number.isFinite(r.h)).toBe(true);
    expect(r.w).toBeGreaterThan(0);
  });
});

describe('stageDelta', () => {
  it('passes drags straight through on an unflipped view', () => {
    expect(stageDelta(0.1, -0.2, { h: false, v: false })).toEqual([0.1, -0.2]);
  });

  it('reverses drags along each mirrored axis, so the dot stays under the pointer', () => {
    expect(stageDelta(0.1, -0.2, { h: true, v: false })).toEqual([-0.1, -0.2]);
    expect(stageDelta(0.1, -0.2, { h: false, v: true })).toEqual([0.1, 0.2]);
    expect(stageDelta(0.1, -0.2, { h: true, v: true })).toEqual([-0.1, 0.2]);
  });
});
