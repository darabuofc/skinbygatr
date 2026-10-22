import { apply, flipPt, squareToQuad, type Flip } from './homography';
import type { Mask, MaskPoint, Pt, Quad } from './types';

/*
 * Freeform masks: a closed outline per panel, drawn on the projector output, that clips the panel
 * to a shape such as the gator's head or one eye. Points are stage fractions as the audience sees
 * the surface, like panel corners. Smooth points curve through their neighbours; corner points
 * make sharp turns. The feather fades the edge inwards, so no light spills past the outline.
 * Geometry here is pure and tested; `drawMask` rasterises it for the renderer.
 */

export const MIN_MASK_POINTS = 3;
export const MAX_MASK_POINTS = 64;
/** Largest feather, as a fraction of the output height. */
export const MAX_MASK_FEATHER = 0.2;
/** Mask bitmap resolution as a share of the output's. Linear filtering keeps edges smooth. */
export const MASK_SCALE = 0.5;

/** Picture masks are stored in the settings, so they must stay small. */
export const MAX_MASK_IMAGE_CHARS = 1_500_000;
const MASK_IMAGE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

const clampCoord = (v: number) => Math.max(-0.25, Math.min(1.25, v));

/** A valid mask, or null when there isn't one to apply. */
export function sanitizeMask(v: unknown): Mask | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.image === 'string') {
    if (!MASK_IMAGE_RE.test(o.image) || o.image.length > MAX_MASK_IMAGE_CHARS) return null;
    const f = typeof o.feather === 'number' && Number.isFinite(o.feather) ? Math.max(0, Math.min(MAX_MASK_FEATHER, o.feather)) : 0;
    return { points: [], feather: f, invert: o.invert === true, image: o.image };
  }
  if (!Array.isArray(o.points)) return null;
  const points: MaskPoint[] = [];
  for (const raw of o.points.slice(0, MAX_MASK_POINTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const p = r.p;
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    points.push({ p: [clampCoord(p[0]), clampCoord(p[1])], smooth: r.smooth === true });
  }
  if (points.length < MIN_MASK_POINTS) return null;
  const f = typeof o.feather === 'number' && Number.isFinite(o.feather) ? Math.max(0, Math.min(MAX_MASK_FEATHER, o.feather)) : 0;
  return { points, feather: f, invert: o.invert === true };
}

/** A starting mask: an oval of smooth points inside the panel, following its perspective. */
export function defaultMask(corners: Quad, n = 8): Mask {
  const h = squareToQuad(corners);
  const points: MaskPoint[] = Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    return { p: apply(h, 0.5 + 0.4 * Math.cos(a), 0.5 + 0.4 * Math.sin(a)), smooth: true };
  });
  return { points, feather: 0.01, invert: false };
}

export interface Segment { from: Pt; c1: Pt; c2: Pt; to: Pt; }

const add = (a: Pt, b: Pt, k = 1): Pt => [a[0] + b[0] * k, a[1] + b[1] * k];
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];

/**
 * The outline as cubic Bézier segments, one from each point to the next (closed). Around a smooth
 * point the curve's tangent runs parallel to the line between its neighbours (Catmull-Rom), so the
 * outline passes through every point; a corner point's handles sit on the point itself.
 */
export function maskSegments(points: readonly MaskPoint[]): Segment[] {
  const n = points.length;
  if (n < 2) return [];
  const at = (i: number) => points[((i % n) + n) % n];
  return points.map((pt, i) => {
    const next = at(i + 1);
    const c1 = pt.smooth ? add(pt.p, sub(next.p, at(i - 1).p), 1 / 6) : pt.p;
    const c2 = next.smooth ? add(next.p, sub(at(i + 2).p, pt.p), -1 / 6) : next.p;
    return { from: pt.p, c1, c2, to: next.p };
  });
}

export function bezierAt(s: Segment, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * s.from[0] + b * s.c1[0] + c * s.c2[0] + d * s.to[0],
    a * s.from[1] + b * s.c1[1] + c * s.c2[1] + d * s.to[1],
  ];
}

/**
 * Where a point clicked on the outline goes in the list: after the start of the segment nearest
 * to it. `aspect` (width / height of the output) makes distances match what's on screen.
 */
export function insertIndex(points: readonly MaskPoint[], pt: Pt, aspect = 1): number {
  const segs = maskSegments(points);
  let best = 0, bestD = Infinity;
  segs.forEach((s, i) => {
    for (let k = 0; k <= 24; k++) {
      const q = bezierAt(s, k / 24);
      const d = ((q[0] - pt[0]) * aspect) ** 2 + (q[1] - pt[1]) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
  });
  return best + 1;
}

/** The outline traced into a path, in pixels of a w × h output, mirrored as the projector draws it. */
export function traceMask(path: { moveTo(x: number, y: number): void; bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void; closePath(): void },
  mask: Mask, w: number, h: number, flip: Flip) {
  const pts = mask.points.map((mp) => ({ ...mp, p: flipPt(mp.p, flip) }));
  const px = (p: Pt) => [p[0] * w, p[1] * h] as const;
  const segs = maskSegments(pts);
  if (!segs.length) return;
  path.moveTo(...px(segs[0].from));
  for (const s of segs) path.bezierCurveTo(...px(s.c1), ...px(s.c2), ...px(s.to));
  path.closePath();
}

/** SVG path data for the outline, in view pixels, for the editing handles. */
export function maskPathData(mask: Mask, w: number, h: number, flip: Flip): string {
  const parts: string[] = [];
  const f = (n: number) => n.toFixed(1);
  traceMask({
    moveTo: (x, y) => parts.push(`M${f(x)} ${f(y)}`),
    bezierCurveTo: (a, b, c, d, e, g) => parts.push(`C${f(a)} ${f(b)} ${f(c)} ${f(d)} ${f(e)} ${f(g)}`),
    closePath: () => parts.push('Z'),
  }, mask, w, h, flip);
  return parts.join('');
}

/** Cache key for a rasterised mask: changes whenever the bitmap would. */
export const maskKey = (mask: Mask, w: number, h: number, flip: Flip) =>
  `${w}x${h}|${flip.h ? 1 : 0}${flip.v ? 1 : 0}|${mask.feather}|${mask.invert ? 1 : 0}|` +
  mask.points.map((m) => `${m.p[0].toFixed(5)},${m.p[1].toFixed(5)}${m.smooth ? 's' : 'c'}`).join(';');

/**
 * Rasterises a mask into the canvas's alpha: opaque where the panel shows. The feather fades the
 * edge inside the outline (outside it for an inverted mask), so the shape's own edge stays dark
 * beyond the line either way. Browsers without canvas filters get a hard edge.
 */
export function drawMask(canvas: HTMLCanvasElement, scratch: HTMLCanvasElement, mask: Mask, w: number, h: number, flip: Flip) {
  for (const c of [canvas, scratch]) if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = canvas.getContext('2d');
  const sg = scratch.getContext('2d');
  if (!g || !sg) return;
  const path = new Path2D();
  traceMask(path, mask, w, h, flip);
  const f = mask.feather * h;
  const canBlur = 'filter' in g;

  // The shape, pulled in (or pushed out, inverted) by half the feather; the blur then spreads it back.
  sg.globalCompositeOperation = 'source-over';
  sg.clearRect(0, 0, w, h);
  sg.fillStyle = '#fff';
  sg.fill(path);
  if (f >= 0.5 && canBlur) {
    sg.lineWidth = f;
    sg.lineJoin = 'round';
    sg.strokeStyle = '#fff';
    sg.globalCompositeOperation = mask.invert ? 'source-over' : 'destination-out';
    sg.stroke(path);
    sg.globalCompositeOperation = 'source-over';
  }

  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  if (mask.invert) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'destination-out'; }
  if (f >= 0.5 && canBlur) g.filter = `blur(${(f / 4).toFixed(2)}px)`;
  g.drawImage(scratch, 0, 0);
  if (canBlur) g.filter = 'none';
  g.globalCompositeOperation = 'source-over';
}
