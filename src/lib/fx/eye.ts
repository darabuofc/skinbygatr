import type { FxDef } from './index';

/**
 * A glowing reptile eye for a curved bowl (mesh-warp the panel onto it). Luminous green-gold
 * iris with radial fibres, a vertical slit pupil that moves and widens, and lids that close
 * from top and bottom. The engine's eye automation adds random blinks (uBlink) and a slow
 * wandering gaze (uWanderX, uWanderY) on top of the manual settings, so it stays alive
 * unattended; both eyes share one set, so they blink and look together.
 */
export const eye: FxDef = {
  id: 'eye',
  name: 'Reptile eye',
  description: 'Glowing slit-pupil eye with lids, random blinks and a slowly wandering gaze.',
  scale: 1,
  params: [
    { name: 'uOpen', label: 'Eye open', min: 0, max: 1, default: 1 },
    { name: 'uPupilX', label: 'Pupil left–right', min: -1, max: 1, default: 0 },
    { name: 'uPupilY', label: 'Pupil up–down', min: -1, max: 1, default: 0 },
    { name: 'uPupilWidth', label: 'Pupil width', min: 0, max: 1, default: 0.3 },
    { name: 'uIrisGlow', label: 'Iris glow', min: 0, max: 1, default: 0.6 },
    { name: 'uIrisHue', label: 'Iris colour', min: 0, max: 1, default: 0 },
    { name: 'uIrisPulse', label: 'Iris pulse', min: 0, max: 1, default: 0.3 },
    { name: 'uKickDilate', label: 'Pupil widens on kick', min: 0, max: 1, default: 0.3 },
    { name: 'uBlinkRate', label: 'Blinks per minute (0 = off)', min: 0, max: 30, default: 8, engine: true },
    { name: 'uWander', label: 'Eye wander', min: 0, max: 1, default: 0.4, engine: true },
    { name: 'uWanderPace', label: 'Wander pace', min: 0.05, max: 1, default: 0.3, engine: true },
  ],
  live: ['uBlink', 'uWanderX', 'uWanderY'],
  triggers: [{ id: 'blink', label: 'Blink' }],
  body: `
// Rotates a colour's hue by a turns (0..1), keeping its brightness.
vec3 hueTurn(vec3 c, float a) {
  float ang = a * 6.2831853;
  vec3 k = vec3(0.57735);
  return c * cos(ang) + cross(k, c) * sin(ang) + k * dot(k, c) * (1.0 - cos(ang));
}

vec3 fx(vec2 fc) {
  // Eye space: −1..1 across the panel's shorter side, y up.
  vec2 q = (fc - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
  float r = length(q);
  float react = clamp(uReact, 0.0, 1.0);

  // Pupil: a vertical slit, moved by the setting plus the wandering gaze.
  vec2 pc = vec2(clamp(uPupilX + uWanderX, -1.0, 1.0) * 0.28, clamp(uPupilY + uWanderY, -1.0, 1.0) * 0.14);
  // The pupil snaps a little wider on each kick, then settles.
  float pw = mix(0.035, 0.42, clamp(uPupilWidth + uKick * uKickDilate * 0.35 * (0.4 + 0.6 * react), 0.0, 1.0));
  vec2 pq = (q - pc) / vec2(pw, 0.62);
  float pupil = smoothstep(1.0, 0.86, length(pq));

  // Iris: radial fibres around the pupil, brightest near it, a dark ring at the rim.
  vec2 iq = q - pc * 0.5;
  float ir = length(iq);
  float ang = atan(iq.y, iq.x);
  float fib = 0.55 + 0.45 * noise(vec2(ang * 9.0, ir * 3.0)) * noise(vec2(ang * 23.0, ir * 6.0 + 4.0));
  float glow = (0.55 + 0.45 * uIrisGlow) * (1.0 + react * 0.8 * uBass) * (1.0 + uIrisPulse * 0.3 * sin(uTime * 0.9));
  // Gold-green by default; Iris colour turns it through amber, red and violet and back.
  vec3 inner = hueTurn(vec3(0.95, 0.85, 0.25), uIrisHue), outer = hueTurn(vec3(0.12, 0.55, 0.22), uIrisHue);
  vec3 col = mix(inner, outer, smoothstep(0.05, 0.85, ir)) * fib * glow;
  col += vec3(0.1, 1.0, 0.8) * uIrisGlow * 0.35 * smoothstep(0.35, 0.0, abs(ir - 0.55)) * fib;
  col *= smoothstep(1.0, 0.82, r);
  col = mix(col, vec3(0.0), pupil);
  // A fixed highlight, as on a wet curved surface; it doesn't follow the pupil.
  col += vec3(0.9) * smoothstep(0.11, 0.0, length(q - vec2(-0.32, 0.36))) * 0.55;

  // Lids: an almond opening that closes from top and bottom as the eye shuts or blinks.
  float open = clamp(uOpen * (1.0 - uBlink), 0.0, 1.0);
  float edge = open * 0.92 * sqrt(max(0.0, 1.0 - q.x * q.x));
  float d = edge - abs(q.y);
  float inside = smoothstep(0.0, 0.04, d);
  // Lid skin: dark scales, with a glowing rim along the lid edge.
  vec2 sc = q * 9.0;
  float cell = hash2(floor(sc)).x;
  vec3 lid = vec3(0.02, 0.06, 0.045) * (0.6 + 0.6 * cell);
  float rim = smoothstep(0.06, 0.0, abs(d)) * step(0.001, open);
  col = mix(lid, col, inside) + vec3(0.1, 0.9, 0.75) * rim * 0.6 * uIrisGlow;
  return col;
}`,
};
