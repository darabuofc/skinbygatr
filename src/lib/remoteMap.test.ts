import { beforeEach, describe, expect, it } from 'vitest';
import { meshCorners } from './mesh';
import { buildGeo, parseGeo, parseToHost, parseToRemote, permits, type GeoMsg, type ToHost } from './remote';
import { applyEdit, resetEdits } from './remoteApply';
import { clampPt, deleteMaskPt, handlePos, insertMaskPt, movePanel, movePoint, pixelStep, toggleMaskPt, type Shaped } from './remoteEdit';
import { addMask, defaultSettings, redoMapping, runtime, selectPanel, setMeshSize, settings, undoMapping } from './store';
import type { Pt, Quad } from './types';

const quad: Quad = [[0.1, 0.1], [0.6, 0.1], [0.6, 0.6], [0.1, 0.6]];
const flat = (): Shaped => ({ corners: quad.map((q) => [...q] as Pt) as Quad });

describe('movePoint', () => {
  it('moves one corner and leaves the rest', () => {
    const p = movePoint(flat(), 'c', 2, [0.7, 0.8]);
    expect(p.corners[2]).toEqual([0.7, 0.8]);
    expect(p.corners[0]).toEqual(quad[0]);
  });
  it('keeps points within the stage margin', () => {
    expect(clampPt([5, -5])).toEqual([1.25, -0.25]);
    expect(movePoint(flat(), 'c', 0, [9, 9]).corners[0]).toEqual([1.25, 1.25]);
  });
  it('ignores handles that do not exist, including corners on a mesh panel', () => {
    const p = flat();
    expect(movePoint(p, 'g', 0, [0, 0])).toBe(p);
    expect(movePoint(p, 'm', 0, [0, 0])).toBe(p);
    expect(movePoint(p, 'c', 7, [0, 0])).toBe(p);
    const mesh = { cols: 2, rows: 2, pts: [[0, 0], [1, 0], [0, 1], [1, 1]] as Pt[] };
    const m: Shaped = { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], mesh };
    expect(handlePos(m, 'c', 0)).toBeNull();
    expect(movePoint(m, 'c', 0, [0.5, 0.5])).toBe(m);
  });
  it('moves a mesh point and keeps the corners following the grid', () => {
    const mesh = { cols: 2, rows: 2, pts: [[0, 0], [1, 0], [0, 1], [1, 1]] as Pt[] };
    const m = movePoint<Shaped>({ corners: [[0, 0], [1, 0], [1, 1], [0, 1]], mesh }, 'g', 3, [0.9, 0.95]);
    expect(m.mesh!.pts[3]).toEqual([0.9, 0.95]);
    expect(m.corners).toEqual(meshCorners(m.mesh as never));
    expect(m.corners[2]).toEqual([0.9, 0.95]);
  });
  it('moves a mask point', () => {
    const p: Shaped = { ...flat(), mask: { points: [{ p: [0.2, 0.2] }, { p: [0.4, 0.2] }, { p: [0.3, 0.4] }] } };
    expect(movePoint(p, 'm', 1, [0.5, 0.25]).mask!.points[1].p).toEqual([0.5, 0.25]);
  });
});

describe('movePanel and pixelStep', () => {
  it('carries mesh and mask along with the corners', () => {
    const p: Shaped = { ...flat(), mask: { points: [{ p: [0.2, 0.2] }] }, mesh: { cols: 2, rows: 2, pts: [[0.1, 0.1], [0.6, 0.1], [0.1, 0.6], [0.6, 0.6]] } };
    const m = movePanel(p, 0.1, -0.05);
    expect(m.corners[0][0]).toBeCloseTo(0.2);
    expect(m.corners[0][1]).toBeCloseTo(0.05);
    expect(m.mask!.points[0].p[0]).toBeCloseTo(0.3);
    expect(m.mesh!.pts[3][1]).toBeCloseTo(0.55);
  });
  it('turns projector pixels into stage fractions per axis', () => {
    expect(pixelStep(10, [1000, 500])).toEqual([0.01, 0.02]);
  });
});

describe('parseToHost mapping messages', () => {
  it('accepts well-formed edits', () => {
    expect(parseToHost({ t: 'pt', p: 1, h: 'g', i: 4, x: 0.5, y: 0.4, b: 1 })).toEqual({ t: 'pt', p: 1, h: 'g', i: 4, x: 0.5, y: 0.4, b: true });
    expect(parseToHost({ t: 'pan', p: 0, dx: 0.1, dy: -0.1 })).toEqual({ t: 'pan', p: 0, dx: 0.1, dy: -0.1 });
    expect(parseToHost({ t: 'sel', p: 2 })).toEqual({ t: 'sel', p: 2 });
    expect(parseToHost({ t: 'undo' })).toEqual({ t: 'undo' });
    expect(parseToHost({ t: 'redo' })).toEqual({ t: 'redo' });
  });
  it('rejects bad indexes, kinds and numbers', () => {
    const bad: unknown[] = [
      { t: 'pt', p: -1, h: 'c', i: 0, x: 0, y: 0 }, { t: 'pt', p: 12, h: 'c', i: 0, x: 0, y: 0 }, { t: 'pt', p: 0.5, h: 'c', i: 0, x: 0, y: 0 },
      { t: 'pt', p: 0, h: 'c', i: 4, x: 0, y: 0 }, { t: 'pt', p: 0, h: 'g', i: 64, x: 0, y: 0 }, { t: 'pt', p: 0, h: 'x', i: 0, x: 0, y: 0 },
      { t: 'pt', p: 0, h: 'c', i: 0, x: NaN, y: 0 }, { t: 'pt', p: 0, h: 'c', i: 0, x: '1', y: 0 }, { t: 'pt', p: 0, h: 'c', i: 0, x: 0 },
      { t: 'pan', p: 0, dx: 5, dy: 0 }, { t: 'pan', p: 0, dx: Infinity, dy: 0 }, { t: 'sel', p: 99 }, { t: 'sel' },
    ];
    for (const b of bad) expect(parseToHost(b)).toBeNull();
  });
});

describe('permits', () => {
  const act: ToHost = { t: 'act', id: 'blackout' };
  const edit: ToHost = { t: 'pt', p: 0, h: 'c', i: 0, x: 0, y: 0 };
  it('lets view-only watch but not act or edit', () => {
    expect(permits('view', { t: 'hello' })).toBe(true);
    expect(permits('view', act)).toBe(false);
    expect(permits('view', edit)).toBe(false);
  });
  it('lets control act but not edit mapping', () => {
    expect(permits('control', act)).toBe(true);
    expect(permits('control', edit)).toBe(false);
    expect(permits('control', { t: 'undo' })).toBe(false);
  });
  it('lets edit do everything', () => {
    expect(permits('edit', act)).toBe(true);
    expect(permits('edit', edit)).toBe(true);
    expect(permits('edit', { t: 'redo' })).toBe(true);
  });
});

describe('geometry message', () => {
  it('round-trips the mapping through the wire format', () => {
    const s = defaultSettings();
    const g = buildGeo(s, { [s.outputs[0].id]: [1280, 720] }, true, false);
    const back = parseToRemote(JSON.parse(JSON.stringify({ t: 'geo', g }))) as GeoMsg;
    expect(back.g.panels).toHaveLength(s.panels.length);
    expect(back.g.panels[0].corners).toEqual(s.panels[0].corners);
    expect(back.g.outputs[0].size).toEqual([1280, 720]);
    expect(back.g.canUndo).toBe(true);
  });
  it('rejects malformed geometry whole', () => {
    const good = buildGeo(defaultSettings(), {}, false, false);
    expect(parseGeo(good)).not.toBeNull();
    expect(parseGeo({ ...good, panels: [] })).toBeNull();
    expect(parseGeo({ ...good, panels: [{ output: 'x', corners: [[0, 0]] }] })).toBeNull();
    expect(parseGeo({ ...good, panels: [{ output: 'x', corners: [[0, 0], [1, 0], [1, 1], [NaN, 1]] }] })).toBeNull();
    expect(parseGeo({ ...good, panels: Array(13).fill(good.panels[0]) })).toBeNull();
    expect(parseGeo({ ...good, outputs: [{ id: 'a', name: 'b', size: ['x', 1] }] })).toBeNull();
  });
  it('sends a mesh and a mask only when there is one', () => {
    const s = defaultSettings();
    settings.set(s);
    setMeshSize(0, 3);
    addMask(1);
    const g = buildGeo(settings.get(), {}, false, false);
    expect(g.panels[0].mesh?.pts).toHaveLength(9);
    expect(g.panels[1].mask?.points.length).toBeGreaterThanOrEqual(3);
    expect(g.panels[2].mesh).toBeUndefined();
    expect(g.panels[2].mask).toBeUndefined();
    expect(parseGeo(JSON.parse(JSON.stringify(g)))).not.toBeNull();
  });
});

describe('applyEdit on the Mac', () => {
  beforeEach(() => { settings.set(defaultSettings()); runtime.set({ selCorner: null }); resetEdits(); });

  it('moves a corner and selects the panel and handle', () => {
    applyEdit({ t: 'pt', p: 1, h: 'c', i: 2, x: 0.5, y: 0.5, b: true });
    expect(settings.get().panels[1].corners[2]).toEqual([0.5, 0.5]);
    expect(settings.get().selected).toBe(1);
    expect(runtime.get().selCorner).toEqual({ p: 1, c: 2 });
  });
  it('makes one undo step per drag, however many moves it has', () => {
    const before = settings.get().panels[0].corners;
    applyEdit({ t: 'pt', p: 0, h: 'c', i: 0, x: 0.2, y: 0.2, b: true });
    applyEdit({ t: 'pt', p: 0, h: 'c', i: 0, x: 0.21, y: 0.21 });
    applyEdit({ t: 'pt', p: 0, h: 'c', i: 0, x: 0.22, y: 0.22 });
    expect(settings.get().panels[0].corners[0]).toEqual([0.22, 0.22]);
    undoMapping();
    expect(settings.get().panels[0].corners).toEqual(before);
    redoMapping();
    expect(settings.get().panels[0].corners[0]).toEqual([0.22, 0.22]);
  });
  it('undo and redo come from the remote too', () => {
    const before = settings.get().panels[0].corners;
    applyEdit({ t: 'pt', p: 0, h: 'c', i: 0, x: 0.3, y: 0.3, b: true });
    applyEdit({ t: 'undo' });
    expect(settings.get().panels[0].corners).toEqual(before);
    applyEdit({ t: 'redo' });
    expect(settings.get().panels[0].corners[0]).toEqual([0.3, 0.3]);
  });
  it('ignores panels and handles that do not exist', () => {
    const before = settings.get().panels;
    applyEdit({ t: 'pt', p: 9, h: 'c', i: 0, x: 0, y: 0, b: true });
    applyEdit({ t: 'pt', p: 0, h: 'g', i: 0, x: 0, y: 0, b: true });
    applyEdit({ t: 'pt', p: 0, h: 'm', i: 0, x: 0, y: 0, b: true });
    applyEdit({ t: 'sel', p: 9 });
    expect(settings.get().panels).toBe(before);
  });
  it('moves a mesh point on a mesh panel and refuses its corners', () => {
    setMeshSize(0, 3);
    applyEdit({ t: 'pt', p: 0, h: 'c', i: 0, x: 0.9, y: 0.9, b: true });
    expect(settings.get().panels[0].mesh!.pts[0]).not.toEqual([0.9, 0.9]);
    applyEdit({ t: 'pt', p: 0, h: 'g', i: 4, x: 0.5, y: 0.5, b: true });
    expect(settings.get().panels[0].mesh!.pts[4]).toEqual([0.5, 0.5]);
    expect(runtime.get().selCorner).toEqual({ p: 0, c: -1, g: 4 });
  });
  it('moves a whole panel as an offset from where the drag began', () => {
    const start = settings.get().panels[0].corners;
    applyEdit({ t: 'pan', p: 0, dx: 0.1, dy: 0, b: true });
    applyEdit({ t: 'pan', p: 0, dx: 0.1, dy: 0.05 });
    const c = settings.get().panels[0].corners;
    expect(c[0][0]).toBeCloseTo(start[0][0] + 0.1);
    expect(c[0][1]).toBeCloseTo(start[0][1] + 0.05);
    undoMapping();
    expect(settings.get().panels[0].corners).toEqual(start);
  });
  it('ignores a whole-panel drag whose start was lost', () => {
    const before = settings.get().panels;
    applyEdit({ t: 'pan', p: 0, dx: 0.1, dy: 0.1 });
    expect(settings.get().panels).toBe(before);
    applyEdit({ t: 'pan', p: 0, dx: 0.1, dy: 0, b: true });
    const after = settings.get().panels;
    applyEdit({ t: 'pan', p: 1, dx: 0.3, dy: 0 });
    expect(settings.get().panels).toBe(after);
  });
  it('selects a panel', () => {
    selectPanel(0);
    applyEdit({ t: 'sel', p: 2 });
    expect(settings.get().selected).toBe(2);
  });
  it('calls back after a move so the Mac can show its magnifier', () => {
    let n = 0;
    applyEdit({ t: 'pt', p: 0, h: 'c', i: 0, x: 0.2, y: 0.2, b: true }, { moved: () => { n++; } });
    expect(n).toBe(1);
  });
});

const tri = (): Shaped => ({
  ...flat(),
  mask: { points: [{ p: [0.2, 0.2], smooth: true }, { p: [0.5, 0.2], smooth: false }, { p: [0.5, 0.5], smooth: true }, { p: [0.2, 0.5], smooth: true }] },
});

describe('mask point helpers', () => {
  it('inserts on the nearest segment, taking the look of the point before it', () => {
    const r = insertMaskPt(tri(), [0.35, 0.19], 1)!;
    expect(r.at).toBe(1);
    expect(r.panel.mask!.points).toHaveLength(5);
    expect(r.panel.mask!.points[1].p).toEqual([0.35, 0.19]);
    expect(r.panel.mask!.points[1].smooth).toBe(true);
    const r2 = insertMaskPt(tri(), [0.52, 0.35], 1)!;
    expect(r2.at).toBe(2);
    expect(r2.panel.mask!.points[2].smooth).toBe(false);
  });
  it('refuses with no mask or a full one', () => {
    expect(insertMaskPt(flat(), [0.3, 0.3], 1)).toBeNull();
    const full: Shaped = { ...flat(), mask: { points: Array.from({ length: 64 }, (_, i) => ({ p: [i / 64, 0.5] as Pt })) } };
    expect(insertMaskPt(full, [0.3, 0.3], 1)).toBeNull();
  });
  it('deletes a point but never below three', () => {
    const p = deleteMaskPt(tri(), 1);
    expect(p.mask!.points).toHaveLength(3);
    expect(deleteMaskPt(p, 0)).toBe(p);
    expect(deleteMaskPt(tri(), 9)).toEqual(tri());
  });
  it('toggles smooth, treating a missing flag as smooth', () => {
    expect(toggleMaskPt(tri(), 0).mask!.points[0].smooth).toBe(false);
    expect(toggleMaskPt(tri(), 1).mask!.points[1].smooth).toBe(true);
    const bare: Shaped = { ...flat(), mask: { points: [{ p: [0, 0] }, { p: [1, 0] }, { p: [1, 1] }] } };
    expect(toggleMaskPt(bare, 0).mask!.points[0].smooth).toBe(false);
  });
});

describe('panel and mask messages', () => {
  it('accepts well-formed ones', () => {
    expect(parseToHost({ t: 'padd' })).toEqual({ t: 'padd' });
    expect(parseToHost({ t: 'pdel', id: 'abc' })).toEqual({ t: 'pdel', id: 'abc' });
    expect(parseToHost({ t: 'madd', p: 1, x: 0.2, y: 0.3 })).toEqual({ t: 'madd', p: 1, x: 0.2, y: 0.3 });
    expect(parseToHost({ t: 'mdel', p: 0, i: 3 })).toEqual({ t: 'mdel', p: 0, i: 3 });
    expect(parseToHost({ t: 'mtog', p: 0, i: 3 })).toEqual({ t: 'mtog', p: 0, i: 3 });
  });
  it('rejects bad ones', () => {
    for (const b of [
      { t: 'pdel' }, { t: 'pdel', id: '' }, { t: 'pdel', id: 5 }, { t: 'pdel', id: 'x'.repeat(65) },
      { t: 'madd', p: 0, x: NaN, y: 0 }, { t: 'madd', p: 12, x: 0, y: 0 }, { t: 'madd', p: 0, x: 0 },
      { t: 'mdel', p: 0, i: -1 }, { t: 'mdel', p: 0, i: 64 }, { t: 'mtog', p: 0.5, i: 0 }, { t: 'mtog', p: 0 },
    ]) expect(parseToHost(b)).toBeNull();
  });
  it('need edit permission', () => {
    for (const m of [{ t: 'padd' }, { t: 'pdel', id: 'a' }, { t: 'madd', p: 0, x: 0, y: 0 }, { t: 'mdel', p: 0, i: 0 }, { t: 'mtog', p: 0, i: 0 }] as ToHost[]) {
      expect(permits('control', m)).toBe(false);
      expect(permits('view', m)).toBe(false);
      expect(permits('edit', m)).toBe(true);
    }
  });
  it('geometry carries panel ids and smooth flags', () => {
    settings.set(defaultSettings());
    addMask(0);
    const g = buildGeo(settings.get(), {}, false, false);
    expect(g.panels[0].id).toBe(settings.get().panels[0].id);
    const back = parseGeo(JSON.parse(JSON.stringify(g)))!;
    expect(back.panels[0].id).toBe(g.panels[0].id);
    expect(back.panels[0].mask!.points.every((mp) => typeof mp.smooth === 'boolean')).toBe(true);
    expect(parseGeo({ ...g, panels: [{ ...g.panels[0], id: 'x'.repeat(65) }] })!.panels[0].id).toBeUndefined();
  });
});

describe('applyEdit panels and masks on the Mac', () => {
  beforeEach(() => { settings.set(defaultSettings()); runtime.set({ selCorner: null }); resetEdits(); });

  it('adds a panel, selects it, and undo takes it away', () => {
    const n = settings.get().panels.length;
    applyEdit({ t: 'padd' });
    expect(settings.get().panels).toHaveLength(n + 1);
    expect(settings.get().selected).toBe(n);
    undoMapping();
    expect(settings.get().panels).toHaveLength(n);
  });
  it('stops adding at twelve panels', () => {
    for (let i = 0; i < 20; i++) applyEdit({ t: 'padd' });
    expect(settings.get().panels).toHaveLength(12);
  });
  it('deletes the panel with that id, not the one at a stale position', () => {
    const [a, b, c] = settings.get().panels;
    applyEdit({ t: 'pdel', id: b.id });
    expect(settings.get().panels.map((p) => p.id)).toEqual([a.id, c.id]);
    applyEdit({ t: 'pdel', id: b.id });
    expect(settings.get().panels).toHaveLength(2);
    undoMapping();
    expect(settings.get().panels.map((p) => p.id)).toEqual([a.id, b.id, c.id]);
  });
  it('never deletes the last panel', () => {
    for (const p of [...settings.get().panels]) applyEdit({ t: 'pdel', id: p.id });
    expect(settings.get().panels).toHaveLength(1);
  });
  it('adds, smooths and deletes mask points', () => {
    addMask(0);
    const n = settings.get().panels[0].mask!.points.length;
    const [x, y] = settings.get().panels[0].mask!.points[0].p;
    applyEdit({ t: 'madd', p: 0, x: x + 0.01, y: y + 0.01 }, { aspect: () => 16 / 9 });
    expect(settings.get().panels[0].mask!.points).toHaveLength(n + 1);
    const was = settings.get().panels[0].mask!.points[1].smooth;
    applyEdit({ t: 'mtog', p: 0, i: 1 });
    expect(settings.get().panels[0].mask!.points[1].smooth).toBe(!was);
    applyEdit({ t: 'mdel', p: 0, i: 1 });
    expect(settings.get().panels[0].mask!.points).toHaveLength(n);
  });
  it('ignores mask edits on a panel without a mask or a point that is not there', () => {
    const before = settings.get().panels;
    applyEdit({ t: 'madd', p: 0, x: 0.3, y: 0.3 });
    applyEdit({ t: 'mdel', p: 0, i: 0 });
    applyEdit({ t: 'mtog', p: 0, i: 0 });
    expect(settings.get().panels).toBe(before);
    addMask(0);
    const m = settings.get().panels[0].mask;
    applyEdit({ t: 'mdel', p: 0, i: 40 });
    applyEdit({ t: 'mtog', p: 0, i: 40 });
    expect(settings.get().panels[0].mask).toBe(m);
  });
});
