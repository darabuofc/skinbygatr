import { clamp } from './store';

export interface Levels {
  bass: number;
  mid: number;
  high: number;
  kick: boolean;
  kickEnv: number;
  beat: number;
  /** Seconds since each of the last 8 kicks (99 when unused). */
  kicks: number[];
  since: number;
  spec: Uint8Array<ArrayBuffer>;
  /** True when levels come from real audio or the auto beat. */
  live: boolean;
}

/** Why the visuals are running on the built-in beat instead of the input, if they are. */
export type AudioState = 'off' | 'listening' | 'silent' | 'lost';

/** Seconds of near-silence before the input counts as gone. Long enough to ride out a quiet breakdown. */
export const SILENCE_SEC = 5;
/** Raw level (0..1, before gain) under which the input is treated as silence: a noise floor, not quiet music. */
export const SILENCE_LEVEL = 0.004;

/** Tracks whether an input is carrying sound. Pure, so the timing rules can be tested. */
export class SignalWatch {
  private quietSince: number | null = null;
  silent = false;

  update(t: number, raw: number): boolean {
    if (raw >= SILENCE_LEVEL) {
      this.quietSince = null;
      this.silent = false;
    } else {
      if (this.quietSince === null) this.quietSince = t;
      if (t - this.quietSince >= SILENCE_SEC) this.silent = true;
    }
    return this.silent;
  }

  reset() { this.quietSince = null; this.silent = false; }
}

/** Kick band in Hz: the kick's body, below most of the bassline's harmonics. */
export const KICK_LO = 40;
export const KICK_HI = 120;
/** Kick-band loudness (dBFS) below which nothing counts as a kick: hum and room noise. */
export const KICK_FLOOR_DB = -70;
/** Shortest gap between kicks, in seconds (about 330 BPM, so double-time hats never merge in). */
export const KICK_REFRACTORY = 0.18;

/**
 * Onset detector for kicks. Works on linear magnitudes from an unsmoothed analyser and
 * fires when the rise in kick-band energy (spectral flux) jumps well above its recent average.
 * A rise, not a level, so a sustained bassline or a hot, clipping input can't hide the kicks.
 * Pure, so it can be tested with synthetic spectra.
 */
export class KickDetector {
  private prev: Float32Array = new Float32Array(0);
  private avg = 0;
  private lastT = -1;
  private last = -10;

  reset() { this.prev = new Float32Array(0); this.avg = 0; this.lastT = -1; this.last = -10; }

  /** `db` is one frame of getFloatFrequencyData; `hz` is the bin width; `sens` is the user's threshold (higher = fewer kicks). */
  detect(t: number, db: Float32Array, hz: number, sens: number): boolean {
    const a = Math.max(1, Math.floor(KICK_LO / hz));
    const b = Math.min(db.length - 1, Math.max(a, Math.ceil(KICK_HI / hz)));
    const n = b - a + 1;
    const first = this.prev.length !== n;
    if (first) this.prev = new Float32Array(n);
    let flux = 0, power = 0, sum = 0;
    for (let i = 0; i < n; i++) {
      const m = Math.pow(10, db[a + i] / 20) || 0;
      const d = m - this.prev[i];
      if (d > 0) flux += d;
      power += m * m;
      sum += m;
      this.prev[i] = m;
    }
    const dt = this.lastT < 0 ? 1 / 60 : clamp(t - this.lastT, 0, 0.1);
    this.lastT = t;
    if (first) return false;
    const loud = 10 * Math.log10(power / n + 1e-12) > KICK_FLOOR_DB;
    // A kick is a real jump (at least 5% of the band's level), not rounding noise on a steady tone.
    const hit = loud && flux > sum * 0.05 && flux > this.avg * sens * 2 && t - this.last > KICK_REFRACTORY;
    // Time-based average (~0.8 s memory) so the threshold doesn't shift with the frame rate.
    this.avg += (flux - this.avg) * (1 - Math.exp(-dt / 0.8));
    if (hit) this.last = t;
    return hit;
  }
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  /** Unsmoothed twin of `analyser`, for kick onsets; smoothing would blur the attack. */
  private kickAnalyser: AnalyserNode | null = null;
  private kickDb: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(0));
  private kickDet = new KickDetector();
  private src: AudioNode | null = null;
  private stream: MediaStream | null = null;
  /** A test track playing through the analysers instead of a live input. */
  private track: HTMLAudioElement | null = null;
  private trackUrl = '';
  private freq: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  private kickTimes: number[] = [];
  private lastKick = -10;
  private prevPh = 0;
  private taps: number[] = [];
  private watch = new SignalWatch();
  active = false;
  /** The input track ended on its own (interface unplugged). Cleared by a successful start or an explicit reset. */
  lost = false;
  /** Called when the input track ends without the user stopping it. */
  onLost: (() => void) | null = null;

  readonly L: Levels = {
    bass: 0, mid: 0, high: 0, kick: false, kickEnv: 0, beat: 0,
    kicks: new Array(8).fill(99), since: 99,
    spec: new Uint8Array(new ArrayBuffer(64)), live: false,
  };

  async start(deviceId: string): Promise<string> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
    if (!this.ctx) this.ctx = new AudioContext();
    await this.ctx.resume();
    this.stop();
    const constraints = (id: string): MediaStreamConstraints => ({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (e) {
      // A saved interface that's no longer plugged in: fall back to the default input.
      if (deviceId && (e as Error).name === 'OverconstrainedError') {
        this.stream = await navigator.mediaDevices.getUserMedia(constraints(''));
      } else throw e;
    }
    this.attach(this.ctx.createMediaStreamSource(this.stream));
    const stream = this.stream;
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (this.stream !== stream) return;
      this.stop();
      this.lost = true;
      this.onLost?.();
    });
    return this.stream.getAudioTracks()[0]?.label || 'the selected input';
  }

  /**
   * Plays an audio file through the same analysis as a live input, and out of the speakers,
   * so reactivity can be judged on real music without a mixer. Loops until stopped.
   */
  async startTrack(file: File): Promise<string> {
    if (!this.ctx) this.ctx = new AudioContext();
    await this.ctx.resume();
    this.stop();
    this.lost = false;
    this.trackUrl = URL.createObjectURL(file);
    const el = new Audio(this.trackUrl);
    el.loop = true;
    this.track = el;
    // An element can only feed one source node, so each track gets a fresh element.
    const node = this.ctx.createMediaElementSource(el);
    node.connect(this.ctx.destination);
    this.attach(node);
    try {
      await el.play();
    } catch (e) {
      this.stop();
      throw e;
    }
    return file.name;
  }

  get trackPlaying() { return !!this.track && !this.track.paused; }

  /** Pauses or resumes the test track. Returns whether it is now playing. */
  toggleTrack(): boolean {
    if (!this.track) return false;
    if (this.track.paused) void this.track.play();
    else this.track.pause();
    return !this.track.paused;
  }

  private attach(node: AudioNode) {
    const ctx = this.ctx!;
    this.src = node;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.45;
    node.connect(this.analyser);
    this.freq = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.kickAnalyser = ctx.createAnalyser();
    this.kickAnalyser.fftSize = 2048;
    this.kickAnalyser.smoothingTimeConstant = 0;
    node.connect(this.kickAnalyser);
    this.kickDb = new Float32Array(new ArrayBuffer(this.kickAnalyser.frequencyBinCount * 4));
    this.kickDet.reset();
    this.active = true;
    this.lost = false;
    this.watch.reset();
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.track) {
      this.track.pause();
      this.track.removeAttribute('src');
      this.track.load();
      this.track = null;
    }
    if (this.trackUrl) { URL.revokeObjectURL(this.trackUrl); this.trackUrl = ''; }
    try { this.src?.disconnect(); } catch { /* already disconnected */ }
    this.stream = null;
    this.src = null;
    this.analyser = null;
    this.kickAnalyser = null;
    this.active = false;
  }

  /** What the visuals are following right now. */
  get state(): AudioState {
    if (this.lost) return 'lost';
    if (!this.active) return 'off';
    return this.watch.silent ? 'silent' : 'listening';
  }

  async devices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
  }

  /** Returns a BPM once three or more taps are close enough together. */
  tap(now: number): number | null {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 6) this.taps.shift();
    if (this.taps.length < 3) return null;
    const iv = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
    const bpm = Math.round(60 / iv);
    return bpm >= 60 && bpm <= 200 ? bpm : null;
  }

  private env(k: 'bass' | 'mid' | 'high', v: number) {
    v = Math.min(1, v);
    const c = this.L[k];
    this.L[k] = c + (v - c) * (v > c ? 0.55 : 0.1);
  }

  private fireKick(t: number) {
    this.L.kick = true;
    this.lastKick = t;
    this.L.beat = (this.L.beat + 1) % 1000;
    this.kickTimes.unshift(t);
    if (this.kickTimes.length > 8) this.kickTimes.pop();
  }

  update(t: number, o: { gain: number; sens: number; autoBpm: boolean; bpm: number }) {
    const L = this.L;
    L.kick = false;
    let listening = false;
    let band = (_lo: number, _hi: number) => 0;
    let hz = 0;
    if (this.active && this.analyser && this.ctx) {
      const f = this.freq;
      this.analyser.getByteFrequencyData(f);
      hz = this.ctx.sampleRate / this.analyser.fftSize;
      band = (lo: number, hi: number) => {
        const a = Math.max(1, Math.floor(lo / hz));
        const b = Math.min(f.length - 1, Math.max(a, Math.ceil(hi / hz)));
        let s = 0;
        for (let i = a; i <= b; i++) s += f[i];
        return s / ((b - a + 1) * 255);
      };
      listening = !this.watch.update(t, band(30, 12000));
    }
    if (listening) {
      const rb = band(30, 150) * o.gain;
      const rm = band(150, 2000) * o.gain;
      const rh = band(2000, 12000) * o.gain * 1.8;
      this.env('bass', rb);
      this.env('mid', rm);
      this.env('high', rh);
      if (this.kickAnalyser) {
        this.kickAnalyser.getFloatFrequencyData(this.kickDb);
        if (this.kickDet.detect(t, this.kickDb, hz, o.sens)) this.fireKick(t);
      }
      for (let k = 0; k < 64; k++) {
        const lo = 30 * Math.pow(16000 / 30, k / 64);
        const hi = 30 * Math.pow(16000 / 30, (k + 1) / 64);
        L.spec[k] = Math.min(255, band(lo, hi) * 255 * o.gain * (1 + k / 64));
      }
      L.live = true;
    } else {
      // No usable input: auto beat at full strength, or a gentle idle pulse so the wall is never dead.
      // A silent or unplugged input always gets the full beat, so the show keeps moving mid-set.
      const fallback = this.lost || this.active;
      const inten = o.autoBpm || fallback ? 1 : 0.45;
      const per = 60 / clamp(o.bpm || 126, 60, 200);
      const ph = (t % per) / per;
      if (ph < this.prevPh) this.fireKick(t);
      this.prevPh = ph;
      L.bass = Math.exp(-ph * 5) * inten;
      L.mid = (0.4 + 0.25 * Math.sin(t * 1.3)) * inten;
      L.high = Math.exp(-((ph + 0.5) % 1) * 9) * 0.9 * inten;
      for (let k = 0; k < 64; k++) {
        const x = k / 64;
        L.spec[k] = Math.min(255, 255 * (
          L.bass * Math.exp(-x * 6) +
          L.mid * 0.6 * Math.exp(-x * 2) * (0.7 + 0.3 * Math.sin(k * 0.9 + t * 3)) +
          (x > 0.5 ? L.high * 0.55 * (0.6 + 0.4 * Math.sin(k * 2.3 + t * 9)) : 0)
        ));
      }
      L.live = o.autoBpm || fallback;
    }
    L.kickEnv = L.kick ? 1 : L.kickEnv * 0.8;
    L.since = t - this.lastKick;
    for (let i = 0; i < 8; i++) L.kicks[i] = i < this.kickTimes.length ? t - this.kickTimes[i] : 99;
  }
}
