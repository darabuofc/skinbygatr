import type { FxDef } from './index';

/*
 * More looks for the backdrop, in the same deep-water world as the bioluminescent water.
 * Each uses square panel units (1 = panel height, y up, surface at the top) and its own
 * speed clock, so a speed change slows the motion rather than jumping it.
 */

/** Drifting jellyfish: glowing bells that rise and sway, pulsing on the kick, with waving tentacles. */
export const jelly: FxDef = {
  id: 'jelly',
  name: 'Jellyfish',
  description: 'Glowing jellyfish rising through dark water, bells pulsing on the kick, tentacles trailing.',
  scale: 0.75,
  params: [
    { name: 'uCount', label: 'Jellyfish', min: 1, max: 6, default: 4 },
    { name: 'uSize', label: 'Size', min: 0.5, max: 2, default: 1 },
    { name: 'uDrift', label: 'Drift speed', min: 0, max: 2, default: 1, clock: 'uJellyT' },
    { name: 'uPulse', label: 'Kick pulse', min: 0, max: 1, default: 0.6 },
    { name: 'uGlow', label: 'Glow', min: 0, max: 1, default: 0.6 },
    { name: 'uCaustic', label: 'Caustics behind', min: 0, max: 1, default: 0.25 },
  ],
  body: `
vec3 fx(vec2 fc) {
  vec2 uv = fc / uRes;
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y);
  float t = uJellyT;
  float r = clamp(uReact, 0.0, 1.0);

  vec3 col = vec3(0.0, 0.02, 0.045) + vec3(0.03, 0.4, 0.42) * caustic(p * 4.0 + vec2(0.0, uTime * 0.05), uTime) * uCaustic * 0.4;

  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float present = clamp(uCount - fi, 0.0, 1.0);
    if (present <= 0.0) continue;
    vec2 h = hash2(vec2(fi * 3.1, 7.7));
    float s = 0.075 * uSize * (0.7 + 0.6 * h.y);
    // Rise slowly from below the panel to above it, then wrap round; sway side to side.
    float y = mix(-0.35, 1.35, fract(h.y * 5.3 + t * (0.018 + 0.012 * h.x)));
    vec2 c = vec2((0.1 + 0.8 * h.x) * asp + 0.05 * sin(t * 0.4 + fi * 1.7), y);
    vec2 d = p - c;
    // The bell contracts gently on its own rhythm, and harder on the kick.
    float beat = 0.5 + 0.5 * sin(t * 1.6 + fi * 2.3);
    float squeeze = 1.0 - 0.12 * beat - 0.18 * uPulse * uKick * (0.4 + 0.6 * r);
    vec2 e2 = d / vec2(s * (2.0 - squeeze), s * 0.85 * squeeze);
    float e = length(e2);
    float dome = step(-0.3, e2.y);
    vec3 tint = mix(vec3(0.2, 0.9, 1.0), mix(vec3(0.6, 0.45, 1.0), vec3(1.0, 0.45, 0.8), step(0.5, h.x)), step(0.4, fract(h.y * 7.0)));
    float fill = smoothstep(1.0, 0.6, e) * dome * 0.35;
    float rim = smoothstep(0.12, 0.0, abs(e - 0.95)) * dome;
    col += tint * (fill + rim * 0.9) * uGlow * present * (1.0 + 0.8 * uPulse * uKick);
    // Tentacles: four waving lines below the bell, fading with depth.
    if (d.y < 0.0 && d.y > -s * 3.5 && abs(d.x) < s * 1.2) {
      for (int k = 0; k < 4; k++) {
        float fk = float(k);
        float x0 = s * (fk - 1.5) * 0.4 + sin(d.y / s * 2.5 - t * 2.0 + fk * 1.3 + fi) * s * 0.15;
        float line = smoothstep(s * 0.06, 0.0, abs(d.x - x0)) * (1.0 + d.y / (s * 3.5));
        col += tint * line * 0.45 * uGlow * present;
      }
    }
  }
  return col;
}`,
};

/** Light shafts from the surface, swaying, with marine snow drifting down through them. */
export const shafts: FxDef = {
  id: 'shafts',
  name: 'Light shafts',
  description: 'Rays of light slanting down from the surface, swaying, with marine snow drifting through them.',
  scale: 0.75,
  params: [
    { name: 'uRays', label: 'Ray strength', min: 0, max: 1.5, default: 0.8 },
    { name: 'uAngle', label: 'Ray angle', min: -0.6, max: 0.6, default: 0.15 },
    { name: 'uSway', label: 'Sway', min: 0, max: 1, default: 0.4 },
    { name: 'uSpeed', label: 'Speed', min: 0, max: 3, default: 1, clock: 'uShaftT' },
    { name: 'uSnow', label: 'Marine snow', min: 0, max: 1, default: 0.5 },
    { name: 'uSurface', label: 'Surface glints', min: 0, max: 1, default: 0.6 },
  ],
  body: `
vec3 fx(vec2 fc) {
  vec2 uv = fc / uRes;
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y);
  float t = uShaftT;
  float r = clamp(uReact, 0.0, 1.0);

  vec3 col = mix(vec3(0.0, 0.01, 0.03), vec3(0.0, 0.05, 0.08), uv.y);

  // Rays: noise stretched along a slanted direction, brightest near the surface.
  float rx = p.x + (1.0 - uv.y) * uAngle + sin(t * 0.25) * uSway * 0.12;
  float rays = 0.0;
  rays += pow(noise(vec2(rx * 6.0, t * 0.12)), 3.0);
  rays += 0.6 * pow(noise(vec2(rx * 13.0 + 5.0, t * 0.2)), 4.0);
  rays += 0.4 * pow(noise(vec2(rx * 25.0 + 9.0, t * 0.3)), 5.0);
  float fall = pow(clamp(uv.y, 0.0, 1.0), 1.6);
  col += vec3(0.25, 0.85, 0.8) * rays * fall * uRays * (0.8 + 0.6 * r * uBass);

  // Glints along the surface.
  col += vec3(0.4, 1.0, 0.95) * caustic(p * 6.0 + vec2(t * 0.05, 0.0), t) * smoothstep(0.82, 1.0, uv.y) * uSurface * 0.6;

  // Marine snow: sparse specks sinking slowly, a little brighter inside the rays.
  vec2 sp = p * 38.0 + vec2(0.0, t * 0.35);
  vec2 cell = floor(sp), f = fract(sp) - 0.5;
  vec2 h = hash2(cell);
  float present = step(1.0 - 0.15 * uSnow, h.x);
  float speck = smoothstep(0.14, 0.0, length(f - (h - 0.5) * 0.6));
  col += vec3(0.75, 0.95, 1.0) * speck * present * uSnow * (0.35 + rays * fall * 1.5);
  return col;
}`,
};

/** Rings of light spreading across the water from a new spot on every kick. */
export const ripples: FxDef = {
  id: 'ripples',
  name: 'Kick ripples',
  description: 'Each kick drops a ring of light into the water that spreads, bending the caustics as it passes.',
  scale: 0.75,
  params: [
    { name: 'uReach', label: 'Ring reach', min: 0.2, max: 1.5, default: 0.7 },
    { name: 'uRingWidth', label: 'Ring width', min: 0.2, max: 2, default: 1 },
    { name: 'uSpread', label: 'Where rings start', min: 0, max: 1, default: 0.7 },
    { name: 'uGlow', label: 'Ring glow', min: 0, max: 1, default: 0.7 },
    { name: 'uCaustic', label: 'Caustics', min: 0, max: 1.5, default: 0.6 },
  ],
  body: `
vec3 fx(vec2 fc) {
  vec2 uv = fc / uRes;
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y);

  float rings = 0.0;
  vec2 bend = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    float tk = uKicks[i];
    if (tk > 3.0) continue;
    // Each kick starts from its own spot: the beat count it landed on picks it.
    vec2 h = hash2(vec2(uBeat - float(i), 3.7));
    vec2 c = vec2(0.5 * asp, 0.5) + (h - 0.5) * vec2(asp, 1.0) * uSpread;
    vec2 d = p - c;
    float dist = length(d);
    float rad = tk * 0.45 * uReach;
    float w = 0.012 * uRingWidth * (1.0 + 2.0 * tk);
    float ring = exp(-tk * 1.3) * smoothstep(w, 0.0, abs(dist - rad));
    rings += ring;
    bend += normalize(d + 1e-5) * ring * 0.04;
  }
  vec3 col = vec3(0.0, 0.025, 0.05);
  col += vec3(0.05, 0.75, 0.75) * caustic((p + bend) * 4.0 + vec2(0.0, uTime * 0.05), uTime) * uCaustic * 0.45;
  col += vec3(0.4, 1.0, 0.95) * min(rings, 1.5) * uGlow;
  return col;
}`,
};

/** A dense swirl of bioluminescent plankton that swells with the music. */
export const plankton: FxDef = {
  id: 'plankton',
  name: 'Plankton storm',
  description: 'Dense, swirling bioluminescent plankton that thickens and brightens with the bass.',
  scale: 0.75,
  params: [
    { name: 'uDensity', label: 'Density', min: 0, max: 1, default: 0.7 },
    { name: 'uSwirl', label: 'Swirl', min: 0, max: 2, default: 1 },
    { name: 'uSpeed', label: 'Speed', min: 0, max: 3, default: 1, clock: 'uPlankT' },
    { name: 'uSize', label: 'Speck size', min: 0.5, max: 2, default: 1 },
    { name: 'uHue', label: 'Colour (teal to violet)', min: 0, max: 1, default: 0.15 },
    { name: 'uSwell', label: 'Swells with bass', min: 0, max: 1, default: 0.6 },
  ],
  body: `
float specks(vec2 q, float scale, float thresh, float t, float size) {
  vec2 sp = q * scale;
  vec2 cell = floor(sp), f = fract(sp) - 0.5;
  vec2 h = hash2(cell);
  float present = step(thresh, h.x);
  float tw = 0.4 + 0.6 * pow(0.5 + 0.5 * sin(t * (0.8 + 2.0 * h.y) + h.x * 30.0), 6.0);
  float d = length(f - (h - 0.5) * 0.6);
  // A bright core with a soft halo, so specks read as glowing points rather than dust.
  return (smoothstep(0.1 * size, 0.0, d) + 0.35 * smoothstep(0.3 * size, 0.0, d)) * present * tw;
}

vec3 fx(vec2 fc) {
  vec2 uv = fc / uRes;
  vec2 p = vec2(uv.x * uRes.x / uRes.y, uv.y);
  float t = uPlankT;
  float r = clamp(uReact, 0.0, 1.0);

  // Swirling flow: warp the lookup with slowly moving noise.
  vec2 w = vec2(fbm(p * 1.4 + vec2(t * 0.05, 0.0)), fbm(p * 1.4 + vec2(7.3, -t * 0.04))) - 0.5;
  vec2 q = p + w * uSwirl + vec2(t * 0.02, t * 0.015);

  float swell = uSwell * r * uBass;
  float thresh = 1.0 - uDensity * (0.35 + 0.3 * swell);
  float s = specks(q, 22.0, thresh, t, uSize) + 0.7 * specks(q + 3.3, 41.0, thresh, t * 1.3, uSize);

  vec3 teal = vec3(0.15, 1.0, 0.85), violet = vec3(0.6, 0.35, 1.0);
  vec3 tint = mix(teal, violet, clamp(uHue + 0.25 * (w.x + 0.5) - 0.12, 0.0, 1.0));
  vec3 col = vec3(0.0, 0.015, 0.035);
  col += tint * smoothstep(0.35, 0.9, fbm(q * 2.0)) * uDensity * 0.35 * (1.0 + swell);
  col += tint * s * (1.3 + 1.0 * swell);
  return col;
}`,
};
