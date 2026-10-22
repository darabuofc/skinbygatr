import { afterEach, describe, expect, it, vi } from 'vitest';
import { PARAM_GROUPS } from './params';
import {
  buildGeo, buildSnapshot, parseGeo, type StateMsg, channelName, CODE_LENGTH, makeThrottle, newSessionCode, parseToHost, parseToRemote, remoteUrl, validSessionCode,
} from './remote';
import { createBroadcastTransport, createMemoryPair } from './transport';
import { codeFromLocation } from './remoteClient';
import { defaultSettings } from './store';
import { SCENES } from './types';

afterEach(() => vi.useRealTimers());

describe('parseToHost', () => {
  it('accepts triggers, ignoring any value', () => {
    expect(parseToHost({ t: 'act', id: 'scene:3', v: 99 })).toEqual({ t: 'act', id: 'scene:3' });
    expect(parseToHost({ t: 'act', id: 'blackout' })).toEqual({ t: 'act', id: 'blackout' });
    expect(parseToHost({ t: 'hello' })).toEqual({ t: 'hello' });
  });
  it('clamps fader values to 0..1 and requires a finite number', () => {
    expect(parseToHost({ t: 'act', id: 'master', v: 4 })).toEqual({ t: 'act', id: 'master', v: 1 });
    expect(parseToHost({ t: 'act', id: 'master', v: -1 })).toEqual({ t: 'act', id: 'master', v: 0 });
    expect(parseToHost({ t: 'act', id: 'master' })).toBeNull();
    expect(parseToHost({ t: 'act', id: 'master', v: NaN })).toBeNull();
    expect(parseToHost({ t: 'act', id: 'master', v: '0.5' })).toBeNull();
  });
  it('turns a hold into 1 or 0', () => {
    expect(parseToHost({ t: 'act', id: 'flash', v: 1 })).toEqual({ t: 'act', id: 'flash', v: 1 });
    expect(parseToHost({ t: 'act', id: 'flash' })).toEqual({ t: 'act', id: 'flash', v: 0 });
  });
  it('knows shader faders and triggers', () => {
    const g = PARAM_GROUPS.find((x) => x.triggers?.length)!;
    expect(parseToHost({ t: 'act', id: `fxtrigger:${g.id}:${g.triggers![0].id}` })).not.toBeNull();
    expect(parseToHost({ t: 'act', id: `param:${g.id}:${g.params[0].name}`, v: 0.5 })).not.toBeNull();
  });
  it('drops anything else', () => {
    for (const bad of [null, 5, 'x', {}, { t: 'act' }, { t: 'act', id: 'scene:99' }, { t: 'act', id: 'rm -rf' }, { t: 'act', id: 'x'.repeat(500) }, { t: 'set', settings: {} }, { t: 'act', id: 7 }]) {
      expect(parseToHost(bad)).toBeNull();
    }
  });
});

describe('snapshot', () => {
  it('round-trips through the wire format', () => {
    const s = defaultSettings();
    s.scene = 4;
    s.cues[1] = { scene: 2 } as never;
    const snap = buildSnapshot(s, true, { eye: { uPulse: 0.3 } });
    const back = parseToRemote(JSON.parse(JSON.stringify({ t: 'state', s: snap }))) as StateMsg;
    expect(back?.s.scene).toBe(4);
    expect(back?.s.blackout).toBe(true);
    expect(back?.s.cues[1]).toBe(SCENES[2]);
    expect(back?.s.cues[0]).toBeNull();
    expect(back?.s.params.eye.uPulse).toBe(0.3);
  });
  it('rejects other versions and fixes out-of-range values', () => {
    expect(parseToRemote({ t: 'state', s: { v: 99 } })).toBeNull();
    expect((parseToRemote({ t: 'state', s: { v: 1, scene: 999, params: { a: { b: 'x', c: 2 } } } }) as StateMsg | null)?.s).toMatchObject({ scene: SCENES.length - 1, params: { a: { c: 2 } } });
  });
});

describe('session code', () => {
  it('is the right length, uses only the alphabet and differs each time', () => {
    const a = newSessionCode(), b = newSessionCode();
    expect(a).toHaveLength(CODE_LENGTH);
    expect(validSessionCode(a)).toBe(true);
    expect(a).not.toBe(b);
  });
  it('is not skewed by bytes that would wrap around the alphabet', () => {
    // 255 is above the rejection limit, so a source of nothing but 255s must fall through to 0s.
    let n = 0;
    const code = newSessionCode((len) => new Uint8Array(len).fill(n++ < 2 ? 255 : 0));
    expect(code).toBe('a'.repeat(CODE_LENGTH));
  });
  it('validates and builds addresses with the code in the fragment', () => {
    expect(validSessionCode('short')).toBe(false);
    expect(validSessionCode('A'.repeat(CODE_LENGTH))).toBe(false);
    const c = newSessionCode();
    expect(remoteUrl('https://x.app', c)).toBe(`https://x.app/remote#${c}`);
    expect(channelName(c)).toBe(`panelmapper:${c}`);
  });
  it('takes the code from the link, else the one remembered, else none', () => {
    const a = newSessionCode(), b = newSessionCode();
    expect(codeFromLocation(`#${a}`, b)).toBe(a);
    expect(codeFromLocation('', b)).toBe(b);
    expect(codeFromLocation('#nonsense', b)).toBe(b);
    expect(codeFromLocation('', '')).toBe('');
  });
});

describe('makeThrottle', () => {
  it('sends the first at once, then at most once per interval, ending on the latest', () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const t = makeThrottle<number>((v) => sent.push(v), 100, () => Date.now());
    t.push(1); t.push(2); t.push(3);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([1, 3]);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([1, 3]);
  });
  it('flush sends the waiting value straight away and cancel drops it', () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const t = makeThrottle<number>((v) => sent.push(v), 100, () => Date.now());
    t.push(1); t.push(2);
    t.flush();
    expect(sent).toEqual([1, 2]);
    // Inside the interval after the flush, so 3 and 4 wait; cancel drops them.
    t.push(3); t.push(4);
    t.cancel();
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([1, 2]);
  });
});

describe('memory transport', () => {
  it('delivers both ways as copies', async () => {
    const [host, remote] = createMemoryPair();
    const got: unknown[] = [];
    host.onMessage((m) => got.push(m));
    const sent = { t: 'act', id: 'blackout' };
    remote.send(sent);
    await Promise.resolve();
    expect(got).toEqual([sent]);
    expect(got[0]).not.toBe(sent);
  });
});

describe('broadcast transport', () => {
  it('does not report or send after it is closed (React runs effects twice in development)', async () => {
    const t = createBroadcastTransport(`test:${Math.random()}`);
    let calls = 0;
    t.onStatus(() => { calls++; });
    t.close();
    await Promise.resolve();
    expect(calls).toBe(0);
    expect(() => t.send({ t: 'hello' })).not.toThrow();
  });
  it('reports connected to a listener that stays', async () => {
    const t = createBroadcastTransport(`test:${Math.random()}`);
    const seen: string[] = [];
    t.onStatus((s) => seen.push(s));
    await Promise.resolve();
    expect(seen).toEqual(['connected']);
    t.close();
  });
});
