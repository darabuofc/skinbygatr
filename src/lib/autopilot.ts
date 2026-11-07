import { seeded } from './automation';
import { BEATS_PER_BAR } from './transitions';
import type { TransitionMode } from './types';

/*
 * Autopilot: a director that runs the show from the incoming sound. It reads the music (silence,
 * groove, build, drop, breakdown), then changes scene, content, colours and transition on the
 * bar grid, and drives RGB split and strobe by energy. It only decides; the engine applies the
 * changes through the normal settings, so crossfades, transitions and the flash limiter all apply.
 * Pure and seeded, so every rule is unit tested.
 */

export type Section = 'ambient' | 'groove' | 'build' | 'drop' | 'breakdown';
export type ApPool = 'both' | 'videos' | 'builtin';

export interface ApConfig {
  on: boolean;
  pool: ApPool;
  /** 0 (calm, few changes) to 1 (wild, frequent changes and heavy effects). */
  intensity: number;
  /** Let drops flash the screen. Still goes through the flash limiter. */
  strobe: boolean;
}

export const POOLS: [ApPool, string][] = [
  ['both', 'Videos and built-in visuals'],
  ['videos', 'My videos only'],
  ['builtin', 'Built-in visuals only'],
];

export function defaultAutopilot(): ApConfig {
  return { on: false, pool: 'both', intensity: 0.5, strobe: false };
}

export function sanitizeAutopilot(v: unknown): ApConfig {
  const d = defaultAutopilot();
  if (!v || typeof v !== 'object') return d;
  const o = v as Record<string, unknown>;
  const i = typeof o.intensity === 'number' && Number.isFinite(o.intensity) ? Math.min(1, Math.max(0, o.intensity)) : d.intensity;
  return {
    on: o.on === true,
    pool: POOLS.some(([p]) => p === o.pool) ? (o.pool as ApPool) : d.pool,
    intensity: i,
    strobe: o.strobe === true,
  };
}

/** Colour pairs the director steps through, all readable on a dark wall. */
export const PALETTES: [string, string][] = [
  ['#ffffff', '#ff3355'],
  ['#00e5ff', '#8e2dff'],
  ['#ffb000', '#ff2d6f'],
  ['#7dff6a', '#00b3ff'],
  ['#ff5a1f', '#ffe066'],
  ['#c084ff', '#2dffd0'],
  ['#ffffff', '#3d7bff'],
  ['#ff2dd1', '#ffe600'],
];

/** Bars between changes for each section before intensity scales it. */
const BASE_BARS: Record<Section, number> = { ambient: 16, breakdown: 16, build: 4, groove: 8, drop: 2 };
/** The soonest two changes may follow each other, in seconds. */
export const MIN_DWELL = 4;
/** After a hand change the director leaves the show alone for this long. */
export const MANUAL_PAUSE = 20;
/** How long strobe may run after a drop starts, in seconds. */
export const DROP_STROBE_SEC = 4;

export interface ApInput {
  t: number;
  dt: number;
  kick: boolean;
  /** Seconds since the last kick. */
  since: number;
  bass: number;
  mid: number;
  high: number;
  /** Seconds per beat. */
  period: number;
  sceneCount: number;
  scene: number;
  /** Library videos and the built-in sources the pool may use. */
  videos: string[];
  builtin: string[];
  /** Current source of each panel the director may change. */
  panels: { id: string; source: string }[];
  /** False when the sound is silent and the engine is on its idle beat. */
  live: boolean;
  pool: ApPool;
  intensity: number;
}

export interface ApChange {
  scene: number;
  c1: string;
  c2: string;
  transition: TransitionMode;
  /** New source by panel id; only panels that change are listed. */
  sources: Record<string, string>;
}

export interface ApFrame {
  section: Section;
  /** Set on the frame a change is due. */
  change: ApChange | null;
  /** RGB split strength to draw, 0 to 1. */
  split: number;
  /** Strobe the kicks on this frame. */
  strobe: boolean;
  /** Bars until the next scheduled change, for the readout. */
  barsLeft: number;
  /** False while paused by a hand change or held: the director changes nothing then. */
  active: boolean;
}

const ema = (cur: number, x: number, dt: number, tau: number) => cur + (x - cur) * (1 - Math.exp(-dt / tau));

export class Autopilot {
  section: Section = 'ambient';
  private fast = 0;
  private slow = 0;
  private highFast = 0;
  private highSlow = 0;
  private kickRate = 0;
  private sectionSince = 0;
  private lastChange = -Infinity;
  private beats = 0;
  private pausedUntil = -Infinity;
  private palette = 0;
  private split = 0;
  private dropAt = -Infinity;
  private rand: () => number;
  held = false;

  constructor(seed = 1) { this.rand = seeded(seed); }

  /** A hand change happened: step back for a while. */
  manual(t: number) { this.pausedUntil = t + MANUAL_PAUSE; }

  /** Back to a clean start, such as when autopilot is switched on. */
  reset() {
    this.fast = this.slow = this.highFast = this.highSlow = this.kickRate = 0;
    this.section = 'ambient';
    this.sectionSince = 0;
    this.lastChange = -Infinity;
    this.beats = 0;
    this.pausedUntil = -Infinity;
    this.split = 0;
    this.dropAt = -Infinity;
  }

  private classify(inp: ApInput): Section {
    const { fast, slow, highFast, highSlow, kickRate } = this;
    const prev = this.section;
    if (!inp.live || fast < 0.05) return 'ambient';
    if (kickRate >= 0.8) {
      if (prev === 'build' || prev === 'breakdown' || prev === 'ambient') return 'drop';
      if (prev === 'drop' && inp.t - this.sectionSince < 6) return 'drop';
      return fast > slow * 1.5 && slow > 0.05 ? 'drop' : 'groove';
    }
    if (kickRate < 0.3) {
      if (highFast > highSlow * 1.25 && highFast > 0.1) return 'build';
      if (prev === 'groove' || prev === 'drop' || prev === 'breakdown') return 'breakdown';
      return 'ambient';
    }
    return prev; // in between: keep what we had rather than flicker
  }

  step(inp: ApInput): ApFrame {
    const { t, dt } = inp;
    const energy = inp.bass * 0.5 + inp.mid * 0.3 + inp.high * 0.2;
    this.fast = ema(this.fast, energy, dt, 1.5);
    this.slow = ema(this.slow, energy, dt, 40);
    this.highFast = ema(this.highFast, inp.high, dt, 1.5);
    this.highSlow = ema(this.highSlow, inp.high, dt, 10);
    // Kicks per second, smoothed over a few seconds.
    this.kickRate = ema(this.kickRate, 0, dt, 4);
    if (inp.kick) this.kickRate += 1 / 4;

    const next = this.classify(inp);
    const entered = next !== this.section;
    if (entered) {
      this.section = next;
      this.sectionSince = t;
      if (next === 'drop') this.dropAt = t;
    }

    // Beats are counted from kicks; with no kicks the clock carries on from the tempo.
    if (inp.kick) this.beats++;
    else if (inp.since > 1.5) this.beats += dt / Math.max(0.3, inp.period);

    const i = Math.min(1, Math.max(0, inp.intensity));
    const bars = Math.max(1, Math.round(BASE_BARS[this.section] * (2 - 1.5 * i)));
    const barsLeft = Math.max(0, bars - this.beats / BEATS_PER_BAR);

    const active = !this.held && t >= this.pausedUntil;
    let change: ApChange | null = null;
    if (active) {
      const due = this.beats >= bars * BEATS_PER_BAR;
      const sectionCue = entered && (next === 'drop' || next === 'breakdown');
      if ((due || sectionCue) && t - this.lastChange >= MIN_DWELL) {
        change = this.pick(inp, sectionCue ? next : null);
        this.lastChange = t;
        this.beats = 0;
      }
    } else this.beats = 0;

    const target = !active ? 0
      : this.section === 'drop' ? 0.5 * i
        : this.section === 'build' ? 0.3 * i * Math.min(1, this.highFast * 4)
          : this.section === 'groove' ? 0.12 * i : 0;
    this.split = ema(this.split, target, dt, 0.4);

    return {
      section: this.section,
      change,
      split: this.split,
      strobe: active && this.section === 'drop' && t - this.dropAt < DROP_STROBE_SEC,
      barsLeft,
      active,
    };
  }

  private pick(inp: ApInput, cue: Section | null): ApChange {
    const r = this.rand;
    let scene = Math.floor(r() * inp.sceneCount);
    if (scene === inp.scene) scene = (scene + 1 + Math.floor(r() * (inp.sceneCount - 1))) % inp.sceneCount;
    this.palette = (this.palette + 1 + Math.floor(r() * (PALETTES.length - 1))) % PALETTES.length;
    const [c1, c2] = PALETTES[this.palette];
    const sec = cue ?? this.section;
    const transition: TransitionMode = sec === 'drop' ? (r() < 0.5 ? 'sparkle' : 'ripple') : sec === 'breakdown' ? 'black' : 'fade';
    // On a drop every panel changes; otherwise about two in three, so the wall never changes all at once.
    const share = sec === 'drop' ? 1 : 0.65;
    const sources: Record<string, string> = {};
    inp.panels.forEach((p, k) => {
      const force = k === 0 && inp.panels.length > 0; // at least one panel always moves
      if (!force && r() >= share) return;
      const src = this.pickSource(inp, p.source);
      if (src && src !== p.source) sources[p.id] = src;
    });
    return { scene, c1, c2, transition, sources };
  }

  /** The pool's next source, never the one already showing when there is another. */
  private pickSource(inp: ApInput, current: string): string | null {
    const r = this.rand;
    const { videos, builtin } = inp;
    const pool = this.poolFor(inp);
    const list = pool === 'videos' ? videos : pool === 'builtin' ? builtin : [];
    const others = list.filter((x) => x !== current);
    const from = others.length ? others : list;
    return from.length ? from[Math.floor(r() * from.length)] : null;
  }

  /** Which pool to draw this change from: both alternates, and falls back when one is empty. */
  private poolFor(inp: ApInput): 'videos' | 'builtin' {
    const r = this.rand;
    const hasV = inp.videos.length > 0;
    if (inp.pool === 'videos' && hasV) return 'videos';
    if (inp.pool === 'builtin' || !hasV) return 'builtin';
    return r() < 0.5 ? 'videos' : 'builtin';
  }
}
