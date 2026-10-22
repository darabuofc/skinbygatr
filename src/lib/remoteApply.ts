import type { EditMsg } from './remote';
import { clampPt, handlePos, movePanel, movePoint } from './remoteEdit';
import {
  addPanel, deleteMaskPoint, deletePanel, insertMaskPoint, recordMapping, redoMapping, runtime, selectPanel, settings, toggleMaskPoint, undoMapping,
} from './store';
import type { Panel } from './types';

/** The panel as it was when a whole-panel drag began, so the drag is an offset from there. */
let panStart: { p: number; panel: Panel } | null = null;

export function resetEdits() { panStart = null; }

export interface EditEnv {
  /** Runs after a handle moves (the Mac shows its magnifier then). */
  moved?: () => void;
  /** Width over height of a projector picture, so a new mask point lands on the nearest bit of outline. */
  aspect?: (outputId: string) => number;
}

/** Applies a mapping edit from a remote to the Mac's panels, checked against what's actually there. */
export function applyEdit(m: EditMsg, env: EditEnv = {}) {
  if (m.t === 'undo') { undoMapping(); return; }
  if (m.t === 'redo') { redoMapping(); return; }
  if (m.t === 'padd') { addPanel(); return; }
  if (m.t === 'pdel') {
    const i = settings.get().panels.findIndex((p) => p.id === m.id);
    if (i >= 0) deletePanel(i);
    return;
  }
  const panel = settings.get().panels[m.p];
  if (!panel) return;
  if (m.t === 'sel') { selectPanel(m.p); return; }
  if (m.t === 'madd') {
    if (!panel.mask?.points.length) return;
    const at = insertMaskPoint(m.p, clampPt([m.x, m.y]), env.aspect?.(panel.output) ?? 1);
    if (at !== null) settings.set({ selected: m.p });
    return;
  }
  if (m.t === 'mdel' || m.t === 'mtog') {
    if (!panel.mask?.points[m.i]) return;
    if (m.t === 'mdel') deleteMaskPoint(m.p, m.i); else toggleMaskPoint(m.p, m.i);
    return;
  }
  if (m.t === 'pt') {
    if (!handlePos(panel, m.h, m.i)) return;
    if (m.b) recordMapping();
    settings.set((s) => ({ selected: m.p, panels: s.panels.map((p, j) => (j === m.p ? movePoint(p, m.h, m.i, [m.x, m.y]) : p)) }));
    runtime.set({ selCorner: m.h === 'c' ? { p: m.p, c: m.i } : m.h === 'g' ? { p: m.p, c: -1, g: m.i } : { p: m.p, c: -1, m: m.i } });
    env.moved?.();
    return;
  }
  if (m.b) { recordMapping(); panStart = { p: m.p, panel }; }
  // A drag with no start (its first message was lost, or it belongs to another panel) is ignored.
  if (!panStart || panStart.p !== m.p) return;
  const to = movePanel(panStart.panel, m.dx, m.dy);
  settings.set((s) => ({
    selected: m.p,
    panels: s.panels.map((p, j) => (j === m.p ? { ...p, corners: to.corners, ...(to.mesh && p.mesh ? { mesh: to.mesh } : {}), ...(to.mask && p.mask ? { mask: to.mask } : {}) } : p)),
  }));
  env.moved?.();
}
