import { FX, type FxDef } from './fx';
import { POST_GROUPS } from './post';
import { Store } from './observable';
import { ACTIONS, type Action } from './types';

/*
 * Live values for panel shader parameters, one set per shader (so both eyes share pupil
 * position and blink). Kept apart from the main settings: faders and MIDI knobs change these
 * many times a second, and nothing else (handles, cues, crossfades) needs to react to that.
 * The render loop eases towards them, so 7-bit MIDI steps and slider jumps don't show.
 */

export type ParamValues = Record<string, Record<string, number>>;

/** A set of settings with sliders: a panel shader, or a projector's post effects. */
export type ParamGroup = Pick<FxDef, 'id' | 'name' | 'params' | 'triggers'>;

/** Every group of settings: the panel shaders, then each projector's post effects. */
export const PARAM_GROUPS: ParamGroup[] = [...FX, ...POST_GROUPS];

export const groupById = (id: string) => PARAM_GROUPS.find((g) => g.id === id);

export const PARAMS_KEY = 'panelmapper.params.v1';
/** Time constant of the easing towards a new value, in seconds: quick, but no visible steps. */
export const SMOOTH_SEC = 0.08;

const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Every shader's parameters at their defaults. */
export function defaultParams(defs: readonly ParamGroup[] = PARAM_GROUPS): ParamValues {
  return Object.fromEntries(defs.map((d) => [d.id, Object.fromEntries(d.params.map((p) => [p.name, p.default]))]));
}

/** Valid values for every shader in this build: saved ones clamped to range, defaults for the rest. */
export function sanitizeParams(raw: unknown, defs: readonly ParamGroup[] = PARAM_GROUPS): ParamValues {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(defs.map((d) => {
    const saved = o[d.id] && typeof o[d.id] === 'object' ? (o[d.id] as Record<string, unknown>) : {};
    return [d.id, Object.fromEntries(d.params.map((p) => {
      const v = saved[p.name];
      return [p.name, typeof v === 'number' && Number.isFinite(v) ? clampTo(v, p.min, p.max) : p.default];
    }))];
  }));
}

/**
 * Valid stored settings for a cue: only shaders and settings it has, clamped to range. Unlike
 * sanitizeParams it doesn't fill in defaults, so recalling it only changes what it saved.
 */
export function sanitizeParamSnapshot(raw: unknown, defs: readonly ParamGroup[] = PARAM_GROUPS): ParamValues | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: ParamValues = {};
  for (const d of defs) {
    const saved = o[d.id];
    if (!saved || typeof saved !== 'object') continue;
    const vals: Record<string, number> = {};
    for (const p of d.params) {
      const v = (saved as Record<string, unknown>)[p.name];
      if (typeof v === 'number' && Number.isFinite(v)) vals[p.name] = clampTo(v, p.min, p.max);
    }
    if (Object.keys(vals).length) out[d.id] = vals;
  }
  return Object.keys(out).length ? out : null;
}

function load(): ParamValues {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (raw) return sanitizeParams(JSON.parse(raw));
  } catch { /* unreadable: defaults */ }
  return defaultParams();
}

export const params = new Store<ParamValues>(typeof window === 'undefined' ? defaultParams() : load());

if (typeof window !== 'undefined') {
  let t: ReturnType<typeof setTimeout> | undefined;
  params.subscribe(() => {
    clearTimeout(t);
    t = setTimeout(() => {
      try { localStorage.setItem(PARAMS_KEY, JSON.stringify(params.get())); } catch { /* storage full or blocked */ }
    }, 500);
  });
}

/** A MIDI fader per panel shader parameter, id `param:<shader>:<uniform>`. */
export function paramActions(defs: readonly ParamGroup[] = PARAM_GROUPS): Action[] {
  return defs.flatMap((d) => d.params.map((p) => ({ id: `param:${d.id}:${p.name}`, label: `${d.name}: ${p.label}`, type: 'fader' as const })));
}

/** A MIDI pad per shader trigger (such as the eye's blink), id `fxtrigger:<shader>:<trigger>`. */
export function triggerActions(defs: readonly ParamGroup[] = PARAM_GROUPS): Action[] {
  return defs.flatMap((d) => (d.triggers ?? []).map((t) => ({ id: `fxtrigger:${d.id}:${t.id}`, label: `${d.name}: ${t.label}`, type: 'trigger' as const })));
}

/** Everything MIDI can be learned for: the fixed actions, then shader triggers and parameters. */
export const allActions = (): Action[] => [...ACTIONS, ...triggerActions(), ...paramActions()];

/** The shader and trigger an `fxtrigger:` action id points at, or null. */
export function parseTriggerAction(id: string): { fx: string; trigger: string } | null {
  const m = /^fxtrigger:([\w-]+):([\w-]+)$/.exec(id);
  return m ? { fx: m[1], trigger: m[2] } : null;
}

/** The shader and uniform a `param:` action id points at, or null. */
export function parseParamAction(id: string): { fx: string; name: string } | null {
  const m = /^param:([\w-]+):(u[A-Z]\w*)$/.exec(id);
  return m ? { fx: m[1], name: m[2] } : null;
}

/** Sets one parameter, clamped to its range. Unknown shaders or parameters are ignored. */
export function setParam(fxId: string, name: string, value: number) {
  const p = groupById(fxId)?.params.find((x) => x.name === name);
  if (!p || !Number.isFinite(value)) return;
  const v = clampTo(value, p.min, p.max);
  params.set((s) => ({ [fxId]: { ...(s[fxId] ?? {}), [name]: v } }));
}

/** Sets a parameter from a fader position, 0..1 across its range. */
export function setParamFromFader(fxId: string, name: string, x: number) {
  const p = groupById(fxId)?.params.find((q) => q.name === name);
  if (p) setParam(fxId, name, p.min + clampTo(x, 0, 1) * (p.max - p.min));
}

export function resetParams(fxId?: string) {
  const d = defaultParams();
  params.set(fxId ? { [fxId]: d[fxId] } : d);
}

/** The value a parameter is heading for, falling back to its default. */
export function targetParam(values: ParamValues, def: ParamGroup, name: string): number {
  const v = values[def.id]?.[name];
  return typeof v === 'number' ? v : def.params.find((p) => p.name === name)?.default ?? 0;
}

/**
 * Eases displayed values towards their targets and integrates clock parameters. A clock (a param
 * with `clock` set) is a speed: its uniform runs at that speed, so changing it slows or speeds the
 * motion instead of jumping it. A clock starts at the scene time, so at speed 1 it matches uTime
 * exactly and looks drawn with it stay in step.
 */
export class ParamSmoother {
  private shown = new Map<string, number>();
  private clocks = new Map<string, number>();
  /** Timed fades in progress (a cue recall), by key: from the shown value to a set target. */
  private glides = new Map<string, { from: number; to: number; start: number; dur: number }>();

  /**
   * Fades every setting whose value is changing from what's shown now to `values` over `dur`
   * seconds, starting at `now`, instead of the quick easing. Moving a setting by hand during
   * the fade takes over from it straight away.
   */
  glide(values: ParamValues, now: number, dur: number, defs: readonly ParamGroup[] = PARAM_GROUPS) {
    if (!(dur > 0)) return;
    for (const d of defs) {
      for (const p of d.params) {
        const key = `${d.id}.${p.name}`;
        const from = this.shown.get(key);
        const to = targetParam(values, d, p.name);
        if (from === undefined || Math.abs(from - to) < 1e-9) continue;
        this.glides.set(key, { from, to, start: now, dur });
      }
    }
  }

  /** Advance by `dt` seconds; `now` is the shared scene time. */
  update(values: ParamValues, dt: number, now: number, defs: readonly ParamGroup[] = PARAM_GROUPS) {
    const k = dt > 0 ? 1 - Math.exp(-dt / SMOOTH_SEC) : 0;
    for (const d of defs) {
      for (const p of d.params) {
        const key = `${d.id}.${p.name}`;
        const target = targetParam(values, d, p.name);
        const cur = this.shown.get(key);
        const g = this.glides.get(key);
        let v: number;
        if (g && g.to === target && cur !== undefined) {
          const x = (now - g.start) / g.dur;
          if (x >= 1) { v = target; this.glides.delete(key); }
          else { const e = Math.max(0, x); v = g.from + (g.to - g.from) * (e < 0.5 ? 2 * e * e : 1 - (-2 * e + 2) ** 2 / 2); }
        } else {
          if (g) this.glides.delete(key);
          v = cur === undefined ? target : cur + (target - cur) * k;
        }
        this.shown.set(key, Math.abs(v - target) < 1e-6 ? target : v);
        if (p.clock) {
          const ck = `${d.id}.${p.clock}`;
          const c = this.clocks.get(ck);
          this.clocks.set(ck, c === undefined ? now * v : c + Math.max(0, dt) * v);
        }
      }
    }
  }

  /** The eased value of a parameter, or its default before the first update. */
  value(fxId: string, name: string): number {
    const v = this.shown.get(`${fxId}.${name}`);
    if (v !== undefined) return v;
    return groupById(fxId)?.params.find((p) => p.name === name)?.default ?? 0;
  }

  /** The integrated clock uniform, or 0 before the first update. */
  clock(fxId: string, name: string): number {
    return this.clocks.get(`${fxId}.${name}`) ?? 0;
  }
}
