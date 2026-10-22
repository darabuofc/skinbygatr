/*
 * Eye automation: random blinks and slow wandering, so a sculpted eye looks alive with nobody
 * at the controls. Pure and seeded, so the timing rules are unit tested; the engine runs one per
 * eye shader (both eyes share it, so they blink and look together) and feeds its output to the
 * shader as uniforms.
 */

/** Blink shape, in seconds: lids close fast, hold, then open a little slower. */
export const BLINK_CLOSE = 0.07;
export const BLINK_HOLD = 0.04;
export const BLINK_OPEN = 0.16;
export const BLINK_LEN = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;
/** Chance a blink is followed straight away by a second one, as real eyes sometimes do. */
export const DOUBLE_BLINK = 0.15;
/** Gap before the second blink of a double. */
export const DOUBLE_GAP = 0.12;
/** Shortest time between automatic blinks, however high the rate. */
export const MIN_BLINK_GAP = 0.8;

export interface EyeSettings {
  /** Automatic blinks per minute; 0 turns them off (a manual blink still works). */
  perMin: number;
  /** How far the eye wanders, 0 (still) to 1 (across the whole range). */
  wander: number;
  /** How lively the wandering is, 0.05 (drifting) to 1 (restless). */
  pace: number;
}

export interface EyeState {
  /** Lid closure from blinking: 0 open, 1 shut. */
  blink: number;
  /** Wander offset added to the pupil position, each −1..1. */
  x: number;
  y: number;
}

const smooth = (x: number) => x * x * (3 - 2 * x);

/** Lid closure `s` seconds into a blink: 0 → 1 → 0. */
export function blinkShape(s: number): number {
  if (s < 0 || s >= BLINK_LEN) return 0;
  if (s < BLINK_CLOSE) return smooth(s / BLINK_CLOSE);
  if (s < BLINK_CLOSE + BLINK_HOLD) return 1;
  return 1 - smooth((s - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN);
}

/** Small seeded generator (mulberry32), so a test can replay the same blinks. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class EyeAutomation {
  /** Start times of blinks under way or queued (a double blink queues its second). */
  private blinks: number[] = [];
  private nextAuto = Infinity;
  private lastRate = 0;
  private x = 0;
  private y = 0;
  private tx = 0;
  private ty = 0;
  private nextLook = 0;

  constructor(private readonly rng: () => number = Math.random) {}

  /** A blink now (a manual trigger). Ignored while a blink is already closing the eye. */
  blink(now: number) {
    if (this.blinks.some((b) => now >= b && now - b < BLINK_CLOSE + BLINK_HOLD)) return;
    this.blinks.push(now);
    if (this.rng() < DOUBLE_BLINK) this.blinks.push(now + BLINK_LEN + DOUBLE_GAP);
  }

  /** Seconds until the next automatic blink at this rate: irregular, as real blinking is. */
  private gap(perMin: number): number {
    const mean = 60 / perMin;
    // Exponential spread, kept within a sensible band around the average.
    const g = -Math.log(1 - this.rng() * 0.999) * mean;
    return Math.max(MIN_BLINK_GAP, Math.min(2.5 * mean, Math.max(0.35 * mean, g)));
  }

  update(now: number, dt: number, s: EyeSettings): EyeState {
    // Automatic blinks: schedule when the rate turns on or changes a lot, fire when due.
    const rate = Math.max(0, s.perMin);
    if (rate <= 0) this.nextAuto = Infinity;
    else if (this.nextAuto === Infinity || Math.abs(rate - this.lastRate) > this.lastRate * 0.5) {
      this.nextAuto = now + this.gap(rate);
    }
    this.lastRate = rate;
    if (now >= this.nextAuto) {
      this.blink(now);
      this.nextAuto = now + this.gap(rate);
    }
    this.blinks = this.blinks.filter((b) => now - b < BLINK_LEN);
    const blink = this.blinks.reduce((m, b) => Math.max(m, blinkShape(now - b)), 0);

    // Wander: every few seconds pick a new place to look, then ease there. Mostly sideways.
    const wander = Math.max(0, Math.min(1, s.wander));
    const pace = Math.max(0.05, Math.min(1, s.pace));
    if (now >= this.nextLook) {
      this.tx = (this.rng() * 2 - 1) * wander;
      this.ty = (this.rng() * 2 - 1) * wander * 0.4;
      this.nextLook = now + (2 + this.rng() * 4) * (0.35 / pace);
    }
    if (wander === 0) { this.tx = 0; this.ty = 0; }
    const tau = 0.15 + 0.85 * (1 - pace);
    const k = dt > 0 ? 1 - Math.exp(-dt / tau) : 0;
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    return { blink, x: this.x, y: this.y };
  }
}
