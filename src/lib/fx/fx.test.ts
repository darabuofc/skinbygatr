import { describe, expect, it } from 'vitest';
import {
  fitImageSize, FX, fxById, fxIdOf, fxSource, fxTargetSize, fxUniformNames, FX_MAX_PX, FX_MIN_PX, FX_UNIFORMS, isFxSource, MAX_IMAGE_PX,
} from './index';
import { sanitize, sanitizeLook } from '../store';
import { SCENES } from '../types';
import type { Pt } from '../types';

/** Uniform names declared in a shader, including comma lists and arrays. */
function declared(src: string) {
  const names = new Set<string>();
  for (const m of src.matchAll(/uniform\s+\w+\s+([^;]+);/g)) {
    for (const n of m[1].split(',')) names.add(n.trim().replace(/\[.*$/, ''));
  }
  return names;
}

const rect = (w: number, h: number): [Pt, Pt, Pt, Pt] => [[0, 0], [w, 0], [w, h], [0, h]];

describe('panel shader definitions', () => {
  it('has unique, URL-safe ids that never clash with a wall scene name', () => {
    const ids = FX.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^[a-z0-9-]+$/));
    FX.forEach((f) => expect(SCENES as readonly string[]).not.toContain(f.name));
  });

  it.each(FX.map((f) => [f.id, f] as const))('%s declares every uniform it uses', (_, def) => {
    const src = fxSource(def);
    const used = new Set(src.match(/\bu[A-Z]\w*/g) ?? []);
    const have = declared(src);
    expect([...used].filter((u) => !have.has(u))).toEqual([]);
    expect(src.match(/void main\(/g)).toHaveLength(1);
    expect(def.body).toMatch(/vec3\s+fx\s*\(\s*vec2/);
  });

  it.each(FX.map((f) => [f.id, f] as const))('%s has sane params and scale', (_, def) => {
    const names = def.params.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of def.params) {
      expect(p.name).toMatch(/^u[A-Z]\w*$/);
      expect(FX_UNIFORMS).not.toContain(p.name);
      expect(p.min).toBeLessThan(p.max);
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
      expect(p.label.trim()).not.toBe('');
    }
    expect(def.scale).toBeGreaterThan(0);
    expect(def.scale).toBeLessThanOrEqual(1);
  });

  it('builds the water from the shared caustic, so other surfaces can move in step with it', () => {
    expect(fxById('water')!.body).toContain('caustic(');
    expect(fxSource(fxById('water')!)).toMatch(/float caustic\(vec2 p, float t\)/);
  });
});

describe('fx sources', () => {
  it('reads the shader id from a source', () => {
    expect(fxIdOf('fx:water')).toBe('water');
    expect(fxIdOf('gen')).toBeNull();
    expect(fxIdOf('vid:abc')).toBeNull();
    expect(isFxSource('fx:water')).toBe(true);
    expect(isFxSource('fx:nope')).toBe(false);
    expect(isFxSource('fx:')).toBe(false);
  });

  it('keeps panel shaders through save and load, and falls back to generated for unknown ones', () => {
    const q = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const s = sanitize({ panels: [{ corners: q, source: 'fx:water' }, { corners: q, source: 'fx:retired' }] });
    expect(s.panels.map((p) => p.source)).toEqual(['fx:water', 'gen']);
  });

  it('keeps panel shaders in cues and drops unknown ones', () => {
    const look = sanitizeLook({
      scene: 0, panels: { a: { source: 'fx:water', band: 'none' }, b: { source: 'fx:retired', band: 'none' } },
    })!;
    expect(look.panels).toEqual({ a: { source: 'fx:water', band: 'none' } });
  });
});

describe('fxTargetSize', () => {
  it('matches the panel size times the shader scale, snapped up', () => {
    expect(fxTargetSize(rect(1920, 1080), 1)).toEqual([1920, 1088]);
    expect(fxTargetSize(rect(1920, 1080), 0.75)).toEqual([1440, 832]);
  });

  it('averages opposite edges of a keystoned panel', () => {
    const q: [Pt, Pt, Pt, Pt] = [[100, 0], [500, 0], [600, 300], [0, 300]];
    expect(fxTargetSize(q, 1)).toEqual([512, 320]);
  });

  it('stays within bounds for tiny, huge and broken panels', () => {
    expect(fxTargetSize(rect(0, 0), 1)).toEqual([FX_MIN_PX, FX_MIN_PX]);
    expect(fxTargetSize(rect(9000, 9000), 1)).toEqual([FX_MAX_PX, FX_MAX_PX]);
    expect(fxTargetSize([[NaN, 0], [1, 0], [1, 1], [0, 1]], 1)).toEqual([FX_MIN_PX, FX_MIN_PX]);
    expect(fxTargetSize(rect(640, 480), NaN)).toEqual([640, 480]);
  });

  it('ignores nudges smaller than the snap step, so the buffer is not reallocated', () => {
    expect(fxTargetSize(rect(1000, 500), 1)).toEqual(fxTargetSize(rect(1003, 498), 1));
  });
});

describe('image inputs', () => {
  it.each(FX.filter((f) => f.textures?.length).map((f) => [f.id, f] as const))('%s declares valid, distinct samplers', (_, def) => {
    const names = def.textures!.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of def.textures!) {
      expect(t.name).toMatch(/^u[A-Z]\w*$/);
      expect(FX_UNIFORMS).not.toContain(t.name);
      expect(def.params.map((p) => p.name)).not.toContain(t.name);
      expect(fxSource(def)).toMatch(new RegExp(`uniform sampler2D[^;]*\\b${t.name}\\b`));
      expect(fxUniformNames(def)).toContain(t.name);
    }
  });

  it('gives the gator skin a height map input that it actually samples', () => {
    const skin = fxById('skin')!;
    expect(skin.textures).toEqual([{ name: 'uHeight', label: 'Height map' }]);
    expect(skin.body).toContain('uHeight');
    expect(skin.body).toContain('caustic(');
  });

  it('scales large images down to the GPU limit, keeping their shape', () => {
    expect(fitImageSize(1920, 1080)).toEqual([1920, 1080]);
    expect(fitImageSize(8192, 4096)).toEqual([MAX_IMAGE_PX, 2048]);
    expect(fitImageSize(3000, 9000, 900)).toEqual([300, 900]);
    expect(fitImageSize(0, 100)).toEqual([1, 1]);
  });
});

describe('speed clocks', () => {
  it('give every clock a valid, unique uniform that the shader declares and uses', () => {
    for (const def of FX) {
      const clocks = def.params.flatMap((p) => (p.clock ? [p.clock] : []));
      expect(new Set(clocks).size).toBe(clocks.length);
      for (const c of clocks) {
        expect(c).toMatch(/^u[A-Z]\w*$/);
        expect(FX_UNIFORMS).not.toContain(c);
        expect(def.params.map((p) => p.name)).not.toContain(c);
        expect(fxUniformNames(def)).toContain(c);
        expect(def.body).toContain(c);
      }
    }
  });

  it('drives water and skin motion from clocks rather than uTime × speed', () => {
    expect(fxById('water')!.body).not.toMatch(/uTime\s*\*\s*uSpeed/);
    expect(fxById('skin')!.body).not.toMatch(/uTime\s*\*\s*uLightSpeed/);
  });
});

describe('eye shader', () => {
  const eye = fxById('eye')!;

  it('has the settings the show needs', () => {
    const names = eye.params.map((p) => p.name);
    for (const n of ['uOpen', 'uPupilX', 'uPupilWidth', 'uBlinkRate', 'uWander']) expect(names).toContain(n);
    expect(eye.triggers).toEqual([{ id: 'blink', label: 'Blink' }]);
  });

  it('declares live uniforms and leaves engine-only settings out of the shader', () => {
    const src = fxSource(eye);
    for (const n of eye.live!) expect(src).toMatch(new RegExp(`uniform float[^;]*\\b${n}\\b`));
    for (const p of eye.params.filter((x) => x.engine)) {
      expect(src).not.toMatch(new RegExp(`\\b${p.name}\\b`));
      expect(fxUniformNames(eye)).not.toContain(p.name);
    }
  });

  it('closes the lids by both the open setting and the blink', () => {
    expect(eye.body).toMatch(/uOpen\s*\*\s*\(1\.0 - uBlink\)/);
    expect(eye.body).toContain('uWanderX');
  });
});

describe('skin reveal', () => {
  it('has a reveal radius that starts fully revealed', () => {
    const p = fxById('skin')!.params.find((x) => x.name === 'uReveal')!;
    expect(p.default).toBe(p.max);
  });
});
