import type { TransitionMode } from './types';

/*
 * Timing for musical scene changes: how long a beat is, when an automatic change is due,
 * and how far through a crossfade we are. Pure, so the rules are unit tested; the engine
 * feeds it kicks and time, and the renderer blends by the mix it returns.
 */

export const BEATS_PER_BAR = 4;
export const BAR_CHOICES = [1, 2, 4, 8, 16, 32] as const;
export const FADE_CHOICES = [0, 1, 2, 4, 8] as const;
/** A fade never runs longer than this, whatever the tempo, so a slow tap can't stall the show. */
export const MAX_FADE_SEC = 8;
/** Longest fade a cue can ask for; cue fades are timed in seconds, for slow ambient changes. */
export const MAX_CUE_FADE_SEC = 60;
/** Cue fade lengths offered when saving, in seconds. */
export const CUE_FADE_CHOICES = [0, 1, 2, 3, 5, 8, 12, 20, 30, 60] as const;

/**
 * Seconds per beat. Uses the spacing of recent kicks when they're steady, otherwise the BPM setting.
 * `kicks` is seconds since each of the last kicks, newest first (99 when unused), as in Levels.
 */
export function beatPeriod(kicks: number[], bpm: number): number {
  const fallback = 60 / Math.min(200, Math.max(60, bpm || 126));
  const times = kicks.filter((k) => k < 99);
  if (times.length < 4) return fallback;
  const gaps = times.slice(1).map((k, i) => k - times[i]).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  // 60–200 BPM, and most gaps agree: a steady four-on-the-floor rather than a broken rhythm.
  if (median < 0.3 || median > 1) return fallback;
  const steady = gaps.filter((g) => Math.abs(g - median) < median * 0.15).length;
  return steady >= gaps.length * 0.6 ? median : fallback;
}

/** Counts kicks towards the next automatic scene change. */
export class BarCounter {
  private beats = 0;

  /** Call on every kick. True when this kick completes the requested number of bars. */
  kick(bars: number): boolean {
    this.beats++;
    if (this.beats >= bars * BEATS_PER_BAR) { this.beats = 0; return true; }
    return false;
  }

  /** Start counting from now, such as after a manual scene change on a drop. */
  reset() { this.beats = 0; }

  get count() { return this.beats; }
}

export const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

/** What the wall showed before a change, kept alive until the fade completes. */
export interface WallLook {
  scene: number;
  c1: string;
  c2: string;
  /** Panel id to source ('gen' or 'vid:<id>'). */
  sources: Record<string, string>;
}

export class Crossfade {
  from: WallLook | null = null;
  /** How the fade in progress looks. */
  mode: TransitionMode = 'fade';
  private start = 0;
  private dur = 0;

  begin(from: WallLook, t: number, seconds: number, maxSec = MAX_FADE_SEC, mode: TransitionMode = 'fade') {
    if (seconds <= 0) { this.from = null; return; }
    this.mode = mode;
    this.from = from;
    this.start = t;
    this.dur = Math.min(maxSec, seconds);
  }

  /** Weight of the new look, 0..1, or null once there's nothing to blend. */
  mix(t: number): number | null {
    if (!this.from) return null;
    const x = (t - this.start) / this.dur;
    if (x >= 1) { this.from = null; return null; }
    return easeInOut(Math.max(0, x));
  }

  cancel() { this.from = null; }
}

/** Whether a settings change should crossfade: a new scene or new panel content. Colour tweaks alone apply instantly. */
export function needsFade(prev: WallLook, next: WallLook): boolean {
  if (prev.scene !== next.scene) return true;
  return Object.keys(next.sources).some((id) => id in prev.sources && prev.sources[id] !== next.sources[id]);
}

/** A number easing from one value to another over a set time, such as a panel's opacity during a cue fade. */
export interface Glide { from: number; to: number; start: number; dur: number; }

/** Where a glide is at time t, and whether it has finished. */
export function glideAt(g: Glide, t: number): { v: number; done: boolean } {
  if (g.dur <= 0 || t >= g.start + g.dur) return { v: g.to, done: true };
  const x = Math.max(0, (t - g.start) / g.dur);
  return { v: g.from + (g.to - g.from) * easeInOut(x), done: false };
}
