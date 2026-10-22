import { describe, expect, it } from 'vitest';
import {
  BLINK_CLOSE, BLINK_HOLD, BLINK_LEN, blinkShape, EyeAutomation, MIN_BLINK_GAP, seeded, type EyeSettings,
} from './automation';

const still: EyeSettings = { perMin: 0, wander: 0, pace: 0.3 };

/** Runs the automation at 60 fps for `sec`, returning blink starts (frames where the lid starts closing). */
function run(a: EyeAutomation, s: EyeSettings, sec: number, t0 = 0) {
  const starts: number[] = [];
  let prev = 0;
  let maxX = 0;
  for (let k = 0; k <= sec * 60; k++) {
    const t = t0 + k / 60;
    const st = a.update(t, 1 / 60, s);
    if (st.blink > 0 && prev === 0) starts.push(t);
    prev = st.blink;
    maxX = Math.max(maxX, Math.abs(st.x));
  }
  return { starts, maxX };
}

describe('blinkShape', () => {
  it('closes, holds shut, then opens, and is open outside the blink', () => {
    expect(blinkShape(-0.1)).toBe(0);
    expect(blinkShape(0)).toBe(0);
    expect(blinkShape(BLINK_CLOSE / 2)).toBeCloseTo(0.5, 6);
    expect(blinkShape(BLINK_CLOSE + BLINK_HOLD / 2)).toBe(1);
    expect(blinkShape(BLINK_LEN - 0.01)).toBeGreaterThan(0);
    expect(blinkShape(BLINK_LEN)).toBe(0);
  });
});

describe('EyeAutomation blinks', () => {
  it('blinks at roughly the set rate, irregularly, never too close together', () => {
    const { starts } = run(new EyeAutomation(seeded(7)), { ...still, perMin: 12 }, 300);
    // Doubles add a few; the average stays near 12 a minute.
    expect(starts.length).toBeGreaterThan(40);
    expect(starts.length).toBeLessThan(90);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(new Set(gaps.map((g) => g.toFixed(1))).size).toBeGreaterThan(10);
    const singles = gaps.filter((g) => g > BLINK_LEN + 0.2);
    expect(Math.min(...singles)).toBeGreaterThanOrEqual(MIN_BLINK_GAP - 1 / 60);
  });

  it('sometimes blinks twice in a row', () => {
    const { starts } = run(new EyeAutomation(seeded(3)), { ...still, perMin: 20 }, 300);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(gaps.some((g) => g < BLINK_LEN + 0.2)).toBe(true);
  });

  it('stays open with the rate at 0, but a manual blink still closes it', () => {
    const a = new EyeAutomation(seeded(1));
    expect(run(a, still, 60).starts).toEqual([]);
    a.blink(60.5);
    const mid = a.update(60.5 + BLINK_CLOSE + 0.01, 1 / 60, still);
    expect(mid.blink).toBe(1);
    expect(a.update(60.5 + BLINK_LEN + 0.5, 1 / 60, still).blink).toBe(0);
  });

  it('ignores a second trigger while the eye is already closing', () => {
    const a = new EyeAutomation(() => 0.99); // never a double
    a.blink(10);
    a.blink(10.03);
    const { starts } = run(a, still, 1, 10);
    expect(starts).toHaveLength(1);
  });

  it('replays the same blinks from the same seed', () => {
    const s = { ...still, perMin: 10 };
    expect(run(new EyeAutomation(seeded(42)), s, 120).starts).toEqual(run(new EyeAutomation(seeded(42)), s, 120).starts);
  });
});

describe('EyeAutomation wander', () => {
  it('holds still with wander at 0', () => {
    expect(run(new EyeAutomation(seeded(5)), still, 60).maxX).toBe(0);
  });

  it('wanders within the set range, and further with more wander', () => {
    const small = run(new EyeAutomation(seeded(9)), { ...still, wander: 0.3 }, 120).maxX;
    const big = run(new EyeAutomation(seeded(9)), { ...still, wander: 1 }, 120).maxX;
    expect(small).toBeGreaterThan(0.02);
    expect(small).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThanOrEqual(1);
  });

  it('moves slowly: no jumps from one frame to the next', () => {
    const a = new EyeAutomation(seeded(11));
    let prev = a.update(0, 1 / 60, { ...still, wander: 1, pace: 0.3 }).x;
    for (let k = 1; k < 600; k++) {
      const x = a.update(k / 60, 1 / 60, { ...still, wander: 1, pace: 0.3 }).x;
      expect(Math.abs(x - prev)).toBeLessThan(0.05);
      prev = x;
    }
  });
});
