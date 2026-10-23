import { allActions, type ParamValues } from './params';
import { SCENES, type Pt, type Quad, type Settings } from './types';

/**
 * Remote control protocol. The Mac running the projectors is the host and the only place
 * anything renders; a phone or tablet is a remote that sends actions (the same ids MIDI
 * learns, see allActions) and shows the state the host reports back.
 */

export const REMOTE_VERSION = 1;

/** Remote → host: run an action. Faders carry a value from 0 to 1. */
export interface ActionMsg { t: 'act'; id: string; v?: number }
/** Remote → host: I just connected, send the state. */
export interface HelloMsg { t: 'hello' }

/** What a remote may do. 'edit' adds mapping; 'view' only watches. Set on the Mac and reported in the state. */
export type Lock = 'view' | 'control' | 'edit';
export const LOCKS: Lock[] = ['view', 'control', 'edit'];

/** A mapping handle: a flat panel's corner (c), a mask point (m) or a mesh grid point (g). */
export type HandleKind = 'c' | 'm' | 'g';
export const MAX_PANELS = 12;
export const MAX_HANDLES = 64;

/** Remote → host: put one handle at an absolute stage position. `b` marks the first of a drag (one undo step). */
export interface PtMsg { t: 'pt'; p: number; h: HandleKind; i: number; x: number; y: number; b?: boolean }
/** Remote → host: move a whole panel (with its mask and mesh) by this much from where it was at `b`. */
export interface PanMsg { t: 'pan'; p: number; dx: number; dy: number; b?: boolean }
export interface SelMsg { t: 'sel'; p: number }
export type HistMsg = { t: 'undo' } | { t: 'redo' };
/** Remote → host: add a panel on the selected panel's projector. */
export interface AddPanelMsg { t: 'padd' }
/** Remote → host: delete a panel. By id, so a list that changed under the phone can't delete the wrong one. */
export interface DelPanelMsg { t: 'pdel'; id: string }
/** Remote → host: add a mask point on the outline nearest this stage position. */
export interface MaskAddMsg { t: 'madd'; p: number; x: number; y: number }
/** Remote → host: delete a mask point. */
export interface MaskDelMsg { t: 'mdel'; p: number; i: number }
/** Remote → host: switch a mask point between a smooth curve and a sharp corner. */
export interface MaskToggleMsg { t: 'mtog'; p: number; i: number }
export type EditMsg = PtMsg | PanMsg | SelMsg | HistMsg | AddPanelMsg | DelPanelMsg | MaskAddMsg | MaskDelMsg | MaskToggleMsg;
export type ToHost = ActionMsg | HelloMsg | EditMsg;

/** What the host reports so a remote can show what's live. Panels and mapping aren't in it yet. */
export interface RemoteSnapshot {
  v: number;
  scene: number;
  blackout: boolean;
  bpm: number;
  master: number;
  react: number;
  rgb: number;
  /** Scene name per cue slot, or null for an empty slot. */
  cues: (string | null)[];
  params: ParamValues;
  lock: Lock;
}
/** Host → remote: the current state, sent on change and every few seconds as a heartbeat. */
export interface StateMsg { t: 'state'; s: RemoteSnapshot }

/** A panel's shape as the audience sees it, in stage fractions. Same fields the edit helpers move. */
export interface GeoPanel {
  /** The panel's id, so a delete names the panel rather than a position that may have changed. */
  id?: string;
  output: string;
  corners: Quad;
  mesh?: { cols: number; rows: number; pts: Pt[] };
  mask?: { points: { p: Pt; smooth: boolean }[]; invert: boolean };
}
export interface RemoteGeo {
  selected: number;
  outputs: { id: string; name: string; /** Projector picture size in pixels, for pixel-sized nudges. */ size: [number, number] }[];
  panels: GeoPanel[];
  canUndo: boolean;
  canRedo: boolean;
}
/** Host → remote: the mapping, sent when it changes. */
export interface GeoMsg { t: 'geo'; g: RemoteGeo }
export type ToRemote = StateMsg | GeoMsg;

export type RemoteMsg = ToHost | ToRemote;

/** No state from the host for this long and a remote shows it as offline. */
export const HEARTBEAT_MS = 3000;
export const OFFLINE_AFTER_MS = 8000;

/** The most often a fader's value is sent while it's being dragged. */
export const FADER_SEND_MS = 33;

/**
 * Checks a message from the network. Anything that isn't a known action with a finite number
 * is dropped: the channel is reachable by anyone who has the session code.
 */
export function parseToHost(raw: unknown): ToHost | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.t === 'hello') return { t: 'hello' };
  if (m.t === 'undo') return { t: 'undo' };
  if (m.t === 'redo') return { t: 'redo' };
  const idx = (x: unknown, max: number) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < max ? x : -1);
  const fin = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (m.t === 'sel') { const p = idx(m.p, MAX_PANELS); return p < 0 ? null : { t: 'sel', p }; }
  if (m.t === 'padd') return { t: 'padd' };
  if (m.t === 'pdel') return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 64 ? { t: 'pdel', id: m.id } : null;
  if (m.t === 'madd') {
    const p = idx(m.p, MAX_PANELS);
    return p < 0 || !fin(m.x) || !fin(m.y) ? null : { t: 'madd', p, x: m.x as number, y: m.y as number };
  }
  if (m.t === 'mdel' || m.t === 'mtog') {
    const p = idx(m.p, MAX_PANELS), i = idx(m.i, MAX_HANDLES);
    return p < 0 || i < 0 ? null : { t: m.t, p, i };
  }
  if (m.t === 'pt') {
    const p = idx(m.p, MAX_PANELS), i = idx(m.i, MAX_HANDLES);
    if (p < 0 || i < 0 || (m.h !== 'c' && m.h !== 'm' && m.h !== 'g') || !fin(m.x) || !fin(m.y)) return null;
    if (m.h === 'c' && i > 3) return null;
    return { t: 'pt', p, h: m.h, i, x: m.x as number, y: m.y as number, ...(m.b ? { b: true } : {}) };
  }
  if (m.t === 'pan') {
    const p = idx(m.p, MAX_PANELS);
    // A drag can't move a panel by more than a couple of screens; anything bigger is a bad message.
    if (p < 0 || !fin(m.dx) || !fin(m.dy) || Math.abs(m.dx as number) > 2 || Math.abs(m.dy as number) > 2) return null;
    return { t: 'pan', p, dx: m.dx as number, dy: m.dy as number, ...(m.b ? { b: true } : {}) };
  }
  if (m.t !== 'act' || typeof m.id !== 'string' || m.id.length > 100) return null;
  const a = allActions().find((x) => x.id === m.id);
  if (!a) return null;
  if (a.type === 'fader') {
    if (typeof m.v !== 'number' || !Number.isFinite(m.v)) return null;
    return { t: 'act', id: a.id, v: Math.max(0, Math.min(1, m.v)) };
  }
  if (a.type === 'hold') return { t: 'act', id: a.id, v: m.v ? 1 : 0 };
  return { t: 'act', id: a.id };
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const parsePt = (x: unknown): Pt | null => (Array.isArray(x) && x.length === 2 && finite(x[0]) && finite(x[1]) ? [x[0], x[1]] : null);

/** Checks a geometry message; anything malformed rejects the whole message. */
export function parseGeo(raw: unknown): RemoteGeo | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (!Array.isArray(g.panels) || g.panels.length === 0 || g.panels.length > MAX_PANELS || !Array.isArray(g.outputs)) return null;
  const panels: GeoPanel[] = [];
  for (const rp of g.panels) {
    if (!rp || typeof rp !== 'object') return null;
    const q = rp as Record<string, unknown>;
    if (typeof q.output !== 'string' || !Array.isArray(q.corners) || q.corners.length !== 4) return null;
    const corners = q.corners.map(parsePt);
    if (corners.some((c) => !c)) return null;
    const panel: GeoPanel = { output: q.output, corners: corners as Quad, ...(typeof q.id === 'string' && q.id.length <= 64 ? { id: q.id } : {}) };
    if (q.mesh) {
      const m = q.mesh as Record<string, unknown>;
      if (!finite(m.cols) || !finite(m.rows) || !Array.isArray(m.pts) || m.pts.length > MAX_HANDLES) return null;
      const pts = m.pts.map(parsePt);
      if (pts.some((c) => !c) || pts.length !== m.cols * m.rows) return null;
      panel.mesh = { cols: m.cols, rows: m.rows, pts: pts as Pt[] };
    }
    if (q.mask) {
      const m = q.mask as Record<string, unknown>;
      if (!Array.isArray(m.points) || m.points.length > MAX_HANDLES) return null;
      const pts = m.points.map((mp) => parsePt((mp as { p?: unknown } | null)?.p));
      if (pts.some((c) => !c)) return null;
      panel.mask = { points: (pts as Pt[]).map((p, k) => ({ p, smooth: (m.points as { smooth?: unknown }[])[k]?.smooth !== false })), invert: m.invert === true };
    }
    panels.push(panel);
  }
  const outputs: RemoteGeo['outputs'] = [];
  for (const ro of g.outputs) {
    const o = ro as Record<string, unknown> | null;
    if (!o || typeof o.id !== 'string' || typeof o.name !== 'string' || !Array.isArray(o.size) || !finite(o.size[0]) || !finite(o.size[1])) return null;
    outputs.push({ id: o.id, name: o.name.slice(0, 40), size: [Math.max(1, o.size[0]), Math.max(1, o.size[1])] });
  }
  return {
    selected: finite(g.selected) ? Math.max(0, Math.min(panels.length - 1, Math.round(g.selected))) : 0,
    outputs, panels, canUndo: g.canUndo === true, canRedo: g.canRedo === true,
  };
}

export function parseToRemote(raw: unknown): ToRemote | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.t === 'geo') { const g = parseGeo(m.g); return g ? { t: 'geo', g } : null; }
  if (m.t !== 'state' || !m.s || typeof m.s !== 'object') return null;
  const s = m.s as Record<string, unknown>;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  if (s.v !== REMOTE_VERSION) return null;
  const params: ParamValues = {};
  if (s.params && typeof s.params === 'object') {
    for (const [fx, vals] of Object.entries(s.params as Record<string, unknown>)) {
      if (!vals || typeof vals !== 'object') continue;
      params[fx] = {};
      for (const [k, v] of Object.entries(vals as Record<string, unknown>)) if (typeof v === 'number' && Number.isFinite(v)) params[fx][k] = v;
    }
  }
  return {
    t: 'state',
    s: {
      v: REMOTE_VERSION,
      scene: Math.max(0, Math.min(SCENES.length - 1, Math.round(num(s.scene, 0)))),
      blackout: s.blackout === true,
      bpm: num(s.bpm, 120),
      master: num(s.master, 1),
      react: num(s.react, 1),
      rgb: num(s.rgb, 0),
      cues: Array.isArray(s.cues) ? s.cues.map((c) => (typeof c === 'string' ? c : null)) : [],
      params,
      lock: LOCKS.includes(s.lock as Lock) ? (s.lock as Lock) : 'control',
    },
  };
}

export function buildSnapshot(s: Settings, blackout: boolean, params: ParamValues, lock: Lock = 'control'): RemoteSnapshot {
  return {
    v: REMOTE_VERSION,
    scene: s.scene,
    blackout,
    bpm: s.bpm,
    master: s.master,
    react: s.react,
    rgb: s.rgbSplit,
    cues: s.cues.map((c) => (c ? SCENES[c.scene] ?? 'Cue' : null)),
    params,
    lock,
  };
}

/** The mapping as a remote needs it: shapes only, no content. */
/** Five decimals is a fraction of a pixel even at 8K, and keeps the message well under Ably's size limit. */
const r5 = (p: Pt): Pt => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];

export function buildGeo(s: Settings, sizes: Record<string, [number, number]>, canUndo: boolean, canRedo: boolean): RemoteGeo {
  return {
    selected: s.selected,
    outputs: s.outputs.map((o) => ({ id: o.id, name: o.name, size: sizes[o.id] ?? [1920, 1080] })),
    panels: s.panels.map((p) => ({
      id: p.id,
      output: p.output,
      corners: p.corners.map(r5) as Quad,
      ...(p.mesh ? { mesh: { cols: p.mesh.cols, rows: p.mesh.rows, pts: p.mesh.pts.map(r5) } } : {}),
      ...(p.mask && p.mask.points.length ? { mask: { points: p.mask.points.map((mp) => ({ p: r5(mp.p), smooth: mp.smooth })), invert: p.mask.invert } } : {}),
    })),
    canUndo,
    canRedo,
  };
}

/** Whether a remote with this lock may do what the message asks. 'view' does nothing; mapping needs 'edit'. */
export function permits(lock: Lock, m: ToHost): boolean {
  if (m.t === 'hello') return true;
  if (lock === 'view') return false;
  return m.t === 'act' || lock === 'edit';
}

/* ---------- pairing ---------- */

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const CODE_LENGTH = 16;

/** A random session code, about 78 bits. It names the channel, so it's the only thing keeping others out. */
export function newSessionCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  // Rejection sampling keeps every letter equally likely.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const b of random(CODE_LENGTH)) {
      if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

export const validSessionCode = (c: string) => c.length === CODE_LENGTH && [...c].every((ch) => CODE_ALPHABET.includes(ch));

export const channelName = (code: string) => `panelmapper:${code}`;

/** The address a remote opens, with the code in the fragment so it never reaches a server. */
export const remoteUrl = (origin: string, code: string) => `${origin}/remote#${code}`;

/* ---------- sending ---------- */

/**
 * Passes a value on at most every `ms`, always finishing on the latest one, so a drag is
 * smooth on the wire and the last position is never lost.
 */
export function makeThrottle<T>(send: (v: T) => void, ms: number, now: () => number = () => Date.now()) {
  let last = -Infinity;
  let pending: { v: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (!pending) return;
    const { v } = pending;
    pending = null;
    last = now();
    send(v);
  };
  return {
    push(v: T) {
      pending = { v };
      const wait = last + ms - now();
      if (wait <= 0) { clearTimeout(timer); flush(); } else if (timer === undefined) timer = setTimeout(flush, wait);
    },
    /** Sends anything still waiting now. */
    flush() { clearTimeout(timer); flush(); },
    cancel() { clearTimeout(timer); timer = undefined; pending = null; },
  };
}
