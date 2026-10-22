import type { SplitDrive } from './effects';

export type Band = 'bass' | 'mid' | 'high' | 'all' | 'none';
export type Pt = [number, number];
/** Corners in normalized stage space (0..1): top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];

/**
 * One projector window. Corners are stored as the audience sees the surface; a flipped
 * output mirrors only what goes to its projector, for rear projection or a ceiling mount.
 */
export interface OutputConfig {
  id: string;
  name: string;
  /** Mirror left-right, for a projector behind the screen. */
  flipH: boolean;
  /** Mirror top-bottom, for a projector hung upside down. */
  flipV: boolean;
}

/** Most projector windows a show can drive. */
export const MAX_OUTPUTS = 2;

export interface Panel {
  id: string;
  /** Id of the output (projector) this panel is on. */
  output: string;
  corners: Quad;
  /** 'gen' for the wall scene, 'vid:<id>' for a library video, or 'fx:<id>' for a panel shader (src/lib/fx). */
  source: string;
  band: Band;
  /** Edge softness as a fraction of the panel (0 = hard edge). */
  feather: number;
  /** How the panel combines with the panels drawn before it on the same projector. */
  blend: BlendMode;
  /** 0 (invisible) to 1. */
  opacity: number;
  /**
   * Grid warp for curved surfaces. When present it replaces the four-corner warp, and `corners`
   * follow the grid's corners. Missing means a flat four-corner panel.
   */
  mesh?: Mesh;
  /** For a panel shader with image inputs: sampler name to library image id. Missing means flat grey. */
  inputs?: Record<string, string>;
  /** Freeform outline the panel is clipped to; missing means the whole panel shows. */
  mask?: Mask;
  /** Text centred on the panel; missing means none. */
  label?: PanelLabel;
}

/**
 * How a panel combines with what's already drawn beneath it. Later panels on a projector draw on top.
 * Normal covers; Add and Screen only brighten (light on light); Multiply only darkens (shadows, tints).
 */
export type BlendMode = 'over' | 'add' | 'screen' | 'multiply';

export const BLEND_MODES: [BlendMode, string][] = [
  ['over', 'Normal'],
  ['add', 'Add'],
  ['screen', 'Screen'],
  ['multiply', 'Multiply'],
];

export interface Mesh {
  /** Control points across and down. */
  cols: number;
  rows: number;
  /** cols × rows points, row by row from the top-left, in stage fractions as the audience sees them. */
  pts: Pt[];
}

export interface MaskPoint {
  /** Stage fractions, as the audience sees the surface. */
  p: Pt;
  /** Curves through this point when true; a sharp corner when false. */
  smooth: boolean;
}

export interface Mask {
  points: MaskPoint[];
  /** Edge fade, inwards from the outline, as a fraction of the output height (0 = hard edge). */
  feather: number;
  /** Show the panel outside the outline instead of inside it. */
  invert: boolean;
  /**
   * A picture used as the mask itself (PNG data URL, white with the shape in its alpha), stretched over the
   * panel's own surface so it follows corners and mesh. Holes and separate pieces survive. When set, `points` is empty.
   */
  image?: string;
}

export interface PanelLabel {
  text: string;
  /** Degrees, -180..180, clockwise. */
  rotation: number;
  /** Text height as a fraction of the panel's extent across the text, 0.05..1. Shrinks to fit. */
  size: number;
  color: string;
  /** Brightness follows the panel's band like the visuals do. */
  pulse: boolean;
}

export interface Look {
  scene: number;
  c1: string;
  c2: string;
  react: number;
  strobe: boolean;
  /** Missing in cues saved before the RGB split existed; recalling those leaves it as it is. */
  rgbSplit?: number;
  rgbDrive?: SplitDrive;
  span: boolean;
  /**
   * Per panel content. Blend and opacity are missing in cues saved before layering; recalling
   * those leaves them as they are. Geometry (corners, mesh, mask) is never part of a cue.
   */
  panels: Record<string, LookPanel>;
  /** Panel shader settings by shader; missing in older cues, which then leave them alone. */
  params?: Record<string, Record<string, number>>;
  /** Fade length in seconds. Missing in older cues, which fade over the beat-based scene fade. */
  fadeSec?: number;
  /** How the cue's content change looks; missing in older cues, which use the current transition. */
  transition?: TransitionMode;
}

/** How a scene or content change moves from the old look to the new one. */
export type TransitionMode = 'fade' | 'ripple' | 'sparkle' | 'black';

export const TRANSITIONS: [TransitionMode, string][] = [
  ['fade', 'Crossfade'],
  ['ripple', 'Ripple wipe from the centre'],
  ['sparkle', 'Sparkle dissolve'],
  ['black', 'Fade through black'],
];

export interface LookPanel {
  source: string;
  band: Band;
  blend?: BlendMode;
  opacity?: number;
}

export type MidiKind = 'note' | 'cc';
export interface MidiBinding { kind: MidiKind; channel: number; num: number; }

export interface Settings {
  version: 3;
  outputs: OutputConfig[];
  panels: Panel[];
  selected: number;
  scene: number;
  autoCycle: boolean;
  /** Automatic scene changes happen every this many bars, counted in kicks. */
  cycleBars: number;
  /** Crossfade length for scene changes and cue recalls, in beats (0 = hard cut). */
  fadeBeats: number;
  /** Fade length given to cues when they're saved, in seconds (0 = cut). */
  cueFade: number;
  /** How scene and content changes move between looks; cues keep the one they were saved with. */
  transition: TransitionMode;
  c1: string;
  c2: string;
  react: number;
  strobe: boolean;
  /** RGB split strength, 0 (off) to 1. */
  rgbSplit: number;
  rgbDrive: SplitDrive;
  span: boolean;
  testGrid: boolean;
  /** Magnified view around a corner while dragging or nudging it. */
  loupe: boolean;
  autoBpm: boolean;
  bpm: number;
  gain: number;
  sens: number;
  master: number;
  cues: (Look | null)[];
  midi: Record<string, MidiBinding>;
  audioDevice: string;
}

export interface VideoItem { id: string; name: string; size: number; }
export interface ImageItem { id: string; name: string; size: number; w: number; h: number; }

export interface Runtime {
  showMode: boolean;
  blackout: boolean;
  flashHold: boolean;
  /** At least one projector window is open. */
  outputOpen: boolean;
  /** Ids of the outputs whose projector window is open. */
  openOutputs: string[];
  /** The output the live copy in this window shows, or '' when it isn't showing. */
  previewOutput: string;
  /** Mapping dots on the wall while the projector window is open. Off keeps the wall clean. */
  wallDots: boolean;
  hideUi: boolean;
  audioOn: boolean;
  /** 'silent' and 'lost' mean the visuals fell back to the built-in beat. */
  audioState: 'off' | 'listening' | 'silent' | 'lost';
  audioMsg: string;
  /** File name of the test track feeding the audio analysis, or '' for a live input. */
  trackName: string;
  trackPlaying: boolean;
  outMsg: string;
  midiOn: boolean;
  midiMsg: string;
  midiLearn: string | null;
  cueSaveMode: boolean;
  videos: VideoItem[];
  /** Images for panel shaders, such as height maps, stored in the browser. */
  images: ImageItem[];
  imageMsg: string;
  offlineReady: boolean;
  wakeLock: boolean;
  storageMsg: string;
  libraryMsg: string;
  devices: { id: string; label: string }[];
  /** The handle last touched: a panel corner (c ≥ 0), a mask point m or a mesh point g (with c = -1). Arrow keys move it. */
  selCorner: { p: number; c: number; m?: number; g?: number } | null;
  /** Mask points of the selected panel are shown for editing. */
  maskEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export const SCENES = [
  'Pulse', 'Spectrum', 'Scan', 'Grid', 'Tunnel', 'Smoke',
  'Kaleido', 'Lasers', 'Warp', 'Radial', 'Hexes', 'Glitch',
] as const;

/** Keyboard key for each scene, in order: 1–9, 0, then - and =. */
export const SCENE_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='] as const;

/** Scene index for a pressed key, or null. */
export function sceneForKey(k: string): number | null {
  const i = (SCENE_KEYS as readonly string[]).indexOf(k);
  return i >= 0 && i < SCENES.length ? i : null;
}

export const BANDS: [Band, string][] = [
  ['bass', 'Bass'],
  ['mid', 'Mids'],
  ['high', 'Highs'],
  ['all', 'Everything'],
  ['none', 'Nothing (steady)'],
];

export const CUE_COUNT = 8;

export type ActionType = 'trigger' | 'hold' | 'fader';
export interface Action { id: string; label: string; type: ActionType; }

export const ACTIONS: Action[] = [
  ...SCENES.map((n, i) => ({ id: `scene:${i}`, label: `Scene ${i + 1}: ${n}`, type: 'trigger' as const })),
  { id: 'scene:next', label: 'Next scene', type: 'trigger' },
  { id: 'blackout', label: 'Blackout on/off', type: 'trigger' },
  { id: 'flash', label: 'Flash while held', type: 'hold' },
  { id: 'tap', label: 'Tap tempo', type: 'trigger' },
  ...Array.from({ length: CUE_COUNT }, (_, i) => ({ id: `cue:${i}`, label: `Recall cue ${i + 1}`, type: 'trigger' as const })),
  { id: 'master', label: 'Master brightness', type: 'fader' },
  { id: 'react', label: 'Reactivity', type: 'fader' },
  { id: 'rgb', label: 'RGB split', type: 'fader' },
];
