import { edgeOffset, moveEdge, moveMeshEdge } from './edge';
import { flipPt, flipQuad, type Flip } from './homography';
import { maskPathData, maskSegments } from './mask';
import { meshLines } from './mesh';
import {
  clamp, deleteMaskPoint, insertMaskPoint, moveMaskPoint, moveMeshPoint, recordMapping, runtime, settings, toggleMaskPoint,
} from './store';
import type { Mask, Pt, Quad } from './types';

const CSS = `
#pm-stage{position:fixed;inset:0;background:#000;z-index:0}
#pm-stage.inset{outline:1px solid #2c3039}
#pm-stage canvas{display:block;width:100%;height:100%}
#pm-handles{position:fixed;inset:0;z-index:5;pointer-events:none}
#pm-handles svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
#pm-handles polygon{fill:none;stroke:rgba(255,176,0,.45);stroke-width:1.5}
#pm-handles polygon.sel{stroke:#ffb000;stroke-width:2.5}
#pm-handles line.pm-edge{stroke:transparent;stroke-width:16;pointer-events:stroke;touch-action:none}
#pm-handles line.pm-edge:hover,#pm-handles line.pm-edge.active{stroke:rgba(255,176,0,.3)}
.pm-h,.pm-mid{position:absolute;pointer-events:auto;transform:translate(-50%,-50%);touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none}
.pm-h{width:26px;height:26px;border-radius:50%;border:2px solid #ffb000;background:rgba(0,0,0,.55)}
.pm-h.sel{background:#ffb000}
.pm-h.active{box-shadow:0 0 0 6px rgba(255,176,0,.35)}
.pm-mid{min-width:34px;height:34px;padding:0 10px;border-radius:17px;background:rgba(0,0,0,.75);border:1.5px solid rgba(255,176,0,.6);color:#ffb000;font:600 15px/31px system-ui,sans-serif;text-align:center}
.pm-mid.sel{background:#ffb000;color:#1a1200}
.pm-loupe{position:absolute;z-index:2;width:168px;height:168px;border-radius:50%;border:2px solid #ffb000;background:#000;box-shadow:0 4px 18px rgba(0,0,0,.6);pointer-events:none;overflow:hidden}
.pm-loupe canvas{display:block;width:100%;height:100%}
.pm-loupe span{position:absolute;left:0;right:0;bottom:18px;text-align:center;font:600 11px/1 system-ui,sans-serif;color:#ffb000;text-shadow:0 1px 2px #000;font-variant-numeric:tabular-nums}
.pm-media{position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none;overflow:hidden;z-index:-1}
.pm-media video{width:2px;height:2px}
#pm-handles path.pm-mask{fill:none;stroke:#33e0ff;stroke-width:1.5;stroke-dasharray:6 4;pointer-events:none}
#pm-handles path.pm-mask-hit{fill:none;stroke:transparent;stroke-width:16;pointer-events:stroke;cursor:copy}
.pm-mp{position:absolute;pointer-events:auto;width:14px;height:14px;transform:translate(-50%,-50%) rotate(45deg);border:2px solid #33e0ff;background:rgba(0,0,0,.6);touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none}
.pm-mp.corner{transform:translate(-50%,-50%);border-radius:2px}
.pm-mp.active{background:#33e0ff;box-shadow:0 0 0 5px rgba(51,224,255,.3)}
#pm-handles polyline.pm-grid{fill:none;stroke:rgba(255,120,220,.55);stroke-width:1}
.pm-gp{position:absolute;pointer-events:auto;width:16px;height:16px;border-radius:50%;transform:translate(-50%,-50%);border:2px solid #ff78dc;background:rgba(0,0,0,.6);touch-action:none;cursor:grab;user-select:none;-webkit-user-select:none}
.pm-gp.active{background:#ff78dc;box-shadow:0 0 0 5px rgba(255,120,220,.3)}
body.pm-show #pm-handles,body.pm-nodots #pm-handles{display:none}
body.pm-show{cursor:none}
`;

/** Sidebar width and gap around the inset preview, in CSS px; matches --side in globals.css. */
const SIDE = 340, GAP = 24, SIDE_BREAKPOINT = 720;

export interface StageRect { x: number; y: number; w: number; h: number; }

/** Space kept under the live preview for its caption bar, in CSS px; matches .mirror-bar in globals.css. */
export const MIRROR_BAR = 56;
/** Minimum time between preview copies, so the preview runs at about 30 fps and spares the GPU. */
const MIRROR_MS = 30;

/** The largest rect with the reference's aspect ratio that fits inside the area, centred in it. */
export function fitRect(area: StageRect, refW: number, refH: number): StageRect {
  const k = Math.min(area.w / refW, area.h / refH);
  const w = refW * k, h = refH * k;
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}

/**
 * Where the live preview of the projector sits in the control window: beside the sidebar when
 * it's showing, above the caption bar, shaped like the projector window so corners line up exactly.
 */
export function mirrorRect(W: number, H: number, refW: number, refH: number, sideVisible: boolean): StageRect {
  const side = sideVisible && W > SIDE_BREAKPOINT ? SIDE : 0;
  const area = {
    x: side + GAP, y: GAP,
    w: Math.max(1, W - side - GAP * 2), h: Math.max(1, H - GAP - MIRROR_BAR),
  };
  return fitRect(area, Math.max(1, refW), Math.max(1, refH));
}

/** Loupe size in CSS px, magnification, and how far it sits from the corner so it never covers it. */
const LOUPE = 168, ZOOM = 4, LOUPE_GAP = 36;
/** How long the loupe stays up after an arrow-key nudge. */
const PEEK_MS = 1500;
/** How far below the centre a mesh panel's number badge sits, in CSS px. */
const MESH_BADGE_OFFSET = 34;
/** Pointer speed while Shift is held during a drag. */
const FINE = 0.1;

interface HandleSet { hs: HTMLDivElement[]; mid: HTMLDivElement; poly: SVGPolygonElement; edges: SVGLineElement[]; }

const NO_FLIP: Flip = { h: false, v: false };

/** Pointer movement on a view to the matching move in stage space, which is mirrored where the view is. */
export function stageDelta(dx: number, dy: number, f: Flip): [number, number] {
  return [f.h ? -dx : dx, f.v ? -dy : dy];
}

/**
 * Owns the output surface (canvas, mapping handles, video elements) in whichever window shows it.
 * Built with a source, it's instead a live preview of that output in the control window: it copies
 * the source's frames and carries its own handles, so the wall can be mapped without touching it.
 */
export class Output {
  /**
   * `outputId` is the projector this surface draws. A preview instead copies whichever surface
   * `setSource` points it at, and takes that surface's output id.
   */
  constructor(public outputId = '', readonly preview = false) {}

  private source: Output | null = null;

  win: Window = window;
  doc: Document = document;
  canvas!: HTMLCanvasElement;
  media!: HTMLDivElement;
  private host!: HTMLElement;
  private stage!: HTMLDivElement;
  private handles!: HTMLDivElement;
  private svg!: SVGSVGElement;
  /** Handles by panel index; empty for panels on another output. */
  private items: (HandleSet | undefined)[] = [];
  private loupe!: HTMLDivElement;
  private loupeCanvas!: HTMLCanvasElement;
  private loupeText!: HTMLSpanElement;
  /** What's being dragged: a corner (c ≥ 0), the whole panel (c = -1), a mask point m or a mesh point g. */
  private dragging: { p: number; c: number; m?: number; g?: number } | null = null;
  /** Mesh grid lines and point handles of the selected panel, and what they were built for. */
  private meshEls: { lines: SVGPolylineElement[]; pts: HTMLDivElement[] } | null = null;
  private meshSig = '';
  /** Mask outline and point handles of the panel being edited, and what they were built for. */
  private maskEls: { path: SVGPathElement; hit: SVGPathElement; pts: HTMLDivElement[] } | null = null;
  private maskSig = '';
  private peekUntil = 0;
  private boundWindows = new WeakSet<Window>();
  private mounted = false;
  private ctx: CanvasRenderingContext2D | null = null;
  private lastCopy = 0;

  isPopup() { return this.win !== window; }

  mount(win: Window, host: HTMLElement) {
    this.win = win;
    this.doc = win.document;
    this.host = host;
    const d = this.doc;
    if (!d.getElementById('pm-style')) {
      const st = d.createElement('style');
      st.id = 'pm-style';
      st.textContent = CSS;
      d.head.appendChild(st);
    }
    host.innerHTML = '';
    const stage = d.createElement('div');
    stage.id = 'pm-stage';
    this.stage = stage;
    this.canvas = d.createElement('canvas');
    stage.appendChild(this.canvas);
    this.handles = d.createElement('div');
    this.handles.id = 'pm-handles';
    this.svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.handles.appendChild(this.svg);
    this.loupe = d.createElement('div');
    this.loupe.className = 'pm-loupe';
    this.loupe.hidden = true;
    this.loupeCanvas = d.createElement('canvas');
    this.loupeText = d.createElement('span');
    this.loupe.append(this.loupeCanvas, this.loupeText);
    this.media = d.createElement('div');
    this.media.className = 'pm-media';
    host.append(stage, this.handles, this.media);
    if (!this.boundWindows.has(win)) {
      win.addEventListener('resize', () => { if (this.win === win) this.layout(); });
      this.boundWindows.add(win);
    }
    this.ctx = null;
    this.mounted = true;
    // Show mode belongs to the wall; the preview keeps its handles so it can still be edited.
    if (!this.preview) this.setShow(runtime.get().showMode);
    this.rebuild();
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    try { if (this.host) this.host.innerHTML = ''; } catch { /* window already gone */ }
    if (!this.preview) {
      try { this.doc.body.classList.remove('pm-show', 'pm-nodots'); } catch { /* window already gone */ }
    }
  }

  /** Points a preview at another surface, rebuilding its handles for that surface's panels. */
  setSource(src: Output | null) {
    if (!this.preview || src === this.source) return;
    this.source = src;
    this.outputId = src?.outputId ?? '';
    this.lastCopy = 0;
    this.rebuild();
  }

  get sourceOutput(): Output | null { return this.source; }

  /** The settings of the output this surface (or preview) shows. */
  private cfg() {
    const { outputs } = settings.get();
    return outputs.find((o) => o.id === this.outputId) ?? outputs[0];
  }

  /** How this output mirrors its projector's picture. */
  private outFlip(): Flip {
    const o = this.cfg();
    return { h: o.flipH, v: o.flipV };
  }

  /**
   * How this view is mirrored relative to the stage. The output itself shows the projector's
   * picture, flipped; the preview in the control window shows the surface as the audience sees it.
   */
  private viewFlip(): Flip { return this.preview ? NO_FLIP : this.outFlip(); }

  setShow(on: boolean) { this.doc.body.classList.toggle('pm-show', on); }

  /** Whether the mapping dots appear on the wall. Only the projector window can hide them. */
  setDots(on: boolean) { this.doc.body.classList.toggle('pm-nodots', this.isPopup() && !on); }

  /** Copies the source's latest frame into the preview. Must run right after render, like the loupe. */
  copyFrame() {
    if (!this.mounted || !this.source) return;
    const now = performance.now();
    if (now - this.lastCopy < MIRROR_MS) return;
    this.lastCopy = now;
    const rect = this.stageRect();
    const dpr = Math.min(2, this.win.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.w * dpr)), h = Math.max(1, Math.round(rect.h * dpr));
    const c = this.canvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = this.ctx ?? (this.ctx = c.getContext('2d'));
    if (!g) return;
    // Undo the projector's mirroring, so the preview matches the surface as the audience sees it.
    const f = this.outFlip();
    g.setTransform(f.h ? -1 : 1, 0, 0, f.v ? -1 : 1, f.h ? w : 0, f.v ? h : 0);
    g.drawImage(this.source.canvas, 0, 0, w, h);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Where the output is drawn inside its window. Full window in the projector window or
   * whenever the controls are hidden; otherwise a scaled copy of the full-window output,
   * centered in the space beside the sidebar so no panel can sit behind it.
   */
  stageRect(): StageRect {
    const W = this.win.innerWidth, H = this.win.innerHeight;
    const r = runtime.get();
    if (this.source) return mirrorRect(W, H, this.source.win.innerWidth, this.source.win.innerHeight, !r.hideUi);
    const controlsVisible = !r.hideUi && !r.showMode;
    if (this.isPopup() || !controlsVisible || W <= SIDE_BREAKPOINT) return { x: 0, y: 0, w: W, h: H };
    const area = { x: SIDE + GAP, y: GAP, w: Math.max(1, W - SIDE - GAP * 2), h: Math.max(1, H - GAP * 2) };
    return fitRect(area, W, H);
  }

  rebuild() {
    if (!this.mounted) return;
    this.items.forEach((it) => { if (!it) return; it.hs.forEach((h) => h.remove()); it.mid.remove(); it.poly.remove(); it.edges.forEach((l) => l.remove()); });
    this.items = [];
    this.clearMaskEls();
    this.clearMeshEls();
    const d = this.doc;
    this.handles.appendChild(this.loupe);
    const s = settings.get();
    const out = this.cfg().id;
    s.panels.forEach((pn, i) => {
      if (pn.output !== out) { this.items.push(undefined); return; }
      const poly = d.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      this.svg.appendChild(poly);
      // Pressing the outline itself slides that edge, to stretch the panel one way.
      const edges: SVGLineElement[] = [0, 1, 2, 3].map((e) => {
        const l = d.createElementNS('http://www.w3.org/2000/svg', 'line');
        l.setAttribute('class', 'pm-edge');
        this.attachEdgeDrag(l, i, e);
        this.svg.appendChild(l);
        return l;
      });
      const hs: HTMLDivElement[] = [];
      for (let c = 0; c < 4; c++) {
        const h = d.createElement('div');
        h.className = 'pm-h';
        h.title = `Panel ${i + 1} corner`;
        this.attachDrag(h, i, c);
        this.handles.appendChild(h);
        hs.push(h);
      }
      const mid = d.createElement('div');
      mid.className = 'pm-mid';
      mid.textContent = String(i + 1);
      mid.title = `Drag to move panel ${i + 1}`;
      this.attachDrag(mid, i, -1);
      this.handles.appendChild(mid);
      this.items.push({ hs, mid, poly, edges });
    });
    this.layout();
  }

  layout() {
    if (!this.mounted) return;
    const s = settings.get();
    const sel = runtime.get().selCorner;
    const rect = this.stageRect();
    const inset = rect.w !== this.win.innerWidth || rect.h !== this.win.innerHeight;
    for (const el of [this.stage, this.handles]) {
      Object.assign(el.style, inset
        ? { inset: 'auto', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }
        : { inset: '0', left: '', top: '', width: '', height: '' });
    }
    this.stage.classList.toggle('inset', inset);
    const W = rect.w, H = rect.h;
    const f = this.viewFlip();
    s.panels.forEach((p, i) => {
      const it = this.items[i];
      if (!it) return;
      const px = flipQuad(p.corners, f).map(([x, y]) => [x * W, y * H]);
      it.hs.forEach((h, c) => {
        // A mesh panel is shaped by its grid points; its corners are the grid's.
        h.style.display = p.mesh ? 'none' : '';
        h.style.left = `${px[c][0]}px`;
        h.style.top = `${px[c][1]}px`;
        h.classList.toggle('sel', i === s.selected);
        h.classList.toggle('active', !!sel && sel.p === i && sel.c === c);
      });
      it.mid.style.left = `${px.reduce((a, q) => a + q[0], 0) / 4}px`;
      // On a mesh panel the badge sits below the centre, so the middle grid point stays reachable.
      it.mid.style.top = `${px.reduce((a, q) => a + q[1], 0) / 4 + (p.mesh ? MESH_BADGE_OFFSET : 0)}px`;
      it.mid.classList.toggle('sel', i === s.selected);
      it.poly.setAttribute('points', px.map((q) => `${q[0]},${q[1]}`).join(' '));
      it.poly.setAttribute('class', i === s.selected ? 'sel' : '');
      // Off while the outline is being edited, so a press there still adds a mask point.
      const maskOn = runtime.get().maskEdit;
      it.edges.forEach((l, e) => {
        const a = px[e], b = px[(e + 1) % 4];
        l.setAttribute('x1', String(a[0])); l.setAttribute('y1', String(a[1]));
        l.setAttribute('x2', String(b[0])); l.setAttribute('y2', String(b[1]));
        l.style.display = maskOn ? 'none' : '';
        l.style.cursor = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 'ns-resize' : 'ew-resize';
      });
    });
    this.layoutMesh(W, H, f);
    this.layoutMask(W, H, f);
  }

  private clearMeshEls() {
    if (this.meshEls) {
      this.meshEls.lines.forEach((el) => el.remove());
      this.meshEls.pts.forEach((el) => el.remove());
    }
    this.meshEls = null;
    this.meshSig = '';
  }

  /** Grid lines and point handles for the selected panel when it's mesh-warped. */
  private layoutMesh(W: number, H: number, f: Flip) {
    const s = settings.get();
    const i = s.selected;
    const p = s.panels[i];
    const mesh = p && p.output === this.cfg().id ? p.mesh : undefined;
    const sig = mesh ? `${i}|${mesh.cols}x${mesh.rows}` : '';
    if (sig !== this.meshSig) {
      this.clearMeshEls();
      this.meshSig = sig;
      if (mesh) {
        const NS = 'http://www.w3.org/2000/svg';
        const lines = Array.from({ length: mesh.cols + mesh.rows }, () => {
          const el = this.doc.createElementNS(NS, 'polyline') as SVGPolylineElement;
          el.setAttribute('class', 'pm-grid');
          this.svg.appendChild(el);
          return el;
        });
        const pts = mesh.pts.map((_, k) => {
          const el = this.doc.createElement('div');
          el.className = 'pm-gp';
          el.title = `Mesh point ${Math.floor(k / mesh.cols) + 1}, ${(k % mesh.cols) + 1}. Drag, or nudge with the arrow keys.`;
          el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            const start = settings.get().panels[i]?.mesh?.pts[k];
            if (start) this.dragPoint(el, e, start, (pt) => moveMeshPoint(i, k, pt), { p: i, c: -1, g: k }, false);
          });
          this.handles.appendChild(el);
          return el;
        });
        this.meshEls = { lines, pts };
      }
    }
    if (!mesh || !this.meshEls) return;
    const sel = runtime.get().selCorner;
    meshLines(mesh).forEach((line, n) => {
      this.meshEls!.lines[n]?.setAttribute('points', line.map((q) => { const [x, y] = flipPt(q, f); return `${x * W},${y * H}`; }).join(' '));
    });
    mesh.pts.forEach((q, k) => {
      const el = this.meshEls!.pts[k];
      const [x, y] = flipPt(q, f);
      el.style.left = `${x * W}px`;
      el.style.top = `${y * H}px`;
      el.classList.toggle('active', !!sel && sel.p === i && sel.g === k);
    });
  }

  private clearMaskEls() {
    if (this.maskEls) {
      this.maskEls.path.remove();
      this.maskEls.hit.remove();
      this.maskEls.pts.forEach((el) => el.remove());
    }
    this.maskEls = null;
    this.maskSig = '';
  }

  /** The panel whose mask is being edited on this output, if any. */
  private editedMask(): { i: number; mask: Mask } | null {
    const s = settings.get();
    const p = s.panels[s.selected];
    if (!runtime.get().maskEdit || !p?.mask || p.mask.image || p.output !== this.cfg().id) return null;
    return { i: s.selected, mask: p.mask };
  }

  /** Mask outline and point handles for the selected panel while mask editing is on. */
  private layoutMask(W: number, H: number, f: Flip) {
    const ed = this.editedMask();
    const sig = ed ? String(ed.i) : '';
    if (sig !== this.maskSig) {
      this.clearMaskEls();
      this.maskSig = sig;
      if (ed) {
        const NS = 'http://www.w3.org/2000/svg';
        const path = this.doc.createElementNS(NS, 'path') as SVGPathElement;
        path.setAttribute('class', 'pm-mask');
        const hit = this.doc.createElementNS(NS, 'path') as SVGPathElement;
        hit.setAttribute('class', 'pm-mask-hit');
        this.attachInsert(hit, ed.i);
        this.svg.append(path, hit);
        this.maskEls = { path, hit, pts: [] };
      }
    }
    // Point handles are rebuilt when points are added or removed; the outline stays, so a drag
    // that started on it by adding a point keeps going.
    if (ed && this.maskEls && this.maskEls.pts.length !== ed.mask.points.length) {
      this.maskEls.pts.forEach((el) => el.remove());
      this.maskEls.pts = ed.mask.points.map((_, k) => {
        const el = this.doc.createElement('div');
        el.className = 'pm-mp';
        el.title = 'Drag to move. Double-click: smooth or corner. Option/Alt-click: delete.';
        this.attachMaskPoint(el, ed.i, k);
        this.handles.appendChild(el);
        return el;
      });
    }
    if (!ed || !this.maskEls) return;
    const sel = runtime.get().selCorner;
    const dPath = maskPathData(ed.mask, W, H, f);
    this.maskEls.path.setAttribute('d', dPath);
    this.maskEls.hit.setAttribute('d', dPath);
    ed.mask.points.forEach((mp, k) => {
      const el = this.maskEls!.pts[k];
      const [x, y] = flipPt(mp.p, f);
      el.style.left = `${x * W}px`;
      el.style.top = `${y * H}px`;
      el.classList.toggle('corner', !mp.smooth);
      el.classList.toggle('active', !!sel && sel.p === ed.i && sel.m === k);
    });
  }

  /** Pointer position on this view as a stage point, as the audience sees it. */
  private stagePoint(e: PointerEvent): Pt {
    const r = this.handles.getBoundingClientRect();
    return flipPt([(e.clientX - r.left) / Math.max(1, r.width), (e.clientY - r.top) / Math.max(1, r.height)], this.viewFlip());
  }

  /** A press on the outline adds a point there, and keeps dragging it while the button is down. */
  private attachInsert(el: SVGPathElement, i: number) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const { w: W, h: H } = this.stageRect();
      const pt = this.stagePoint(e);
      const k = insertMaskPoint(i, pt, W / Math.max(1, H));
      if (k !== null) this.dragPoint(el, e, pt, (q) => moveMaskPoint(i, k, q), { p: i, c: -1, m: k }, true);
    });
  }

  private attachMaskPoint(el: HTMLDivElement, i: number, k: number) {
    el.addEventListener('dblclick', (e) => { e.preventDefault(); toggleMaskPoint(i, k); });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.altKey) { deleteMaskPoint(i, k); return; }
      const start = settings.get().panels[i]?.mask?.points[k]?.p;
      if (start) this.dragPoint(el, e, start, (q) => moveMaskPoint(i, k, q), { p: i, c: -1, m: k }, false);
    });
  }

  /**
   * Drags one point (mask or mesh) from `start`, calling `set` with its new stage position.
   * `recorded` when the undo step was already taken (a point just added).
   */
  private dragPoint(el: Element, e: PointerEvent, start: Pt, set: (p: Pt) => void,
    sel: { p: number; c: number; m?: number; g?: number }, recorded: boolean) {
    try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const { w: W, h: H } = this.stageRect();
    const f = this.viewFlip();
    let lx = e.clientX, ly = e.clientY, dx = 0, dy = 0;
    runtime.set({ selCorner: sel });
    this.dragging = sel;
    const move = (ev: PointerEvent) => {
      if (ev.clientX === lx && ev.clientY === ly) return;
      const sp = ev.shiftKey ? FINE : 1;
      const [mx, my] = stageDelta(((ev.clientX - lx) / W) * sp, ((ev.clientY - ly) / H) * sp, f);
      dx += mx; dy += my;
      lx = ev.clientX; ly = ev.clientY;
      if (!recorded) { recordMapping(); recorded = true; }
      set([clamp(start[0] + dx, -0.25, 1.25), clamp(start[1] + dy, -0.25, 1.25)]);
    };
    const up = (ev: Event) => {
      try { el.releasePointerCapture((ev as PointerEvent).pointerId); } catch { /* already released */ }
      this.dragging = null;
      el.removeEventListener('pointermove', move as EventListener);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** Shows the loupe briefly around the selected corner, after an arrow-key nudge. */
  peekLoupe() { this.peekUntil = performance.now() + PEEK_MS; }

  /**
   * Draws the magnified view around the corner being dragged or nudged. Must run right after
   * the frame renders: the WebGL canvas isn't preserved, so it's only readable in that moment.
   */
  drawLoupe(enabled: boolean) {
    if (!this.mounted) return;
    const target = this.dragging ?? (performance.now() < this.peekUntil ? runtime.get().selCorner : null);
    const s = settings.get();
    const out = this.cfg().id;
    const panels = s.panels;
    const corner = !target ? null
      : target.m !== undefined ? panels[target.p]?.mask?.points[target.m]?.p ?? null
        : target.g !== undefined ? panels[target.p]?.mesh?.pts[target.g] ?? null
          : target.c >= 0 ? panels[target.p]?.corners[target.c] : null;
    if (!enabled || !corner) { this.loupe.hidden = true; return; }
    const rect = this.stageRect();
    const vf = this.viewFlip();
    const [vx, vy] = flipPt(corner, vf);
    const cx = vx * rect.w, cy = vy * rect.h;

    // Sit up and to the left of the corner, flipping to whichever side has room.
    const lx = cx - LOUPE - LOUPE_GAP >= 0 ? cx - LOUPE - LOUPE_GAP : cx + LOUPE_GAP;
    const ly = cy - LOUPE - LOUPE_GAP >= 0 ? cy - LOUPE - LOUPE_GAP : cy + LOUPE_GAP;
    this.loupe.style.left = `${lx}px`;
    this.loupe.style.top = `${ly}px`;
    this.loupe.hidden = false;

    const dpr = Math.min(2, this.win.devicePixelRatio || 1);
    const lc = this.loupeCanvas;
    const size = Math.round(LOUPE * dpr);
    if (lc.width !== size) { lc.width = size; lc.height = size; }
    const g = lc.getContext('2d');
    if (!g) return;
    // Source square in canvas pixels, centred on the corner. The preview magnifies the
    // projector's own full-resolution frame rather than its scaled-down copy.
    const img = this.source?.canvas ?? this.canvas;
    const k = img.width / rect.w;
    const src = (LOUPE / ZOOM) * k;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    // The preview's source is the projector's picture: find the corner there and mirror it back.
    const imf = this.source ? this.outFlip() : NO_FLIP;
    const [ix, iy] = flipPt([vx, vy], imf);
    g.save();
    g.translate(size / 2, size / 2);
    g.scale(imf.h ? -1 : 1, imf.v ? -1 : 1);
    g.drawImage(img, ix * img.width - src / 2, iy * img.height - src / 2, src, src, -size / 2, -size / 2, size, size);
    g.restore();

    // Panel edges nearby, so neighbouring corners can be lined up exactly.
    const toLoupe = ([x, y]: number[]) => [(x * rect.w - cx) * ZOOM * dpr + size / 2, (y * rect.h - cy) * ZOOM * dpr + size / 2];
    g.lineWidth = dpr;
    panels.forEach((p, i) => {
      if (p.output !== out) return;
      g.strokeStyle = target && i === target.p ? 'rgba(255,176,0,.95)' : 'rgba(255,176,0,.45)';
      g.beginPath();
      flipQuad(p.corners, vf).forEach((q, c) => { const [x, y] = toLoupe(q); if (c) g.lineTo(x, y); else g.moveTo(x, y); });
      g.closePath();
      g.stroke();
    });
    // The outline being edited, so a mask point can be laid along the sculpture's edge.
    const tm = target && target.m !== undefined ? panels[target.p]?.mask : undefined;
    if (tm) {
      const pts = tm.points.map((mp) => ({ ...mp, p: flipPt(mp.p, vf) }));
      g.strokeStyle = 'rgba(51,224,255,.95)';
      g.beginPath();
      maskSegments(pts).forEach((sg, n) => {
        const a = toLoupe(sg.from), b = toLoupe(sg.c1), c = toLoupe(sg.c2), d = toLoupe(sg.to);
        if (!n) g.moveTo(a[0], a[1]);
        g.bezierCurveTo(b[0], b[1], c[0], c[1], d[0], d[1]);
      });
      g.closePath();
      g.stroke();
    }
    // Crosshair on the exact corner.
    g.strokeStyle = '#fff';
    g.beginPath();
    g.moveTo(size / 2, 0); g.lineTo(size / 2, size / 2 - 6 * dpr);
    g.moveTo(size / 2, size / 2 + 6 * dpr); g.lineTo(size / 2, size);
    g.moveTo(0, size / 2); g.lineTo(size / 2 - 6 * dpr, size / 2);
    g.moveTo(size / 2 + 6 * dpr, size / 2); g.lineTo(size, size / 2);
    g.stroke();
    // Positions read in projector pixels, whichever window is being edited, mirrored as the projector draws them.
    const ref = this.source ? { w: this.source.win.innerWidth, h: this.source.win.innerHeight } : rect;
    const [px, py] = flipPt(corner, this.outFlip());
    this.loupeText.textContent = `${Math.round(px * ref.w)}, ${Math.round(py * ref.h)} px`;
  }

  /** Drags one edge of a panel along its outward normal; Shift slows the pointer. */
  private attachEdgeDrag(el: SVGLineElement, i: number, edge: number) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      const { w: W, h: H } = this.stageRect();
      const f = this.viewFlip();
      let lx = e.clientX, ly = e.clientY, dx = 0, dy = 0, recorded = false;
      const start = settings.get().panels[i];
      const orig = start.corners.map((q) => [...q] as Pt) as Quad;
      const origMesh = start.mesh;
      settings.set({ selected: i });
      runtime.set({ selCorner: null });
      el.classList.add('active');
      const move = (ev: PointerEvent) => {
        if (ev.clientX === lx && ev.clientY === ly) return;
        const k = ev.shiftKey ? FINE : 1;
        const [mx, my] = stageDelta(((ev.clientX - lx) / W) * k, ((ev.clientY - ly) / H) * k, f);
        dx += mx; dy += my;
        lx = ev.clientX; ly = ev.clientY;
        if (!recorded) { recordMapping(); recorded = true; }
        const off = edgeOffset(orig, edge, [dx, dy], W / Math.max(1, H));
        const corners = moveEdge(orig, edge, off);
        const mesh = origMesh && moveMeshEdge(origMesh, edge, off);
        settings.set((s) => ({ panels: s.panels.map((p, j) => (j === i ? { ...p, corners, ...(mesh ? { mesh } : {}) } : p)) }));
      };
      const up = (ev: PointerEvent) => {
        try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
        el.classList.remove('active');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  private attachDrag(el: HTMLDivElement, i: number, c: number) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      const { w: W, h: H } = this.stageRect();
      // On a flipped output a drag to the right moves the corner left on the surface.
      const f = this.viewFlip();
      let lx = e.clientX, ly = e.clientY;
      // Accumulated offset in stage fractions; Shift slows the pointer for fine placement.
      let dx = 0, dy = 0;
      let recorded = false;
      const orig = settings.get().panels[i].corners.map((q) => [...q] as Pt) as Quad;
      // Moving the whole panel carries its mask along; a corner drag leaves the outline where it is.
      const origMask = c < 0 ? settings.get().panels[i].mask : undefined;
      const origMesh = c < 0 ? settings.get().panels[i].mesh : undefined;
      settings.set({ selected: i });
      runtime.set({ selCorner: c >= 0 ? { p: i, c } : null });
      this.dragging = { p: i, c };
      const move = (ev: PointerEvent) => {
        if (ev.clientX === lx && ev.clientY === ly) return;
        const k = ev.shiftKey ? FINE : 1;
        const [mx, my] = stageDelta(((ev.clientX - lx) / W) * k, ((ev.clientY - ly) / H) * k, f);
        dx += mx;
        dy += my;
        lx = ev.clientX; ly = ev.clientY;
        // Record on the first real movement, so a click on a dot doesn't add an undo step.
        if (!recorded) { recordMapping(); recorded = true; }
        const corners = (c >= 0
          ? orig.map((q, n) => (n === c ? [clamp(q[0] + dx, -0.25, 1.25), clamp(q[1] + dy, -0.25, 1.25)] : q))
          : orig.map((q) => [q[0] + dx, q[1] + dy])) as Quad;
        const mask = origMask && { ...origMask, points: origMask.points.map((mp) => ({ ...mp, p: [mp.p[0] + dx, mp.p[1] + dy] as Pt })) };
        const mesh = origMesh && { ...origMesh, pts: origMesh.pts.map((q) => [q[0] + dx, q[1] + dy] as Pt) };
        settings.set((s) => ({ panels: s.panels.map((p, j) => (j === i ? { ...p, corners, ...(mask ? { mask } : {}), ...(mesh ? { mesh } : {}) } : p)) }));
      };
      const up = (ev: PointerEvent) => {
        try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
        this.dragging = null;
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
}
