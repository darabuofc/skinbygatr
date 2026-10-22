import { describe, expect, it } from 'vitest';
import { FrameGuard, REPORT_EVERY_MS } from './loop';

describe('FrameGuard', () => {
  it('runs a clean frame and reports nothing', () => {
    const msgs: string[] = [];
    const g = new FrameGuard((m) => msgs.push(m));
    let ran = false;
    expect(g.run(() => { ran = true; }, 0)).toBe(true);
    expect(ran).toBe(true);
    expect(msgs).toEqual([]);
  });

  it('catches a throwing frame so the caller can schedule the next one', () => {
    const msgs: string[] = [];
    const g = new FrameGuard((m) => msgs.push(m));
    expect(g.run(() => { throw new TypeError("Cannot read properties of undefined (reading 'slice')"); }, 0)).toBe(false);
    expect(g.failing).toBe(1);
    expect(msgs).toEqual(["Cannot read properties of undefined (reading 'slice')"]);
  });

  it('reports a repeating error at most once per interval', () => {
    const msgs: string[] = [];
    const g = new FrameGuard((m) => msgs.push(m));
    const boom = () => { throw new Error('boom'); };
    for (let t = 0; t < REPORT_EVERY_MS; t += 16) g.run(boom, t);
    expect(msgs).toHaveLength(1);
    g.run(boom, REPORT_EVERY_MS);
    expect(msgs).toHaveLength(2);
  });

  it('reports a different error straight away and resets once frames are clean', () => {
    const msgs: string[] = [];
    const g = new FrameGuard((m) => msgs.push(m));
    g.run(() => { throw new Error('a'); }, 0);
    g.run(() => { throw new Error('b'); }, 16);
    g.run(() => { throw 'plain string'; }, 32);
    expect(msgs).toEqual(['a', 'b', 'plain string']);
    expect(g.failing).toBe(3);
    g.run(() => {}, 48);
    expect(g.failing).toBe(0);
  });
});
