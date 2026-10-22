import { describe, expect, it } from 'vitest';
import { FX, fxById } from './fx';
import {
  allActions, defaultParams, PARAM_GROUPS, paramActions, params, ParamSmoother, parseParamAction, parseTriggerAction, resetParams, sanitizeParams,
  sanitizeParamSnapshot, setParam, setParamFromFader, SMOOTH_SEC, triggerActions,
} from './params';
import { ACTIONS } from './types';

const water = fxById('water')!;

describe('sanitizeParams', () => {
  it('fills every shader and projector post group with defaults', () => {
    const p = sanitizeParams(undefined);
    expect(Object.keys(p).sort()).toEqual(PARAM_GROUPS.map((f) => f.id).sort());
    expect(Object.keys(p)).toEqual(expect.arrayContaining([...FX.map((f) => f.id), 'post1', 'post2']));
    expect(p.water.uCaustic).toBe(1);
  });

  it('keeps saved values, clamped, and ignores unknown shaders and params', () => {
    const p = sanitizeParams({ water: { uCaustic: 1.5, uScale: 999, uBogus: 3, uDepth: 'x' }, retired: { uA: 1 } });
    expect(p.water.uCaustic).toBe(1.5);
    expect(p.water.uScale).toBe(12);
    expect(p.water.uDepth).toBe(0.6);
    expect(p.water).not.toHaveProperty('uBogus');
    expect(p).not.toHaveProperty('retired');
  });
});

describe('setting params', () => {
  it('clamps to range and ignores unknown targets', () => {
    params.set(defaultParams());
    setParam('water', 'uCaustic', 5);
    expect(params.get().water.uCaustic).toBe(2);
    setParam('water', 'uNope', 1);
    setParam('nope', 'uCaustic', 1);
    setParam('water', 'uDepth', NaN);
    expect(params.get().water).not.toHaveProperty('uNope');
    expect(params.get()).not.toHaveProperty('nope');
    expect(params.get().water.uDepth).toBe(0.6);
  });

  it('maps a fader across the range', () => {
    setParamFromFader('water', 'uScale', 0);
    expect(params.get().water.uScale).toBe(1.5);
    setParamFromFader('water', 'uScale', 1);
    expect(params.get().water.uScale).toBe(12);
    setParamFromFader('water', 'uScale', 0.5);
    expect(params.get().water.uScale).toBeCloseTo(6.75, 9);
  });

  it('resets one shader or all of them', () => {
    setParam('water', 'uCaustic', 0.2);
    setParam('skin', 'uGlow', 0.9);
    resetParams('water');
    expect(params.get().water.uCaustic).toBe(1);
    expect(params.get().skin.uGlow).toBe(0.9);
    resetParams();
    expect(params.get().skin.uGlow).toBe(0.4);
  });
});

describe('ParamSmoother', () => {
  it('starts at the set value, then eases towards a new one without stepping', () => {
    const sm = new ParamSmoother();
    const v = defaultParams();
    sm.update(v, 1 / 60, 10);
    expect(sm.value('water', 'uCaustic')).toBe(1);
    v.water.uCaustic = 2;
    sm.update(v, 1 / 60, 10 + 1 / 60);
    const one = sm.value('water', 'uCaustic');
    expect(one).toBeGreaterThan(1);
    expect(one).toBeLessThan(1.3);
    for (let k = 0; k < 90; k++) sm.update(v, 1 / 60, 10);
    // Settles exactly once it's within rounding distance.
    expect(sm.value('water', 'uCaustic')).toBe(2);
  });

  it('gets most of the way within a few time constants, whatever the frame rate', () => {
    for (const fps of [30, 60, 120]) {
      const sm = new ParamSmoother();
      const v = defaultParams();
      sm.update(v, 1 / fps, 0);
      v.water.uCaustic = 2;
      const frames = Math.round((3 * SMOOTH_SEC) * fps);
      for (let k = 0; k < frames; k++) sm.update(v, 1 / fps, 0);
      expect(sm.value('water', 'uCaustic')).toBeCloseTo(1 + (1 - Math.exp(-3)), 1);
    }
  });

  it('runs a speed clock in step with scene time at speed 1', () => {
    const sm = new ParamSmoother();
    const v = defaultParams();
    let t = 1000;
    sm.update(v, 0, t);
    for (let k = 0; k < 120; k++) { t += 1 / 60; sm.update(v, 1 / 60, t); }
    expect(sm.clock('water', 'uWaterT')).toBeCloseTo(t, 6);
  });

  it('slows a speed clock smoothly instead of jumping it', () => {
    const sm = new ParamSmoother();
    const v = defaultParams();
    let t = 5000;
    sm.update(v, 0, t);
    v.water.uSpeed = 0;
    let prev = sm.clock('water', 'uWaterT');
    for (let k = 0; k < 60; k++) {
      t += 1 / 60;
      sm.update(v, 1 / 60, t);
      const c = sm.clock('water', 'uWaterT');
      expect(c - prev).toBeGreaterThanOrEqual(0);
      expect(c - prev).toBeLessThanOrEqual(1 / 60 + 1e-9);
      prev = c;
    }
    sm.update(v, 1, t + 1);
    expect(sm.clock('water', 'uWaterT') - prev).toBeLessThan(1e-3);
  });

  it('falls back to defaults before the first frame', () => {
    expect(new ParamSmoother().value('skin', 'uGlow')).toBe(0.4);
  });
});

describe('param MIDI actions', () => {
  it('offers a fader for every shader parameter, after the fixed actions', () => {
    const pa = paramActions();
    expect(pa.length).toBe(PARAM_GROUPS.reduce((n, f) => n + f.params.length, 0));
    expect(pa.map((a) => a.id)).toContain('param:post2:uBloom');
    expect(pa.every((a) => a.type === 'fader')).toBe(true);
    expect(pa.map((a) => a.id)).toContain('param:water:uCaustic');
    expect(pa.find((a) => a.id === 'param:water:uCaustic')!.label).toBe(`${water.name}: Caustic strength`);
    expect(allActions().slice(0, ACTIONS.length)).toEqual(ACTIONS);
    expect(new Set(allActions().map((a) => a.id)).size).toBe(allActions().length);
  });

  it('reads the shader and uniform back from an action id', () => {
    expect(parseParamAction('param:water:uCaustic')).toEqual({ fx: 'water', name: 'uCaustic' });
    expect(parseParamAction('master')).toBeNull();
    expect(parseParamAction('param:water:caustic')).toBeNull();
  });
});

describe('shader trigger actions', () => {
  it('offers a MIDI pad for the eye blink', () => {
    const t = triggerActions();
    expect(t).toContainEqual({ id: 'fxtrigger:eye:blink', label: 'Reptile eye: Blink', type: 'trigger' });
    expect(allActions().map((a) => a.id)).toContain('fxtrigger:eye:blink');
    expect(parseTriggerAction('fxtrigger:eye:blink')).toEqual({ fx: 'eye', trigger: 'blink' });
    expect(parseTriggerAction('param:eye:uOpen')).toBeNull();
  });
});

describe('cue fades for shader settings', () => {
  it('stores only what a cue has, clamped', () => {
    expect(sanitizeParamSnapshot({ water: { uCaustic: 9 }, eye: {}, retired: { uA: 1 } })).toEqual({ water: { uCaustic: 2 } });
    expect(sanitizeParamSnapshot('x')).toBeNull();
    expect(sanitizeParamSnapshot({})).toBeNull();
  });

  it('glides from the shown value to the cue value over the fade time', () => {
    const sm = new ParamSmoother();
    const v = defaultParams();
    sm.update(v, 1 / 60, 0);
    v.eye.uPupilX = 1;
    sm.glide(v, 0, 4);
    sm.update(v, 1 / 60, 1);
    const early = sm.value('eye', 'uPupilX');
    sm.update(v, 1 / 60, 2);
    expect(sm.value('eye', 'uPupilX')).toBeCloseTo(0.5, 6);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.5);
    sm.update(v, 1 / 60, 4.01);
    expect(sm.value('eye', 'uPupilX')).toBe(1);
  });

  it('lets a hand change take over mid-fade', () => {
    const sm = new ParamSmoother();
    const v = defaultParams();
    sm.update(v, 1 / 60, 0);
    v.eye.uPupilX = 1;
    sm.glide(v, 0, 10);
    sm.update(v, 1 / 60, 1);
    v.eye.uPupilX = -1;
    for (let k = 0; k < 60; k++) sm.update(v, 1 / 60, 1 + k / 60);
    expect(sm.value('eye', 'uPupilX')).toBeCloseTo(-1, 3);
  });

  it('leaves unchanged settings alone and ignores a zero-length fade', () => {
    const sm = new ParamSmoother();
    const v = defaultParams();
    sm.update(v, 1 / 60, 0);
    sm.glide(v, 0, 5);
    v.water.uCaustic = 2;
    sm.glide(v, 0, 0);
    // No glide, so the quick easing applies: most of the way after one 80 ms time constant.
    sm.update(v, SMOOTH_SEC, SMOOTH_SEC);
    expect(sm.value('water', 'uCaustic')).toBeCloseTo(1 + (1 - Math.exp(-1)), 6);
  });
});
