import { describe, expect, it } from 'vitest';
import type { Levels } from './audio';
import { MAX_SPLIT, splitOffset } from './effects';

const levels = (patch: Partial<Levels> = {}): Levels => ({
  bass: 0, mid: 0, high: 0, kick: false, kickEnv: 0, beat: 0,
  kicks: new Array(8).fill(99), since: 99, spec: new Uint8Array(new ArrayBuffer(64)), live: true, ...patch,
});

describe('splitOffset', () => {
  it('is off at zero amount, however loud it is', () => {
    expect(splitOffset(levels({ kickEnv: 1, bass: 1 }), 0, 'kick')).toBe(0);
  });

  it('holds still without real audio or the auto beat', () => {
    expect(splitOffset(levels({ kickEnv: 1, live: false }), 1, 'kick')).toBe(0);
  });

  it('peaks at the maximum on a full kick and fades with the kick envelope', () => {
    expect(Math.abs(splitOffset(levels({ kickEnv: 1 }), 1, 'kick'))).toBeCloseTo(MAX_SPLIT, 9);
    expect(Math.abs(splitOffset(levels({ kickEnv: 0.5 }), 1, 'kick'))).toBeCloseTo(MAX_SPLIT / 2, 9);
  });

  it('tears the other way on alternate kicks', () => {
    const a = splitOffset(levels({ kickEnv: 1, beat: 4 }), 1, 'kick');
    const b = splitOffset(levels({ kickEnv: 1, beat: 5 }), 1, 'kick');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeLessThan(0);
  });

  it('follows the chosen band, not the kick', () => {
    const L = levels({ kickEnv: 1, high: 0 });
    expect(splitOffset(L, 1, 'high')).toBe(0);
    expect(splitOffset(levels({ high: 0.5 }), 1, 'high')).toBeCloseTo(0.65 * MAX_SPLIT, 9);
    expect(splitOffset(levels({ bass: 1 }), 1, 'bass')).toBeCloseTo(MAX_SPLIT, 9);
  });

  it('never goes past the maximum', () => {
    expect(splitOffset(levels({ mid: 5 }), 3, 'mid')).toBeCloseTo(MAX_SPLIT, 9);
  });
});
