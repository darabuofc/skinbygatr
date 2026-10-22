import { apply, squareToQuad } from './homography';
import type { Mesh, Pt, Quad } from './types';

/*
 * Mesh warp: a grid of control points per panel, for surfaces that aren't flat, such as an
 * upturned bowl. The picture bends smoothly through every point (a Catmull-Rom surface), so a
 * 5×5 grid can follow a dome without visible kinks. Points are stage fractions as the audience
 * sees the surface, row by row from the top-left. Pure and tested; the renderer draws the
 * tessellation and the handles draw the grid lines.
 */

export const MIN_MESH = 2;
export const MAX_MESH = 8;
/** Grid sizes offered in the panel settings, points across × down. */
export const MESH_SIZES = [3, 4, 5, 6] as const;
/** Triangles per control cell, each way. Enough that the curve reads as smooth on a projector. */
export const MESH_SUB = 16;

const clampCoord = (v: number) => Math.max(-0.25, Math.min(1.25, v));
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** A valid mesh, or null when the panel should use its four corners. */
export function sanitizeMesh(v: unknown): Mesh | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isInt(o.cols, MIN_MESH, MAX_MESH) || !isInt(o.rows, MIN_MESH, MAX_MESH) || !Array.isArray(o.pts)) return null;
  if (o.pts.length !== o.cols * o.rows) return null;
  const pts: Pt[] = [];
  for (const p of o.pts) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    pts.push([clampCoord(p[0]), clampCoord(p[1])]);
  }
  return { cols: o.cols, rows: o.rows, pts };
}

/** A grid that reproduces the panel's four-corner warp, so switching to a mesh changes nothing on the wall. */
export function meshFromQuad(corners: Quad, cols: number, rows: number): Mesh {
  const h = squareToQuad(corners);
  const pts: Pt[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push(apply(h, c / (cols - 1), r / (rows - 1)));
  return { cols, rows, pts };
}

/** Corners of the grid, in panel order: top-left, top-right, bottom-right, bottom-left. */
export function meshCorners(m: Mesh): Quad {
  const at = (c: number, r: number) => m.pts[r * m.cols + c];
  return [at(0, 0), at(m.cols - 1, 0), at(m.cols - 1, m.rows - 1), at(0, m.rows - 1)];
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
}

/** Control point, extended past the edge in a straight line so the border stays where its points are. */
function ctrl(m: Mesh, c: number, r: number): Pt {
  const cc = Math.max(0, Math.min(m.cols - 1, c)), rr = Math.max(0, Math.min(m.rows - 1, r));
  const base = m.pts[rr * m.cols + cc];
  if (cc === c && rr === r) return base;
  // Mirror through the edge point: P(-1) = 2·P(0) − P(1), in whichever directions ran off.
  const ic = cc + (c < cc ? 1 : c > cc ? -1 : 0), ir = rr + (r < rr ? 1 : r > rr ? -1 : 0);
  const inner = m.pts[Math.min(m.rows - 1, Math.max(0, ir)) * m.cols + Math.min(m.cols - 1, Math.max(0, ic))];
  return [2 * base[0] - inner[0], 2 * base[1] - inner[1]];
}

/** Point on the warped surface at panel coordinates (u, v), 0..1 each. */
export function evalMesh(m: Mesh, u: number, v: number): Pt {
  const fx = Math.max(0, Math.min(1, u)) * (m.cols - 1), fy = Math.max(0, Math.min(1, v)) * (m.rows - 1);
  const c = Math.min(m.cols - 2, Math.floor(fx)), r = Math.min(m.rows - 2, Math.floor(fy));
  const tx = fx - c, ty = fy - r;
  const out: Pt = [0, 0];
  for (const k of [0, 1] as const) {
    const rowsAt = [-1, 0, 1, 2].map((dr) => {
      const q = [-1, 0, 1, 2].map((dc) => ctrl(m, c + dc, r + dr)[k]);
      return catmull(q[0], q[1], q[2], q[3], tx);
    });
    out[k] = catmull(rowsAt[0], rowsAt[1], rowsAt[2], rowsAt[3], ty);
  }
  return out;
}

/** The same surface with a different number of points, so changing grid size keeps the fit. */
export function resampleMesh(m: Mesh, cols: number, rows: number): Mesh {
  const pts: Pt[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push(evalMesh(m, c / (cols - 1), r / (rows - 1)));
  return { cols, rows, pts };
}

export interface Tessellation {
  /** Vertex positions (stage fractions) and panel uv, interleaved x, y, u, v. */
  verts: Float32Array;
  indices: Uint16Array;
  /** Bounding box of the vertices: min x, min y, max x, max y. */
  bbox: [number, number, number, number];
}

/** Triangles covering the warped surface, `sub` per cell each way. */
export function tessellate(m: Mesh, sub = MESH_SUB): Tessellation {
  const nx = (m.cols - 1) * sub + 1, ny = (m.rows - 1) * sub + 1;
  const verts = new Float32Array(nx * ny * 4);
  const bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const u = i / (nx - 1), v = j / (ny - 1);
      const [x, y] = evalMesh(m, u, v);
      verts.set([x, y, u, v], (j * nx + i) * 4);
      bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y);
      bbox[2] = Math.max(bbox[2], x); bbox[3] = Math.max(bbox[3], y);
    }
  }
  const indices = new Uint16Array((nx - 1) * (ny - 1) * 6);
  let k = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      indices.set([a, b, c, b, d, c], k);
      k += 6;
    }
  }
  return { verts, indices, bbox };
}

/** Grid lines through the control rows and columns, sampled along the surface, for the editing handles. */
export function meshLines(m: Mesh, samples = 24): Pt[][] {
  const lines: Pt[][] = [];
  for (let r = 0; r < m.rows; r++) {
    lines.push(Array.from({ length: samples + 1 }, (_, s) => evalMesh(m, s / samples, r / (m.rows - 1))));
  }
  for (let c = 0; c < m.cols; c++) {
    lines.push(Array.from({ length: samples + 1 }, (_, s) => evalMesh(m, c / (m.cols - 1), s / samples)));
  }
  return lines;
}

/** Cache key for a tessellation: changes whenever the triangles would. */
export const meshKey = (m: Mesh) => `${m.cols}x${m.rows}|${m.pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';')}`;
