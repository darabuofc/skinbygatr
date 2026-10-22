import type { FxParam } from './fx';
import { MAX_OUTPUTS } from './types';

/*
 * Post effects: a finishing pass over a projector's whole picture, after every panel is drawn.
 * Bloom, a water-ripple shimmer, a colour tint, saturation and a vignette, set per projector.
 * Their settings live with the panel shader settings (one group per projector slot), so they
 * get sliders, MIDI faders, smoothing, saving and cue fades the same way. At their defaults the
 * pass is skipped entirely and costs nothing.
 */

export interface PostGroup { id: string; name: string; params: FxParam[]; }

export const POST_PARAMS: FxParam[] = [
  { name: 'uBloom', label: 'Bloom', min: 0, max: 1.5, default: 0 },
  { name: 'uRipple', label: 'Water shimmer', min: 0, max: 1, default: 0 },
  { name: 'uRippleSpeed', label: 'Shimmer speed', min: 0, max: 3, default: 1, clock: 'uRippleT' },
  { name: 'uTint', label: 'Tint amount', min: 0, max: 1, default: 0 },
  { name: 'uTintHue', label: 'Tint colour', min: 0, max: 1, default: 0.5 },
  { name: 'uSaturation', label: 'Saturation', min: 0, max: 2, default: 1 },
  { name: 'uVignette', label: 'Vignette', min: 0, max: 1, default: 0 },
];

/** Settings group for the projector at this position (0 = first). By position, so it survives renaming. */
export const postGroupId = (index: number) => `post${index + 1}`;

export const POST_GROUPS: PostGroup[] = Array.from({ length: MAX_OUTPUTS }, (_, i) => ({
  id: postGroupId(i),
  name: `Projector ${i + 1} post`,
  params: POST_PARAMS,
}));

export interface PostValues {
  bloom: number; ripple: number; rippleT: number; tint: number; tintHue: number; saturation: number; vignette: number;
}

/** Whether the pass would change the picture at all; when not, it's skipped. */
export function postActive(v: PostValues): boolean {
  return v.bloom > 0.001 || v.ripple > 0.001 || v.tint > 0.001 || Math.abs(v.saturation - 1) > 0.001 || v.vignette > 0.001;
}

/** A fully saturated colour for a hue 0..1 (red, through green and blue, back to red). */
export function hueToRgb(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return 1 - Math.max(0, Math.min(1, Math.min(k, 4 - k)));
  };
  return [f(5), f(3), f(1)];
}
