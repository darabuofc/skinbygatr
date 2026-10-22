import { NOISE_GLSL } from '../shaders';
import type { Pt } from '../types';
import { jelly, plankton, ripples, shafts } from './backdrop';
import { eye } from './eye';
import { skin } from './skin';
import { water } from './water';

/*
 * Panel shaders: looks written for one surface (the backdrop water, the gator's skin, an eye)
 * rather than the twelve wall scenes. Each is a typed definition compiled into its own program,
 * so a broken one blanks only its panels. A panel shows one with the source 'fx:<id>'.
 * They are kept apart from SCENES on purpose: number keys, cue scene numbers and auto-cycle
 * only ever walk the twelve scenes.
 */

/** A setting with a slider, MIDI fader and saved value. Usually a uniform the shader reads. */
export interface FxParam {
  /** Uniform name in the GLSL, such as uCaustic. */
  name: string;
  label: string;
  min: number;
  max: number;
  default: number;
  /**
   * For a speed: the name of a uniform that runs at this speed, such as uWaterT. Use that clock
   * in the shader instead of uTime × speed, so changing the speed live slows or quickens the
   * motion rather than jumping it. At speed 1 the clock equals uTime.
   */
  clock?: string;
  /**
   * Read by the engine's automation (such as blinks per minute), not passed to the shader.
   * It still gets a slider, a MIDI fader and a saved value like any other setting.
   */
  engine?: boolean;
}

/** A one-shot action on a shader, such as a blink: a button, and a MIDI pad to learn. */
export interface FxTrigger { id: string; label: string; }

/** An image the shader reads, such as a height map. Each panel picks which library image feeds it. */
export interface FxTexture {
  /** Sampler uniform name in the GLSL, such as uHeight. */
  name: string;
  label: string;
}

export interface FxDef {
  id: string;
  name: string;
  description: string;
  /**
   * GLSL defining `vec3 fx(vec2 fc)`, given the pixel position in the panel's buffer.
   * The prelude supplies the standard uniforms, noise and caustics; param uniforms are declared for it.
   */
  body: string;
  params: FxParam[];
  /**
   * Images the shader samples. Without one picked, a sampler reads flat mid-grey (0.5), so a height
   * map that's missing gives an even surface rather than a broken one. Image rows run top to bottom:
   * sample at vec2(uv.x, 1.0 - uv.y) for uv from fc / uRes.
   */
  textures?: FxTexture[];
  /** Uniforms the engine's automation sets every frame (such as the blink in progress). */
  live?: string[];
  /** One-shot actions the engine's automation runs for this shader. */
  triggers?: FxTrigger[];
  /**
   * Buffer resolution as a share of the panel's size on the output. Below 1 for soft looks
   * on soft surfaces, which saves most of the cost.
   */
  scale: number;
}

export const FX: FxDef[] = [water, jelly, shafts, ripples, plankton, skin, eye];

export function fxById(id: string): FxDef | undefined {
  return FX.find((f) => f.id === id);
}

export const FX_PREFIX = 'fx:';

/** The panel shader id in a source string, or null when the source isn't one. */
export function fxIdOf(source: string): string | null {
  return source.startsWith(FX_PREFIX) ? source.slice(FX_PREFIX.length) : null;
}

/** Whether a source names a panel shader that exists in this build. */
export const isFxSource = (source: string) => {
  const id = fxIdOf(source);
  return id !== null && !!fxById(id);
};

/** Uniforms every panel shader gets, matching the wall scenes so the looks move together. */
export const FX_UNIFORMS = ['uRes', 'uTime', 'uBass', 'uMid', 'uHigh', 'uKick', 'uBeat', 'uSince',
  'uPhaseA', 'uPhaseB', 'uC1', 'uC2', 'uSpec', 'uKicks', 'uReact'];

/**
 * Shared by every panel shader. `caustic` lives here rather than in one shader so the
 * backdrop water and the light on the gator are the same pattern at the same moment.
 */
export const FX_PRELUDE = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 uRes;
uniform float uTime, uBass, uMid, uHigh, uKick, uBeat, uSince, uPhaseA, uPhaseB;
// Audio reactivity from the Visuals section, 0..1, so each shader can scale its own response.
uniform float uReact;
uniform vec3 uC1, uC2;
uniform sampler2D uSpec;
uniform float uKicks[8];

${NOISE_GLSL}

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// Distance to the nearest edge between cells of a moving Voronoi pattern: 0 on an edge.
float causticCells(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 h = hash2(i + g);
      vec2 c = g + 0.5 + 0.42 * sin(t * (0.6 + 0.5 * h.yx) + 6.2831853 * h) - f;
      float d = length(c);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}

// Water caustics: two wobbling layers of bright cell edges, like light focused through ripples.
// p is in caustic cells (about 4 across a panel looks right), t in seconds. Returns about 0..1.2.
float caustic(vec2 p, float t) {
  vec2 w = vec2(noise(p * 0.6 + t * 0.11), noise(p * 0.6 - t * 0.09 + 5.2)) - 0.5;
  float a = causticCells(p + w * 0.8, t * 0.7);
  float b = causticCells(p * 1.7 - w * 0.5 + 3.1, t * 0.9 + 1.7);
  return exp(-a * 10.0) * 0.75 + exp(-b * 14.0) * 0.45;
}
`;

/** Full fragment shader source for one panel shader. */
export function fxSource(def: FxDef): string {
  const floats = shaderFloats(def);
  const params = floats.length ? `uniform float ${floats.join(', ')};\n` : '';
  const textures = def.textures?.length ? `uniform sampler2D ${def.textures.map((t) => t.name).join(', ')};\n` : '';
  return `${FX_PRELUDE}
${params}${textures}
${def.body}

void main() {
  o = vec4(clamp(fx(gl_FragCoord.xy), 0.0, 1.0), 1.0);
}`;
}

/** The float uniforms a shader declares: its params (not engine-only ones), their clocks, and live values. */
function shaderFloats(def: FxDef): string[] {
  return [
    ...def.params.filter((p) => !p.engine).map((p) => p.name),
    ...def.params.flatMap((p) => (p.clock ? [p.clock] : [])),
    ...(def.live ?? []),
  ];
}

/** Every uniform a panel shader's program looks up: the shared ones, its floats and its images. */
export const fxUniformNames = (def: FxDef) => [...FX_UNIFORMS, ...shaderFloats(def), ...(def.textures ?? []).map((t) => t.name)];

/** Longest side an image is stored at on the GPU; larger ones are scaled down when loaded. */
export const MAX_IMAGE_PX = 4096;

/** Size to load an image at so its longest side is at most `max`, keeping its shape. */
export function fitImageSize(w: number, h: number, max = MAX_IMAGE_PX): [number, number] {
  if (!(w > 0) || !(h > 0)) return [1, 1];
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/** Smallest and largest buffer side, in px. */
export const FX_MIN_PX = 16;
export const FX_MAX_PX = 2048;
/** Buffer sizes snap to this step, so nudging a corner doesn't reallocate the buffer every frame. */
export const FX_STEP_PX = 32;

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const snap = (v: number) => Math.min(FX_MAX_PX, Math.max(FX_MIN_PX, Math.ceil(v / FX_STEP_PX) * FX_STEP_PX));

/**
 * Buffer size for a panel shader: the panel's size on the output (average of opposite edges,
 * corners in output pixels) times the shader's scale, so its pixels match the wall's.
 */
export function fxTargetSize(q: readonly [Pt, Pt, Pt, Pt], scale: number): [number, number] {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return [snap((Number.isFinite(w) ? w : 0) * k), snap((Number.isFinite(h) ? h : 0) * k)];
}
