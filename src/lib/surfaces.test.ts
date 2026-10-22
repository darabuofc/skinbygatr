import { describe, expect, it } from 'vitest';
import { mainView, pickDriver, windowName } from './surfaces';

describe('mainView', () => {
  it('draws the first projector here while no projector window is open', () => {
    expect(mainView([], 'out1', null)).toEqual({ kind: 'surface', id: 'out1' });
    expect(mainView([], 'out1', 'out2')).toEqual({ kind: 'surface', id: 'out1' });
  });

  it('shows a live copy once any projector window is open', () => {
    expect(mainView(['out2'], 'out1', null)).toEqual({ kind: 'preview', id: 'out2' });
  });

  it('keeps the projector asked for when its window is open, else the first open one', () => {
    expect(mainView(['out1', 'out2'], 'out1', 'out2')).toEqual({ kind: 'preview', id: 'out2' });
    expect(mainView(['out1'], 'out1', 'out2')).toEqual({ kind: 'preview', id: 'out1' });
  });
});

describe('pickDriver', () => {
  const win = (closed: boolean, visibilityState: string) => ({ closed, document: { visibilityState } });

  it('follows the first open, visible window', () => {
    const a = win(false, 'visible'), b = win(false, 'visible');
    expect(pickDriver([a, b])).toBe(a);
  });

  it('skips closed and hidden windows', () => {
    const closed = win(true, 'visible'), hidden = win(false, 'hidden'), main = win(false, 'visible');
    expect(pickDriver([closed, hidden, main])).toBe(main);
  });

  it('returns null when nothing is visible, so the loop falls back to a timer', () => {
    expect(pickDriver([win(false, 'hidden'), win(true, 'visible')])).toBeNull();
    expect(pickDriver([])).toBeNull();
  });

  it('survives a window that throws while being torn down', () => {
    const broken = { get closed(): boolean { throw new Error('gone'); }, document: { visibilityState: 'visible' } };
    const main = win(false, 'visible');
    expect(pickDriver([broken, main])).toBe(main);
  });
});

describe('windowName', () => {
  it('differs per projector, so opening the second one opens a new window', () => {
    expect(windowName('out1')).not.toBe(windowName('out2'));
  });
});
