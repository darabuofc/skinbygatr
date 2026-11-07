import { describe, expect, it } from 'vitest';
import { Autopilot, defaultAutopilot, MANUAL_PAUSE, MIN_DWELL, PALETTES, sanitizeAutopilot, type ApFrame, type ApInput } from './autopilot';

const base: ApInput = {
  t: 0, dt: 1 / 60, kick: false, since: 99, bass: 0, mid: 0, high: 0, period: 0.5, sceneCount: 12, scene: 0,
  videos: ['vid:a', 'vid:b'], builtin: ['gen', 'fx:water', 'fx:jelly'], panels: [{ id: 'p1', source: 'gen' }, { id: 'p2', source: 'gen' }],
  live: true, pool: 'both', intensity: 0.5,
};

/** Runs the director for `sec` seconds of a steady signal, kicking at 2 a second when `kicks`. */
function run(ap: Autopilot, from: number, sec: number, o: Partial<ApInput> & { kicks?: boolean } = {}) {
  const { kicks = false, ...rest } = o;
  const frames: ApFrame[] = [];
  let nextKick = from;
  for (let t = from; t < from + sec; t += 1 / 60) {
    const kick = kicks && t >= nextKick;
    if (kick) nextKick += 0.5;
    frames.push(ap.step({ ...base, ...rest, t, kick, since: kicks ? 0.2 : 99 }));
  }
  return frames;
}
const loud = { bass: 0.8, mid: 0.5, high: 0.4 };

describe('sanitizeAutopilot', () => {
  it('falls back to defaults and clamps', () => {
    expect(sanitizeAutopilot(null)).toEqual(defaultAutopilot());
    expect(sanitizeAutopilot({ on: true, pool: 'nope', intensity: 9, strobe: 'x' })).toEqual({ on: true, pool: 'both', intensity: 1, strobe: false });
    expect(sanitizeAutopilot({ intensity: NaN }).intensity).toBe(0.5);
  });
});

describe('section detection', () => {
  it('is ambient in silence and never changes anything', () => {
    const f = run(new Autopilot(), 0, 30, { live: false });
    expect(f.every((x) => x.section === 'ambient')).toBe(true);
    expect(f.some((x) => x.strobe)).toBe(false);
  });

  it('settles into groove on steady kicks', () => {
    const ap = new Autopilot();
    run(ap, 0, 30, { ...loud, kicks: true });
    expect(run(ap, 30, 20, { ...loud, kicks: true }).at(-1)!.section).toBe('groove');
  });

  it('calls it a breakdown when kicks stop but sound remains', () => {
    const ap = new Autopilot();
    run(ap, 0, 40, { ...loud, kicks: true });
    expect(run(ap, 40, 12, { bass: 0.1, mid: 0.3, high: 0.1 }).at(-1)!.section).toBe('breakdown');
  });

  it('calls it a drop when kicks return after a breakdown, then groove', () => {
    const ap = new Autopilot();
    run(ap, 0, 40, { ...loud, kicks: true });
    run(ap, 40, 12, { bass: 0.1, mid: 0.3, high: 0.1 });
    const drop = run(ap, 52, 3, { ...loud, kicks: true });
    expect(drop.some((x) => x.section === 'drop')).toBe(true);
    expect(run(ap, 55, 30, { ...loud, kicks: true }).at(-1)!.section).toBe('groove');
  });

  it('calls rising highs without kicks a build', () => {
    const ap = new Autopilot();
    run(ap, 0, 30, { bass: 0.2, mid: 0.2, high: 0.1 });
    const f = run(ap, 30, 6, { bass: 0.2, mid: 0.3, high: 0.7 });
    expect(f.some((x) => x.section === 'build')).toBe(true);
  });
});

describe('changes', () => {
  it('changes on the bar grid and keeps the minimum dwell', () => {
    const ap = new Autopilot();
    const f = run(ap, 0, 90, { ...loud, kicks: true });
    const at = f.map((x, i) => (x.change ? i / 60 : -1)).filter((x) => x >= 0);
    expect(at.length).toBeGreaterThan(2);
    for (let k = 1; k < at.length; k++) expect(at[k] - at[k - 1]).toBeGreaterThanOrEqual(MIN_DWELL - 0.02);
  });

  it('changes more often when wild than when calm', () => {
    const count = (intensity: number) => run(new Autopilot(3), 0, 120, { ...loud, kicks: true, intensity }).filter((x) => x.change).length;
    expect(count(1)).toBeGreaterThan(count(0));
  });

  it('never repeats the scene or the colours it just used, and uses known palettes', () => {
    const ap = new Autopilot(7);
    let scene = 0, pal = '';
    for (const f of run(ap, 0, 200, { ...loud, kicks: true })) {
      if (!f.change) continue;
      expect(f.change.scene).not.toBe(scene);
      expect(PALETTES.some(([a, b]) => a === f.change!.c1 && b === f.change!.c2)).toBe(true);
      expect(`${f.change.c1}${f.change.c2}`).not.toBe(pal);
      scene = f.change.scene; pal = `${f.change.c1}${f.change.c2}`;
      base.scene = scene; // the engine feeds the live scene back in
    }
    base.scene = 0;
  });

  it('uses black through breakdowns and a flashy transition on drops', () => {
    const ap = new Autopilot(2);
    run(ap, 0, 40, { ...loud, kicks: true });
    const bd = run(ap, 40, 12, { bass: 0.1, mid: 0.3, high: 0.1 }).filter((x) => x.change);
    expect(bd[0]?.change?.transition).toBe('black');
    const dr = run(ap, 52, 8, { ...loud, kicks: true }).filter((x) => x.change);
    expect(['sparkle', 'ripple']).toContain(dr[0]?.change?.transition);
  });

  it('always moves at least one panel', () => {
    const ap = new Autopilot(5);
    for (const f of run(ap, 0, 120, { ...loud, kicks: true })) if (f.change) expect(Object.keys(f.change.sources).length).toBeGreaterThan(0);
  });
});

describe('content pool', () => {
  const sources = (pool: ApInput['pool'], videos: string[]) => {
    const out = new Set<string>();
    for (const f of run(new Autopilot(9), 0, 200, { ...loud, kicks: true, pool, videos })) if (f.change) Object.values(f.change.sources).forEach((s) => out.add(s));
    return [...out];
  };
  it('videos only picks only videos', () => {
    const s = sources('videos', ['vid:a', 'vid:b']);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.startsWith('vid:'))).toBe(true);
  });
  it('built-in only never picks a video', () => {
    expect(sources('builtin', ['vid:a']).some((x) => x.startsWith('vid:'))).toBe(false);
  });
  it('both mixes them, and falls back to built-in when there are no videos', () => {
    const s = sources('both', ['vid:a', 'vid:b']);
    expect(s.some((x) => x.startsWith('vid:'))).toBe(true);
    expect(s.some((x) => !x.startsWith('vid:'))).toBe(true);
    expect(sources('videos', []).every((x) => !x.startsWith('vid:'))).toBe(true);
  });
});

describe('effects and overrides', () => {
  it('strobes only just after a drop, and scales split by intensity', () => {
    const ap = new Autopilot();
    run(ap, 0, 40, { ...loud, kicks: true });
    run(ap, 40, 12, { bass: 0.1, mid: 0.3, high: 0.1 });
    const f = run(ap, 52, 20, { ...loud, kicks: true });
    expect(f.some((x) => x.strobe)).toBe(true);
    expect(f.at(-1)!.strobe).toBe(false);
    const wild = Math.max(...run(new Autopilot(), 0, 60, { ...loud, kicks: true, intensity: 1 }).map((x) => x.split));
    const calm = Math.max(...run(new Autopilot(), 0, 60, { ...loud, kicks: true, intensity: 0.1 }).map((x) => x.split));
    expect(wild).toBeGreaterThan(calm);
  });

  it('pauses after a hand change and resumes', () => {
    const ap = new Autopilot();
    run(ap, 0, 5, { ...loud, kicks: true });
    ap.manual(5);
    const paused = run(ap, 5, MANUAL_PAUSE - 1, { ...loud, kicks: true });
    expect(paused.some((x) => x.change || x.active)).toBe(false);
    expect(run(ap, 5 + MANUAL_PAUSE, 60, { ...loud, kicks: true }).some((x) => x.change)).toBe(true);
  });

  it('holds on request', () => {
    const ap = new Autopilot();
    ap.held = true;
    expect(run(ap, 0, 60, { ...loud, kicks: true }).some((x) => x.change)).toBe(false);
  });
});
