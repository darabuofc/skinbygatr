import { describe, expect, it } from 'vitest';
import { defaultPlaylist, MAX_PLAYLIST_ITEMS, nextSource, PLAYLIST_BEAT_CHOICES, PlaylistCounter, sanitizePlaylist, SubBeatClock } from './playlist';
import { sanitize } from './store';
import type { PanelPlaylist } from './types';

const pl = (over: Partial<PanelPlaylist> = {}): PanelPlaylist => ({ ...defaultPlaylist(), items: ['vid:a', 'img:b', 'vid:c'], ...over });

describe('nextSource', () => {
  it('walks the list in order and wraps', () => {
    expect(nextSource(pl(), 'vid:a')).toBe('img:b');
    expect(nextSource(pl(), 'vid:c')).toBe('vid:a');
  });
  it('starts at the first item when the current source is not in the list', () => {
    expect(nextSource(pl(), 'gen')).toBe('vid:a');
  });
  it('shuffle never repeats the current item', () => {
    for (const r of [0, 0.5, 0.999]) expect(nextSource(pl({ order: 'shuffle' }), 'img:b', () => r)).not.toBe('img:b');
  });
  it('keeps the source for an empty list', () => {
    expect(nextSource(pl({ items: [] }), 'gen')).toBe('gen');
  });
});

describe('PlaylistCounter', () => {
  it('fires every N kicks, per panel', () => {
    const c = new PlaylistCounter();
    expect([1, 2, 3, 4].map(() => c.kick('p', 2))).toEqual([false, true, false, true]);
    expect(c.kick('q', 1)).toBe(true);
  });
  it('forgets panels that are gone', () => {
    const c = new PlaylistCounter();
    c.kick('p', 2);
    c.keepOnly(new Set());
    expect(c.kick('p', 2)).toBe(false);
  });
});

describe('sanitizePlaylist', () => {
  it('rejects non-objects', () => expect(sanitizePlaylist(null)).toBeNull());
  it('drops non-media, duplicates and extras, and falls back on bad values', () => {
    const out = sanitizePlaylist({ items: ['vid:a', 'vid:a', 'gen', 'fx:x', 5, ...Array.from({ length: 30 }, (_, i) => `img:${i}`)], beats: 3, order: 'nope' })!;
    expect(out.items[0]).toBe('vid:a');
    expect(out.items.every((x) => x.startsWith('vid:') || x.startsWith('img:'))).toBe(true);
    expect(out.items.length).toBe(MAX_PLAYLIST_ITEMS);
    expect(out.beats).toBe(4);
    expect(out.order).toBe('seq');
  });
});

describe('saved layouts', () => {
  it('keep a panel playlist through sanitize', () => {
    const s = sanitize({ panels: [{ corners: [[0, 0], [1, 0], [1, 1], [0, 1]], source: 'vid:a', playlist: pl({ beats: 2 }) }] });
    expect(s.panels[0].playlist).toEqual(pl({ beats: 2 }));
  });
});

describe('half and quarter beats', () => {
  it('are offered, and a saved list keeps them and the hard-cut choice', () => {
    expect(PLAYLIST_BEAT_CHOICES).toContain(0.25);
    expect(PLAYLIST_BEAT_CHOICES).toContain(0.5);
    expect(sanitizePlaylist({ items: ['vid:a'], beats: 0.25, cut: true })).toMatchObject({ beats: 0.25, cut: true });
    expect(sanitizePlaylist({ items: [], beats: 0.3 })).toMatchObject({ beats: 4, cut: false });
  });
});

describe('SubBeatClock', () => {
  const dt = 1 / 120;
  /** Steps over `seconds` at 120 BPM (0.5 s a beat) with kicks every `kickEvery` seconds (0 = none). */
  function run(every: number, seconds: number, kickEvery: number) {
    const c = new SubBeatClock();
    const fires: number[] = [];
    let nextKick = 0;
    for (let t = 0; t < seconds; t += dt) {
      const kick = kickEvery > 0 && t >= nextKick - 1e-9 && (nextKick += kickEvery, true);
      if (c.tick('p', dt, kick, every, 0.5)) fires.push(+t.toFixed(3));
    }
    return fires;
  }
  it('fires four times a beat for quarter beats, locked to the kick', () => {
    const f = run(0.25, 2, 0.5);
    expect(f.length).toBeGreaterThanOrEqual(15);
    expect(f.length).toBeLessThanOrEqual(17);
    expect(f[0]).toBe(0);
    expect(f.some((x) => Math.abs(x - 0.5) < 0.01)).toBe(true);
  });
  it('fires twice a beat for half beats', () => {
    const f = run(0.5, 2, 0.5);
    expect(f.length).toBeGreaterThanOrEqual(7);
    expect(f.length).toBeLessThanOrEqual(9);
  });
  it('never fires twice in quick succession around a kick', () => {
    const f = run(0.25, 4, 0.5);
    const gaps = f.slice(1).map((x, i) => x - f[i]);
    expect(Math.min(...gaps)).toBeGreaterThan(0.125 * 0.6 - 0.01);
  });
  it('carries on at the tempo with no kicks at all', () => {
    const f = run(0.5, 2, 0);
    expect(f.length).toBeGreaterThanOrEqual(7);
    expect(f.length).toBeLessThanOrEqual(9);
  });
  it('forgets panels that are gone', () => {
    const c = new SubBeatClock();
    expect(c.tick('a', dt, true, 0.5, 0.5)).toBe(true);
    expect(c.tick('a', dt, true, 0.5, 0.5)).toBe(false); // too soon after the last step
    c.keepOnly(new Set());
    expect(c.tick('a', dt, true, 0.5, 0.5)).toBe(true); // a fresh clock has no last step
  });
});
