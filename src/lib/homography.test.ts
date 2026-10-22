import { describe, expect, it } from 'vitest';
import { apply, flipPt, flipQuad, invert3, squareToQuad } from './homography';
import type { Pt } from './types';

const close = (a: Pt, b: Pt) => {
  expect(a[0]).toBeCloseTo(b[0], 6);
  expect(a[1]).toBeCloseTo(b[1], 6);
};

describe('squareToQuad', () => {
  const cases: [string, [Pt, Pt, Pt, Pt]][] = [
    ['axis-aligned rectangle', [[100, 50], [500, 50], [500, 350], [100, 350]]],
    ['parallelogram', [[0, 0], [400, 40], [500, 340], [100, 300]]],
    ['keystoned panel', [[120, 80], [520, 140], [480, 600], [90, 560]]],
  ];
  for (const [name, q] of cases) {
    it(`maps unit-square corners onto a ${name}`, () => {
      const m = squareToQuad(q);
      close(apply(m, 0, 0), q[0]);
      close(apply(m, 1, 0), q[1]);
      close(apply(m, 1, 1), q[2]);
      close(apply(m, 0, 1), q[3]);
    });
    it(`round-trips through the inverse for a ${name}`, () => {
      const m = squareToQuad(q);
      const inv = invert3(m)!;
      expect(inv).not.toBeNull();
      const p = apply(m, 0.3, 0.7);
      close(apply(inv, p[0], p[1]), [0.3, 0.7]);
    });
  }

  it('rejects a collapsed quad', () => {
    const m = squareToQuad([[10, 10], [10, 10], [10, 10], [10, 10]]);
    expect(invert3(m)).toBeNull();
  });
});

describe('flip', () => {
  const q: [Pt, Pt, Pt, Pt] = [[0.1, 0.2], [0.6, 0.15], [0.7, 0.8], [0.05, 0.9]];
  const flips = [
    ['left–right', { h: true, v: false }],
    ['upside down', { h: false, v: true }],
    ['both (ceiling mount)', { h: true, v: true }],
  ] as const;

  for (const [name, f] of flips) {
    it(`mirrors the whole panel ${name}, not just its corners`, () => {
      // The homography onto the flipped quad must equal the mirror of the original at every point,
      // so content, text and softness inside the panel mirror too.
      const m = squareToQuad(q);
      const mf = squareToQuad(flipQuad(q, f));
      for (const [u, v] of [[0.5, 0.5], [0.25, 0.8], [0.9, 0.1]]) close(apply(mf, u, v), flipPt(apply(m, u, v), f));
    });

    it(`undoes itself ${name}`, () => {
      close(flipPt(flipPt([0.3, 0.7], f), f), [0.3, 0.7]);
    });
  }

  it('leaves an unflipped quad alone', () => {
    expect(flipQuad(q, { h: false, v: false })).toBe(q);
  });
});
