import type { FxDef } from './index';

/**
 * Scaled reptile skin for a sculpted head, shaped by a greyscale height map of the sculpture
 * (white = closest to the projector). The map lights the relief with a slowly swinging light,
 * sets the scale size (bigger on high ground, finer in the folds) and darkens low areas as
 * shadow. Glowing grooves and the shared water caustics make it part of the same world as the
 * backdrop: the caustics run on the same clock, ripple size and speed as the water's defaults,
 * so the light on the head moves in step with the backdrop. Without a height map it renders as
 * an evenly lit, flat surface.
 */
export const skin: FxDef = {
  id: 'skin',
  name: 'Reptile skin (height map)',
  description: 'Lit scales shaped by a height map, with glowing grooves and the water’s caustics.',
  scale: 1,
  textures: [{ name: 'uHeight', label: 'Height map' }],
  params: [
    { name: 'uScaleSize', label: 'Scale size', min: 6, max: 60, default: 22 },
    { name: 'uScaleVar', label: 'Scale size follows relief', min: 0, max: 1, default: 0.5 },
    { name: 'uRelief', label: 'Relief lighting', min: 0, max: 2, default: 1 },
    { name: 'uLightSpeed', label: 'Light swing', min: 0, max: 2, default: 0.3, clock: 'uLightT' },
    { name: 'uShadow', label: 'Shadow in folds', min: 0, max: 1, default: 0.6 },
    { name: 'uCaustic', label: 'Caustic strength', min: 0, max: 1.5, default: 0.6 },
    { name: 'uGlow', label: 'Scale glow', min: 0, max: 1, default: 0.4 },
    { name: 'uReveal', label: 'Reveal radius', min: 0, max: 1.5, default: 1.5 },
    { name: 'uWave', label: 'Glow wave', min: 0, max: 1, default: 0.4 },
    { name: 'uWaveSpeed', label: 'Glow wave speed', min: 0, max: 2, default: 0.5, clock: 'uWaveT' },
    { name: 'uSheen', label: 'Wet sheen', min: 0, max: 1, default: 0.35 },
    { name: 'uBreath', label: 'Breathing', min: 0, max: 1, default: 0.3 },
  ],
  body: `
// Height at a panel position; image rows run top to bottom.
float heightAt(vec2 uv, float lod) { return textureLod(uHeight, vec2(uv.x, 1.0 - uv.y), lod).r; }

vec3 fx(vec2 fc) {
  vec2 uv = fc / uRes;
  float asp = uRes.x / uRes.y;
  vec2 sq = vec2(uv.x * asp, uv.y);
  float r = clamp(uReact, 0.0, 1.0);

  // Relief: a normal from the height map's slope, lit by a light that swings slowly across.
  float h = heightAt(uv, 0.0);
  vec2 e = 1.5 / uRes;
  float hx = heightAt(uv + vec2(e.x, 0.0), 0.0) - heightAt(uv - vec2(e.x, 0.0), 0.0);
  float hy = heightAt(uv + vec2(0.0, e.y), 0.0) - heightAt(uv - vec2(0.0, e.y), 0.0);
  vec3 n = normalize(vec3(-hx * 40.0 * uRelief, -hy * 40.0 * uRelief, 1.0));
  float a = uLightT;
  vec3 l = normalize(vec3(0.7 * cos(a), 0.45 + 0.3 * sin(a * 0.7), 0.65));
  float diff = clamp(dot(n, l), 0.0, 1.0);

  // Scales: rounded cells, larger on high ground. A blurred height sets the size, so scales
  // grow and shrink gradually instead of tearing at sharp edges in the map.
  float hs = heightAt(uv, 5.0);
  vec2 p = sq * uScaleSize * mix(1.0, 0.6, hs * uScaleVar);
  vec2 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      float d = length(g + 0.15 + 0.7 * hash2(i + g) - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  float inside = smoothstep(0.0, 0.12, d2 - d1);
  float dome = clamp(1.0 - d1 * 1.1, 0.0, 1.0);

  vec3 skinCol = vec3(0.10, 0.32, 0.26);
  vec3 col = vec3(0.01, 0.03, 0.025) + skinCol * diff * (0.45 + 0.55 * dome) * inside;

  // Caustic light from the water, falling on the lit side.
  float c = caustic(sq * 4.0 + vec2(0.0, uTime * 0.05), uTime);
  col += vec3(0.05, 0.85, 0.8) * c * uCaustic * 0.5 * (0.3 + 0.7 * diff);

  // Grooves between scales glow softly, breathing, and lift with the bass.
  float breathe = 0.6 + 0.4 * sin(uTime * 0.8 + hs * 6.0);
  col += vec3(0.1, 1.0, 0.85) * (1.0 - inside) * uGlow * 0.35 * breathe * (1.0 + r * 1.5 * uBass);

  // Wet sheen: a tight highlight off each scale's dome, following the swinging light.
  vec3 refl = reflect(-l, n);
  float spec = pow(max(refl.z, 0.0), 24.0) * dome * inside;
  col += vec3(0.7, 1.0, 0.95) * spec * uSheen * 0.6;

  // Glow wave: a band of light rolling slowly across the head, lighting the grooves as it passes.
  float phase = fract(dot(sq, vec2(0.55, 0.35)) * 0.8 - uWaveT * 0.12);
  float band = smoothstep(0.14, 0.0, abs(phase - 0.5));
  col += vec3(0.15, 1.0, 0.85) * band * uWave * (0.25 + 0.75 * (1.0 - inside)) * 0.6;

  // Breathing: the whole head swells gently brighter and dimmer.
  col *= 1.0 + uBreath * 0.35 * sin(uTime * 0.6);

  // Shadow: low parts of the sculpture fall away into the dark.
  col *= mix(1.0, smoothstep(0.0, 0.55, h), uShadow);

  // Reveal: the skin shows within this distance of the panel's centre, with a soft glowing edge,
  // so the head can emerge from the dark. At the top of the range everything shows.
  float rd = length((uv - 0.5) * vec2(asp, 1.0)) / max(0.5 * asp, 0.5);
  float shown = smoothstep(uReveal, uReveal - 0.15, rd);
  col = col * shown + vec3(0.1, 1.0, 0.85) * 0.5 * smoothstep(0.08, 0.0, abs(rd - uReveal + 0.07)) * step(0.01, uReveal) * step(uReveal, 1.45);
  return col;
}`,
};
