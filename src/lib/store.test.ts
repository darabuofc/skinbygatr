import { describe, expect, it } from 'vitest';
import {
  addMask, addOutput, addPanel, cueFadeInProgress, cueTransitionInProgress, defaultSettings, onCueRecall, type CueRecall, deleteMaskPoint, FIRST_OUTPUT, insertMaskPoint, KEY, layerTarget, loadSettings,
  moveMaskPoint, moveMeshPoint, movePanelLayer, movePanelToOutput, recallCue, redoMapping, removeMask, removeOutput, runtime, sanitize, sanitizeLook,
  sanitizeMidi, sanitizeOutputs, saveCue, updateOutline, removeOutline, sanitizeInputs, selectPanel, setMeshSize, setPanelInput, settings, toggleMaskPoint, undoMapping, updateMask,
} from './store';
import { defaultParams, params, resetParams, setParam } from './params';
import { MAX_OUTPUTS } from './types';

describe('sanitize', () => {
  it('returns defaults for garbage input', () => {
    const s = sanitize('nope');
    expect(s.panels.length).toBe(3);
    expect(s.version).toBe(3);
  });

  it('drops malformed panels and unknown video sources from a v1 layout', () => {
    const s = sanitize({
      panels: [
        { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], source: 'v:old.mp4', band: 'bass' },
        { corners: [[0, 0]], source: 'gen' },
      ],
      gain: 99,
    });
    expect(s.panels).toHaveLength(1);
    expect(s.panels[0].source).toBe('gen');
    expect(s.gain).toBe(6);
  });

  it('keeps the RGB split in range and rejects an unknown driver', () => {
    const s = sanitize({ rgbSplit: 4, rgbDrive: 'snare' });
    expect(s.rgbSplit).toBe(1);
    expect(s.rgbDrive).toBe('kick');
    expect(sanitize({}).rgbSplit).toBe(0);
    expect(sanitize({ rgbDrive: 'high' }).rgbDrive).toBe('high');
  });

  it('keeps panel text in range and drops empty or malformed labels', () => {
    const q = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const s = sanitize({
      panels: [
        { corners: q, label: { text: '  ENCORE  ', rotation: 400, size: 9, color: 'red', pulse: 'yes' } },
        { corners: q, label: { text: '   ', rotation: 90 } },
        { corners: q, label: 'hello' },
        { corners: q },
        { corners: q, label: { text: 'x'.repeat(500), rotation: -90, size: 0.3, color: '#00ff88', pulse: true } },
      ],
    });
    expect(s.panels[0].label).toEqual({ text: 'ENCORE', rotation: 180, size: 1, color: '#ffffff', pulse: false });
    expect(s.panels[1].label).toBeUndefined();
    expect(s.panels[2].label).toBeUndefined();
    expect(s.panels[3]).not.toHaveProperty('label');
    expect(s.panels[4].label).toMatchObject({ rotation: -90, size: 0.3, color: '#00ff88', pulse: true });
    expect(s.panels[4].label!.text).toHaveLength(120);
  });
});

describe('neon outline', () => {
  it('is added with defaults, edited, and kept through a save and load', () => {
    settings.set(defaultSettings());
    updateOutline(0, { style: 'dashes', width: 12 });
    const o = settings.get().panels[0].outline!;
    expect(o.style).toBe('dashes');
    expect(o.width).toBe(12);
    expect(sanitize(JSON.parse(JSON.stringify(settings.get()))).panels[0].outline).toEqual(o);
    removeOutline(0);
    expect(settings.get().panels[0].outline).toBeUndefined();
  });

  it('clamps edits to valid values', () => {
    settings.set(defaultSettings());
    updateOutline(0, { width: 9999, runners: 0 });
    expect(settings.get().panels[0].outline).toMatchObject({ width: 40, runners: 1 });
  });

  it('comes back with a cue, including being switched off, and cues without one leave it alone', () => {
    settings.set(defaultSettings());
    const id = settings.get().panels[0].id;
    updateOutline(0, { on: true, style: 'rainbow' });
    saveCue(0);
    updateOutline(0, { on: false, style: 'flicker' });
    saveCue(1);
    updateOutline(0, { on: true, style: 'chase' });
    recallCue(0);
    expect(settings.get().panels.find((p) => p.id === id)!.outline).toMatchObject({ on: true, style: 'rainbow' });
    recallCue(1);
    expect(settings.get().panels.find((p) => p.id === id)!.outline).toMatchObject({ on: false, style: 'flicker' });
    // A cue saved on a panel with no outline (or an older cue) leaves the outline as it is.
    settings.set(defaultSettings());
    saveCue(2);
    updateOutline(0, { style: 'pulse' });
    recallCue(2);
    expect(settings.get().panels[0].outline!.style).toBe('pulse');
  });

  it('drops a malformed outline from a cue instead of failing the cue', () => {
    const look = sanitizeLook({ scene: 1, panels: { a: { source: 'gen', band: 'none', outline: 'nope' } } })!;
    expect(look.panels.a.outline).toBeUndefined();
  });
});

describe('cues', () => {
  it('restores scene, colors and per-panel content', () => {
    settings.set(defaultSettings());
    const id = settings.get().panels[0].id;
    settings.set((s) => ({ scene: 3, c1: '#123456', panels: s.panels.map((p, i) => (i === 0 ? { ...p, band: 'high' } : p)) }));
    saveCue(0);
    settings.set((s) => ({ scene: 1, c1: '#ffffff', panels: s.panels.map((p) => ({ ...p, band: 'none' })) }));
    recallCue(0);
    const s = settings.get();
    expect(s.scene).toBe(3);
    expect(s.c1).toBe('#123456');
    expect(s.panels.find((p) => p.id === id)!.band).toBe('high');
  });

  it('restores the RGB split', () => {
    settings.set(defaultSettings());
    settings.set({ rgbSplit: 0.6, rgbDrive: 'bass' });
    saveCue(1);
    settings.set({ rgbSplit: 0, rgbDrive: 'kick' });
    recallCue(1);
    expect(settings.get().rgbSplit).toBe(0.6);
    expect(settings.get().rgbDrive).toBe('bass');
  });

  it('leaves the RGB split alone when recalling a cue saved before it existed', () => {
    settings.set(defaultSettings());
    saveCue(2);
    settings.set((s) => ({
      cues: s.cues.map((c, i) => {
        if (i !== 2 || !c) return c;
        const { rgbSplit: _a, rgbDrive: _b, ...old } = c;
        return old;
      }),
      rgbSplit: 0.4, rgbDrive: 'mid',
    }));
    recallCue(2);
    expect(settings.get().rgbSplit).toBe(0.4);
    expect(settings.get().rgbDrive).toBe('mid');
  });

  it('ignores an empty slot', () => {
    settings.set(defaultSettings());
    settings.set({ scene: 2 });
    recallCue(5);
    expect(settings.get().scene).toBe(2);
  });
});

describe('cue validation', () => {
  // Regression: a cue without colours recalled undefined into c1, hexToRgb threw inside the
  // render loop, and the watchdog restarted straight into the same error, freezing the wall.
  it('fills missing colours so a recalled cue can always be drawn', () => {
    settings.set(sanitize({ cues: [{ scene: 4, react: 0.5, panels: {} }] }));
    recallCue(0);
    const s = settings.get();
    expect(s.scene).toBe(4);
    expect(s.c1).toMatch(/^#[0-9a-f]{6}$/i);
    expect(s.c2).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('drops cues that have no usable scene', () => {
    const s = sanitize({ cues: [{ c1: '#ffffff' }, { scene: 'Pulse' }, 'cue', null, { scene: NaN }] });
    expect(s.cues.every((c) => c === null)).toBe(true);
  });

  it('clamps values and drops malformed per-panel entries', () => {
    const look = sanitizeLook({
      scene: 99, c1: 'red', react: 7, strobe: 'yes', rgbSplit: 3, rgbDrive: 'snare',
      panels: { a: { source: 'gen', band: 'bass' }, b: { source: 'ftp:x', band: 'bass' }, c: { source: 'gen', band: 'loud' }, d: 5 },
    })!;
    expect(look.scene).toBe(11);
    expect(look.c1).toBe('#ffffff');
    expect(look.react).toBe(1);
    expect(look.strobe).toBe(false);
    expect(look.rgbSplit).toBe(1);
    expect(look).not.toHaveProperty('rgbDrive');
    expect(look.panels).toEqual({ a: { source: 'gen', band: 'bass' } });
  });

  it('keeps cues saved before the RGB split without inventing one', () => {
    const look = sanitizeLook({ scene: 2, c1: '#112233', c2: '#445566', react: 0.3, strobe: true, span: false, panels: {} })!;
    expect(look).not.toHaveProperty('rgbSplit');
    expect(look).not.toHaveProperty('rgbDrive');
    expect(look.strobe).toBe(true);
  });

  it('round-trips a saved cue unchanged', () => {
    settings.set(defaultSettings());
    settings.set({ scene: 6, c1: '#abcdef', rgbSplit: 0.25, rgbDrive: 'mid' });
    saveCue(0);
    const saved = settings.get().cues[0];
    expect(sanitize(JSON.parse(JSON.stringify(settings.get()))).cues[0]).toEqual(saved);
  });
});

describe('MIDI map validation', () => {
  it('keeps well-formed bindings, including ones for actions added later', () => {
    const m = sanitizeMidi({
      master: { kind: 'cc', channel: 0, num: 7 },
      'cue:0': { kind: 'note', channel: 9, num: 36 },
      'param:eye:blink': { kind: 'note', channel: 1, num: 40 },
    });
    expect(Object.keys(m)).toEqual(['master', 'cue:0', 'param:eye:blink']);
  });

  it('drops malformed bindings', () => {
    const m = sanitizeMidi({
      a: { kind: 'pitch', channel: 0, num: 1 },
      b: { kind: 'cc', channel: 16, num: 1 },
      c: { kind: 'cc', channel: 0, num: 128 },
      d: { kind: 'cc', channel: 0.5, num: 1 },
      e: { kind: 'cc', channel: 0 },
      f: 'cc:0:1',
      g: null,
    });
    expect(m).toEqual({});
    expect(sanitizeMidi([{ kind: 'cc', channel: 0, num: 1 }])).toEqual({});
    expect(sanitizeMidi('x')).toEqual({});
  });

  it('strips extra fields from a binding', () => {
    expect(sanitizeMidi({ tap: { kind: 'note', channel: 0, num: 60, evil: 1 } })).toEqual({ tap: { kind: 'note', channel: 0, num: 60 } });
  });
});

/** A layout as v2 saved and exported it: no outputs, panels without an output. */
const V2_LAYOUT = {
  version: 2,
  panels: [
    { id: 'p1', corners: [[0.08, 0.2], [0.32, 0.2], [0.32, 0.8], [0.08, 0.8]], source: 'gen', band: 'bass', feather: 0.05 },
    { id: 'p2', corners: [[0.38, 0.2], [0.62, 0.2], [0.62, 0.8], [0.38, 0.8]], source: 'fx:water', band: 'none', feather: 0,
      label: { text: 'GLOW', rotation: 0, size: 0.4, color: '#ffffff', pulse: false } },
  ],
  selected: 1, scene: 6, autoCycle: true, cycleBars: 16, fadeBeats: 4, c1: '#00ffcc', c2: '#3300ff',
  react: 0.4, strobe: false, rgbSplit: 0.2, rgbDrive: 'bass', span: false, testGrid: false, loupe: true,
  autoBpm: false, bpm: 122, gain: 1.5, sens: 1.45, master: 0.9,
  cues: [{ scene: 6, c1: '#00ffcc', c2: '#3300ff', react: 0.4, strobe: false, span: false, panels: { p1: { source: 'gen', band: 'bass' } } }],
  midi: { master: { kind: 'cc', channel: 0, num: 7 } },
  audioDevice: '',
};

describe('settings v3 migration', () => {
  it('puts a v2 layout on one unflipped projector and keeps everything else', () => {
    const s = sanitize(V2_LAYOUT);
    expect(s.version).toBe(3);
    expect(s.outputs).toEqual([{ id: FIRST_OUTPUT, name: 'Projector 1', flipH: false, flipV: false }]);
    expect(s.panels.map((p) => [p.id, p.output, p.source])).toEqual([['p1', FIRST_OUTPUT, 'gen'], ['p2', FIRST_OUTPUT, 'fx:water']]);
    expect(s.panels[0].corners).toEqual(V2_LAYOUT.panels[0].corners);
    expect(s.panels[0].feather).toBe(0.05);
    expect(s.panels[1].label?.text).toBe('GLOW');
    expect(s.cues[0]).toEqual(V2_LAYOUT.cues[0]);
    expect(s.midi).toEqual(V2_LAYOUT.midi);
    expect([s.scene, s.selected, s.cycleBars, s.fadeBeats, s.master]).toEqual([6, 1, 16, 4, 0.9]);
  });

  it('round-trips a v3 layout, flips included', () => {
    const s = sanitize(V2_LAYOUT);
    const v3 = { ...s, outputs: [{ ...s.outputs[0], name: 'Backdrop', flipH: true }] };
    expect(sanitize(JSON.parse(JSON.stringify(v3)))).toEqual(v3);
  });

  it('moves a panel on a missing output to the first projector', () => {
    const s = sanitize({
      outputs: [{ id: 'back', name: 'Backdrop' }],
      panels: [{ corners: [[0, 0], [1, 0], [1, 1], [0, 1]], output: 'gone' }, { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], output: 'back' }],
    });
    expect(s.panels.map((p) => p.output)).toEqual(['back', 'back']);
  });

  it('gives a layout without panels default panels on its first output', () => {
    const s = sanitize({ outputs: [{ id: 'back' }] });
    expect(s.panels.length).toBe(3);
    expect(s.panels.every((p) => p.output === 'back')).toBe(true);
  });
});

describe('sanitizeOutputs', () => {
  it('falls back to one projector', () => {
    expect(sanitizeOutputs(undefined)).toHaveLength(1);
    expect(sanitizeOutputs([])).toHaveLength(1);
    expect(sanitizeOutputs('two')).toHaveLength(1);
    expect(sanitizeOutputs([null, 3])).toHaveLength(1);
  });

  it('makes ids unique and valid, names readable, and flips strict', () => {
    const o = sanitizeOutputs([
      { id: 'a', name: '  Backdrop  ', flipH: true, flipV: 'yes' },
      { id: 'a', name: '', flipV: true },
    ]);
    expect(o).toEqual([
      { id: 'a', name: 'Backdrop', flipH: true, flipV: false },
      { id: 'out2', name: 'Projector 2', flipH: false, flipV: true },
    ]);
    expect(sanitizeOutputs([{ id: 'bad id!' }])[0].id).toBe('out1');
  });

  it(`keeps at most ${MAX_OUTPUTS}`, () => {
    expect(sanitizeOutputs(Array.from({ length: 5 }, (_, i) => ({ id: `o${i}` })))).toHaveLength(MAX_OUTPUTS);
  });
});

describe('loadSettings', () => {
  const storage = (items: Record<string, string>) => ({ getItem: (k: string) => items[k] ?? null });

  it('prefers the v3 save and migrates an older one when there is none', () => {
    const v3 = JSON.stringify({ ...sanitize(V2_LAYOUT), scene: 2 });
    expect(loadSettings(storage({ [KEY]: v3, 'panelmapper.v2': JSON.stringify(V2_LAYOUT) })).scene).toBe(2);
    const migrated = loadSettings(storage({ 'panelmapper.v2': JSON.stringify(V2_LAYOUT) }));
    expect(migrated.version).toBe(3);
    expect(migrated.scene).toBe(6);
  });

  it('saves under a new key, leaving the v2 save for an older build', () => {
    expect(KEY).not.toBe('panelmapper.v2');
  });

  it('falls back to an older save when the newest one is unreadable', () => {
    expect(loadSettings(storage({ [KEY]: '{broken', 'panelmapper.v2': JSON.stringify(V2_LAYOUT) })).scene).toBe(6);
    expect(loadSettings(storage({})).panels).toHaveLength(3);
  });
});

describe('outputs and panels', () => {
  it('adds a new panel to the projector of the selected panel', () => {
    const base = sanitize({
      outputs: [{ id: 'back' }, { id: 'gator' }],
      panels: [{ corners: [[0, 0], [1, 0], [1, 1], [0, 1]], output: 'back' }, { corners: [[0, 0], [1, 0], [1, 1], [0, 1]], output: 'gator' }],
    });
    settings.set(base);
    selectPanel(1);
    addPanel();
    const s = settings.get();
    expect(s.panels[s.panels.length - 1].output).toBe('gator');
  });
});

describe('projector list', () => {
  const q = [[0, 0], [1, 0], [1, 1], [0, 1]];

  it('adds a second projector and no more', () => {
    settings.set(defaultSettings());
    const id = addOutput();
    expect(id).not.toBeNull();
    expect(settings.get().outputs.map((o) => o.name)).toEqual(['Projector 1', 'Projector 2']);
    expect(addOutput()).toBeNull();
    expect(settings.get().outputs).toHaveLength(MAX_OUTPUTS);
  });

  it('moves a removed projector’s panels to the first one, and undo brings them back', () => {
    settings.set(sanitize({ outputs: [{ id: 'back' }, { id: 'gator' }], panels: [{ corners: q, output: 'back' }, { corners: q, output: 'gator' }] }));
    removeOutput('gator');
    expect(settings.get().outputs.map((o) => o.id)).toEqual(['back']);
    expect(settings.get().panels.map((p) => p.output)).toEqual(['back', 'back']);
    // The projector itself stays removed, so the undone panel can't land on a missing one.
    undoMapping();
    expect(settings.get().panels.map((p) => p.output)).toEqual(['back', 'back']);
  });

  it('never removes the first projector', () => {
    settings.set(sanitize({ outputs: [{ id: 'back' }, { id: 'gator' }], panels: [{ corners: q, output: 'back' }] }));
    removeOutput('back');
    expect(settings.get().outputs.map((o) => o.id)).toEqual(['back', 'gator']);
  });

  it('moves a panel between projectors as an undoable mapping change', () => {
    settings.set(sanitize({ outputs: [{ id: 'back' }, { id: 'gator' }], panels: [{ corners: q, output: 'back' }] }));
    movePanelToOutput(0, 'gator');
    expect(settings.get().panels[0].output).toBe('gator');
    expect(settings.get().panels[0].corners).toEqual(q);
    undoMapping();
    expect(settings.get().panels[0].output).toBe('back');
    redoMapping();
    expect(settings.get().panels[0].output).toBe('gator');
    movePanelToOutput(0, 'nowhere');
    expect(settings.get().panels[0].output).toBe('gator');
  });
});

describe('layering', () => {
  const q = [[0, 0], [1, 0], [1, 1], [0, 1]];

  it('draws saves from before layering as before: normal and fully opaque', () => {
    const s = sanitize(V2_LAYOUT);
    expect(s.panels.every((p) => p.blend === 'over' && p.opacity === 1)).toBe(true);
  });

  it('keeps valid blend modes and clamps opacity', () => {
    const s = sanitize({
      panels: [
        { corners: q, blend: 'screen', opacity: 0.4 },
        { corners: q, blend: 'dodge', opacity: 7 },
        { corners: q, blend: 'multiply', opacity: -1 },
      ],
    });
    expect(s.panels.map((p) => [p.blend, p.opacity])).toEqual([['screen', 0.4], ['over', 1], ['multiply', 0]]);
  });

  const layout = () => sanitize({
    outputs: [{ id: 'back' }, { id: 'gator' }],
    panels: [
      { id: 'head', corners: q, output: 'gator' },
      { id: 'water', corners: q, output: 'back' },
      { id: 'eyeL', corners: q, output: 'gator' },
      { id: 'eyeR', corners: q, output: 'gator' },
    ],
  });

  it('finds the next layer on the same projector, skipping the other one', () => {
    const p = layout().panels;
    expect(layerTarget(p, 0, 1)).toBe(2);
    expect(layerTarget(p, 2, -1)).toBe(0);
    expect(layerTarget(p, 0, -1)).toBeNull();
    expect(layerTarget(p, 3, 1)).toBeNull();
    expect(layerTarget(p, 1, 1)).toBeNull();
    expect(layerTarget(p, 9, 1)).toBeNull();
  });

  it('swaps layers, keeps the panel selected, and undoes the move', () => {
    settings.set(layout());
    selectPanel(0);
    movePanelLayer(0, 1);
    const s = settings.get();
    expect(s.panels.map((p) => p.id)).toEqual(['eyeL', 'water', 'head', 'eyeR']);
    expect(s.selected).toBe(2);
    undoMapping();
    expect(settings.get().panels.map((p) => p.id)).toEqual(['head', 'water', 'eyeL', 'eyeR']);
  });

  it('does nothing at the top or bottom', () => {
    settings.set(layout());
    movePanelLayer(3, 1);
    movePanelLayer(1, -1);
    expect(settings.get().panels.map((p) => p.id)).toEqual(['head', 'water', 'eyeL', 'eyeR']);
  });
});

describe('panel masks', () => {
  const q = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
  const fresh = () => {
    settings.set(sanitize({ panels: [{ id: 'head', corners: q }] }));
    selectPanel(0);
  };

  it('keeps a mask through save and load, and drops a broken one', () => {
    const s = sanitize({
      panels: [
        { corners: q, mask: { points: [{ p: [0.2, 0.2] }, { p: [0.8, 0.2], smooth: true }, { p: [0.5, 0.8] }], feather: 0.02, invert: true } },
        { corners: q, mask: { points: [{ p: [0.2, 0.2] }] } },
      ],
    });
    expect(s.panels[0].mask).toEqual({ points: [{ p: [0.2, 0.2], smooth: false }, { p: [0.8, 0.2], smooth: true }, { p: [0.5, 0.8], smooth: false }], feather: 0.02, invert: true });
    expect(s.panels[1]).not.toHaveProperty('mask');
    expect(sanitize(JSON.parse(JSON.stringify(s))).panels[0].mask).toEqual(s.panels[0].mask);
  });

  it('adds an oval to start from, opens it for editing, and undo takes it away', () => {
    fresh();
    addMask(0);
    expect(settings.get().panels[0].mask!.points).toHaveLength(8);
    expect(runtime.get().maskEdit).toBe(true);
    undoMapping();
    expect(settings.get().panels[0]).not.toHaveProperty('mask');
    redoMapping();
    expect(settings.get().panels[0].mask).toBeDefined();
  });

  it('inserts, deletes and toggles points within limits, each undoable', () => {
    fresh();
    addMask(0);
    const n = settings.get().panels[0].mask!.points.length;
    const at = insertMaskPoint(0, [0.5, 0.05])!;
    expect(settings.get().panels[0].mask!.points).toHaveLength(n + 1);
    expect(settings.get().panels[0].mask!.points[at].p).toEqual([0.5, 0.05]);
    expect(runtime.get().selCorner).toEqual({ p: 0, c: -1, m: at });
    undoMapping();
    expect(settings.get().panels[0].mask!.points).toHaveLength(n);
    toggleMaskPoint(0, 0);
    expect(settings.get().panels[0].mask!.points[0].smooth).toBe(false);
    for (let k = 0; k < 10; k++) deleteMaskPoint(0, 0);
    expect(settings.get().panels[0].mask!.points).toHaveLength(3);
  });

  it('moves a point without touching the panel corners', () => {
    fresh();
    addMask(0);
    moveMaskPoint(0, 2, [0.33, 0.44]);
    expect(settings.get().panels[0].mask!.points[2].p).toEqual([0.33, 0.44]);
    expect(settings.get().panels[0].corners).toEqual(q);
  });

  it('is left alone by cues', () => {
    fresh();
    addMask(0);
    saveCue(0);
    moveMaskPoint(0, 0, [0.3, 0.3]);
    updateMask(0, { feather: 0.05 });
    recallCue(0);
    const m = settings.get().panels[0].mask!;
    expect(m.points[0].p).toEqual([0.3, 0.3]);
    expect(m.feather).toBe(0.05);
  });

  it('removes a mask, undoably', () => {
    fresh();
    addMask(0);
    removeMask(0);
    expect(settings.get().panels[0]).not.toHaveProperty('mask');
    undoMapping();
    expect(settings.get().panels[0].mask).toBeDefined();
  });
});

describe('mesh warp', () => {
  const q = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
  const fresh = () => { settings.set(sanitize({ panels: [{ id: 'eye', corners: q }] })); selectPanel(0); };

  it('starts a grid from the four-corner warp, and undo goes back to flat', () => {
    fresh();
    setMeshSize(0, 5);
    const m = settings.get().panels[0].mesh!;
    expect([m.cols, m.rows, m.pts.length]).toEqual([5, 5, 25]);
    expect(settings.get().panels[0].corners).toEqual([m.pts[0], m.pts[4], m.pts[24], m.pts[20]]);
    undoMapping();
    expect(settings.get().panels[0]).not.toHaveProperty('mesh');
  });

  it('keeps the corners on the grid when a corner point moves', () => {
    fresh();
    setMeshSize(0, 4);
    moveMeshPoint(0, 15, [0.95, 0.97]);
    expect(settings.get().panels[0].corners[2]).toEqual([0.95, 0.97]);
    moveMeshPoint(0, 5, [0.4, 0.3]);
    expect(settings.get().panels[0].corners[2]).toEqual([0.95, 0.97]);
  });

  it('resizes the grid keeping its corners, and drops it for the flat warp', () => {
    fresh();
    setMeshSize(0, 4);
    moveMeshPoint(0, 0, [0.05, 0.05]);
    setMeshSize(0, 6);
    expect(settings.get().panels[0].mesh!.pts).toHaveLength(36);
    expect(settings.get().panels[0].corners[0][0]).toBeCloseTo(0.05, 9);
    setMeshSize(0, 0);
    expect(settings.get().panels[0]).not.toHaveProperty('mesh');
    expect(settings.get().panels[0].corners[0][0]).toBeCloseTo(0.05, 9);
  });

  it('loads a saved mesh with corners taken from the grid', () => {
    const s = sanitize({ panels: [{ corners: [[0, 0], [1, 0], [1, 1], [0, 1]], mesh: { cols: 2, rows: 2, pts: [[0.1, 0.2], [0.8, 0.2], [0.1, 0.9], [0.8, 0.9]] } }] });
    expect(s.panels[0].corners).toEqual([[0.1, 0.2], [0.8, 0.2], [0.8, 0.9], [0.1, 0.9]]);
  });

  it('is left alone by cues', () => {
    fresh();
    setMeshSize(0, 3);
    saveCue(0);
    moveMeshPoint(0, 4, [0.6, 0.6]);
    recallCue(0);
    expect(settings.get().panels[0].mesh!.pts[4]).toEqual([0.6, 0.6]);
  });
});

describe('panel image inputs', () => {
  const q = [[0, 0], [1, 0], [1, 1], [0, 1]];

  it('keeps valid picks through save and load and drops junk', () => {
    const s = sanitize({ panels: [{ corners: q, source: 'fx:skin', inputs: { uHeight: 'img1', bad: 'x', uOther: 7, uTex: '../../etc' } }] });
    expect(s.panels[0].inputs).toEqual({ uHeight: 'img1' });
    expect(sanitize({ panels: [{ corners: q, inputs: { nope: 'x' } }] }).panels[0]).not.toHaveProperty('inputs');
    expect(sanitizeInputs(['uHeight', 'img1'])).toBeNull();
  });

  it('picks and clears an image for a sampler', () => {
    settings.set(sanitize({ panels: [{ corners: q, source: 'fx:skin' }] }));
    setPanelInput(0, 'uHeight', 'img1');
    expect(settings.get().panels[0].inputs).toEqual({ uHeight: 'img1' });
    setPanelInput(0, 'uHeight', '');
    expect(settings.get().panels[0]).not.toHaveProperty('inputs');
  });
});

describe('cues v2', () => {
  const q = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const fresh = () => {
    settings.set(sanitize({ panels: [{ id: 'eye', corners: q, source: 'fx:eye' }, { id: 'head', corners: q, source: 'fx:skin' }] }));
    params.set(defaultParams());
  };

  it('saves shader settings, blend, opacity and the fade time, but no geometry', () => {
    fresh();
    settings.set((s) => ({ cueFade: 12, panels: s.panels.map((p, i) => (i === 1 ? { ...p, blend: 'screen', opacity: 0.4 } : p)) }));
    setParam('eye', 'uPupilX', 0.7);
    saveCue(0);
    const c = settings.get().cues[0]!;
    expect(c.fadeSec).toBe(12);
    expect(c.params!.eye.uPupilX).toBe(0.7);
    expect(c.panels.head).toEqual({ source: 'fx:skin', band: 'none', blend: 'screen', opacity: 0.4 });
    expect(JSON.stringify(c)).not.toMatch(/corners|mesh|mask/);
  });

  it('recalls them all, and survives save and load', () => {
    fresh();
    setParam('eye', 'uOpen', 0.2);
    settings.set((s) => ({ panels: s.panels.map((p) => ({ ...p, opacity: 0.5, blend: 'add' })) }));
    saveCue(1);
    settings.set(sanitize(JSON.parse(JSON.stringify(settings.get()))));
    resetParams();
    settings.set((s) => ({ panels: s.panels.map((p) => ({ ...p, opacity: 1, blend: 'over' })) }));
    recallCue(1);
    expect(params.get().eye.uOpen).toBe(0.2);
    expect(settings.get().panels.map((p) => [p.blend, p.opacity])).toEqual([['add', 0.5], ['add', 0.5]]);
  });

  it('leaves shader settings, blend and opacity alone when recalling an older cue', () => {
    fresh();
    settings.set({ cues: [sanitizeLook({ scene: 2, panels: { eye: { source: 'fx:eye', band: 'none' } } }), ...settings.get().cues.slice(1)] });
    setParam('eye', 'uPupilX', -0.5);
    settings.set((s) => ({ panels: s.panels.map((p) => ({ ...p, opacity: 0.3 })) }));
    recallCue(0);
    expect(params.get().eye.uPupilX).toBe(-0.5);
    expect(settings.get().panels[0].opacity).toBe(0.3);
    expect(settings.get().scene).toBe(2);
  });

  it('tells the engine the fade time and the opacities before, and the fade time during the change', () => {
    fresh();
    settings.set({ cueFade: 8 });
    saveCue(2);
    settings.set((s) => ({ panels: s.panels.map((p) => ({ ...p, opacity: 0.25 })) }));
    let during: number | null = -1;
    const unsub = settings.subscribe(() => { during = cueFadeInProgress(); });
    const seen: CueRecall[] = [];
    const off = onCueRecall((r) => seen.push(r));
    recallCue(2);
    unsub(); off();
    expect(during).toBe(8);
    expect(cueFadeInProgress()).toBeNull();
    expect(seen).toEqual([{ fadeSec: 8, prevOpacity: { eye: 0.25, head: 0.25 } }]);
  });

  it('validates cue fade times, blends, opacities and shader settings', () => {
    const c = sanitizeLook({
      scene: 0, fadeSec: 500,
      panels: { a: { source: 'gen', band: 'bass', blend: 'dodge', opacity: 3 } },
      params: { eye: { uPupilX: 9, uNope: 1 }, retired: { uA: 1 } },
    })!;
    expect(c.fadeSec).toBe(60);
    expect(c.panels.a).toEqual({ source: 'gen', band: 'bass', opacity: 1 });
    expect(c.params).toEqual({ eye: { uPupilX: 1 } });
    expect(sanitize({ cueFade: 7 }).cueFade).toBe(3);
    expect(sanitize({ cueFade: 20 }).cueFade).toBe(20);
  });
});

describe('cue transitions', () => {
  it('saves the current transition with a cue and hands it to the engine during recall', () => {
    settings.set(sanitize({ transition: 'ripple' }));
    saveCue(3);
    expect(settings.get().cues[3]!.transition).toBe('ripple');
    settings.set({ transition: 'fade', scene: 5 });
    let during: string | null = null;
    const unsub = settings.subscribe(() => { during = cueTransitionInProgress(); });
    recallCue(3);
    unsub();
    expect(during).toBe('ripple');
    expect(cueTransitionInProgress()).toBeNull();
  });

  it('validates transitions in settings and cues', () => {
    expect(sanitize({ transition: 'warp' }).transition).toBe('fade');
    expect(sanitize({ transition: 'black' }).transition).toBe('black');
    expect(sanitizeLook({ scene: 0, transition: 'sparkle' })!.transition).toBe('sparkle');
    expect(sanitizeLook({ scene: 0, transition: 'warp' })).not.toHaveProperty('transition');
  });
});
