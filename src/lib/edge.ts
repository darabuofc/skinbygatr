import type { Mesh, Pt, Quad } from './types';

/*
 * Edge drag: pressing on a panel's outline slides that edge in or out, stretching the panel
 * one way without the other corners moving. Edges are numbered clockwise from the top,
 * between corners e and e+1: 0 top, 1 right, 2 bottom, 3 left. Pure and tested.
 */

export const EDGES = [0, 1, 2, 3] as const;

const lo = -0.25, hi = 1.25;
const clampCoord = (v: number) => Math.max(lo, Math.min(hi, v));

/**
 * How far to move an edge for a pointer move of `delta` (stage fractions): only the part along the
 * edge's outward normal counts, so a diagonal drag still stretches cleanly. `aspect` is stage
 * width over height, so the normal is measured in pixels rather than fractions.
 */
export function edgeOffset(corners: Quad, edge: number, delta: Pt, aspect: number): Pt {
  const a = corners[edge], b = corners[(edge + 1) % 4];
  const dx = (b[0] - a[0]) * aspect, dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [0, 0];
  let nx = dy / len, ny = -dx / len;
  // Outward is away from the middle of the panel, whichever way the corners wind.
  const cx = corners.reduce((s, q) => s + q[0], 0) / 4, cy = corners.reduce((s, q) => s + q[1], 0) / 4;
  if (((a[0] + b[0]) / 2 - cx) * aspect * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
  const t = delta[0] * aspect * nx + delta[1] * ny;
  return [(t * nx) / aspect, t * ny];
}

/** The corners with one edge moved by `offset`. */
export function moveEdge(corners: Quad, edge: number, offset: Pt): Quad {
  const j = (edge + 1) % 4;
  return corners.map((q, n) => (n === edge || n === j ? [clampCoord(q[0] + offset[0]), clampCoord(q[1] + offset[1])] : q)) as Quad;
}

/** Indices into a mesh's points of one border: its whole row or column. */
export function meshEdgeIndices(m: Mesh, edge: number): number[] {
  const out: number[] = [];
  if (edge === 0) for (let c = 0; c < m.cols; c++) out.push(c);
  else if (edge === 2) for (let c = 0; c < m.cols; c++) out.push((m.rows - 1) * m.cols + c);
  else if (edge === 1) for (let r = 0; r < m.rows; r++) out.push(r * m.cols + m.cols - 1);
  else for (let r = 0; r < m.rows; r++) out.push(r * m.cols);
  return out;
}

/** The mesh with the points along one border moved by `offset`. */
export function moveMeshEdge(m: Mesh, edge: number, offset: Pt): Mesh {
  const on = new Set(meshEdgeIndices(m, edge));
  return { ...m, pts: m.pts.map((q, i) => (on.has(i) ? [clampCoord(q[0] + offset[0]), clampCoord(q[1] + offset[1])] as Pt : q)) };
}
