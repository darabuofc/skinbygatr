import type { Pt, Quad } from './types';

/** Row-major 3x3 matrix. */
export type Mat3 = number[];

/**
 * Projective map from the unit square to a quad.
 * (0,0)->q[0] (TL), (1,0)->q[1] (TR), (1,1)->q[2] (BR), (0,1)->q[3] (BL).
 */
export function squareToQuad(q: readonly [Pt, Pt, Pt, Pt]): Mat3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  }
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  const out = inv.map((v) => v / det);
  return out.every(Number.isFinite) ? out : null;
}

export function apply(m: Mat3, u: number, v: number): Pt {
  const w = m[6] * u + m[7] * v + m[8];
  return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
}

/** WebGL expects column-major order for uniformMatrix3fv. */
export function toColumnMajor(m: Mat3): Float32Array {
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

/** Which axes an output mirrors. */
export interface Flip { h: boolean; v: boolean; }

/**
 * Where a stage point (0..1) lands on a flipped output. Mirroring is its own inverse, so this
 * also takes a point on the output back to the stage.
 */
export function flipPt([x, y]: Pt, f: Flip): Pt {
  return [f.h ? 1 - x : x, f.v ? 1 - y : y];
}

/**
 * The quad as drawn on a flipped output. Keeping corner order means the panel's homography to
 * this quad is the original one followed by the mirror, so content, text, softness and the test
 * grid all mirror with it.
 */
export function flipQuad(q: Quad, f: Flip): Quad {
  return (f.h || f.v ? q.map((p) => flipPt(p, f)) : q) as Quad;
}
