import { describe, expect, it } from 'vitest';
import { runChecks, summarize, type PreflightInput } from './preflight';

/** A venue where everything is right. Each test breaks one thing. */
const ready: PreflightInput = {
  outputOpen: true, closedOutputs: [], outputFullscreen: true, fps: 60, audioState: 'listening', testTrack: false, autoBpm: false,
  wakeLock: true, offlineReady: true, isDev: false, charging: true, storagePersisted: true,
  videosInUse: [{ name: 'loop.mp4', state: 'ok' }], missingVideos: 0,
  showMode: true, wallDots: false, blackout: false, testGrid: false, master: 1,
};

const check = (patch: Partial<PreflightInput>, id: string) => runChecks({ ...ready, ...patch }).find((c) => c.id === id);

describe('runChecks', () => {
  it('is all clear for a ready venue', () => {
    const checks = runChecks(ready);
    expect(summarize(checks).clear).toBe(true);
    expect(checks.every((c) => c.hint === '')).toBe(true);
  });

  it('grades frame rate as ok, warn or fail', () => {
    expect(check({ fps: 59.6 }, 'fps')!.status).toBe('ok');
    expect(check({ fps: 40 }, 'fps')!.status).toBe('warn');
    expect(check({ fps: 20 }, 'fps')!.status).toBe('fail');
  });

  it('fails a disconnected input and warns on a silent one', () => {
    expect(check({ audioState: 'lost' }, 'audio')!.status).toBe('fail');
    expect(check({ audioState: 'silent' }, 'audio')!.status).toBe('warn');
  });

  it('warns when a test track is standing in for the live input', () => {
    expect(check({ audioState: 'listening', testTrack: true }, 'audio')!.status).toBe('warn');
  });

  it('treats audio off as a warning only when Auto beat is covering', () => {
    expect(check({ audioState: 'off', autoBpm: true }, 'audio')!.status).toBe('warn');
    expect(check({ audioState: 'off', autoBpm: false }, 'audio')!.status).toBe('fail');
  });

  it('separates undecodable videos from ones waiting on autoplay', () => {
    const broken = check({ videosInUse: [{ name: 'bad.mov', state: 'broken' }] }, 'videos')!;
    expect(broken.status).toBe('fail');
    expect(broken.hint).toContain('bad.mov');
    const paused = check({ videosInUse: [{ name: 'loop.mp4', state: 'paused' }] }, 'videos')!;
    expect(paused.status).toBe('warn');
    expect(paused.hint).toContain('Click');
  });

  it('fails panels pointing at deleted videos', () => {
    expect(check({ missingVideos: 2 }, 'videos')!.hint).toContain('2 panels');
  });

  it('skips video and storage checks when no panel uses a video', () => {
    const checks = runChecks({ ...ready, videosInUse: [], storagePersisted: false });
    expect(checks.find((c) => c.id === 'videos')).toBeUndefined();
    expect(checks.find((c) => c.id === 'storage')).toBeUndefined();
  });

  it('skips what the browser or dev server cannot report instead of failing it', () => {
    expect(check({ charging: null }, 'power')!.status).toBe('skip');
    expect(check({ isDev: true, offlineReady: false }, 'offline')!.status).toBe('skip');
    expect(summarize(runChecks({ ...ready, charging: null, isDev: true })).clear).toBe(true);
  });

  it('treats the wall as clean when the projector window is open without wall dots', () => {
    expect(check({ showMode: false, outputOpen: true, wallDots: false }, 'show')?.status).toBe('ok');
    expect(check({ showMode: false, outputOpen: true, wallDots: true }, 'show')?.status).toBe('warn');
    // Without a projector window the dots are drawn on the output in this window.
    expect(check({ showMode: false, outputOpen: false, wallDots: false }, 'show')?.status).toBe('warn');
  });

  it('catches show-night leftovers: blackout, test grid, low master, visible dots', () => {
    const s = summarize(runChecks({ ...ready, blackout: true, testGrid: true, master: 0.2, showMode: false, wallDots: true }));
    expect(s.warn).toBe(4);
    expect(s.fail).toBe(0);
  });
});

describe('projector windows', () => {
  it('names the projectors whose window is closed', () => {
    const one = runChecks({ ...ready, closedOutputs: ['Projector 2'] }).find((c) => c.id === 'output')!;
    expect(one.status).toBe('warn');
    expect(one.hint).toContain('Projector 2 has no window open');
    const both = runChecks({ ...ready, closedOutputs: ['Backdrop', 'Gator'] }).find((c) => c.id === 'output')!;
    expect(both.hint).toContain('Backdrop and Gator have no window open');
  });

  it('passes with every projector window open', () => {
    expect(runChecks({ ...ready, closedOutputs: [] }).find((c) => c.id === 'output')!.status).toBe('ok');
  });
});
