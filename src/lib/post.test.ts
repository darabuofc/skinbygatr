import { describe, expect, it } from 'vitest';
import { groupById, PARAM_GROUPS } from './params';
import { hueToRgb, POST_GROUPS, POST_PARAMS, postActive, postGroupId, type PostValues } from './post';
import { MAX_OUTPUTS } from './types';

const rest: PostValues = { bloom: 0, ripple: 0, rippleT: 123, tint: 0, tintHue: 0.5, saturation: 1, vignette: 0 };

describe('post effects', () => {
  it('has a settings group per projector slot, part of the shared settings', () => {
    expect(POST_GROUPS.map((g) => g.id)).toEqual(Array.from({ length: MAX_OUTPUTS }, (_, i) => `post${i + 1}`));
    expect(postGroupId(1)).toBe('post2');
    for (const g of POST_GROUPS) expect(PARAM_GROUPS).toContain(g);
    expect(groupById('post1')!.params).toBe(POST_PARAMS);
  });

  it('is skipped at its defaults, so it costs nothing until used', () => {
    const d = Object.fromEntries(POST_PARAMS.map((p) => [p.name, p.default]));
    expect(postActive({
      bloom: d.uBloom, ripple: d.uRipple, rippleT: 0, tint: d.uTint, tintHue: d.uTintHue, saturation: d.uSaturation, vignette: d.uVignette,
    })).toBe(false);
    expect(postActive(rest)).toBe(false);
  });

  it('turns on as soon as any effect does', () => {
    for (const patch of [{ bloom: 0.2 }, { ripple: 0.1 }, { tint: 0.5 }, { saturation: 0.6 }, { saturation: 1.4 }, { vignette: 0.3 }]) {
      expect(postActive({ ...rest, ...patch })).toBe(true);
    }
    // Changing only the tint colour, with no tint, changes nothing.
    expect(postActive({ ...rest, tintHue: 0.1 })).toBe(false);
  });

  it('turns a hue into a pure colour round the wheel', () => {
    expect(hueToRgb(0)).toEqual([1, 0, 0]);
    expect(hueToRgb(1 / 3).map((v) => +v.toFixed(6))).toEqual([0, 1, 0]);
    expect(hueToRgb(2 / 3).map((v) => +v.toFixed(6))).toEqual([0, 0, 1]);
    expect(hueToRgb(0.5).map((v) => +v.toFixed(6))).toEqual([0, 1, 1]);
  });
});
