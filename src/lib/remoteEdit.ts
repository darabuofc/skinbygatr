import { insertIndex, MAX_MASK_POINTS, MIN_MASK_POINTS } from './mask';
import { meshCorners } from './mesh';
import type { HandleKind } from './remote';
import type { Pt, Quad } from './types';

/**
 * Mapping edits as pure functions over a panel's shape. The Mac applies them to its panels and the
 * phone applies the same ones to its copy as it sends, so both agree and a drag looks instant on the phone.
 */

export interface Shaped {
  corners: Quad;
  mesh?: { cols: number; rows: number; pts: Pt[] };
  mask?: { points: { p: Pt; smooth?: boolean }[] };
}

/** How far outside the stage a point may be dragged, as in the on-screen handles. */
export const EDGE_MIN = -0.25;
export const EDGE_MAX = 1.25;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const clampPt = ([x, y]: Pt): Pt => [clamp(x, EDGE_MIN, EDGE_MAX), clamp(y, EDGE_MIN, EDGE_MAX)];

/** Where a handle is now, or null when the panel has no such handle. */
export function handlePos(p: Shaped, h: HandleKind, i: number): Pt | null {
  if (h === 'c') return p.mesh ? null : p.corners[i] ?? null;
  if (h === 'g') return p.mesh?.pts[i] ?? null;
  return p.mask?.points[i]?.p ?? null;
}

/** Moves one handle to an absolute stage position. A panel without that handle comes back unchanged. */
export function movePoint<T extends Shaped>(p: T, h: HandleKind, i: number, to: Pt): T {
  const pt = clampPt(to);
  if (!handlePos(p, h, i)) return p;
  if (h === 'c') return { ...p, corners: p.corners.map((q, n) => (n === i ? pt : q)) as Quad };
  if (h === 'g' && p.mesh) {
    const mesh = { ...p.mesh, pts: p.mesh.pts.map((q, n) => (n === i ? pt : q)) };
    return { ...p, mesh, corners: meshCorners(mesh as never) };
  }
  if (h === 'm' && p.mask) return { ...p, mask: { ...p.mask, points: p.mask.points.map((mp, n) => (n === i ? { ...mp, p: pt } : mp)) } };
  return p;
}

/** Moves the whole panel, carrying its mesh and mask along, like dragging its middle badge. */
export function movePanel<T extends Shaped>(p: T, dx: number, dy: number): T {
  const sh = ([x, y]: Pt): Pt => [x + dx, y + dy];
  return {
    ...p,
    corners: p.corners.map(sh) as Quad,
    ...(p.mesh ? { mesh: { ...p.mesh, pts: p.mesh.pts.map(sh) } } : {}),
    ...(p.mask ? { mask: { ...p.mask, points: p.mask.points.map((mp) => ({ ...mp, p: sh(mp.p) })) } } : {}),
  };
}

/** A projector-pixel step as a stage fraction, for nudge buttons. */
export const pixelStep = (px: number, size: [number, number]): Pt => [px / Math.max(1, size[0]), px / Math.max(1, size[1])];

/**
 * Adds a mask point on the outline nearest `pt`, as clicking the outline on the Mac does: after the
 * start of the nearest segment, taking the look of the point before it. Returns the panel and the new
 * point's index, or null when there's no room or no mask.
 */
export function insertMaskPt<T extends Shaped>(p: T, pt: Pt, aspect: number): { panel: T; at: number } | null {
  const m = p.mask;
  if (!m || m.points.length >= MAX_MASK_POINTS || m.points.length === 0) return null;
  const pts = m.points.map((mp) => ({ p: mp.p, smooth: mp.smooth !== false }));
  const at = insertIndex(pts, pt, aspect);
  const smooth = pts[at - 1]?.smooth ?? true;
  const points = [...m.points.slice(0, at), { p: clampPt(pt), smooth }, ...m.points.slice(at)];
  return { panel: { ...p, mask: { ...m, points } }, at };
}

/** Removes a mask point, keeping at least the three an outline needs. */
export function deleteMaskPt<T extends Shaped>(p: T, i: number): T {
  const m = p.mask;
  if (!m || !m.points[i] || m.points.length <= MIN_MASK_POINTS) return p;
  return { ...p, mask: { ...m, points: m.points.filter((_, j) => j !== i) } };
}

/** Switches a mask point between a smooth curve and a sharp corner. */
export function toggleMaskPt<T extends Shaped>(p: T, i: number): T {
  const m = p.mask;
  if (!m || !m.points[i]) return p;
  return { ...p, mask: { ...m, points: m.points.map((mp, j) => (j === i ? { ...mp, smooth: mp.smooth === false } : mp)) } };
}
