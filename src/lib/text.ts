import type { PanelLabel, Pt } from './types';

export const MAX_LABEL_CHARS = 120;
/** Share of the panel the rotated text may fill, so it never touches the edges. */
const FIT = 0.9;
/** Longest side of the text bitmap, in px. */
const TEX_LONG = 1024;
const FONT = '800 100px system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const LINE = 1.1;

export function defaultLabel(): PanelLabel {
  return { text: '', rotation: 0, size: 0.4, color: '#ffffff', pulse: false };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Width over height of a panel as seen on screen, from the average length of opposite edges. Corners in pixels. */
export function panelAspect(q: [Pt, Pt, Pt, Pt]): number {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.max(0.1, Math.min(10, w / h));
}

/**
 * Scale for a text block of bw × bh so that its height is `size` of the panel's extent across the text,
 * shrunk if needed so the rotated block stays inside the W × H panel.
 */
export function fitScale(bw: number, bh: number, rotationDeg: number, W: number, H: number, size: number): number {
  if (!(bw > 0) || !(bh > 0)) return 0;
  const r = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const want = (size * (c * H + s * W)) / bh;
  const maxW = (FIT * W) / (bw * c + bh * s);
  const maxH = (FIT * H) / (bw * s + bh * c);
  return Math.min(want, maxW, maxH);
}

/** Bitmap size for a panel of this aspect: TEX_LONG on the long side. */
export function labelCanvasSize(aspect: number): [number, number] {
  return aspect >= 1
    ? [TEX_LONG, Math.max(64, Math.round(TEX_LONG / aspect))]
    : [Math.max(64, Math.round(TEX_LONG * aspect)), TEX_LONG];
}

/** Draws the label centred and rotated onto a transparent canvas shaped like the panel. */
export function drawLabel(canvas: HTMLCanvasElement, label: PanelLabel, aspect: number) {
  const [W, H] = labelCanvasSize(aspect);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  const lines = label.text.split('\n');
  ctx.font = FONT;
  const bw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const bh = lines.length * 100 * LINE;
  const k = fitScale(bw, bh, label.rotation, W, H, label.size);
  if (!k) return;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((label.rotation * Math.PI) / 180);
  ctx.scale(k, k);
  ctx.fillStyle = label.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, 0, (i - (lines.length - 1) / 2) * 100 * LINE));
  ctx.restore();
}

/** Changes whenever the bitmap would look different. Aspect is rounded so dragging corners doesn't redraw every frame. */
export function labelKey(label: PanelLabel, aspect: number): string {
  return [label.text, label.rotation, label.size, label.color, Math.round(aspect * 20) / 20].join('\u0000');
}
