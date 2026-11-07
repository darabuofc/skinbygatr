/**
 * Caps how often the whole screen may flash. A flash starts when the raw flash level rises past `HIGH`
 * and ends when it falls back under `LOW`. A new flash is let through only if enough time has passed
 * since the last one started; a refused one is held at zero until it ends, so it can't sneak in late.
 * A steady held flash is one flash, not a strobe, so it passes once it has been let through.
 */
const HIGH = 0.3;
const LOW = 0.15;

export class FlashLimiter {
  private on = false;
  private blocked = false;
  private lastStart = -Infinity;

  /** The flash level to draw for a raw level at time t (seconds), with at most `perSec` flashes a second (0 = no limit). */
  update(raw: number, t: number, perSec: number): number {
    if (perSec <= 0) { this.on = raw > LOW; this.blocked = false; if (this.on) this.lastStart = t; return raw; }
    if (!this.on && !this.blocked && raw >= HIGH) {
      if (t - this.lastStart >= 1 / perSec) { this.on = true; this.lastStart = t; }
      else this.blocked = true;
    }
    if (raw <= LOW) { this.on = false; this.blocked = false; }
    return this.on ? raw : 0;
  }

  reset() { this.on = false; this.blocked = false; this.lastStart = -Infinity; }
}
