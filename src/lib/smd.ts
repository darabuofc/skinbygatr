import { sanitizePlaylist } from './playlist';
import type { Panel, SmdConfig, SmdFit, SmdPreset } from './types';

/** Choices for the flash limit, in flashes per second (0 = no limit). 3 per second is the usual photosensitivity guideline. */
export const FLASH_LIMITS = [0, 2, 3, 5] as const;

/** Smallest and largest SMD screen side, in pixels, and the most pixels in all (three buffers of this size live on the GPU). */
export const SMD_MIN = 16;
export const SMD_MAX_SIDE = 8192;
export const SMD_MAX_PIXELS = 4096 * 4096;

/** Id of the one layer SMD mode draws; cues never contain it. */
export const SMD_PANEL_ID = 'smd';

export const SMD_FITS: [SmdFit, string][] = [
  ['fit', 'Scale to fill the window'],
  ['pixel', 'True pixel size (1 pixel = 1 pixel)'],
];

/** Most saved screen set-ups, and the longest name. */
export const MAX_SMD_PRESETS = 12;
export const MAX_PRESET_NAME = 32;

/** A saved set-up from the screen as it is now. */
export function presetOf(name: string, c: SmdConfig): SmdPreset {
  return { name: name.trim().slice(0, MAX_PRESET_NAME), width: c.width, height: c.height, fit: c.fit, maxBrightness: c.maxBrightness, gamma: c.gamma, warmth: c.warmth, flashLimit: c.flashLimit };
}

/** The list with this preset added, replacing one of the same name (any letter case); the oldest goes if the list is full. */
export function withPreset(list: SmdPreset[], p: SmdPreset): SmdPreset[] {
  if (!p.name) return list;
  const i = list.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase());
  if (i >= 0) return list.map((x, j) => (j === i ? p : x));
  return [...list, p].slice(-MAX_SMD_PRESETS);
}

/** Valid presets from saved data: each is passed through the same repairs as the live screen. */
export function sanitizePresets(v: unknown, validSource: (s: unknown) => s is string, validBand: (b: unknown) => boolean): SmdPreset[] {
  if (!Array.isArray(v)) return [];
  let out: SmdPreset[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object' || typeof (x as { name?: unknown }).name !== 'string') continue;
    const name = (x as { name: string }).name.trim().slice(0, MAX_PRESET_NAME);
    if (!name) continue;
    out = withPreset(out, presetOf(name, sanitizeSmd(x, validSource, validBand)));
  }
  return out;
}

/** Common LED sizes, to start from. Anything else is typed in. */
export const SMD_PRESETS: { name: string; width: number; height: number }[] = [
  { name: 'Square 1080', width: 1080, height: 1080 },
  { name: 'Square 512', width: 512, height: 512 },
  { name: 'Square 256', width: 256, height: 256 },
  { name: 'Full HD', width: 1920, height: 1080 },
  { name: 'Wide strip', width: 3840, height: 640 },
];

export function defaultSmd(): SmdConfig {
  return { width: 1080, height: 1080, fit: 'fit', source: 'gen', band: 'none', maxBrightness: 1, gamma: 1, warmth: 0, flashLimit: 3 };
}

const whole = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback);

/**
 * A usable screen size from whatever was typed or saved: whole pixels, each side within limits and the total
 * under the pixel cap. Too large a total is scaled down keeping the shape.
 */
export function clampSmdSize(width: unknown, height: unknown): { width: number; height: number } {
  const d = defaultSmd();
  let w = Math.min(SMD_MAX_SIDE, Math.max(SMD_MIN, whole(width, d.width)));
  let h = Math.min(SMD_MAX_SIDE, Math.max(SMD_MIN, whole(height, d.height)));
  if (w * h > SMD_MAX_PIXELS) {
    const k = Math.sqrt(SMD_MAX_PIXELS / (w * h));
    w = Math.max(SMD_MIN, Math.floor(w * k));
    h = Math.max(SMD_MIN, Math.floor(h * k));
  }
  return { width: w, height: h };
}

export function sanitizeSmd(v: unknown, validSource: (s: unknown) => s is string, validBand: (b: unknown) => boolean): SmdConfig {
  const d = defaultSmd();
  if (!v || typeof v !== 'object') return d;
  const o = v as Record<string, unknown>;
  const playlist = sanitizePlaylist(o.playlist);
  return {
    ...clampSmdSize(o.width, o.height),
    fit: o.fit === 'pixel' ? 'pixel' : 'fit',
    source: validSource(o.source) ? o.source : d.source,
    band: validBand(o.band) ? (o.band as SmdConfig['band']) : d.band,
    maxBrightness: inRange(o.maxBrightness, 0.1, 1, d.maxBrightness),
    gamma: inRange(o.gamma, 0.5, 3, d.gamma),
    warmth: inRange(o.warmth, -1, 1, d.warmth),
    flashLimit: (FLASH_LIMITS as readonly number[]).includes(o.flashLimit as number) ? (o.flashLimit as number) : d.flashLimit,
    ...(playlist ? { playlist } : {}),
  };
}

const inRange = (v: unknown, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

/** LED output corrections for the renderer, or null when they would change nothing. */
export function ledOf(cfg: Pick<SmdConfig, 'maxBrightness' | 'gamma' | 'warmth'>): { cap: number; gamma: number; warmth: number } | null {
  const led = { cap: cfg.maxBrightness, gamma: cfg.gamma, warmth: cfg.warmth };
  return led.cap < 0.999 || Math.abs(led.gamma - 1) > 0.001 || Math.abs(led.warmth) > 0.001 ? led : null;
}

/** The single full-screen layer SMD mode draws, as a panel so it uses the same renderer, effects and post pass. */
export function smdPanel(cfg: SmdConfig, output: string): Panel {
  return {
    id: SMD_PANEL_ID,
    output,
    corners: [[0, 0], [1, 0], [1, 1], [0, 1]],
    source: cfg.source,
    band: cfg.band,
    feather: 0,
    blend: 'over',
    opacity: 1,
  };
}

export interface Box { x: number; y: number; w: number; h: number; }

/**
 * Where the SMD picture sits in a window of CSS size W×H on a display with the given pixel ratio.
 * 'fit' is the largest copy with the screen's shape, centred; 'pixel' is the screen's true size from
 * the top-left corner, so a processor that crops that corner of the signal gets every pixel exactly.
 */
export function smdBox(W: number, H: number, dpr: number, cfg: Pick<SmdConfig, 'width' | 'height' | 'fit'>): Box {
  if (cfg.fit === 'pixel') return { x: 0, y: 0, w: cfg.width / dpr, h: cfg.height / dpr };
  const k = Math.min(W / cfg.width, H / cfg.height);
  const w = cfg.width * k, h = cfg.height * k;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}
