import type { FxDef } from './index';

/**
 * Bioluminescent water for the backdrop: deep blue-black water, teal caustic light that is
 * brightest near the surface, and drifting plankton that twinkles and flares on the kick.
 * Uses the shared `caustic`, so light on other surfaces moves in step with it.
 */
export const water: FxDef = {
  id: 'water',
  name: 'Bioluminescent water',
  description: 'Teal caustics over deep water with drifting, twinkling plankton.',
  scale: 0.75,
  params: [
    { name: 'uCaustic', label: 'Caustic strength', min: 0, max: 2, default: 1 },
    { name: 'uScale', label: 'Ripple size', min: 1.5, max: 12, default: 4 },
    { name: 'uSpeed', label: 'Speed', min: 0, max: 3, default: 1, clock: 'uWaterT' },
    { name: 'uDepth', label: 'Depth fade', min: 0, max: 1, default: 0.6 },
    { name: 'uSparkle', label: 'Plankton', min: 0, max: 1, default: 0.5 },
    { name: 'uGlow', label: 'Water glow', min: 0, max: 1, default: 0.35 },
  ],
  body: `
vec3 fx(vec2 fc) {
  // 0..1 across the panel, y up, so the surface (top of the panel) is y = 1.
  vec2 uv = fc / uRes;
  // Square units, 1 = panel height, so ripples stay round on any panel shape.
  vec2 p = vec2(uv.x * uRes.x / uRes.y, uv.y);
  // Runs at uSpeed; equals uTime at speed 1, so it stays in step with the skin's caustics.
  float t = uWaterT;
  float r = clamp(uReact, 0.0, 1.0);

  // Deep water: darker further down, with slow drifting murk.
  float depth = mix(1.0, 0.25 + 0.75 * uv.y, uDepth);
  float murk = fbm(p * 2.5 + vec2(t * 0.03, -t * 0.02));
  vec3 col = vec3(0.0, 0.025, 0.05) + vec3(0.0, 0.10, 0.14) * murk * uGlow;

  // Caustic light, lifted by the bass and the kick as far as reactivity allows.
  float c = caustic(p * uScale + vec2(0.0, t * 0.05), t);
  float lift = 1.0 + r * (1.4 * uBass + 0.6 * uKick);
  vec3 teal = vec3(0.05, 0.85, 0.8);
  vec3 crest = vec3(0.65, 1.0, 0.95);
  col += mix(teal, crest, smoothstep(0.7, 1.1, c)) * c * uCaustic * 0.6 * lift * depth;

  // Plankton: sparse points drifting upwards, each twinkling at its own rate.
  vec2 sp = p * 34.0 - vec2(0.0, t * 0.6);
  vec2 cell = floor(sp), f = fract(sp) - 0.5;
  vec2 h = hash2(cell);
  float present = step(1.0 - 0.18 * uSparkle, h.x);
  float twinkle = pow(0.5 + 0.5 * sin(t * (0.7 + 1.6 * h.y) + h.x * 40.0), 10.0);
  float spark = smoothstep(0.16, 0.0, length(f - (h - 0.5) * 0.6));
  col += crest * spark * present * twinkle * uSparkle * (1.0 + 2.5 * r * uKick) * (0.4 + 0.6 * depth);
  return col;
}`,
};
