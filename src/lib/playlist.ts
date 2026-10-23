import type { PanelPlaylist } from './types';

/*
 * Per-panel media playlists: a panel steps through its own videos and pictures every few beats.
 * The step is a plain change of the panel's source, so the usual crossfade and transition apply.
 * Settings and the stepping rule are pure and tested here; the engine feeds it kicks.
 */

/** Beats between changes. 1 beat = every kick; a bar is 4 beats. */
export const PLAYLIST_BEAT_CHOICES = [1, 2, 4, 8, 16, 32] as const;
export const MAX_PLAYLIST_ITEMS = 16;
export const PLAYLIST_ORDERS: [PanelPlaylist['order'], string][] = [
  ['seq', 'In order'],
  ['shuffle', 'Shuffle'],
];

const isMedia = (v: unknown): v is string => typeof v === 'string' && (v.startsWith('vid:') || v.startsWith('img:'));

export function defaultPlaylist(): PanelPlaylist {
  return { on: true, items: [], beats: 4, order: 'seq' };
}

/** A valid playlist, or null when there isn't one to apply. */
export function sanitizePlaylist(v: unknown): PanelPlaylist | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const d = defaultPlaylist();
  const items = Array.isArray(o.items) ? [...new Set(o.items.filter(isMedia))].slice(0, MAX_PLAYLIST_ITEMS) : [];
  return {
    on: o.on !== false,
    items,
    beats: PLAYLIST_BEAT_CHOICES.find((b) => b === o.beats) ?? d.beats,
    order: o.order === 'shuffle' ? 'shuffle' : 'seq',
  };
}

/**
 * The source to show next. In order it moves to the item after the current one (the first when the
 * current one isn't in the list); shuffled it picks any other item. `rand` is 0 to 1, injectable for tests.
 */
export function nextSource(pl: PanelPlaylist, current: string, rand: () => number = Math.random): string {
  const { items } = pl;
  if (items.length === 0) return current;
  const at = items.indexOf(current);
  if (pl.order === 'shuffle' && items.length > 1) {
    const others = items.filter((x) => x !== current);
    return others[Math.min(others.length - 1, Math.floor(rand() * others.length))];
  }
  return items[(at + 1) % items.length];
}

/** Counts kicks per panel towards its next change. */
export class PlaylistCounter {
  private beats = new Map<string, number>();

  /** Call on every kick for a panel with a running playlist. True when this kick completes `every` beats. */
  kick(panelId: string, every: number): boolean {
    const n = (this.beats.get(panelId) ?? 0) + 1;
    if (n >= every) { this.beats.set(panelId, 0); return true; }
    this.beats.set(panelId, n);
    return false;
  }

  /** Forget a panel, so its count starts again from the next kick. */
  reset(panelId: string) { this.beats.delete(panelId); }

  /** Forget every panel whose id isn't in `live`. */
  keepOnly(live: Set<string>) { for (const id of [...this.beats.keys()]) if (!live.has(id)) this.beats.delete(id); }
}
