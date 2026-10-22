import { describe, expect, it } from 'vitest';
import { apply, squareToQuad } from './homography';
import {
  evalMesh, MAX_MESH, meshCorners, meshFromQuad, meshKey, meshLines, resampleMesh, sanitizeMesh, tessellate,
} from './mesh';
import type { Mesh, Pt, Quad } from './types';

const close = (a: Pt, b: Pt, d = 9) => { expect(a[0]).toBeCloseTo(b[0], d); expect(a[1]).toBeCloseTo(b[1], d); };
const quad: Quad = [[0.1, 0.1], [0.6, 0.15], [0.65, 0.8], [0.05, 0.75]];

describe('meshFromQuad', () => {
  it('samples the four-corner warp at every grid point', () => {
    const m = meshFromQuad(quad, 5, 5);
    const h = squareToQuad(quad);
    expect(m.pts).toHaveLength(25);
    close(m.pts[7], apply(h, 2 / 4, 1 / 4));
    expect(meshCorners(m)).toEqual([m.pts[0], m.pts[4], m.pts[24], m.pts[20]]);
    meshCorners(m).forEach((c, i) => close(c, quad[i]));
  });
});

describe('evalMesh', () => {
  it('passes exactly through every control point', () => {
    const m = meshFromQuad(quad, 4, 4);
    m.pts[5] = [0.3, 0.2];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) close(evalMesh(m, c / 3, r / 3), m.pts[r * 4 + c]);
  });

  it('keeps a flat, even grid flat and even', () => {
    const m: Mesh = { cols: 3, rows: 3, pts: [] };
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m.pts.push([0.2 + 0.3 * c, 0.1 + 0.4 * r]);
    close(evalMesh(m, 0.25, 0.75), [0.2 + 0.6 * 0.25, 0.1 + 0.8 * 0.75]);
  });

  it('keeps straight edges straight', () => {
    const m = meshFromQuad([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], 5, 5);
    m.pts[12] = [0.55, 0.45]; // a bulge in the middle
    for (let k = 0; k <= 10; k++) expect(evalMesh(m, k / 10, 0)[1]).toBeCloseTo(0.1, 9);
  });

  it('bends smoothly towards a moved point', () => {
    const m = meshFromQuad([[0, 0], [1, 0], [1, 1], [0, 1]], 5, 5);
    m.pts[12] = [0.5, 0.4];
    const near = evalMesh(m, 0.5, 0.45)[1], far = evalMesh(m, 0.5, 0.9)[1];
    expect(near).toBeLessThan(0.45);
    expect(far).toBeCloseTo(0.9, 1);
  });
});

describe('resampleMesh', () => {
  it('keeps the shape when the grid size changes', () => {
    const m = meshFromQuad(quad, 4, 4);
    m.pts[5] = [0.3, 0.2];
    const r = resampleMesh(m, 6, 6);
    expect(r.pts).toHaveLength(36);
    for (const [u, v] of [[0, 0], [1, 1], [0.4, 0.6]]) close(evalMesh(r, u, v), evalMesh(m, u, v), 2);
    meshCorners(r).forEach((c, i) => close(c, meshCorners(m)[i]));
  });
});

describe('tessellate', () => {
  it('covers the grid with sub × sub cells of two triangles', () => {
    const t = tessellate(meshFromQuad(quad, 5, 5), 8);
    const n = 4 * 8 + 1;
    expect(t.verts.length).toBe(n * n * 4);
    expect(t.indices.length).toBe((n - 1) * (n - 1) * 6);
    expect(Math.max(...t.indices)).toBe(n * n - 1);
    // First vertex is the top-left corner with uv (0, 0); last is bottom-right with uv (1, 1).
    expect([...t.verts.slice(0, 4)].map((v) => +v.toFixed(5))).toEqual([0.1, 0.1, 0, 0]);
    expect([...t.verts.slice(-2)]).toEqual([1, 1]);
    expect(t.bbox[0]).toBeCloseTo(0.05, 5);
    expect(t.bbox[3]).toBeCloseTo(0.8, 5);
  });

  it('stays within 16-bit indices at the largest grid', () => {
    const t = tessellate(meshFromQuad(quad, MAX_MESH, MAX_MESH));
    expect(t.verts.length / 4).toBeLessThan(65536);
  });
});

describe('sanitizeMesh', () => {
  it('keeps a valid grid and clamps its points', () => {
    const m = sanitizeMesh({ cols: 2, rows: 2, pts: [[0, 0], [9, 0], [1, 1], [0, -9]] })!;
    expect(m.pts).toEqual([[0, 0], [1.25, 0], [1, 1], [0, -0.25]]);
  });

  it('rejects grids that are the wrong size, too big, or have broken points', () => {
    expect(sanitizeMesh({ cols: 3, rows: 3, pts: [[0, 0]] })).toBeNull();
    expect(sanitizeMesh({ cols: 9, rows: 9, pts: Array(81).fill([0, 0]) })).toBeNull();
    expect(sanitizeMesh({ cols: 1, rows: 4, pts: Array(4).fill([0, 0]) })).toBeNull();
    expect(sanitizeMesh({ cols: 2, rows: 2, pts: [[0, 0], [1, 0], [1, NaN], [0, 1]] })).toBeNull();
    expect(sanitizeMesh({ cols: 2.5, rows: 2, pts: [] })).toBeNull();
    expect(sanitizeMesh(null)).toBeNull();
  });
});

describe('mesh helpers', () => {
  it('draws one line per row and column', () => {
    expect(meshLines(meshFromQuad(quad, 4, 5))).toHaveLength(9);
  });

  it('changes the cache key when a point moves', () => {
    const m = meshFromQuad(quad, 3, 3);
    const moved = { ...m, pts: m.pts.map((p, i) => (i === 4 ? [p[0] + 0.001, p[1]] as Pt : p)) };
    expect(meshKey(moved)).not.toBe(meshKey(m));
  });
});
