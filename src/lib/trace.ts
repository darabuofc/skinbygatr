import { apply, squareToQuad } from './homography';
import { MAX_MASK_POINTS, MIN_MASK_POINTS, sanitizeMask } from './mask';
import type { Mask, MaskPoint, Pt, Quad } from './types';

/*
 * Masks from pictures: trace the outline of a cutout image (its transparent or its bright
 * area) into a freeform mask. The biggest solid shape wins; holes inside it, such as eyes, are
 * ignored because a mask is a single outline. Pure and tested; `traceImage` is the browser glue.
 */

/** Longest side of the grid the shape is traced on. Plenty for ≤64 points. */
export const TRACE_SIZE = 512;
/** Points turning sharper than this (degrees) stay corners; gentler ones become curves. */
const CORNER_ANGLE = 55;

/** `photo`: the shape is the warm-coloured board in a photo of the real cutout, against a pale wall or floor. */
export type TraceSource = 'auto' | 'alpha' | 'brightness' | 'photo';
export type TraceFit = 'image' | 'shape';

/** RGBA pixels, as from ImageData. */
export interface Pixels { width: number; height: number; data: ArrayLike<number>; }

/** Which channel describes the shape: transparency if the picture has any, else brightness. */
export function pickSource(px: Pixels): 'alpha' | 'brightness' {
  for (let i = 3; i < px.data.length; i += 4) if (px.data[i] < 250) return 'alpha';
  return 'brightness';
}

/** True where the shape is: opaque pixels, or bright ones (white shows) for a flat picture. */
export function solidGrid(px: Pixels, source: TraceSource = 'auto'): Uint8Array {
  const src = source === 'auto' ? pickSource(px) : source;
  const out = new Uint8Array(px.width * px.height);
  if (src === 'photo') return photoGrid(px);
  for (let i = 0; i < out.length; i++) {
    const r = px.data[i * 4], g = px.data[i * 4 + 1], b = px.data[i * 4 + 2], a = px.data[i * 4 + 3];
    out[i] = src === 'alpha' ? (a >= 128 ? 1 : 0) : (a >= 128 && 0.2126 * r + 0.7152 * g + 0.0722 * b >= 128 ? 1 : 0);
  }
  return out;
}

/**
 * The cutout in a photo: board stock is warm (red well above blue) while walls, floors and shadows
 * are neutral or cool, so a threshold on red − blue, found per photo (Otsu), separates them.
 */
export function photoGrid(px: Pixels): Uint8Array {
  const n = px.width * px.height;
  const warm = new Int16Array(n);
  const hist = new Array<number>(511).fill(0);
  for (let i = 0; i < n; i++) { const v = px.data[i * 4] - px.data[i * 4 + 2]; warm[i] = v; hist[v + 255]++; }
  let sum = 0;
  for (let t = 0; t < 511; t++) sum += t * hist[t];
  let wB = 0, sB = 0, best = -1, thr = 255 + 20;
  for (let t = 0; t < 511; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  // Never call plain greys warm, even in a photo with nothing else to separate.
  const cut = Math.max(thr - 255, 15);
  return Uint8Array.from(warm, (v) => (v > cut ? 1 : 0));
}

/** Keeps only the largest 4-connected blob (others become 0). Returns null for an empty grid. */
export function largestBlob(grid: Uint8Array, w: number, h: number): Uint8Array | null {
  const label = new Int32Array(w * h);
  const stack: number[] = [];
  let best = 0, bestSize = 0, next = 0;
  for (let s = 0; s < grid.length; s++) {
    if (!grid[s] || label[s]) continue;
    const id = ++next;
    let size = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const x = c % w, y = (c / w) | 0;
      for (const n of [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, y > 0 ? c - w : -1, y < h - 1 ? c + w : -1]) {
        if (n >= 0 && grid[n] && !label[n]) { label[n] = id; stack.push(n); }
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
  }
  if (!best) return null;
  return Uint8Array.from(label, (l) => (l === best ? 1 : 0));
}

/** Pixel-corner outline of a single blob, found by walking its edges (clockwise on screen). */
export function traceOutline(grid: Uint8Array, w: number, h: number): Pt[] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && grid[y * w + x] === 1;
  let sx = -1, sy = -1;
  for (let i = 0; i < grid.length && sx < 0; i++) if (grid[i]) { sx = i % w; sy = (i / w) | 0; }
  if (sx < 0) return [];
  // Walk lattice corners with the shape on the right-hand side. Start at the top-left corner of the first pixel.
  const dirs: Pt[] = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // east, south, west, north
  const pts: Pt[] = [[sx, sy]]; // the first pixel's top-left corner is always a corner of the outline
  let x = sx, y = sy, d = 0;
  const startX = x, startY = y;
  const limit = (w + 1) * (h + 1) * 4;
  for (let n = 0; n < limit; n++) {
    // Pixels ahead-left and ahead-right of the corner, relative to the heading.
    const ahead = (ox: number, oy: number) => on(x + ox, y + oy);
    const left = d === 0 ? ahead(0, -1) : d === 1 ? ahead(0, 0) : d === 2 ? ahead(-1, 0) : ahead(-1, -1);
    const right = d === 0 ? ahead(0, 0) : d === 1 ? ahead(-1, 0) : d === 2 ? ahead(-1, -1) : ahead(0, -1);
    let nd = d;
    if (!right) nd = (d + 1) % 4;        // right is empty: turn right, hugging the shape
    else if (left) nd = (d + 3) % 4;     // left is solid: turn left
    if (nd !== d) pts.push([x, y]);
    d = nd;
    x += dirs[d][0]; y += dirs[d][1];
    if (x === startX && y === startY && n > 0) break;
  }
  return pts;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (!l2) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

function dp(pts: Pt[], lo: number, hi: number, eps: number, keep: boolean[]) {
  let worst = -1, wi = -1;
  for (let i = lo + 1; i < hi; i++) {
    const d = segDist(pts[i], pts[lo], pts[hi]);
    if (d > worst) { worst = d; wi = i; }
  }
  if (wi >= 0 && worst > eps) { keep[wi] = true; dp(pts, lo, wi, eps, keep); dp(pts, wi, hi, eps, keep); }
}

/** Douglas-Peucker for a closed polygon: anchored on the two points farthest apart. */
export function simplifyClosed(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 3) return pts.slice();
  let a = 0, b = 0, far = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = dist(pts[0], pts[i]);
    if (d > far) { far = d; a = i; }
  }
  far = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = dist(pts[a], pts[i]);
    if (d > far) { far = d; b = i; }
  }
  const [i0, i1] = a < b ? [a, b] : [b, a];
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[i0] = keep[i1] = true;
  dp(pts, i0, i1, eps, keep);
  const wrapped = [...pts.slice(i1), ...pts.slice(0, i0 + 1)];
  const keepW = new Array<boolean>(wrapped.length).fill(false);
  keepW[0] = keepW[wrapped.length - 1] = true;
  dp(wrapped, 0, wrapped.length - 1, eps, keepW);
  const out: Pt[] = [];
  pts.forEach((p, i) => { if (keep[i] && i >= i0 && i <= i1) out.push(p); });
  // wrapped runs i1 → end → 0 → i0; skip its endpoints (already counted) to avoid duplicates.
  const back: Pt[] = [];
  wrapped.forEach((p, i) => { if (keepW[i] && i > 0 && i < wrapped.length - 1) back.push(p); });
  return [...out, ...back];
}

/** Simplifies until at most `max` points remain, keeping as much detail as that allows. */
export function simplifyTo(pts: Pt[], max: number): Pt[] {
  if (pts.length <= max) return pts.slice();
  let lo = 0, hi = 1;
  while (simplifyClosed(pts, hi).length > max && hi < 1e6) hi *= 2;
  let best = simplifyClosed(pts, hi);
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    const r = simplifyClosed(pts, mid);
    if (r.length > max) lo = mid; else { hi = mid; best = r; }
  }
  return best;
}

/** Marks sharp turns as corners and gentle ones as curves. */
export function withSmoothness(pts: Pt[]): MaskPoint[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    const v1: Pt = [p[0] - a[0], p[1] - a[1]], v2: Pt = [b[0] - p[0], b[1] - p[1]];
    const l = Math.hypot(...v1) * Math.hypot(...v2);
    const turn = l ? (Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / l))) * 180) / Math.PI : 0;
    return { p, smooth: turn < CORNER_ANGLE };
  });
}

export interface TraceOptions {
  source?: TraceSource;
  /** `image`: the whole picture fills the panel. `shape`: the traced shape's bounds fill it. */
  fit?: TraceFit;
  maxPoints?: number;
}

/**
 * A mask from a picture's pixels, placed on the panel's quad (stage fractions, audience view).
 * Null when no shape is found.
 */
export function maskFromPixels(px: Pixels, corners: Quad, opts: TraceOptions = {}): Mask | null {
  const { width: w, height: h } = px;
  if (w < 2 || h < 2) return null;
  const blob = largestBlob(solidGrid(px, opts.source), w, h);
  if (!blob) return null;
  const outline = traceOutline(blob, w, h);
  if (outline.length < MIN_MASK_POINTS) return null;
  const max = Math.max(MIN_MASK_POINTS, Math.min(MAX_MASK_POINTS, opts.maxPoints ?? 48));
  // Simplify in pixels (error of ~1/4 % of the size is invisible), then normalise.
  const simple = simplifyTo(outline, max);
  let [x0, y0, x1, y1] = [0, 0, w, h];
  if (opts.fit === 'shape') {
    x0 = Math.min(...outline.map((p) => p[0])); x1 = Math.max(...outline.map((p) => p[0]));
    y0 = Math.min(...outline.map((p) => p[1])); y1 = Math.max(...outline.map((p) => p[1]));
  }
  const sw = x1 - x0 || 1, sh = y1 - y0 || 1;
  const hm = squareToQuad(corners);
  const placed = simple.map((p) => apply(hm, (p[0] - x0) / sw, (p[1] - y0) / sh));
  return sanitizeMask({ points: withSmoothness(placed), feather: 0.004, invert: false });
}

/** Browser glue: decodes a picture file and traces it. Rejects when the file isn't a picture. */
export async function traceImage(file: Blob, corners: Quad, opts: TraceOptions = {}): Promise<Mask | null> {
  const bmp = await createImageBitmap(file, { colorSpaceConversion: 'none' });
  try {
    const k = Math.min(1, TRACE_SIZE / Math.max(bmp.width, bmp.height));
    const w = Math.max(2, Math.round(bmp.width * k)), h = Math.max(2, Math.round(bmp.height * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(bmp, 0, 0, w, h);
    return maskFromPixels(g.getImageData(0, 0, w, h), corners, opts);
  } finally {
    bmp.close();
  }
}

/** Longest side of a baked picture mask. Big enough for crisp edges on a projector, small enough to store. */
export const BAKE_SIZE = 768;

/**
 * The picture as a mask, untouched: white pixels whose alpha says how much shows (transparency, or
 * brightness for a flat picture). Everything is kept, holes and separate pieces included. With
 * `fit: 'shape'` the picture is cropped to the shape's bounds. Null when nothing shows.
 */
export function bakeMaskPixels(px: Pixels, opts: { source?: TraceSource; fit?: TraceFit } = {}): Pixels | null {
  const { width: w, height: h } = px;
  const src = !opts.source || opts.source === 'auto' ? pickSource(px) : opts.source;
  const cover = new Uint8ClampedArray(w * h);
  // A photo's cutout is one solid piece: keep the biggest, dropping stray warm patches elsewhere.
  const photo = src === 'photo' ? largestBlob(photoGrid(px), w, h) : null;
  if (src === 'photo' && !photo) return null;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < cover.length; i++) {
    const a = px.data[i * 4 + 3];
    const c = photo ? (photo[i] ? 255 : 0) : src === 'alpha' ? a : (a / 255) * (0.2126 * px.data[i * 4] + 0.7152 * px.data[i * 4 + 1] + 0.0722 * px.data[i * 4 + 2]);
    cover[i] = c;
    if (c >= 16) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  if (opts.fit !== 'shape') { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const data = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const o = (y * cw + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = 255;
    data[o + 3] = cover[(y + y0) * w + x + x0];
  }
  return { width: cw, height: ch, data };
}

/** Browser glue: a picture file as a small PNG data URL for `Mask.image`, or null when it holds no shape. */
export async function bakeMaskImage(file: Blob, opts: { source?: TraceSource; fit?: TraceFit } = {}): Promise<string | null> {
  const bmp = await createImageBitmap(file, { colorSpaceConversion: 'none' });
  try {
    const k = Math.min(1, BAKE_SIZE / Math.max(bmp.width, bmp.height));
    const w = Math.max(2, Math.round(bmp.width * k)), h = Math.max(2, Math.round(bmp.height * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(bmp, 0, 0, w, h);
    const baked = bakeMaskPixels(g.getImageData(0, 0, w, h), opts);
    if (!baked) return null;
    const out = document.createElement('canvas');
    out.width = baked.width; out.height = baked.height;
    const og = out.getContext('2d');
    if (!og) return null;
    og.putImageData(new ImageData(new Uint8ClampedArray(baked.data as ArrayLike<number> as Uint8ClampedArray), baked.width, baked.height), 0, 0);
    return out.toDataURL('image/png');
  } finally {
    bmp.close();
  }
}

/** Bounds of a picture's non-transparent pixels as [x, y, width, height] fractions; the whole picture when nothing is transparent. */
export function pictureBounds(px: Pixels): [number, number, number, number] {
  const { width: w, height: h } = px;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (px.data[i * 4 + 3] >= 16) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return [0, 0, 1, 1];
  return [x0 / w, y0 / h, (x1 - x0 + 1) / w, (y1 - y0 + 1) / h];
}
