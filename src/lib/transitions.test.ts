import { describe, expect, it } from 'vitest';
import { sanitize } from './store';
import {
  BarCounter, beatPeriod, Crossfade, easeInOut, glideAt, MAX_CUE_FADE_SEC, MAX_FADE_SEC, needsFade, type WallLook,
} from './transitions';

/** Seconds-since-kick list (newest first) for a steady beat. */
const steady = (period: number, n = 8) => Array.from({ length: 8 }, (_, i) => (i < n ? 0.05 + i * period : 99));

describe('beatPeriod', () => {
  it('reads the tempo from steady kicks', () => {
    expect(beatPeriod(steady(0.5), 90)).toBeCloseTo(0.5, 6);
  });

  it('falls back to the BPM setting with too few kicks', () => {
    expect(beatPeriod(steady(0.5, 3), 120)).toBeCloseTo(0.5, 6);
    expect(beatPeriod(steady(0.5, 3), 60)).toBeCloseTo(1, 6);
  });

  it('ignores a broken rhythm and out-of-range spacing', () => {
    const broken = [0.05, 0.3, 1.1, 1.25, 2.2, 2.6, 3.9, 4.0];
    expect(beatPeriod(broken, 128)).toBeCloseTo(60 / 128, 6);
    expect(beatPeriod(steady(0.2), 128)).toBeCloseTo(60 / 128, 6); // 300 BPM: double-triggering
  });
});

describe('BarCounter', () => {
  it('fires on the kick that completes the bars, then starts again', () => {
    const b = new BarCounter();
    const fired = Array.from({ length: 16 }, () => b.kick(2)).map((f, i) => (f ? i + 1 : 0)).filter(Boolean);
    expect(fired).toEqual([8, 16]);
  });

  it('restarts the count after a manual change', () => {
    const b = new BarCounter();
    for (let i = 0; i < 6; i++) b.kick(2);
    b.reset();
    const fired = Array.from({ length: 8 }, () => b.kick(2));
    expect(fired.indexOf(true)).toBe(7);
  });
});

describe('Crossfade', () => {
  const look: WallLook = { scene: 0, c1: '#ffffff', c2: '#000000', sources: {} };

  it('eases from 0 to 1 and ends', () => {
    const f = new Crossfade();
    f.begin(look, 10, 2);
    expect(f.mix(10)).toBe(0);
    expect(f.mix(11)).toBeCloseTo(0.5, 6);
    expect(f.mix(11.5)!).toBeGreaterThan(0.75);
    expect(f.mix(12)).toBeNull();
    expect(f.from).toBeNull();
  });

  it('cuts immediately when the fade length is zero', () => {
    const f = new Crossfade();
    f.begin(look, 0, 0);
    expect(f.mix(0)).toBeNull();
  });

  it('caps very long fades', () => {
    const f = new Crossfade();
    f.begin(look, 0, 60);
    expect(f.mix(MAX_FADE_SEC)).toBeNull();
  });

  it('easing is symmetric and bounded', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 6);
  });
});

describe('needsFade', () => {
  const a: WallLook = { scene: 1, c1: '#ffffff', c2: '#ff0000', sources: { p1: 'gen', p2: 'vid:x' } };

  it('fades on a new scene or new panel content', () => {
    expect(needsFade(a, { ...a, scene: 2 })).toBe(true);
    expect(needsFade(a, { ...a, sources: { ...a.sources, p2: 'gen' } })).toBe(true);
  });

  it('does not fade colour tweaks, added panels or removed panels', () => {
    expect(needsFade(a, { ...a, c1: '#000000' })).toBe(false);
    expect(needsFade(a, { ...a, sources: { ...a.sources, p3: 'gen' } })).toBe(false);
    expect(needsFade(a, { ...a, sources: { p1: 'gen' } })).toBe(false);
  });
});

describe('settings migration', () => {
  it('converts the old seconds setting to the nearest bar count at the saved tempo', () => {
    expect(sanitize({ cycleSec: 32, bpm: 120 }).cycleBars).toBe(16); // 64 beats = 16 bars
    expect(sanitize({ cycleSec: 8, bpm: 120 }).cycleBars).toBe(4);
  });

  it('keeps valid new settings and rejects invalid ones', () => {
    expect(sanitize({ cycleBars: 32, fadeBeats: 4 })).toMatchObject({ cycleBars: 32, fadeBeats: 4 });
    expect(sanitize({ cycleBars: 7, fadeBeats: 3 })).toMatchObject({ cycleBars: 8, fadeBeats: 2 });
  });
});

describe('glideAt', () => {
  it('eases from one value to the other over the time, then holds', () => {
    const g = { from: 1, to: 0, start: 10, dur: 4 };
    expect(glideAt(g, 9)).toEqual({ v: 1, done: false });
    expect(glideAt(g, 12).v).toBeCloseTo(0.5, 9);
    expect(glideAt(g, 11).v).toBeGreaterThan(0.75);
    expect(glideAt(g, 14)).toEqual({ v: 0, done: true });
  });

  it('jumps straight to the end with no time to fade', () => {
    expect(glideAt({ from: 0, to: 1, start: 0, dur: 0 }, 0)).toEqual({ v: 1, done: true });
  });
});

describe('Crossfade length limits', () => {
  it('caps beat fades at 8 s but lets a cue fade run to a minute', () => {
    const f = new Crossfade();
    const look = { scene: 0, c1: '#fff', c2: '#000', sources: {} };
    f.begin(look, 0, 30);
    expect(f.mix(9)).toBeNull();
    f.begin(look, 0, 30, MAX_CUE_FADE_SEC);
    expect(f.mix(15)).toBeCloseTo(0.5, 9);
    f.begin(look, 0, 500, MAX_CUE_FADE_SEC);
    expect(f.mix(59)).not.toBeNull();
    expect(f.mix(60)).toBeNull();
  });
});

describe('Crossfade transition mode', () => {
  it('remembers how the fade in progress should look', () => {
    const f = new Crossfade();
    const look = { scene: 0, c1: '#fff', c2: '#000', sources: {} };
    expect(f.mode).toBe('fade');
    f.begin(look, 0, 2, MAX_FADE_SEC, 'sparkle');
    expect(f.mode).toBe('sparkle');
    f.begin(look, 0, 2);
    expect(f.mode).toBe('fade');
  });
});
