import { describe, expect, it } from 'vitest';
import { defaultPlaylist, MAX_PLAYLIST_ITEMS, nextSource, PlaylistCounter, sanitizePlaylist } from './playlist';
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
