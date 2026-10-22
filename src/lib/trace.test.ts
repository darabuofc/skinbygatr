import { describe, expect, it } from 'vitest';
import { bakeMaskPixels, pictureBounds, photoGrid, largestBlob, maskFromPixels, pickSource, simplifyTo, solidGrid, traceOutline, withSmoothness } from './trace';
import type { Pt, Quad } from './types';

const UNIT: Quad = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** RGBA pixels from rows of characters: '#' = opaque white, '.' = fully transparent. */
function alphaPx(rows: string[]) {
  const h = rows.length, w = rows[0].length;
  const data = new Uint8ClampedArray(w * h * 4);
  rows.forEach((r, y) => [...r].forEach((c, x) => data.set(c === '#' ? [255, 255, 255, 255] : [0, 0, 0, 0], (y * w + x) * 4)));
  return { width: w, height: h, data };
}
const area = (p: Pt[]) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const grid = (rows: string[]) => Uint8Array.from(rows.join(''), (c) => (c === '#' ? 1 : 0));

describe('traceOutline', () => {
  it('walks a rectangle round its four corners', () => {
    const o = traceOutline(grid(['....', '.##.', '.##.', '....']), 4, 4);
    expect(o).toHaveLength(4);
    expect(area(o)).toBe(4);
  });

  it('follows a concave shape exactly (outline area equals pixel count)', () => {
    const rows = ['#.....', '#.....', '#.##..', '####..', '......'];
    const o = traceOutline(grid(rows), 6, 5);
    expect(area(o)).toBe([...rows.join('')].filter((c) => c === '#').length);
  });

  it('works for a single pixel and touching the image border', () => {
    expect(area(traceOutline(grid(['#']), 1, 1))).toBe(1);
    expect(area(traceOutline(grid(['##', '##']), 2, 2))).toBe(4);
  });

  it('ignores holes: the outer outline is what is traced', () => {
    const rows = ['####', '#..#', '#..#', '####'];
    expect(area(traceOutline(grid(rows), 4, 4))).toBe(16);
  });
});

describe('largestBlob', () => {
  it('keeps the biggest shape only', () => {
    const rows = ['##...#', '##....', '......'];
    const b = largestBlob(grid(rows), 6, 3)!;
    expect([...b].reduce((a, v) => a + v, 0)).toBe(4);
    expect(b[5]).toBe(0);
  });

  it('is null for an empty picture', () => {
    expect(largestBlob(grid(['....']), 4, 1)).toBeNull();
  });
});

describe('source detection', () => {
  it('uses alpha when the picture has transparency, brightness otherwise', () => {
    expect(pickSource(alphaPx(['#.']))).toBe('alpha');
    const flat = { width: 2, height: 1, data: [255, 255, 255, 255, 0, 0, 0, 255] };
    expect(pickSource(flat)).toBe('brightness');
    expect([...solidGrid(flat)]).toEqual([1, 0]);
  });
});

describe('simplifyTo', () => {
  it('reduces a circle to at most the limit and stays close to it', () => {
    const circle: Pt[] = Array.from({ length: 400 }, (_, i) => [50 + 40 * Math.cos((i / 400) * 6.2832), 50 + 40 * Math.sin((i / 400) * 6.2832)]);
    const s = simplifyTo(circle, 24);
    expect(s.length).toBeLessThanOrEqual(24);
    expect(s.length).toBeGreaterThan(12);
    expect(area(s)).toBeGreaterThan(area(circle) * 0.95);
  });

  it('leaves short outlines alone', () => {
    const sq: Pt[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(simplifyTo(sq, 10)).toEqual(sq);
  });
});

describe('withSmoothness', () => {
  it('keeps a square\'s corners sharp and curves a gentle bend', () => {
    expect(withSmoothness([[0, 0], [1, 0], [1, 1], [0, 1]]).every((m) => !m.smooth)).toBe(true);
    expect(withSmoothness([[0, 0], [10, 1], [20, 3], [10, 20]])[1].smooth).toBe(true);
  });
});

describe('maskFromPixels', () => {
  const rows = ['........', '..####..', '..####..', '..####..', '........'];

  it('places the whole picture on the panel', () => {
    const m = maskFromPixels(alphaPx(rows), UNIT)!;
    const xs = m.points.map((q) => q.p[0]), ys = m.points.map((q) => q.p[1]);
    expect(Math.min(...xs)).toBeCloseTo(0.25); expect(Math.max(...xs)).toBeCloseTo(0.75);
    expect(Math.min(...ys)).toBeCloseTo(0.2); expect(Math.max(...ys)).toBeCloseTo(0.8);
  });

  it('can fit the shape\'s bounds to the panel instead', () => {
    const m = maskFromPixels(alphaPx(rows), UNIT, { fit: 'shape' })!;
    const xs = m.points.map((q) => q.p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0); expect(Math.max(...xs)).toBeCloseTo(1);
  });

  it('follows the panel\'s quad', () => {
    const quad: Quad = [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]];
    const m = maskFromPixels(alphaPx(rows), quad, { fit: 'shape' })!;
    expect(Math.min(...m.points.map((q) => q.p[0]))).toBeCloseTo(0.5);
  });

  it('respects the point limit and returns null for blank pictures', () => {
    const big = alphaPx(Array.from({ length: 40 }, (_, y) => '.'.repeat(5) + '#'.repeat(10 + (y % 7)) + '.'.repeat(7 - (y % 7) + 5)));
    expect(maskFromPixels(big, UNIT, { maxPoints: 8 })!.points.length).toBeLessThanOrEqual(8);
    expect(maskFromPixels(alphaPx(['....', '....']), UNIT)).toBeNull();
  });
});

describe('bakeMaskPixels', () => {
  const rows = ['........', '.##..##.', '.######.', '........'];

  it('keeps the picture as it is, holes and pieces included', () => {
    const b = bakeMaskPixels(alphaPx(rows))!;
    expect([b.width, b.height]).toEqual([8, 4]);
    const a = (x: number, y: number) => b.data[(y * b.width + x) * 4 + 3];
    expect(a(1, 1)).toBe(255); expect(a(3, 1)).toBe(0); expect(a(5, 1)).toBe(255);
    expect(b.data[0]).toBe(255);
  });

  it('crops to the shape on request', () => {
    const b = bakeMaskPixels(alphaPx(rows), { fit: 'shape' })!;
    expect([b.width, b.height]).toEqual([6, 2]);
  });

  it('reads brightness for a flat picture and is null when nothing shows', () => {
    const flat = { width: 2, height: 1, data: [255, 255, 255, 255, 0, 0, 0, 255] };
    expect(bakeMaskPixels(flat)!.data[3]).toBe(255);
    expect(bakeMaskPixels(flat)!.data[7]).toBe(0);
    expect(bakeMaskPixels(alphaPx(['....']))).toBeNull();
  });
});

describe('pictureBounds', () => {
  it('finds the shape inside transparent margins', () => {
    expect(pictureBounds(alphaPx(['....', '.##.', '.##.', '....']))).toEqual([0.25, 0.25, 0.5, 0.5]);
  });
  it('is the whole picture when it has no shape to find', () => {
    expect(pictureBounds(alphaPx(['....']))).toEqual([0, 0, 1, 1]);
  });
});

describe('photo cutouts', () => {
  /** A photo: pale grey wall, a tan board, and a small tan speck elsewhere. */
  function photo() {
    const w = 20, h = 10, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w, y = (i / w) | 0;
      const board = x >= 4 && x < 16 && y >= 2 && y < 8;
      const speck = x === 1 && y === 1;
      data.set(board || speck ? [190, 160, 125, 255] : [225, 225, 228, 255], i * 4);
    }
    return { width: w, height: h, data };
  }

  it('separates the warm board from a neutral wall', () => {
    const g = photoGrid(photo());
    expect(g[3 * 20 + 5]).toBe(1);
    expect(g[0]).toBe(0);
  });

  it('bakes only the biggest piece, cropped to it on request', () => {
    const b = bakeMaskPixels(photo(), { source: 'photo', fit: 'shape' })!;
    expect([b.width, b.height]).toEqual([12, 6]);
    expect(b.data[3]).toBe(255);
  });
});
