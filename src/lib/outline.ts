import { flipPt, type Flip } from './homography';
import { bezierAt, maskSegments } from './mask';
import { evalMesh, meshKey } from './mesh';
import type { Band, Mesh, Mask, Outline, OutlineStyle, Pt, Quad } from './types';

/*
 * Neon outlines: an animated line along a panel's edge. The path is the freeform mask's outline, or
 * the panel's own border (corners, or the mesh's rim) when there's no outline mask. It's drawn as its
 * own triangle strip over the panel, so it stays crisp however soft the mask's feather is. Geometry
 * and settings are pure and tested here; the renderer uploads the strip and the shader animates it.
 */

export const OUTLINE_STYLE_IDS: OutlineStyle[] = ['chase', 'dashes', 'pulse', 'rainbow', 'flicker'];
const BANDS: Band[] = ['bass', 'mid', 'high', 'all', 'none'];
/** Bars per lap choices; 0 runs free at `speed`. */
export const OUTLINE_SYNCS: [number, string][] = [[0, 'Free (speed)'], [1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars']];
export const MAX_OUTLINE_WIDTH = 40;
export const MAX_OUTLINE_SPEED = 2;
export const MAX_OUTLINE_RUNNERS = 8;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);

export function defaultOutline(): Outline {
  return { on: true, style: 'chase', color: 'c1', width: 6, glow: 0.6, speed: 0.25, runners: 2, length: 0.5, reverse: false, band: 'none', sync: 0 };
}

/** A valid outline, or null when there isn't one to apply. */
export function sanitizeOutline(v: unknown): Outline | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const d = defaultOutline();
  return {
    on: o.on === true,
    style: OUTLINE_STYLE_IDS.includes(o.style as OutlineStyle) ? (o.style as OutlineStyle) : d.style,
    color: o.color === 'c1' || o.color === 'c2' || (typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color)) ? (o.color as string) : d.color,
    width: num(o.width, 1, MAX_OUTLINE_WIDTH, d.width),
    glow: num(o.glow, 0, 1, d.glow),
    speed: num(o.speed, 0, MAX_OUTLINE_SPEED, d.speed),
    runners: Math.round(num(o.runners, 1, MAX_OUTLINE_RUNNERS, d.runners)),
    length: num(o.length, 0.05, 1, d.length),
    reverse: o.reverse === true,
    band: BANDS.includes(o.band as Band) ? (o.band as Band) : d.band,
    sync: OUTLINE_SYNCS.some(([n]) => n === o.sync) ? (o.sync as number) : d.sync,
  };
}

/** Where along the loop the animation is, in laps (fractional; the sign gives the direction). */
export function outlinePhase(o: Outline, t: number, bpm: number, beatsPerBar: number): number {
  const laps = o.sync > 0 ? (t * bpm) / 60 / (o.sync * beatsPerBar) : t * o.speed;
  return o.reverse ? -laps : laps;
}

interface Shaped { corners: Quad; mesh?: Mesh; mask?: Mask }

const SAMPLES = 16;
const RIM = 24;

/** The line's path as a closed polyline of stage fractions, mirrored as the projector draws it. */
export function outlinePath(p: Shaped, flip: Flip): Pt[] {
  const raw: Pt[] = [];
  if (p.mask && p.mask.points.length >= 3 && !p.mask.image) {
    for (const s of maskSegments(p.mask.points)) for (let k = 0; k < SAMPLES; k++) raw.push(bezierAt(s, k / SAMPLES));
  } else if (p.mesh) {
    const m = p.mesh;
    for (let k = 0; k < RIM; k++) raw.push(evalMesh(m, k / RIM, 0));
    for (let k = 0; k < RIM; k++) raw.push(evalMesh(m, 1, k / RIM));
    for (let k = 0; k < RIM; k++) raw.push(evalMesh(m, 1 - k / RIM, 1));
    for (let k = 0; k < RIM; k++) raw.push(evalMesh(m, 0, 1 - k / RIM));
  } else raw.push(...p.corners);
  const out: Pt[] = [];
  for (const q of raw) {
    const f = flipPt(q, flip);
    const last = out[out.length - 1];
    if (!last || Math.hypot(f[0] - last[0], f[1] - last[1]) > 1e-6) out.push(f);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-6) out.pop();
  return out;
}

/** Floats per strip vertex: clip x, clip y, position round the loop (0..1), and side (-1..1). */
export const STRIP_STRIDE = 4;
const MITER_LIMIT = 2.5;

/**
 * The path extruded into a closed triangle strip, `half` pixels either side, in clip space for a
 * w × h output. `s` runs 0..1 round the loop by length in pixels, so speed looks even everywhere.
 * Returns null when there's nothing to draw.
 */
export function buildStrip(path: readonly Pt[], w: number, h: number, half: number): { verts: Float32Array; count: number } | null {
  const n = path.length;
  if (n < 2) return null;
  const px = path.map(([x, y]) => [x * w, y * h] as Pt);
  const len: number[] = [0];
  for (let i = 1; i <= n; i++) {
    const a = px[i - 1], b = px[i % n];
    len.push(len[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = len[n];
  if (total < 1e-6) return null;
  const verts = new Float32Array((n + 1) * 2 * STRIP_STRIDE);
  for (let i = 0; i <= n; i++) {
    const prev = px[(i - 1 + n) % n], cur = px[i % n], next = px[(i + 1) % n];
    const unit = (a: Pt, b: Pt): Pt => {
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      return [dx / l, dy / l];
    };
    const d0 = unit(prev, cur), d1 = unit(cur, next);
    // Normal of the average direction, stretched so the strip keeps its width round a bend.
    let nx = -(d0[1] + d1[1]), ny = d0[0] + d1[0];
    const nl = Math.hypot(nx, ny);
    let scale = 1;
    if (nl < 1e-6) { nx = -d1[1]; ny = d1[0]; } else {
      nx /= nl; ny /= nl;
      scale = Math.min(MITER_LIMIT, 1 / Math.max(0.01, nx * -d1[1] + ny * d1[0]));
    }
    const s = len[i] / total;
    for (const side of [-1, 1]) {
      const o = (i * 2 + (side < 0 ? 0 : 1)) * STRIP_STRIDE;
      verts[o] = ((cur[0] + nx * half * scale * side) / w) * 2 - 1;
      verts[o + 1] = 1 - ((cur[1] + ny * half * scale * side) / h) * 2;
      verts[o + 2] = s;
      verts[o + 3] = side;
    }
  }
  return { verts, count: (n + 1) * 2 };
}

/** Half the strip's width in pixels: the line plus room for its glow. */
export const stripHalf = (o: Outline, h: number) => {
  const k = h / 1080;
  return (o.width / 2 + 2 + o.glow * o.width * 4 + o.glow * 24) * k;
};

/** Cache key for a panel's strip, from what the path is made of, so it's cheap to check every frame. */
export function stripKey(p: Shaped, flip: Flip, w: number, h: number, half: number): string {
  const f = (q: Pt) => `${q[0].toFixed(5)},${q[1].toFixed(5)}`;
  const shape = p.mask && p.mask.points.length >= 3 && !p.mask.image
    ? 'm' + p.mask.points.map((m) => f(m.p) + (m.smooth ? 's' : 'c')).join(';')
    : p.mesh ? 'g' + meshKey(p.mesh) : 'q' + p.corners.map(f).join(';');
  return `${w}x${h}|${flip.h ? 1 : 0}${flip.v ? 1 : 0}|${half.toFixed(2)}|${shape}`;
}
