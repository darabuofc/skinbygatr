import { describe, expect, it } from 'vitest';
import { AudioEngine, KICK_REFRACTORY, KickDetector, SILENCE_LEVEL, SILENCE_SEC, SignalWatch } from './audio';

const opts = { gain: 1.5, sens: 1.45, autoBpm: false, bpm: 120 };

describe('SignalWatch', () => {
  it('stays live through a short quiet stretch', () => {
    const w = new SignalWatch();
    w.update(0, 0.2);
    expect(w.update(SILENCE_SEC - 0.5, 0)).toBe(false);
  });

  it('flags silence after the timeout and clears the moment sound returns', () => {
    const w = new SignalWatch();
    w.update(10, 0);
    expect(w.update(10 + SILENCE_SEC, SILENCE_LEVEL / 2)).toBe(true);
    expect(w.update(10 + SILENCE_SEC + 0.02, SILENCE_LEVEL * 2)).toBe(false);
  });

  it('restarts the silence timer after any sound', () => {
    const w = new SignalWatch();
    w.update(0, 0);
    w.update(4, 0.1);
    expect(w.update(4 + SILENCE_SEC - 0.1, 0)).toBe(false);
  });
});

describe('AudioEngine fallback', () => {
  const run = (a: AudioEngine, seconds: number) => {
    let kicks = 0;
    for (let t = 0; t < seconds; t += 1 / 60) { a.update(t, opts); if (a.L.kick) kicks++; }
    return kicks;
  };

  it('idles gently when audio was never started', () => {
    const a = new AudioEngine();
    run(a, 2);
    expect(a.state).toBe('off');
    expect(a.L.live).toBe(false);
  });

  it('drives a full-strength beat at the set BPM once the input is lost, even with Auto beat off', () => {
    const a = new AudioEngine();
    a.lost = true;
    const kicks = run(a, 10);
    expect(a.state).toBe('lost');
    expect(a.L.live).toBe(true);
    expect(kicks).toBeGreaterThanOrEqual(19); // 120 BPM for 10 s
    expect(kicks).toBeLessThanOrEqual(21);
  });
});

describe('KickDetector', () => {
  const HZ = 48000 / 2048;
  const BINS = 1024;
  const db = (amp: number) => (amp > 0 ? 20 * Math.log10(amp) : -Infinity);

  /** Kick-band spectrum: a decaying kick on each beat over a bassline, all in linear amplitude. */
  const song = (o: { bpm: number; kick: number; bass: number; offbeatBass?: boolean }) => (t: number) => {
    const per = 60 / o.bpm;
    const since = t % per;
    const offbeat = o.offbeatBass && (t + per / 2) % per < per / 2 ? 0.5 : 1;
    const amp = o.kick * Math.exp(-since / 0.08) + o.bass * offbeat;
    const f = new Float32Array(BINS).fill(-120);
    for (let i = 1; i < 8; i++) f[i] = db(amp);
    return f;
  };

  const count = (spec: (t: number) => Float32Array, seconds: number, sens = 1.45, fps = 60) => {
    const k = new KickDetector();
    let n = 0;
    for (let t = 0; t < seconds; t += 1 / fps) if (k.detect(t, spec(t), HZ, sens)) n++;
    return n;
  };

  // Regression: the old detector compared dB-scaled byte levels against their average, so a steady
  // bassline (or a hot input pinning the bins at the top of the range) meant kicks never registered.
  it('finds every kick over a loud, sustained bassline', () => {
    const n = count(song({ bpm: 128, kick: 0.5, bass: 0.15, offbeatBass: true }), 10);
    expect(n).toBeGreaterThanOrEqual(20); // 128 BPM for 10 s ≈ 21, minus warm-up
    expect(n).toBeLessThanOrEqual(22);
  });

  it('keeps finding kicks when the input runs hot', () => {
    const n = count(song({ bpm: 124, kick: 3, bass: 1.5 }), 10);
    expect(n).toBeGreaterThanOrEqual(19);
    expect(n).toBeLessThanOrEqual(21);
  });

  it('gives the same count at 60 and 144 fps', () => {
    const spec = song({ bpm: 128, kick: 0.5, bass: 0.15, offbeatBass: true });
    expect(Math.abs(count(spec, 10, 1.45, 144) - count(spec, 10, 1.45, 60))).toBeLessThanOrEqual(1);
  });

  it('ignores a steady bass tone with no attacks', () => {
    expect(count(() => { const f = new Float32Array(BINS).fill(-120); for (let i = 1; i < 8; i++) f[i] = -12; return f; }, 5)).toBe(0);
  });

  it('ignores kicks below the noise floor', () => {
    expect(count(song({ bpm: 128, kick: 0.0002, bass: 0 }), 5)).toBe(0);
  });

  it('never fires faster than the refractory gap', () => {
    expect(count(song({ bpm: 600, kick: 0.5, bass: 0 }), 5)).toBeLessThanOrEqual(Math.ceil(5 / KICK_REFRACTORY));
  });

  it('fires less as sensitivity goes up', () => {
    const spec = song({ bpm: 128, kick: 0.2, bass: 0.15, offbeatBass: true });
    expect(count(spec, 10, 2.5)).toBeLessThanOrEqual(count(spec, 10, 1.1));
  });
});
