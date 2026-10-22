import { describe, expect, it } from 'vitest';
import { BLEND_FUNCS, tryLink } from './renderer';
import { BLEND_MODES } from './types';

/** Just enough of WebGL2 to compile and link, failing any fragment shader that contains `BROKEN`. */
function fakeGl() {
  const deleted = { shaders: 0, programs: 0 };
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    createShader: (type: number) => ({ type, src: '' }),
    shaderSource: (s: { src: string }, src: string) => { s.src = src; },
    compileShader: () => {},
    getShaderParameter: (s: { src: string }) => !s.src.includes('BROKEN'),
    getShaderInfoLog: () => "ERROR: 0:3: 'BROKEN' : syntax error",
    deleteShader: () => { deleted.shaders++; },
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => { deleted.programs++; },
    getUniformLocation: (_p: unknown, n: string) => ({ n }),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, deleted };
}

describe('tryLink', () => {
  it('returns the program and its uniforms when the shader compiles', () => {
    const { gl } = fakeGl();
    const errors: string[] = [];
    const prog = tryLink(gl, '#version 300 es\nvoid main(){}', ['uTime'], (m) => errors.push(m));
    expect(prog).not.toBeNull();
    expect(prog!.u.uTime).toEqual({ n: 'uTime' });
    expect(errors).toEqual([]);
  });

  it('returns null and reports the driver log instead of throwing', () => {
    const { gl, deleted } = fakeGl();
    const errors: string[] = [];
    const prog = tryLink(gl, 'BROKEN', ['uTime'], (m) => errors.push(m));
    expect(prog).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('BROKEN');
    // The vertex shader that did compile and the half-built program are freed.
    expect(deleted.programs).toBe(1);
    expect(deleted.shaders).toBeGreaterThanOrEqual(2);
  });
});

describe('BLEND_FUNCS', () => {
  type V = [number, number, number];
  /** What GL does with a blend func, per channel: src·F(src) + dst·F(dst). Src is premultiplied. */
  function glBlend(mode: keyof typeof BLEND_FUNCS, c: V, a: number, d: V): V {
    const s = c.map((x) => x * a) as V;
    const factor = (f: string, i: number) => ({
      ONE: 1, ONE_MINUS_SRC_ALPHA: 1 - a, ONE_MINUS_SRC_COLOR: 1 - s[i], DST_COLOR: d[i],
    } as Record<string, number>)[f];
    const [sf, df] = BLEND_FUNCS[mode];
    return s.map((sv, i) => sv * factor(sf, i) + d[i] * factor(df, i)) as V;
  }
  /** The mode applied at full strength, then faded towards the background by alpha. */
  const reference: Record<keyof typeof BLEND_FUNCS, (c: number, d: number) => number> = {
    over: (c) => c,
    add: (c, d) => c + d,
    screen: (c, d) => 1 - (1 - c) * (1 - d),
    multiply: (c, d) => c * d,
  };
  const c: V = [0.8, 0.4, 0.1], d: V = [0.2, 0.5, 0.9];

  it.each(Object.keys(BLEND_FUNCS) as (keyof typeof BLEND_FUNCS)[])('%s matches its formula at full opacity', (mode) => {
    glBlend(mode, c, 1, d).forEach((v, i) => expect(v).toBeCloseTo(reference[mode](c[i], d[i]), 6));
  });

  it.each(['over', 'screen', 'multiply'] as const)('%s fades linearly towards what is beneath', (mode) => {
    const a = 0.3;
    glBlend(mode, c, a, d).forEach((v, i) => expect(v).toBeCloseTo(d[i] + a * (reference[mode](c[i], d[i]) - d[i]), 6));
  });

  it('adds only its faded light', () => {
    glBlend('add', c, 0.3, d).forEach((v, i) => expect(v).toBeCloseTo(d[i] + 0.3 * c[i], 6));
  });

  it.each(Object.keys(BLEND_FUNCS) as (keyof typeof BLEND_FUNCS)[])('%s at zero opacity leaves the layers beneath untouched', (mode) => {
    glBlend(mode, c, 0, d).forEach((v, i) => expect(v).toBeCloseTo(d[i], 6));
  });

  it('covers every blend mode', () => {
    expect(Object.keys(BLEND_FUNCS).sort()).toEqual(BLEND_MODES.map(([m]) => m).sort());
  });
});
