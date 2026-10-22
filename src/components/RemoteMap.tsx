'use client';
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useStore } from '@/lib/hooks';
import { FADER_SEND_MS, makeThrottle, type GeoPanel, type HandleKind, type ToHost } from '@/lib/remote';
import { remoteClient, sendToHost } from '@/lib/remoteClient';
import { deleteMaskPt, handlePos, insertMaskPt, movePanel, movePoint, pixelStep, toggleMaskPt } from '@/lib/remoteEdit';
import { MAX_PANELS } from '@/lib/remote';
import { MAX_MASK_POINTS, MIN_MASK_POINTS } from '@/lib/mask';
import type { Pt } from '@/lib/types';

/**
 * Mapping from the phone: the panels as outlines, drawn as the audience sees them. A touch near a handle
 * grabs it, and dragging moves it by how far the finger moves (like a trackpad), so a finger never
 * covers or jumps the point. Zoom and a slow mode give the last pixels.
 */

type HKind = HandleKind | 'a';
interface Sel { k: HKind; i: number }
interface Handle extends Sel { pt: Pt }

/** Touch radius for grabbing a handle, in screen pixels. */
const HIT = 32;
/** Slow mode moves a handle this much per finger pixel. */
const FINE = 0.25;
/** Offset of the whole-panel handle below the centre on a mesh panel, so the middle grid point stays reachable. */
const MESH_BADGE = 26;
const ZOOMS = [1, 3, 6] as const;
const NUDGE_MERGE_MS = 1000;

const centroid = (p: GeoPanel): Pt => [p.corners.reduce((a, q) => a + q[0], 0) / 4, p.corners.reduce((a, q) => a + q[1], 0) / 4];

function handlesOf(p: GeoPanel): Handle[] {
  const hs: Handle[] = p.mesh ? p.mesh.pts.map((pt, i) => ({ k: 'g', i, pt })) : p.corners.map((pt, i) => ({ k: 'c', i, pt }));
  p.mask?.points.forEach((m, i) => hs.push({ k: 'm', i, pt: m.p }));
  hs.push({ k: 'a', i: 0, pt: centroid(p) });
  return hs;
}

function inside(poly: Pt[], [x, y]: Pt): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export default function RemoteMap({ canEdit }: { canEdit: boolean }) {
  const c = useStore(remoteClient);
  const geo = c.geo;
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(340);
  const [sel, setSel] = useState<Sel | null>(null);
  const [fine, setFine] = useState(false);
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1);
  const [step, setStep] = useState<1 | 10>(1);
  const [out, setOut] = useState('');
  // Armed by Add point: the next touch on the canvas adds a mask point there and carries on dragging it.
  const [adding, setAdding] = useState(false);
  // Edits show at once on the phone; the Mac's echo takes over a moment after the last one.
  const [ov, setOv] = useState<GeoPanel[] | null>(null);
  const ovTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const panels = ov ?? geo?.panels ?? [];
  // After a delete the Mac's selection can briefly point past the end of the phone's list.
  const selPanel = geo ? Math.max(0, Math.min(geo.selected, panels.length - 1)) : 0;
  const panel = panels[selPanel];
  const outputId = out || panel?.output || '';
  const size: [number, number] = geo?.outputs.find((o) => o.id === outputId)?.size ?? [1920, 1080];

  // Latest values for the pointer handlers, which outlive a render.
  const live = useRef({ panels, selPanel, sel, fine, zoom, canEdit, step, adding, size });
  live.current = { panels, selPanel, sel, fine, zoom, canEdit, step, adding, size };

  useEffect(() => { if (panel && panel.output !== out) setOut(panel.output); }, [panel, out]);
  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => clearTimeout(ovTimer.current), []);

  const keepOv = (next: GeoPanel[]) => {
    // Handlers read the ref, so a second edit before the next render builds on this one.
    live.current.panels = next;
    setOv(next);
    clearTimeout(ovTimer.current);
    ovTimer.current = setTimeout(() => setOv(null), 1500);
  };

  // The view: a square of the stage in fractions (the canvas has the projector's shape), centred on the handle in use.
  const vw = 1.1 / zoom;
  const focus: Pt = (sel && panel && (sel.k === 'a' ? centroid(panel) : handlePos(panel, sel.k, sel.i))) || (panel ? centroid(panel) : [0.5, 0.5]);
  // Whole stage while unzoomed; zoomed in, follow the handle being worked on.
  const [cx, cy] = zoom === 1 ? [0.5, 0.5] : focus;
  const x0 = Math.max(-0.25, Math.min(1.25 - vw, cx - vw / 2));
  const y0 = Math.max(-0.25, Math.min(1.25 - vw, cy - vw / 2));
  const height = Math.round((width * size[1]) / size[0]);
  const sx = (x: number) => ((x - x0) / vw) * width;
  const sy = (y: number) => ((y - y0) / vw) * height;
  const view = useRef({ x0, y0, vw, width, height });
  view.current = { x0, y0, vw, width, height };

  const throttle = useRef(makeThrottle<ToHost>((m) => sendToHost(m), FADER_SEND_MS));
  useEffect(() => { const t = throttle.current; return () => t.cancel(); }, []);
  const drag = useRef<{ p: number; x: number; y: number; sel: Sel | null; start: Pt | GeoPanel | null; moved: boolean; first: boolean; tap: number | null } | null>(null);
  const lastNudge = useRef({ key: '', at: 0 });

  const screenOf = (h: Handle, p: GeoPanel): Pt => [sx(h.pt[0]), sy(h.pt[1]) + (h.k === 'a' && p.mesh ? MESH_BADGE : 0)];

  const down = (e: RPointerEvent<SVGSVGElement>) => {
    const L = live.current;
    const p = L.panels[L.selPanel];
    if (!L.canEdit || !p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (L.adding && p.mask) {
      const V = view.current;
      const at: Pt = [V.x0 + (px / V.width) * V.vw, V.y0 + (py / V.height) * V.vw];
      const ins = insertMaskPt(p, at, L.size[0] / L.size[1]);
      setAdding(false);
      if (ins) {
        sendToHost({ t: 'madd', p: L.selPanel, x: at[0], y: at[1] });
        keepOv(L.panels.map((q, j) => (j === L.selPanel ? ins.panel : q)));
        const ns: Sel = { k: 'm', i: ins.at };
        setSel(ns);
        // The Mac already took the undo step for the new point, so this drag carries on from it without another.
        drag.current = { p: L.selPanel, x: e.clientX, y: e.clientY, sel: ns, start: ins.panel.mask!.points[ins.at].p, moved: false, first: false, tap: null };
      }
      return;
    }
    let best: Handle | null = null, bd = HIT;
    for (const h of handlesOf(p)) {
      const [hx, hy] = screenOf(h, p);
      const d = Math.hypot(hx - px, hy - py);
      if (d < bd) { bd = d; best = h; }
    }
    let nextSel = L.sel;
    let tap: number | null = null;
    if (best) { nextSel = { k: best.k, i: best.i }; setSel(nextSel); }
    else {
      // Not on a handle: a tap inside another panel selects it; a drag keeps moving the handle already chosen.
      const V = view.current;
      const at: Pt = [V.x0 + (px / V.width) * V.vw, V.y0 + (py / V.height) * V.vw];
      for (let j = L.panels.length - 1; j >= 0; j--) {
        if (L.panels[j].output === p.output && inside(L.panels[j].corners, at)) { tap = j; break; }
      }
    }
    let start: Pt | GeoPanel | null = null;
    if (nextSel) start = nextSel.k === 'a' ? p : handlePos(p, nextSel.k, nextSel.i);
    drag.current = { p: L.selPanel, x: e.clientX, y: e.clientY, sel: nextSel, start, moved: false, first: true, tap };
  };

  const move = (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current, L = live.current;
    if (!d || !d.sel || !d.start) return;
    const px = e.clientX - d.x, py = e.clientY - d.y;
    if (!d.moved && Math.hypot(px, py) < 3) return;
    d.moved = true;
    const V = view.current;
    const k = L.fine ? FINE : 1;
    const dx = (px / V.width) * V.vw * k, dy = (py / V.height) * V.vw * k;
    // The panel the drag began on, even if the selection changes under a slow echo.
    const p = d.p;
    const send = (m: ToHost) => {
      // The first message of a drag marks its undo step, so it goes straight out rather than through the throttle.
      if (d.first) { d.first = false; throttle.current.cancel(); sendToHost(m); } else throttle.current.push(m);
    };
    if (d.sel.k === 'a') {
      const start = d.start as GeoPanel;
      send({ t: 'pan', p, dx, dy, ...(d.first ? { b: true } : {}) });
      keepOv(L.panels.map((q, j) => (j === p ? movePanel(start, dx, dy) : q)));
    } else {
      const start = d.start as Pt;
      const to: Pt = [start[0] + dx, start[1] + dy];
      send({ t: 'pt', p, h: d.sel.k, i: d.sel.i, x: to[0], y: to[1], ...(d.first ? { b: true } : {}) });
      keepOv(L.panels.map((q, j) => (j === p ? movePoint(q, d.sel!.k as HandleKind, d.sel!.i, to) : q)));
    }
  };

  const up = () => {
    const d = drag.current;
    drag.current = null;
    throttle.current.flush();
    if (d && !d.moved && d.tap !== null && d.tap !== live.current.selPanel) { sendToHost({ t: 'sel', p: d.tap }); setSel(null); }
  };

  const nudge = (dx: number, dy: number) => {
    const L = live.current;
    const p = L.panels[L.selPanel];
    if (!L.canEdit || !p || !L.sel) return;
    const [ux, uy] = pixelStep(L.step, size);
    const now = Date.now();
    if (L.sel.k === 'a') {
      sendToHost({ t: 'pan', p: L.selPanel, dx: dx * ux, dy: dy * uy, b: true });
      keepOv(L.panels.map((q, j) => (j === L.selPanel ? movePanel(q, dx * ux, dy * uy) : q)));
      return;
    }
    const at = handlePos(p, L.sel.k, L.sel.i);
    if (!at) return;
    const to: Pt = [at[0] + dx * ux, at[1] + dy * uy];
    // A run of taps on one handle is one undo step.
    const key = `${L.selPanel}:${L.sel.k}:${L.sel.i}`;
    const b = lastNudge.current.key !== key || now - lastNudge.current.at > NUDGE_MERGE_MS;
    lastNudge.current = { key, at: now };
    sendToHost({ t: 'pt', p: L.selPanel, h: L.sel.k, i: L.sel.i, x: to[0], y: to[1], ...(b ? { b: true } : {}) });
    keepOv(L.panels.map((q, j) => (j === L.selPanel ? movePoint(q, L.sel!.k as HandleKind, L.sel!.i, to) : q)));
  };

  const addPanel = () => {
    if (!live.current.canEdit) return;
    // The new panel arrives from the Mac with the next update; drop the phone's own picture so it isn't hidden.
    clearTimeout(ovTimer.current); setOv(null); setSel(null); setAdding(false);
    sendToHost({ t: 'padd' });
  };
  const deletePanel = () => {
    const L = live.current;
    const p = L.panels[L.selPanel];
    if (!L.canEdit || !p?.id || L.panels.length <= 1) return;
    if (!confirm(`Delete panel ${L.selPanel + 1}? You can undo it.`)) return;
    sendToHost({ t: 'pdel', id: p.id });
    keepOv(L.panels.filter((_, j) => j !== L.selPanel));
    setSel(null); setAdding(false);
  };
  const maskDelete = () => {
    const L = live.current;
    const p = L.panels[L.selPanel];
    if (!L.canEdit || !p?.mask || L.sel?.k !== 'm') return;
    sendToHost({ t: 'mdel', p: L.selPanel, i: L.sel.i });
    keepOv(L.panels.map((q, j) => (j === L.selPanel ? deleteMaskPt(q, L.sel!.i) : q)));
    setSel(null);
  };
  const maskToggle = () => {
    const L = live.current;
    const p = L.panels[L.selPanel];
    if (!L.canEdit || !p?.mask || L.sel?.k !== 'm') return;
    sendToHost({ t: 'mtog', p: L.selPanel, i: L.sel.i });
    keepOv(L.panels.map((q, j) => (j === L.selPanel ? toggleMaskPt(q, L.sel!.i) : q)));
  };

  const readout = useMemo(() => {
    if (!panel || !sel) return '';
    const pt = sel.k === 'a' ? centroid(panel) : handlePos(panel, sel.k, sel.i);
    return pt ? `${Math.round(pt[0] * size[0])}, ${Math.round(pt[1] * size[1])} px` : '';
  }, [panel, sel, size]);

  if (!geo || !panel) return <p className="rnote">Waiting for the mapping from the Mac…</p>;

  const here = panels.map((p, i) => ({ p, i })).filter(({ p }) => p.output === outputId);
  const poly = (pts: Pt[]) => pts.map(([x, y]) => `${sx(x)},${sy(y)}`).join(' ');
  const outputs = geo.outputs;

  return (
    <div className="rmap">
      {!canEdit && <p className="rnote">Mapping is locked. On the Mac, set Remote may: Control and edit mapping.</p>}
      {outputs.length > 1 && (
        <div className="rrow" role="group" aria-label="Projector">
          {outputs.map((o) => (
            <button key={o.id} className={o.id === outputId ? 'on' : ''} aria-pressed={o.id === outputId} onClick={() => { setOut(o.id); const j = panels.findIndex((p) => p.output === o.id); if (j >= 0 && canEdit) { sendToHost({ t: 'sel', p: j }); setSel(null); } }}>{o.name}</button>
          ))}
        </div>
      )}
      <div className="rcanvas" style={{ height }}>
        <svg
          ref={svgRef} width={width} height={height} role="img" aria-label="Panels as the audience sees them"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        >
          <rect x={sx(0)} y={sy(0)} width={sx(1) - sx(0)} height={sy(1) - sy(0)} className="stage" />
          {here.map(({ p, i }) => (
            <g key={i} className={i === selPanel ? 'sel' : ''}>
              <polygon points={poly(p.corners)} className="quad" />
              {p.mesh && Array.from({ length: p.mesh.rows }, (_, r) => <polyline key={`r${r}`} className="grid" points={poly(p.mesh!.pts.slice(r * p.mesh!.cols, (r + 1) * p.mesh!.cols))} />)}
              {p.mesh && Array.from({ length: p.mesh.cols }, (_, cc) => <polyline key={`c${cc}`} className="grid" points={poly(Array.from({ length: p.mesh!.rows }, (_, r) => p.mesh!.pts[r * p.mesh!.cols + cc]))} />)}
              {p.mask && <polygon points={poly(p.mask.points.map((m) => m.p))} className="mask" />}
              <text x={sx(centroid(p)[0])} y={sy(centroid(p)[1]) - 6} className="num">{i + 1}</text>
            </g>
          ))}
          {canEdit && handlesOf(panel).map((h) => {
            const [hx, hy] = screenOf(h, panel);
            const on = sel?.k === h.k && sel.i === h.i;
            if (h.k === 'a') return <g key="a" className={`hd all${on ? ' on' : ''}`}><circle cx={hx} cy={hy} r={13} /><path d={`M${hx - 6},${hy}H${hx + 6}M${hx},${hy - 6}V${hy + 6}`} /></g>;
            if (h.k === 'm') {
              // Smooth points are round, sharp corners are diamonds.
              const smooth = panel.mask?.points[h.i]?.smooth !== false;
              return <rect key={`m${h.i}`} className={`hd mask${on ? ' on' : ''}`} x={hx - 7} y={hy - 7} width={14} height={14} rx={smooth ? 7 : 0} transform={smooth ? undefined : `rotate(45 ${hx} ${hy})`} />;
            }
            return <circle key={`${h.k}${h.i}`} className={`hd${on ? ' on' : ''}`} cx={hx} cy={hy} r={h.k === 'g' ? 8 : 11} />;
          })}
        </svg>
      </div>
      <p className="rread" aria-live="polite">{sel ? `${{ c: 'Corner', g: 'Grid point', m: 'Mask point', a: 'Whole panel' }[sel.k]}${sel.k === 'a' ? '' : ` ${sel.i + 1}`} · ${readout}` : 'Touch a handle, then drag anywhere to move it.'}</p>

      <div className="rrow">
        <button disabled={!canEdit || !geo.canUndo} onClick={() => sendToHost({ t: 'undo' })}>Undo</button>
        <button disabled={!canEdit || !geo.canRedo} onClick={() => sendToHost({ t: 'redo' })}>Redo</button>
        <button className={fine ? 'on' : ''} aria-pressed={fine} onClick={() => setFine(!fine)}>Slow</button>
        <button onClick={() => setZoom(ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length])}>Zoom {zoom}×</button>
      </div>
      <div className="rpad" role="group" aria-label="Nudge">
        <button disabled={!canEdit || !sel} aria-label="Up" onClick={() => nudge(0, -1)} style={{ gridArea: 'u' }}>↑</button>
        <button disabled={!canEdit || !sel} aria-label="Left" onClick={() => nudge(-1, 0)} style={{ gridArea: 'l' }}>←</button>
        <button style={{ gridArea: 'm' }} onClick={() => setStep(step === 1 ? 10 : 1)} aria-label="Step size">{step} px</button>
        <button disabled={!canEdit || !sel} aria-label="Right" onClick={() => nudge(1, 0)} style={{ gridArea: 'r' }}>→</button>
        <button disabled={!canEdit || !sel} aria-label="Down" onClick={() => nudge(0, 1)} style={{ gridArea: 'd' }}>↓</button>
      </div>
      <h3 className="rsub">Panels</h3>
      <div className="rrow">
        <button disabled={!canEdit || panels.length >= MAX_PANELS} onClick={addPanel}>Add panel</button>
        <button disabled={!canEdit || panels.length <= 1 || !panel.id} onClick={deletePanel}>Delete panel {selPanel + 1}</button>
      </div>
      {panel.mask && (
        <>
          <h3 className="rsub">Mask points</h3>
          <div className="rrow">
            <button className={adding ? 'on' : ''} aria-pressed={adding} disabled={!canEdit || panel.mask.points.length >= MAX_MASK_POINTS} onClick={() => setAdding(!adding)}>
              {adding ? 'Touch the outline…' : 'Add point'}
            </button>
            <button disabled={!canEdit || sel?.k !== 'm'} onClick={maskToggle}>{sel?.k === 'm' && panel.mask.points[sel.i]?.smooth === false ? 'Make smooth' : 'Make corner'}</button>
            <button disabled={!canEdit || sel?.k !== 'm' || panel.mask.points.length <= MIN_MASK_POINTS} onClick={maskDelete}>Delete point</button>
          </div>
        </>
      )}
    </div>
  );
}
