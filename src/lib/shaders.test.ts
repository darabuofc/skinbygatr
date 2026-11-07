import { describe, expect, it } from 'vitest';
import { MESH_VS, NEON_FS, NEON_VS, PANEL_FS, PANEL_MESH_FS, POST_FS, SCENE_FS, VS } from './shaders';

/** Uniform names declared in a shader, including comma lists like `uniform float uA, uB;` and arrays. */
function declared(src: string) {
  const names = new Set<string>();
  for (const m of src.matchAll(/uniform\s+\w+\s+([^;]+);/g)) {
    for (const n of m[1].split(',')) names.add(n.trim().replace(/\[.*$/, ''));
  }
  return names;
}

describe('shaders', () => {
  it.each([['VS', VS], ['SCENE_FS', SCENE_FS], ['PANEL_FS', PANEL_FS], ['PANEL_MESH_FS', PANEL_MESH_FS], ['MESH_VS', MESH_VS], ['POST_FS', POST_FS], ['NEON_FS', NEON_FS], ['NEON_VS', NEON_VS]])(
    '%s declares every uniform it uses',
    (_, src) => {
      const used = new Set(src.match(/\bu[A-Z]\w*/g) ?? []);
      const have = declared(src);
      expect([...used].filter((u) => !have.has(u))).toEqual([]);
    },
  );

  it('keeps scene functions out of the vertex shader', () => {
    expect(VS).not.toMatch(/\bvec3\s+\w+\s*\(vec2/);
    expect(VS.match(/void main\(/g)).toHaveLength(1);
  });

  it('builds the mesh panel shader from the same body, with the panel position from the mesh', () => {
    expect(PANEL_MESH_FS).toContain('in vec2 vUv;');
    expect(PANEL_MESH_FS).not.toContain('uInvH');
    expect(PANEL_FS).toContain('uniform mat3 uInvH;');
    // Everything after the panel position is shared, so flat and mesh panels look the same.
    const tail = (src: string) => src.slice(src.indexOf('vec2 s0 ='));
    expect(tail(PANEL_MESH_FS)).toBe(tail(PANEL_FS));
  });

  it('gives flat and mesh panels the same transitions', () => {
    for (const src of [PANEL_FS, PANEL_MESH_FS]) {
      expect(src).toContain('vec3 transition(vec3 a, vec3 b, float m, vec2 uv)');
      expect(src).toContain('col = transition(colB, col, uMix, uv);');
    }
  });

  it('the post pass ends with gamma, warmth and a brightness ceiling that can only dim', () => {
    expect(POST_FS).toMatch(/pow\(col, vec3\(uGamma\)\)/);
    expect(POST_FS).toMatch(/o = vec4\(col \* uCap, 1\.0\)/);
    // Warmth factors are all at most 1, so they can't push a channel past the ceiling.
    expect(POST_FS).not.toMatch(/1\.0 \+ 0\.\d+ \*/);
  });

  it('scenes keep square cells and visible lines on any screen shape', () => {
    // Grid columns follow the aspect ratio (no fixed 8 x 5 stretched over a square screen).
    expect(SCENE_FS).not.toContain('vec2(8.0, 5.0)');
    expect(SCENE_FS).toMatch(/cols\s*=.*uRes\.x \/ uRes\.y/);
    // Thin lines are floored at 1.5 pixels, so a small LED screen doesn't flicker them away.
    expect(SCENE_FS).toMatch(/float thin\(float w\) \{ return max\(w, 1\.5 \* px\(\)\); \}/);
    expect((SCENE_FS.match(/thin\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});
