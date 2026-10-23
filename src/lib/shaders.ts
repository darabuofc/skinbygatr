/** Full-screen triangle; no vertex buffers needed in WebGL2. */
export const VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Hash, value noise and fbm, shared by the scenes and the panel shaders (src/lib/fx). */
export const NOISE_GLSL = `float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }`;

/** Generated, audio-reactive scenes rendered into an offscreen 1080p texture. */
export const SCENE_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 uRes;
uniform float uTime, uBass, uMid, uHigh, uKick, uBeat, uSince, uPhaseA, uPhaseB;
uniform int uScene;
uniform vec3 uC1, uC2;
uniform sampler2D uSpec;
uniform float uKicks[8];

${NOISE_GLSL}

vec3 pulse(vec2 fc) {
  vec2 p = (fc - 0.5 * uRes) / uRes.y;
  float d = length(p);
  vec3 col = uC2 * smoothstep(0.1 + uBass * 0.35, 0.0, d) * (0.25 + 0.75 * uBass);
  for (int i = 0; i < 8; i++) {
    float t = uKicks[i];
    if (t < 3.0) {
      float r = t * (0.55 + uMid * 0.9);
      float w = 0.006 + 0.035 * uBass * exp(-t * 2.0);
      col += uC1 * exp(-t * 1.3) * smoothstep(w, 0.0, abs(d - r));
    }
  }
  return col;
}

vec3 spectrum(vec2 fc) {
  vec2 uv = fc / uRes;
  float x = abs(uv.x - 0.5) * 2.0;
  float n = 48.0;
  float bi = floor(x * n);
  float v = texture(uSpec, vec2(pow(bi / n, 1.4) * 0.95 + 0.01, 0.5)).r;
  float gap = step(0.14, fract(x * n));
  float h = abs(uv.y - 0.5) * 2.0;
  return mix(uC1, uC2, step(0.75, v)) * step(h, v * 0.95) * gap * (0.35 + 0.65 * v);
}

vec3 scan(vec2 fc) {
  float y = fc.y / uRes.y;
  vec3 col = vec3(0.0);
  for (int k = 0; k < 10; k++) {
    float fk = float(k);
    bool major = mod(fk, 3.0) < 0.5;
    float yy = fract(fk / 10.0 + uPhaseA);
    float th = 0.002 + uBass * 0.03 * (major ? 1.0 : 0.35);
    float a = 0.35 + 0.65 * (mod(fk, 2.0) > 0.5 ? uHigh : uBass);
    float dy = abs(y - yy); dy = min(dy, 1.0 - dy);
    col += (major ? uC2 : uC1) * a * smoothstep(th + 0.0015, th * 0.5, dy);
  }
  return col + uC1 * 0.2 * uKick;
}

vec3 grid(vec2 fc) {
  vec2 g = fc / uRes * vec2(8.0, 5.0);
  vec2 c = floor(g), f = fract(g);
  float inside = step(0.04, f.x) * step(f.x, 0.96) * step(0.06, f.y) * step(f.y, 0.94);
  float lit = 0.0;
  if (hash(c + uBeat * 1.37) < 0.1 + 0.25 * uBass) lit = exp(-uSince * 3.0);
  if (hash(c + floor(uTime * 8.0) * 0.71) < uHigh * 0.12) lit = max(lit, 0.6);
  return mix(uC1, uC2, step(0.8, hash(c + 3.1))) * lit * inside;
}

vec3 tunnel(vec2 fc) {
  vec2 p = (fc - 0.5 * uRes) / uRes.y;
  float a = sin(uTime * 0.3) * 0.25 * uMid;
  p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
  vec2 q = p / vec2(uRes.x / uRes.y, 1.0) * 2.0;
  float d = max(abs(q.x), abs(q.y));
  float z = -log(d + 1e-4) * 1.6 + uPhaseB;
  float s = fract(z);
  float w = 0.05 + uBass * 0.18;
  float line = smoothstep(w, 0.0, s) + smoothstep(1.0 - w * 0.3, 1.0, s);
  return mix(uC1, uC2, step(3.0, mod(floor(z), 4.0))) * line * smoothstep(0.02, 0.25, d);
}

vec3 smoke(vec2 fc) {
  vec2 p = fc / uRes.y;
  float n = fbm(p * 2.2 + vec2(uTime * 0.04, uPhaseA * 0.4));
  float m = fbm(p * 4.0 - vec2(uPhaseB * 0.3, uTime * 0.03));
  return uC1 * smoothstep(0.45, 0.95, n) * (0.25 + 0.9 * uBass) + uC2 * smoothstep(0.62, 0.9, m) * (0.2 + uHigh);
}

vec3 kaleido(vec2 fc) {
  vec2 p = (fc - 0.5 * uRes) / uRes.y * (1.0 - 0.2 * uKick);
  float r = length(p);
  float seg = 6.2831853 / 8.0;
  float a = mod(atan(p.y, p.x) + uPhaseA * 0.5, seg);
  a = abs(a - seg * 0.5);
  vec2 q = vec2(cos(a), sin(a)) * r + vec2(uPhaseB * 0.12, 0.0);
  float n = fbm(q * 3.0 + uTime * 0.05);
  float bands = sin(n * 14.0 + r * 8.0 - uPhaseB * 2.0);
  float line = smoothstep(0.9 - 0.35 * uBass, 1.0, bands);
  vec3 col = mix(uC1, uC2, smoothstep(0.35, 0.65, n)) * line * (0.4 + 0.8 * uMid);
  return col * (smoothstep(1.1, 0.1, r) + 0.15) + uC2 * uHigh * 0.25 * smoothstep(0.35, 0.8, n) * line;
}

vec3 lasers(vec2 fc) {
  vec2 p = fc / uRes.y;
  vec2 d = p - vec2(0.5 * uRes.x / uRes.y, -0.05);
  float len = length(d);
  float ang = atan(d.x, d.y);
  float fan = 1.9 * (0.65 + 0.35 * sin(uPhaseA * 1.3));
  vec3 col = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float base = (fi / 11.0 - 0.5) * fan + sin(uPhaseA * 2.0 + fi * 0.9) * 0.06;
    float off = ang - base;
    float dist = abs(sin(off)) * len;
    float w = 0.0015 + 0.006 * uBass;
    float on = step(0.3, hash(vec2(fi, floor(uBeat))));
    float beam = (smoothstep(w, 0.0, dist) + 0.35 * exp(-dist * 90.0)) * step(0.0, cos(off));
    col += mix(uC1, uC2, mod(fi, 2.0)) * beam * on * (0.6 + 0.4 * uHigh);
  }
  return col * (0.5 + 0.7 * uKick) * smoothstep(1.4, 0.2, len);
}

vec3 warp(vec2 fc) {
  vec2 p = (fc - 0.5 * uRes) / uRes.y;
  float r = length(p);
  float a = atan(p.y, p.x);
  vec3 col = vec3(0.0);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float n = 48.0 + fl * 24.0;
    vec2 q = vec2(a / 6.2831853 * n, log(r + 1e-4) * 5.0 - uPhaseB * (2.5 + fl));
    vec2 id = floor(q), f = fract(q);
    float h = hash(id + fl * 7.13);
    if (h > 0.72) {
      float xp = 0.2 + 0.6 * fract(h * 17.3);
      float tail = 0.85 - (0.12 + 0.5 * uBass + 0.3 * uKick);
      float streak = smoothstep(0.09, 0.0, abs(f.x - xp)) * smoothstep(tail, 0.85, f.y) * step(f.y, 0.85);
      col += mix(uC1, uC2, step(0.7, fract(h * 13.1))) * streak;
    }
  }
  return col * smoothstep(0.02, 0.35, r) * (0.7 + 0.5 * uMid) + uC2 * 0.15 * uKick * smoothstep(0.3, 0.0, r);
}

vec3 radial(vec2 fc) {
  vec2 p = (fc - 0.5 * uRes) / uRes.y;
  float r = length(p);
  float a = mod(atan(p.y, p.x) + uPhaseA * 0.2 + 3.1415927, 6.2831853) - 3.1415927;
  float x = abs(a) / 3.1415927;
  float n = 40.0;
  float bi = floor(x * n);
  float v = texture(uSpec, vec2(pow(bi / n, 1.4) * 0.95 + 0.01, 0.5)).r;
  float inner = 0.16 + 0.06 * uKick;
  float bar = step(inner, r) * step(r, inner + 0.02 + v * 0.34) * step(0.18, fract(x * n));
  vec3 col = mix(uC1, uC2, smoothstep(0.1, 0.3, r - inner)) * bar * (0.4 + 0.6 * v);
  col += uC2 * smoothstep(0.006, 0.0, abs(r - inner + 0.025)) * (0.4 + uKick);
  return col + uC1 * 0.3 * uBass * smoothstep(inner - 0.04, 0.0, r);
}

float hexDist(vec2 p) { p = abs(p); return max(dot(p, vec2(0.5, 0.8660254)), p.x); }

vec3 hexes(vec2 fc) {
  vec2 p = (fc - 0.5 * uRes) / uRes.y * 7.0;
  vec2 sz = vec2(1.0, 1.7320508);
  vec2 ga = mod(p, sz) - sz * 0.5;
  vec2 gb = mod(p - sz * 0.5, sz) - sz * 0.5;
  vec2 gv = dot(ga, ga) < dot(gb, gb) ? ga : gb;
  vec2 id = p - gv;
  // Cell centres sit on a half-unit lattice; round so float error can't stripe the hash inside a cell.
  vec2 key = floor(id * vec2(2.0, 1.1547005) + 0.5);
  float d = hexDist(gv);
  float dc = length(id) / 7.0;
  float lit = 0.0;
  for (int i = 0; i < 8; i++) {
    float t = uKicks[i];
    if (t < 2.5) lit += exp(-t * 1.6) * smoothstep(0.14, 0.0, abs(dc - t * (0.6 + 0.6 * uMid)));
  }
  if (hash(key + floor(uTime * 6.0) * 0.37) < uHigh * 0.15) lit = max(lit, 0.5);
  float fill = smoothstep(0.47, 0.43, d);
  float edge = smoothstep(0.02, 0.0, abs(d - 0.46)) * 0.12 * (0.3 + uBass);
  return mix(uC1, uC2, step(0.7, hash(key + 5.3))) * min(lit, 1.0) * fill + uC1 * edge;
}

vec3 glitchLayer(float x, float y) {
  float stripes = step(0.55, hash(vec2(floor(x * 16.0 + uPhaseA * 3.0), floor(y * 3.0)))) * (0.3 + 0.5 * uMid);
  float blocks = step(0.9 - 0.25 * uBass, hash(floor(vec2(x * 10.0, y * 6.0)) + floor(uBeat) * 1.7));
  return uC1 * stripes + uC2 * blocks;
}

vec3 glitch(vec2 fc) {
  vec2 uv = fc / uRes;
  float gk = hash(vec2(floor(uv.y * 24.0), floor(uBeat) + floor(uTime * 12.0) * step(0.5, uHigh)));
  float x = uv.x + (gk - 0.5) * 2.0 * uKick * (0.08 + 0.2 * uBass) * step(0.5, gk);
  float sp = 0.003 + 0.02 * uKick;
  vec3 col = vec3(glitchLayer(x + sp, uv.y).r, glitchLayer(x, uv.y).g, glitchLayer(x - sp, uv.y).b);
  col *= 0.85 + 0.15 * sin(fc.y * 1.6);
  return col + step(0.997 - 0.01 * uHigh, hash(fc + fract(uTime))) * 0.6;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec3 c;
  if (uScene == 0) c = pulse(fc);
  else if (uScene == 1) c = spectrum(fc);
  else if (uScene == 2) c = scan(fc);
  else if (uScene == 3) c = grid(fc);
  else if (uScene == 4) c = tunnel(fc);
  else if (uScene == 5) c = smoke(fc);
  else if (uScene == 6) c = kaleido(fc);
  else if (uScene == 7) c = lasers(fc);
  else if (uScene == 8) c = warp(fc);
  else if (uScene == 9) c = radial(fc);
  else if (uScene == 10) c = hexes(fc);
  else c = glitch(fc);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/**
 * Draws one panel. Flat panels: the inverse homography maps each screen pixel back into the
 * panel's unit square, which gives exact perspective-correct warping. Mesh panels: the
 * tessellated grid carries each vertex's panel position, interpolated across its triangle.
 */
function panelFs(mesh: boolean) {
  return `#version 300 es
precision highp float;
out vec4 o;
${mesh ? 'in vec2 vUv;' : 'uniform mat3 uInvH;'}
uniform vec2 uCanvas;
uniform sampler2D uTex, uTexB;
uniform vec4 uSrc;
uniform float uFlipY, uLevel, uFlash, uFeather, uGrid, uHasTex, uMaster;
// Panel opacity, 0..1; the blend mode itself is set on the GL blend state.
uniform float uOpacity;
// Freeform mask over the whole output, in its alpha; rows run top to bottom like the canvas it came from.
uniform sampler2D uMask;
uniform float uHasMask;
uniform float uMaskUv;
// Crossfade: uTexB holds the outgoing look, uMix is the weight of the incoming one (1 = no fade).
// uTrans picks how it moves: 0 crossfade, 1 ripple wipe, 2 sparkle dissolve, 3 through black.
uniform float uFlipYB, uHasTexB, uMix, uTrans;
uniform vec3 uFlashColor, uGridColor;
// RGB split: red and blue sample this far either side of green, as a fraction of the panel width.
uniform float uSplit;
// Panel text: premultiplied, in panel space so it warps with the panel. uTextPulse follows the band.
uniform sampler2D uText;
uniform float uHasText, uTextPulse;

vec3 sampleSplit(sampler2D t, vec2 s0, float flip) {
  vec2 s = s0;
  if (flip > 0.5) s.y = 1.0 - s.y;
  if (uSplit == 0.0) return texture(t, s).rgb;
  vec2 d = vec2(uSplit * uSrc.z, 0.0);
  return vec3(texture(t, s - d).r, texture(t, s).g, texture(t, s + d).b);
}

${NOISE_GLSL}

// The outgoing look a giving way to the incoming b, m of the way through (0..1), at panel position uv.
vec3 transition(vec3 a, vec3 b, float m, vec2 uv) {
  if (uTrans < 0.5) return mix(a, b, m);
  if (uTrans < 1.5) {
    // Ripple wipe: a wavy ring of light spreads from the panel's centre, the new look inside it.
    vec2 d = uv - 0.5;
    float r = length(d) / 0.7071 + 0.035 * sin(atan(d.y, d.x) * 7.0 + m * 12.0);
    float edge = m * 1.3 - 0.15;
    float k = smoothstep(edge + 0.05, edge - 0.05, r);
    float ring = smoothstep(0.05, 0.0, abs(r - edge)) * (1.0 - m);
    return mix(a, b, k) + vec3(0.2, 1.0, 0.9) * ring * 0.9;
  }
  if (uTrans < 2.5) {
    // Sparkle dissolve: the new look grows through the old in specks, with a glint at the edges.
    float n = noise(uv * 18.0) * 0.6 + noise(uv * 55.0 + 3.0) * 0.4;
    float x = m * 1.15 - 0.075;
    float k = smoothstep(n - 0.04, n + 0.04, x);
    float glint = smoothstep(0.035, 0.0, abs(x - n)) * step(0.001, m) * step(m, 0.999);
    return mix(a, b, k) + vec3(0.6, 1.0, 0.95) * glint;
  }
  // Through black: the old look fades out completely before the new one fades in.
  return m < 0.5 ? a * (1.0 - m * 2.0) : b * (m * 2.0 - 1.0);
}

float aaLine(float dist, float fw, float px) { return 1.0 - clamp(dist / max(fw * px, 1e-6), 0.0, 1.0); }

void main() {
${mesh ? `  vec2 uv = clamp(vUv, 0.0, 1.0);` : `  vec2 px = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  vec3 q = uInvH * vec3(px, 1.0);
  if (q.z <= 0.0) discard;
  vec2 uv = q.xy / q.z;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;`}

  vec2 s0 = uSrc.xy + uv * uSrc.zw;
  vec3 col = uHasTex > 0.5 ? sampleSplit(uTex, s0, uFlipY) * uLevel : vec3(0.0);
  if (uMix < 1.0) {
    vec3 colB = uHasTexB > 0.5 ? sampleSplit(uTexB, s0, uFlipYB) * uLevel : vec3(0.0);
    col = transition(colB, col, uMix, uv);
  }
  if (uHasText > 0.5) {
    vec4 tx = texture(uText, uv);
    col = col * (1.0 - tx.a) + tx.rgb * mix(1.0, uLevel, uTextPulse);
  }
  col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
  col *= uMaster;

  if (uGrid > 0.5) {
    vec2 g = uv * vec2(10.0, 8.0);
    vec2 gd = abs(fract(g + 0.5) - 0.5);
    vec2 gw = fwidth(g);
    vec2 uw = fwidth(uv);
    float lines = max(aaLine(gd.x, gw.x, 1.5), aaLine(gd.y, gw.y, 1.5));
    float border = max(max(aaLine(uv.x, uw.x, 8.0), aaLine(1.0 - uv.x, uw.x, 8.0)),
                       max(aaLine(uv.y, uw.y, 8.0), aaLine(1.0 - uv.y, uw.y, 8.0)));
    float d1 = uv.x - uv.y, d2 = uv.x + uv.y - 1.0;
    float diag = max(aaLine(abs(d1), fwidth(d1), 2.0), aaLine(abs(d2), fwidth(d2), 2.0));
    float r = length(uv - 0.5) - 0.35;
    float ring = aaLine(abs(r), fwidth(r), 2.0);
    col = mix(vec3(1.0), uGridColor, max(max(lines * 0.7, border), max(diag, ring)));
  }

  float a = 1.0;
  if (uFeather > 0.0) {
    a = smoothstep(0.0, uFeather, uv.x) * smoothstep(0.0, uFeather, 1.0 - uv.x) *
        smoothstep(0.0, uFeather, uv.y) * smoothstep(0.0, uFeather, 1.0 - uv.y);
  }
  a *= uOpacity;
  if (uHasMask > 0.5) {
    // A picture mask lies on the panel's own surface; an outline mask is drawn in output space.
    vec2 mc = uMaskUv > 0.5 ? uv : vec2(gl_FragCoord.x / uCanvas.x, 1.0 - gl_FragCoord.y / uCanvas.y);
    a *= texture(uMask, mc).a;
  }
  o = vec4(col * a, a);
}`;
}

export const PANEL_FS = panelFs(false);
export const PANEL_MESH_FS = panelFs(true);

/** Vertex shader for mesh panels: positions in clip space, panel position passed through. */
export const MESH_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * Finishing pass over a projector's whole picture: water shimmer, bloom from the blurred mip
 * levels, saturation, tint and vignette. Reads the frame the panels were drawn into.
 */
export const POST_FS = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uBloom, uRipple, uRippleT, uTint, uSaturation, uVignette;
uniform vec3 uTintColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  // Shimmer: a gentle, slowly moving refraction, as if seen through moving water.
  float T = uRippleT;
  vec2 off = vec2(sin(uv.y * 38.0 + T * 2.0 + sin(uv.x * 13.0 + T)), cos(uv.x * 33.0 - T * 1.7 + sin(uv.y * 11.0 - T)));
  vec2 suv = uv + off * 0.005 * uRipple;
  vec3 col = texture(uTex, suv).rgb;
  // Bloom: light spilling around bright areas, from progressively blurrier copies of the frame.
  vec3 b = textureLod(uTex, suv, 3.0).rgb * 0.45 + textureLod(uTex, suv, 5.0).rgb * 0.35 + textureLod(uTex, suv, 7.0).rgb * 0.3;
  col += b * b * 1.6 * uBloom + b * 0.25 * uBloom;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSaturation);
  col = mix(col, l * uTintColor * 1.8, uTint);
  float d = length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0)) / length(vec2(0.5 * uRes.x / uRes.y, 0.5));
  col *= mix(1.0, smoothstep(1.05, 0.35, d), uVignette);
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/** Neon outline strip: clip-space position, position round the loop and side of the line. */
export const NEON_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aLine;
out vec2 vLine;
void main() {
  vLine = aLine;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * Neon outline: a bright core with a soft glow falling off from it, brightness along the loop set
 * by the style. uStyle picks it: 0 chase, 1 dashes, 2 pulse, 3 rainbow, 4 flicker. uPhase is how far
 * round the loop the animation is, in laps (signed), uDir its direction. Draws with screen blending,
 * so where the line overlaps itself or the panel beneath it only brightens.
 */
export const NEON_FS = `#version 300 es
precision highp float;
in vec2 vLine;
out vec4 o;
uniform float uStyle, uPhase, uDir, uTime, uRunners, uLen, uHalf, uCore, uGlowPx, uGlow, uLevel, uMaster, uOpacity;
uniform vec3 uColor;

${NOISE_GLSL}

vec3 hsv(float h) {
  vec3 k = clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return k;
}

void main() {
  float s = vLine.x;
  float d = abs(vLine.y) * uHalf;
  float core = 1.0 - smoothstep(uCore - 0.5, uCore + 1.0, d);
  float glow = exp(-max(d - uCore, 0.0) / max(uGlowPx, 0.5)) * (0.12 + 0.88 * uGlow);
  // The strip's own edge fades out, so the glow is never cut off square.
  glow *= 1.0 - smoothstep(0.7, 1.0, abs(vLine.y));
  float m = 1.0;
  vec3 col = uColor;
  if (uStyle < 0.5) {
    float b = fract(-uDir * (s - uPhase) * uRunners);
    m = 0.07 + (b < uLen ? pow(1.0 - b / uLen, 1.6) : 0.0);
  } else if (uStyle < 1.5) {
    float x = fract((s - uPhase) * uRunners * 4.0);
    float on = smoothstep(0.0, 0.06, x) * (1.0 - smoothstep(uLen * 0.8, uLen * 0.8 + 0.06, x));
    m = 0.08 + on;
  } else if (uStyle < 2.5) {
    m = 0.3 + 0.7 * (0.5 + 0.5 * sin(6.2831853 * (uPhase * uRunners)));
  } else if (uStyle < 3.5) {
    col = hsv(s * uRunners - uPhase * uRunners * uDir);
  } else {
    float seg = floor(s * 12.0);
    float t = floor(uTime * 11.0);
    m = hash(vec2(seg, t)) < 0.1 ? 0.12 : 1.0;
    m *= hash(vec2(t, 7.0)) < 0.06 ? 0.3 : 1.0;
  }
  // The core runs white-hot with the colour in the glow, as a lit tube does.
  vec3 rgb = mix(col * (glow * 1.6), mix(col, vec3(1.0), 0.75), core);
  o = vec4(rgb * (m * uLevel * uMaster * uOpacity), 1.0);
}`;
