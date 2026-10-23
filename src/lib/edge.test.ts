import { describe, expect, it } from 'vitest';
import { edgeOffset, meshEdgeIndices, moveEdge, moveMeshEdge } from './edge';
import { meshCorners, meshFromQuad } from './mesh';
import type { Quad } from './types';

const rect: Quad = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];

describe('edgeOffset', () => {
  it('keeps only the part of the drag along the edge normal', () => {
    const top = edgeOffset(rect, 0, [0.1, -0.05], 1), right = edgeOffset(rect, 1, [0.1, -0.05], 1);
    expect(top[0]).toBeCloseTo(0); expect(top[1]).toBeCloseTo(-0.05);
    expect(right[0]).toBeCloseTo(0.1); expect(right[1]).toBeCloseTo(0);
    const o = edgeOffset(rect, 3, [0.1, 0.3], 1);
    expect(o[0]).toBeCloseTo(0.1); expect(o[1]).toBeCloseTo(0);
  });

  it('points outward for every edge, so dragging out grows the panel', () => {
    expect(edgeOffset(rect, 2, [0, 0.1], 1)[1]).toBeCloseTo(0.1);
    expect(edgeOffset(rect, 3, [-0.1, 0], 1)[0]).toBeCloseTo(-0.1);
  });

  it('works whichever way the corners wind', () => {
    const rev: Quad = [rect[0], rect[3], rect[2], rect[1]];
    expect(edgeOffset(rev, 1, [0, 0.1], 1)[1]).toBeCloseTo(0.1);
  });

  it('follows a skewed edge, measured in pixels on a wide stage', () => {
    const o = edgeOffset([[0, 0.5], [0.5, 0.5], [0.5, 1], [0, 1]], 0, [0.2, 0.2], 2);
    expect(o[0]).toBeCloseTo(0); expect(o[1]).toBeCloseTo(0.2);
    const skew: Quad = [[0.1, 0.1], [0.6, 0.2], [0.6, 0.8], [0.1, 0.8]];
    const k = edgeOffset(skew, 0, [0, -0.1], 1);
    expect(k[0]).not.toBeCloseTo(0);
    expect(k[1]).toBeLessThan(0);
  });

  it('is zero for a collapsed edge', () => {
    expect(edgeOffset([[0.5, 0.5], [0.5, 0.5], [0.8, 0.8], [0.2, 0.8]], 0, [0.1, 0.1], 1)).toEqual([0, 0]);
  });
});

describe('moveEdge', () => {
  it('moves only the two corners of the edge and clamps', () => {
    const q = moveEdge(rect, 1, [0.1, 0]);
    expect(q[1]).toEqual([0.9, 0.2]); expect(q[2]).toEqual([0.9, 0.8]);
    expect(q[0]).toEqual(rect[0]); expect(q[3]).toEqual(rect[3]);
    expect(moveEdge(rect, 3, [-5, 0])[0][0]).toBe(-0.25);
  });
});

describe('mesh borders', () => {
  const m = meshFromQuad(rect, 4, 3);
  it('lists the row or column of points', () => {
    expect(meshEdgeIndices(m, 0)).toEqual([0, 1, 2, 3]);
    expect(meshEdgeIndices(m, 2)).toEqual([8, 9, 10, 11]);
    expect(meshEdgeIndices(m, 1)).toEqual([3, 7, 11]);
    expect(meshEdgeIndices(m, 3)).toEqual([0, 4, 8]);
  });
  it('moves just that border, matching the four-corner move', () => {
    const n = moveMeshEdge(m, 0, [0, -0.1]);
    n.pts.forEach((p, i) => { if (i < 4) expect(p[1]).toBeCloseTo(0.1); else expect(p).toEqual(m.pts[i]); });
    const c = meshCorners(n), q = moveEdge(rect, 0, [0, -0.1]);
    c.forEach((p, i) => { expect(p[0]).toBeCloseTo(q[i][0]); expect(p[1]).toBeCloseTo(q[i][1]); });
  });
});
