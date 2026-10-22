import { describe, expect, it } from 'vitest';
import { COALESCE_MS, HISTORY_LIMIT, MapHistory, restoreGeometry } from './history';
import {
  addPanel, defaultSettings, deletePanel, history, recordMapping, redoMapping, runtime, settings, undoMapping,
} from './store';
import type { Panel, Quad } from './types';

const panel = (id: string, x: number, source = 'gen'): Panel => ({
  id, output: 'out1', source, band: 'bass', feather: 0, blend: 'over', opacity: 1,
  corners: [[x, 0], [x + 0.1, 0], [x + 0.1, 1], [x, 1]] as Quad,
});

describe('restoreGeometry', () => {
  it('restores corners but keeps a surviving panel’s current content', () => {
    const snap = [panel('a', 0.1)];
    const now = [{ ...panel('a', 0.5), source: 'vid:x', band: 'high' as const }];
    const out = restoreGeometry(now, snap);
    expect(out[0].corners[0][0]).toBe(0.1);
    expect(out[0].source).toBe('vid:x');
    expect(out[0].band).toBe('high');
  });

  it('restores which projector a panel was on', () => {
    const out = restoreGeometry([{ ...panel('a', 0.1), output: 'out2' }], [panel('a', 0.1)]);
    expect(out[0].output).toBe('out1');
  });

  it('records a move between projectors even when the corners stay put', () => {
    const h = new MapHistory();
    h.push([panel('a', 0.1)]);
    h.push([{ ...panel('a', 0.1), output: 'out2' }]);
    expect(h.undo([panel('a', 0.1)])?.[0].output).toBe('out2');
  });

  it('brings back a deleted panel whole', () => {
    const out = restoreGeometry([panel('a', 0)], [panel('a', 0), panel('b', 0.5, 'vid:y')]);
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
    expect(out[1].source).toBe('vid:y');
  });
});

describe('MapHistory', () => {
  it('undoes and redoes in order', () => {
    const h = new MapHistory();
    const s0 = [panel('a', 0)], s1 = [panel('a', 0.2)], s2 = [panel('a', 0.4)];
    h.push(s0, '', 0);
    h.push(s1, '', 10);
    expect(h.undo(s2)![0].corners[0][0]).toBe(0.2);
    expect(h.undo(s1)![0].corners[0][0]).toBe(0);
    expect(h.undo(s0)).toBeNull();
    expect(h.redo(s0)![0].corners[0][0]).toBe(0.2);
  });

  it('merges a burst of nudges on one corner into one step', () => {
    const h = new MapHistory();
    h.push([panel('a', 0)], 'nudge:0:1', 0);
    h.push([panel('a', 0.01)], 'nudge:0:1', 200);
    h.push([panel('a', 0.02)], 'nudge:0:1', 400);
    expect(h.undo([panel('a', 0.03)])![0].corners[0][0]).toBe(0);
    expect(h.canUndo).toBe(false);
  });

  it('starts a new step after a pause or on another corner', () => {
    const h = new MapHistory();
    h.push([panel('a', 0)], 'nudge:0:1', 0);
    h.push([panel('a', 0.01)], 'nudge:0:1', COALESCE_MS + 1);
    h.push([panel('a', 0.02)], 'nudge:0:2', COALESCE_MS + 2);
    h.undo([panel('a', 0.03)]);
    h.undo([panel('a', 0.02)]);
    expect(h.canUndo).toBe(true);
  });

  it('clears redo after a new edit and caps its size', () => {
    const h = new MapHistory();
    h.push([panel('a', 0)], '', 0);
    h.undo([panel('a', 0.1)]);
    expect(h.canRedo).toBe(true);
    h.push([panel('a', 0.3)], '', 10);
    expect(h.canRedo).toBe(false);
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h.push([panel('a', i)], '', i * 10);
    let n = 0;
    while (h.undo([panel('a', -1)])) n++;
    expect(n).toBe(HISTORY_LIMIT);
  });
});

describe('store mapping undo', () => {
  const reset = () => { settings.set(defaultSettings()); history.clear(); runtime.set({ canUndo: false, canRedo: false }); };

  it('undoes add and delete panel and tracks button state', () => {
    reset();
    addPanel();
    expect(settings.get().panels).toHaveLength(4);
    expect(runtime.get().canUndo).toBe(true);
    deletePanel(0);
    undoMapping();
    expect(settings.get().panels).toHaveLength(4);
    undoMapping();
    expect(settings.get().panels).toHaveLength(3);
    expect(runtime.get().canRedo).toBe(true);
    redoMapping();
    expect(settings.get().panels).toHaveLength(4);
  });

  it('does not revert a source change made after a drag', () => {
    reset();
    recordMapping();
    settings.set((s) => ({ panels: s.panels.map((p, i) => (i === 0 ? { ...p, corners: [[0, 0], [1, 0], [1, 1], [0, 1]] as Quad } : p)) }));
    settings.set((s) => ({ panels: s.panels.map((p, i) => (i === 0 ? { ...p, source: 'vid:abc' } : p)) }));
    undoMapping();
    const p = settings.get().panels[0];
    expect(p.corners[1][0]).not.toBe(1);
    expect(p.source).toBe('vid:abc');
  });

  it('keeps the selection in range after undoing an add', () => {
    reset();
    addPanel();
    expect(settings.get().selected).toBe(3);
    undoMapping();
    expect(settings.get().selected).toBe(2);
  });
});
