import { SPLIT_DRIVES, type SplitDrive } from './effects';
import { isFxSource } from './fx';
import { MapHistory } from './history';
import { defaultMask, insertIndex, MAX_MASK_POINTS, MIN_MASK_POINTS, sanitizeMask } from './mask';
import { MAX_MESH, meshCorners, meshFromQuad, MIN_MESH, resampleMesh, sanitizeMesh } from './mesh';
import { Store } from './observable';
import { params, sanitizeParamSnapshot, type ParamValues } from './params';
import { BAR_CHOICES, BEATS_PER_BAR, CUE_FADE_CHOICES, FADE_CHOICES, MAX_CUE_FADE_SEC } from './transitions';
import { defaultLabel, MAX_LABEL_CHARS } from './text';
import {
  BANDS, BLEND_MODES, CUE_COUNT, MAX_OUTPUTS, SCENES, TRANSITIONS,
  type Band, type BlendMode, type Look, type LookPanel, type Mask, type OutputConfig, type Panel, type PanelLabel, type Pt, type Quad, type Runtime,
  type Settings, type TransitionMode,
} from './types';

// The store class lives on its own so the shader settings module can use it without importing this one.
export { Store } from './observable';

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * Each settings version saves under its own key and reads the older ones as a fallback, so going
 * back to an older build (a cached install, say) finds its own last save untouched.
 */
export const KEY = 'panelmapper.v3';
export const OLD_KEYS = ['panelmapper.v2', 'panelmapper.v1'];
const BAND_IDS = BANDS.map(([b]) => b);
const BLEND_IDS = BLEND_MODES.map(([b]) => b);

/** The first projector's id in a fresh or migrated layout. */
export const FIRST_OUTPUT = 'out1';

export function defaultOutputs(): OutputConfig[] {
  return [{ id: FIRST_OUTPUT, name: 'Projector 1', flipH: false, flipV: false }];
}

export function defaultPanels(output = FIRST_OUTPUT): Panel[] {
  return [0, 1, 2].map((i) => {
    const x0 = 0.08 + i * 0.3, x1 = x0 + 0.24;
    return {
      id: uid(),
      output,
      corners: [[x0, 0.2], [x1, 0.2], [x1, 0.8], [x0, 0.8]] as Quad,
      source: 'gen',
      band: (['bass', 'mid', 'high'] as Band[])[i],
      feather: 0,
      blend: 'over',
      opacity: 1,
    };
  });
}

export function defaultSettings(): Settings {
  return {
    version: 3,
    outputs: defaultOutputs(),
    panels: defaultPanels(),
    selected: 0,
    scene: 0,
    autoCycle: false,
    cycleBars: 8,
    fadeBeats: 2,
    cueFade: 3,
    transition: 'fade',
    c1: '#ffffff',
    c2: '#ff3355',
    react: 0.7,
    strobe: false,
    rgbSplit: 0,
    rgbDrive: 'kick',
    span: false,
    testGrid: false,
    loupe: true,
    autoBpm: false,
    bpm: 126,
    gain: 1.5,
    sens: 1.45,
    master: 1,
    cues: Array.from({ length: CUE_COUNT }, () => null),
    midi: {},
    audioDevice: '',
  };
}

const num = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : dflt;
const hex = (v: unknown, dflt: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : dflt);

/** The allowed value equal to v, or the fallback. */
const pick = (allowed: readonly number[], v: unknown, dflt: number) =>
  typeof v === 'number' && allowed.includes(v) ? v : dflt;

/** Converts the old "every N seconds" setting to the nearest bar count at the saved tempo. */
function barsFromSeconds(sec: unknown, bpm: unknown): number | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return null;
  const tempo = typeof bpm === 'number' && bpm >= 60 && bpm <= 200 ? bpm : 126;
  const bars = (sec * tempo) / 60 / BEATS_PER_BAR;
  return BAR_CHOICES.reduce((a, b) => (Math.abs(b - bars) < Math.abs(a - bars) ? b : a));
}

function validQuad(q: unknown): q is Quad {
  return Array.isArray(q) && q.length === 4 &&
    q.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)));
}

/** A valid panel label, or null when there's no text to show. */
export function sanitizeLabel(v: unknown): PanelLabel | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, MAX_LABEL_CHARS) : '';
  if (!text) return null;
  const d = defaultLabel();
  return {
    text,
    rotation: num(o.rotation, -180, 180, d.rotation),
    size: num(o.size, 0.05, 1, d.size),
    color: hex(o.color, d.color),
    pulse: o.pulse === true,
  };
}

/** 'gen', a library video, or a panel shader this build has. An unknown shader falls back to 'gen'. */
const validTransition = (v: unknown): v is TransitionMode => TRANSITIONS.some(([m]) => m === v);

const validSource = (v: unknown): v is string =>
  typeof v === 'string' && (v === 'gen' || v.startsWith('vid:') || v.startsWith('img:') || isFxSource(v));
const validBand = (v: unknown): v is Band => BAND_IDS.includes(v as Band);

/**
 * A valid cue, or null when it can't be recalled safely. A cue goes into the render loop as is,
 * so a missing colour or scene here would stop the wall; bad fields fall back instead.
 */
export function sanitizeLook(v: unknown): Look | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.scene !== 'number' || !Number.isFinite(o.scene)) return null;
  const d = defaultSettings();
  const panelsIn = o.panels && typeof o.panels === 'object' ? (o.panels as Record<string, unknown>) : {};
  const panels: Look['panels'] = {};
  for (const [id, p] of Object.entries(panelsIn)) {
    if (!p || typeof p !== 'object') continue;
    const { source, band, blend, opacity } = p as Record<string, unknown>;
    if (!validSource(source) || !validBand(band)) continue;
    const lp: LookPanel = { source, band };
    if (BLEND_IDS.includes(blend as BlendMode)) lp.blend = blend as BlendMode;
    if (typeof opacity === 'number' && Number.isFinite(opacity)) lp.opacity = clamp(opacity, 0, 1);
    panels[id] = lp;
  }
  const look: Look = {
    scene: Math.round(clamp(o.scene, 0, SCENES.length - 1)),
    c1: hex(o.c1, d.c1),
    c2: hex(o.c2, d.c2),
    react: num(o.react, 0, 1, d.react),
    strobe: o.strobe === true,
    span: o.span === true,
    panels,
  };
  // Missing in cues saved before the RGB split existed; recall then leaves it as it is.
  if (o.rgbSplit !== undefined) look.rgbSplit = num(o.rgbSplit, 0, 1, d.rgbSplit);
  if (SPLIT_DRIVES.some(([dv]) => dv === o.rgbDrive)) look.rgbDrive = o.rgbDrive as SplitDrive;
  const ps = sanitizeParamSnapshot(o.params);
  if (ps) look.params = ps;
  if (typeof o.fadeSec === 'number' && Number.isFinite(o.fadeSec)) look.fadeSec = clamp(o.fadeSec, 0, MAX_CUE_FADE_SEC);
  if (validTransition(o.transition)) look.transition = o.transition;
  return look;
}

const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Keeps only well-formed MIDI bindings. Unknown action ids are kept, so bindings survive actions added later. */
export function sanitizeMidi(v: unknown): Settings['midi'] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Settings['midi'] = {};
  for (const [id, b] of Object.entries(v as Record<string, unknown>)) {
    if (!id || !b || typeof b !== 'object') continue;
    const { kind, channel, num: n } = b as Record<string, unknown>;
    if ((kind === 'note' || kind === 'cc') && int(channel, 0, 15) && int(n, 0, 127)) {
      out[id] = { kind, channel: channel as number, num: n as number };
    }
  }
  return out;
}

/**
 * Valid outputs: at least one, at most MAX_OUTPUTS, unique ids. Layouts from before outputs
 * existed get a single unflipped projector, which is what they always drew to.
 */
export function sanitizeOutputs(v: unknown): OutputConfig[] {
  const out: OutputConfig[] = [];
  const list = Array.isArray(v) ? v : [];
  for (const o of list) {
    if (out.length >= MAX_OUTPUTS) break;
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    let id = typeof r.id === 'string' && /^[\w-]{1,32}$/.test(r.id) ? r.id : '';
    for (let n = out.length + 1; !id || out.some((x) => x.id === id); n++) id = `out${n}`;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : `Projector ${out.length + 1}`;
    out.push({ id, name, flipH: r.flipH === true, flipV: r.flipV === true });
  }
  return out.length ? out : defaultOutputs();
}

/** Image picks for a panel shader: sampler names to image ids. Null when there are none. */
export function sanitizeInputs(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, id] of Object.entries(v as Record<string, unknown>)) {
    if (/^u[A-Z]\w{0,31}$/.test(k) && typeof id === 'string' && /^[\w-]{1,64}$/.test(id)) out[k] = id;
  }
  return Object.keys(out).length ? out : null;
}

/** Picks the library image a panel shader's sampler reads, or clears it with ''. */
export function setPanelInput(i: number, name: string, imageId: string) {
  settings.set((s) => ({
    panels: s.panels.map((p, j) => {
      if (j !== i) return p;
      const inputs = { ...(p.inputs ?? {}) };
      if (imageId) inputs[name] = imageId; else delete inputs[name];
      const { inputs: _old, ...rest } = p;
      return Object.keys(inputs).length ? { ...rest, inputs } : rest;
    }),
  }));
}

/** Accepts anything (saved state, imported file, v1 or v2 layout) and returns valid v3 settings. */
export function sanitize(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as Record<string, unknown>;
  const outputs = sanitizeOutputs(o.outputs);
  const outputIds = new Set(outputs.map((x) => x.id));
  const panelsIn = Array.isArray(o.panels) ? o.panels : [];
  const panels: Panel[] = panelsIn
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .filter((p) => validQuad(p.corners))
    .slice(0, 12)
    .map((p) => {
      const src = validSource(p.source) ? p.source : 'gen';
      const band = validBand(p.band) ? p.band : 'none';
      const panel: Panel = {
        id: typeof p.id === 'string' && p.id ? p.id : uid(),
        // Panels from before outputs existed, or on an output that's gone, land on the first projector.
        output: typeof p.output === 'string' && outputIds.has(p.output) ? p.output : outputs[0].id,
        corners: (p.corners as Quad).map(([x, y]) => [clamp(x, -0.25, 1.25), clamp(y, -0.25, 1.25)]) as Quad,
        source: src,
        band,
        feather: num(p.feather, 0, 0.25, 0),
        // Saves from before layering draw as they always did: normal and fully opaque.
        blend: BLEND_IDS.includes(p.blend as BlendMode) ? (p.blend as BlendMode) : 'over',
        opacity: num(p.opacity, 0, 1, 1),
      };
      const label = sanitizeLabel(p.label);
      const inputs = sanitizeInputs(p.inputs);
      if (inputs) panel.inputs = inputs;
      const mask = sanitizeMask(p.mask);
      const mesh = sanitizeMesh(p.mesh);
      // With a mesh, the corners are the grid's, whatever was saved beside it.
      if (mesh) panel.corners = meshCorners(mesh);
      return { ...panel, ...(mesh ? { mesh } : {}), ...(mask ? { mask } : {}), ...(label ? { label } : {}) };
    });
  const cuesIn = Array.isArray(o.cues) ? o.cues : [];
  const s: Settings = {
    version: 3,
    outputs,
    panels: panels.length ? panels : defaultPanels(outputs[0].id),
    selected: 0,
    scene: Math.round(num(o.scene, 0, SCENES.length - 1, 0)),
    autoCycle: o.autoCycle === true,
    cycleBars: pick(BAR_CHOICES, o.cycleBars, barsFromSeconds(o.cycleSec, o.bpm) ?? d.cycleBars),
    fadeBeats: pick(FADE_CHOICES, o.fadeBeats, d.fadeBeats),
    cueFade: pick(CUE_FADE_CHOICES, o.cueFade, d.cueFade),
    transition: validTransition(o.transition) ? o.transition : d.transition,
    c1: hex(o.c1, d.c1),
    c2: hex(o.c2, d.c2),
    react: num(o.react, 0, 1, d.react),
    strobe: o.strobe === true,
    rgbSplit: num(o.rgbSplit, 0, 1, d.rgbSplit),
    rgbDrive: SPLIT_DRIVES.some(([v]) => v === o.rgbDrive) ? (o.rgbDrive as SplitDrive) : d.rgbDrive,
    span: o.span === true,
    testGrid: o.testGrid === true,
    loupe: o.loupe !== false,
    autoBpm: o.autoBpm === true,
    bpm: num(o.bpm, 60, 200, d.bpm),
    gain: num(o.gain, 0.2, 6, d.gain),
    sens: num(o.sens, 1.1, 2.5, d.sens),
    master: num(o.master, 0, 1, 1),
    cues: Array.from({ length: CUE_COUNT }, (_, i) => sanitizeLook(cuesIn[i])),
    midi: sanitizeMidi(o.midi),
    audioDevice: typeof o.audioDevice === 'string' ? o.audioDevice : '',
  };
  s.selected = Math.round(num(o.selected, 0, s.panels.length - 1, 0));
  return s;
}

/** The newest save there is, migrated to the current version; defaults when there's none or it won't parse. */
export function loadSettings(storage: Pick<Storage, 'getItem'>): Settings {
  for (const key of [KEY, ...OLD_KEYS]) {
    try {
      const raw = storage.getItem(key);
      if (raw) return sanitize(JSON.parse(raw));
    } catch { /* unreadable: try an older save */ }
  }
  return defaultSettings();
}

export const settings = new Store<Settings>(typeof window === 'undefined' ? defaultSettings() : loadSettings(localStorage));

export const runtime = new Store<Runtime>({
  showMode: false,
  blackout: false,
  flashHold: false,
  outputOpen: false,
  openOutputs: [],
  previewOutput: '',
  wallDots: false,
  hideUi: false,
  audioOn: false,
  audioState: 'off',
  audioMsg: '',
  trackName: '',
  trackPlaying: false,
  outMsg: '',
  midiOn: false,
  midiMsg: '',
  midiLearn: null,
  cueSaveMode: false,
  videos: [],
  images: [],
  imageMsg: '',
  offlineReady: false,
  wakeLock: false,
  storageMsg: '',
  libraryMsg: '',
  devices: [],
  selCorner: null,
  maskEdit: false,
  canUndo: false,
  canRedo: false,
});

if (typeof window !== 'undefined') {
  let t: ReturnType<typeof setTimeout> | undefined;
  settings.subscribe(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(settings.get())); } catch { /* storage full or blocked */ }
    }, 250);
  });
}

/* ---------- mapping undo ---------- */

export const history = new MapHistory();

const syncHistory = () => runtime.set({ canUndo: history.canUndo, canRedo: history.canRedo });

/** Call just before a mapping edit. A key merges a burst of edits (such as nudges) into one step. */
export function recordMapping(key = '') {
  history.push(settings.get().panels, key);
  syncHistory();
}

function applyHistory(restored: Panel[] | null) {
  if (!restored) return;
  // A panel whose projector has since been removed comes back on the first one.
  const ids = new Set(settings.get().outputs.map((o) => o.id));
  const first = settings.get().outputs[0].id;
  const panels = restored.map((p) => (ids.has(p.output) ? p : { ...p, output: first }));
  settings.set((s) => ({ panels, selected: clamp(s.selected, 0, panels.length - 1) }));
  runtime.set({ selCorner: null });
  syncHistory();
}

export function undoMapping() { applyHistory(history.undo(settings.get().panels)); }
export function redoMapping() { applyHistory(history.redo(settings.get().panels)); }

/* ---------- actions ---------- */

/** The output the projector window shows. One window for now; a second comes with multi-projector support. */
export function mainOutput(s: Settings): OutputConfig { return s.outputs[0]; }

export function updateOutput(id: string, patch: Partial<Omit<OutputConfig, 'id'>>) {
  settings.set((s) => ({ outputs: s.outputs.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
}

/** Adds a projector, up to MAX_OUTPUTS. Returns its id, or null when there's no room. */
export function addOutput(): string | null {
  const s = settings.get();
  if (s.outputs.length >= MAX_OUTPUTS) return null;
  let n = s.outputs.length + 1;
  while (s.outputs.some((o) => o.id === `out${n}`)) n++;
  const o: OutputConfig = { id: `out${n}`, name: `Projector ${s.outputs.length + 1}`, flipH: false, flipV: false };
  settings.set({ outputs: [...s.outputs, o] });
  return o.id;
}

/** Removes a projector other than the first. Its panels move to the first one, so no mapping is lost. */
export function removeOutput(id: string) {
  const s = settings.get();
  if (s.outputs.length <= 1 || s.outputs[0].id === id || !s.outputs.some((o) => o.id === id)) return;
  recordMapping();
  const first = s.outputs[0].id;
  settings.set({
    outputs: s.outputs.filter((o) => o.id !== id),
    panels: s.panels.map((p) => (p.output === id ? { ...p, output: first } : p)),
  });
}

/** Moves a panel to another projector, keeping its corners where they are on the stage. Undoable. */
export function movePanelToOutput(i: number, id: string) {
  const s = settings.get();
  if (!s.panels[i] || s.panels[i].output === id || !s.outputs.some((o) => o.id === id)) return;
  recordMapping();
  updatePanel(i, { output: id });
  runtime.set({ selCorner: null });
}

export function setScene(i: number) { settings.set({ scene: clamp(Math.round(i), 0, SCENES.length - 1) }); }

export function selectPanel(i: number) {
  settings.set({ selected: i });
  runtime.set({ selCorner: null });
}

export function updatePanel(i: number, patch: Partial<Panel>) {
  settings.set((s) => ({ panels: s.panels.map((p, j) => (j === i ? { ...p, ...patch } : p)) }));
}

export function addPanel() {
  if (settings.get().panels.length < 12) recordMapping();
  settings.set((s) => {
    if (s.panels.length >= 12) return {};
    const o = 0.03 * (s.panels.length % 6);
    const p: Panel = {
      id: uid(),
      // On the same projector as the panel being worked on.
      output: s.panels[s.selected]?.output ?? s.outputs[0].id,
      corners: [[0.38 + o, 0.3 + o], [0.62 + o, 0.3 + o], [0.62 + o, 0.7 + o], [0.38 + o, 0.7 + o]],
      source: 'gen',
      band: BAND_IDS[s.panels.length % 3],
      feather: 0,
      blend: 'over',
      opacity: 1,
    };
    return { panels: [...s.panels, p], selected: s.panels.length };
  });
  runtime.set({ selCorner: null });
}

export function deletePanel(i: number) {
  if (settings.get().panels.length > 1) recordMapping();
  settings.set((s) => {
    if (s.panels.length <= 1) return {};
    const panels = s.panels.filter((_, j) => j !== i);
    return { panels, selected: clamp(s.selected, 0, panels.length - 1) };
  });
  runtime.set({ selCorner: null });
}

/**
 * The index a panel would move to one layer forward (+1, towards the top) or back (−1) among the
 * panels on its projector, or null when it's already at that end. Panels on other projectors
 * don't count: layer order only matters within one projector's picture.
 */
export function layerTarget(panels: Panel[], i: number, dir: 1 | -1): number | null {
  const p = panels[i];
  if (!p) return null;
  for (let j = i + dir; j >= 0 && j < panels.length; j += dir) {
    if (panels[j].output === p.output) return j;
  }
  return null;
}

/** Swaps a panel with its neighbour in the layer order on its projector. Undoable; renumbers both. */
export function movePanelLayer(i: number, dir: 1 | -1) {
  const j = layerTarget(settings.get().panels, i, dir);
  if (j === null) return;
  recordMapping();
  settings.set((s) => {
    const panels = [...s.panels];
    [panels[i], panels[j]] = [panels[j], panels[i]];
    return { panels, selected: j };
  });
  runtime.set({ selCorner: null });
}

/* ---------- mesh warp ---------- */

/**
 * Sets a panel's warp: a size × size grid, or 0 for the flat four-corner warp. A new grid starts
 * from the current warp, and a new size resamples the current curve, so nothing jumps. Undoable.
 */
export function setMeshSize(i: number, size: number) {
  const p = settings.get().panels[i];
  if (!p) return;
  const cur = p.mesh;
  if (size === 0) {
    if (!cur) return;
    recordMapping();
    settings.set((s) => ({ panels: s.panels.map((q, j) => { if (j !== i) return q; const { mesh: _m, ...rest } = q; return rest; }) }));
  } else {
    const n = Math.round(clamp(size, MIN_MESH, MAX_MESH));
    if (cur && cur.cols === n && cur.rows === n) return;
    recordMapping();
    const mesh = cur ? resampleMesh(cur, n, n) : meshFromQuad(p.corners, n, n);
    updatePanel(i, { mesh, corners: meshCorners(mesh) });
  }
  runtime.set({ selCorner: null });
}

/** Moves one grid point, keeping the panel's corners on the grid's. The caller records the undo step. */
export function moveMeshPoint(i: number, k: number, pt: Pt) {
  settings.set((s) => ({
    panels: s.panels.map((p, j) => {
      if (j !== i || !p.mesh || !p.mesh.pts[k]) return p;
      const mesh = { ...p.mesh, pts: p.mesh.pts.map((q, n) => (n === k ? pt : q)) };
      return { ...p, mesh, corners: meshCorners(mesh) };
    }),
  }));
}

/* ---------- masks ---------- */

const setMask = (i: number, fn: (m: Mask) => Mask | undefined) =>
  settings.set((s) => ({ panels: s.panels.map((p, j) => (j === i && p.mask ? { ...p, mask: fn(p.mask) } : p)) }));

/** Gives a panel an oval mask inside it to start from, and shows its points. Undoable. */
export function addMask(i: number) {
  const p = settings.get().panels[i];
  if (!p || p.mask) return;
  recordMapping();
  updatePanel(i, { mask: defaultMask(p.corners) });
  runtime.set({ maskEdit: true, selCorner: null });
}

/** Replaces (or gives) a panel's mask with one traced from a picture. Undoable; keeps feather and invert if it had a mask. */
export function setTracedMask(i: number, traced: Mask) {
  const p = settings.get().panels[i];
  if (!p) return;
  recordMapping();
  updatePanel(i, { mask: p.mask ? { ...traced, feather: p.mask.feather, invert: p.mask.invert } : traced });
  runtime.set({ maskEdit: true, selCorner: null });
}

/** Uses a baked picture (see bakeMaskImage) as the panel's mask. Undoable; keeps feather and invert if it had a mask. */
export function setImageMask(i: number, image: string) {
  const p = settings.get().panels[i];
  if (!p) return;
  const mask = sanitizeMask({ image, feather: p.mask?.feather ?? 0.003, invert: p.mask?.invert });
  if (!mask) return;
  recordMapping();
  updatePanel(i, { mask });
  runtime.set({ maskEdit: false, selCorner: null });
}

export function removeMask(i: number) {
  const p = settings.get().panels[i];
  if (!p?.mask) return;
  recordMapping();
  settings.set((s) => ({ panels: s.panels.map((q, j) => { if (j !== i) return q; const { mask: _m, ...rest } = q; return rest; }) }));
  runtime.set({ selCorner: null });
}

/** Changes feather or invert. Not an undo step on its own, like the other panel settings. */
export function updateMask(i: number, patch: Partial<Pick<Mask, 'feather' | 'invert'>>) {
  setMask(i, (m) => ({ ...m, ...patch }));
}

/** Moves one mask point. The caller records the undo step (once per drag, merged per nudge burst). */
export function moveMaskPoint(i: number, k: number, p: Pt) {
  setMask(i, (m) => ({ ...m, points: m.points.map((mp, j) => (j === k ? { ...mp, p } : mp)) }));
}

/** Adds a point where the outline was clicked, between the two points around it. Returns its index. */
export function insertMaskPoint(i: number, p: Pt, aspect = 1): number | null {
  const m = settings.get().panels[i]?.mask;
  if (!m || m.points.length >= MAX_MASK_POINTS) return null;
  const at = insertIndex(m.points, p, aspect);
  // A new point takes the look of the one before it, so a curve stays a curve.
  const smooth = m.points[at - 1]?.smooth ?? true;
  recordMapping();
  setMask(i, (mm) => ({ ...mm, points: [...mm.points.slice(0, at), { p, smooth }, ...mm.points.slice(at)] }));
  runtime.set({ selCorner: { p: i, c: -1, m: at } });
  return at;
}

export function deleteMaskPoint(i: number, k: number) {
  const m = settings.get().panels[i]?.mask;
  if (!m || m.points.length <= MIN_MASK_POINTS) return;
  recordMapping();
  setMask(i, (mm) => ({ ...mm, points: mm.points.filter((_, j) => j !== k) }));
  runtime.set({ selCorner: null });
}

/** Switches a point between a smooth curve and a sharp corner. */
export function toggleMaskPoint(i: number, k: number) {
  if (!settings.get().panels[i]?.mask?.points[k]) return;
  recordMapping();
  setMask(i, (m) => ({ ...m, points: m.points.map((mp, j) => (j === k ? { ...mp, smooth: !mp.smooth } : mp)) }));
}

/** Makes every point of the mask smooth or a corner. */
export function setMaskSmooth(i: number, smooth: boolean) {
  if (!settings.get().panels[i]?.mask) return;
  recordMapping();
  setMask(i, (m) => ({ ...m, points: m.points.map((mp) => ({ ...mp, smooth })) }));
}

/** The look on the wall now: everything a cue brings back. Geometry is left out, so cues never move the mapping. */
export function captureLook(s: Settings, values: ParamValues = params.get()): Look {
  return {
    scene: s.scene, c1: s.c1, c2: s.c2, react: s.react, strobe: s.strobe, span: s.span,
    rgbSplit: s.rgbSplit, rgbDrive: s.rgbDrive,
    panels: Object.fromEntries(s.panels.map((p) => [p.id, { source: p.source, band: p.band, blend: p.blend, opacity: p.opacity }])),
    params: JSON.parse(JSON.stringify(values)),
    fadeSec: s.cueFade,
    transition: s.transition,
  };
}

export function saveCue(i: number) {
  settings.set((s) => ({ cues: s.cues.map((c, j) => (j === i ? captureLook(s) : c)) }));
}

/** What a cue recall changed, for the engine to fade: the fade length and each panel's opacity before. */
export interface CueRecall { fadeSec: number | null; prevOpacity: Record<string, number>; }

const recallListeners = new Set<(r: CueRecall) => void>();
/** Called after every cue recall, once its values are set. */
export function onCueRecall(fn: (r: CueRecall) => void) {
  recallListeners.add(fn);
  return () => { recallListeners.delete(fn); };
}

/** Set only while a cue is being recalled, so the crossfade it starts can use the cue's own length. */
let recallFadeSec: number | null = null;
/** The fade length of the cue being recalled right now, or null outside a recall (or for an older cue). */
export const cueFadeInProgress = () => recallFadeSec;
let recallTransition: TransitionMode | null = null;
/** The transition of the cue being recalled right now, or null outside a recall (or for an older cue). */
export const cueTransitionInProgress = () => recallTransition;

export function clearCue(i: number) {
  settings.set((s) => ({ cues: s.cues.map((c, j) => (j === i ? null : c)) }));
}

export function recallCue(i: number) {
  const look = settings.get().cues[i];
  if (!look) return;
  const prevOpacity = Object.fromEntries(settings.get().panels.map((p) => [p.id, p.opacity]));
  recallFadeSec = look.fadeSec ?? null;
  recallTransition = look.transition ?? null;
  try {
    settings.set((s) => ({
      scene: look.scene, c1: look.c1, c2: look.c2, react: look.react, strobe: look.strobe, span: look.span,
      rgbSplit: look.rgbSplit ?? s.rgbSplit, rgbDrive: look.rgbDrive ?? s.rgbDrive,
      panels: s.panels.map((p) => (look.panels[p.id] ? { ...p, ...look.panels[p.id] } : p)),
    }));
  } finally {
    recallFadeSec = null;
    recallTransition = null;
  }
  if (look.params) {
    const lp = look.params;
    params.set((cur) => Object.fromEntries(Object.entries(cur).map(([fx, v]) => [fx, lp[fx] ? { ...v, ...lp[fx] } : v])));
  }
  const info: CueRecall = { fadeSec: look.fadeSec ?? null, prevOpacity };
  recallListeners.forEach((fn) => fn(info));
}
