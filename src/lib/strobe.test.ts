import { describe, expect, it } from 'vitest';
import { FlashLimiter } from './strobe';

/** A kick-driven flash: spikes to 0.85 at each beat and decays to 0 in between. */
function run(perSec: number, beatsPerSec: number, seconds: number) {
  const lim = new FlashLimiter();
  let flashes = 0, prev = 0;
  const dt = 1 / 120;
  for (let t = 0; t < seconds; t += dt) {
    const sinceBeat = (t * beatsPerSec) % 1 / beatsPerSec;
    const raw = 0.85 * Math.exp(-sinceBeat * 18);
    const out = lim.update(raw, t, perSec);
    if (out >= 0.3 && prev < 0.3) flashes++;
    prev = out;
  }
  return flashes;
}

describe('FlashLimiter', () => {
  it('lets everything through with no limit', () => {
    expect(run(0, 8, 4)).toBeGreaterThanOrEqual(30);
  });
  it('never exceeds the limit even when the raw flash is much faster', () => {
    expect(run(3, 8, 4)).toBeLessThanOrEqual(3 * 4 + 1);
    expect(run(2, 8, 4)).toBeLessThanOrEqual(2 * 4 + 1);
  });
  it('leaves a slow rhythm alone', () => {
    expect(run(3, 2, 4)).toBeGreaterThanOrEqual(7);
  });
  it('passes a steady held flash once and does not repeat it', () => {
    const lim = new FlashLimiter();
    expect(lim.update(1, 0, 3)).toBe(1);
    expect(lim.update(1, 0.5, 3)).toBe(1);
    expect(lim.update(1, 5, 3)).toBe(1);
  });
  it('holds a refused flash at zero until it has ended', () => {
    const lim = new FlashLimiter();
    expect(lim.update(0.8, 0, 3)).toBe(0.8);
    lim.update(0.05, 0.05, 3);
    expect(lim.update(0.8, 0.1, 3)).toBe(0);
    expect(lim.update(0.8, 0.5, 3)).toBe(0); // enough time has passed, but this one was refused
    lim.update(0.05, 0.6, 3);
    expect(lim.update(0.8, 0.7, 3)).toBe(0.8);
  });
});
