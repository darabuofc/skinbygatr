import { describe, expect, it } from 'vitest';
import { clampSmdSize, defaultSmd, ledOf, MAX_SMD_PRESETS, presetOf, sanitizePresets, sanitizeSmd, withPreset, smdBox, smdPanel, SMD_MAX_PIXELS, SMD_MIN } from './smd';

const okSource = (s: unknown): s is string => s === 'gen' || (typeof s === 'string' && s.startsWith('fx:'));
const okBand = (b: unknown) => b === 'none' || b === 'bass';

describe('clampSmdSize', () => {
  it('keeps a normal size and rounds to whole pixels', () => {
    expect(clampSmdSize(1080, 1080)).toEqual({ width: 1080, height: 1080 });
    expect(clampSmdSize(255.6, 128.2)).toEqual({ width: 256, height: 128 });
  });
  it('falls back to the default for junk and clamps tiny sizes', () => {
    expect(clampSmdSize('x', NaN)).toEqual({ width: 1080, height: 1080 });
    expect(clampSmdSize(1, -5)).toEqual({ width: SMD_MIN, height: SMD_MIN });
  });
  it('scales an oversized screen down keeping its shape', () => {
    const { width, height } = clampSmdSize(8192, 8192);
    expect(width * height).toBeLessThanOrEqual(SMD_MAX_PIXELS);
    expect(width).toBe(height);
    const wide = clampSmdSize(8192, 4096);
    expect(wide.width * wide.height).toBeLessThanOrEqual(SMD_MAX_PIXELS);
    expect(wide.width / wide.height).toBeCloseTo(2, 1);
  });
});

describe('sanitizeSmd', () => {
  it('defaults to a square screen', () => {
    expect(sanitizeSmd(undefined, okSource, okBand)).toEqual(defaultSmd());
    expect(defaultSmd().width).toBe(defaultSmd().height);
  });
  it('keeps valid fields and repairs bad ones', () => {
    expect(sanitizeSmd({ width: 512, height: 512, fit: 'pixel', source: 'fx:water', band: 'bass' }, okSource, okBand))
      .toEqual({ ...defaultSmd(), width: 512, height: 512, fit: 'pixel', source: 'fx:water', band: 'bass' });
    const bad = sanitizeSmd({ width: 'a', fit: 'zoom', source: 'vid:gone', band: 'loud' }, okSource, okBand);
    expect(bad).toEqual({ ...defaultSmd(), source: 'gen' });
  });
});

describe('smdPanel', () => {
  it('covers the whole screen with the chosen content', () => {
    const p = smdPanel({ ...defaultSmd(), source: 'fx:water', band: 'bass' }, 'out1');
    expect(p.corners).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(p).toMatchObject({ output: 'out1', source: 'fx:water', band: 'bass', opacity: 1, blend: 'over', feather: 0 });
  });
});

describe('smdBox', () => {
  const sq = { width: 1080, height: 1080 };
  it('fit centres the largest copy of the screen shape', () => {
    expect(smdBox(1920, 1080, 1, { ...sq, fit: 'fit' })).toEqual({ x: 420, y: 0, w: 1080, h: 1080 });
    const tall = smdBox(1000, 2000, 1, { ...sq, fit: 'fit' });
    expect(tall).toEqual({ x: 0, y: 500, w: 1000, h: 1000 });
  });
  it('pixel keeps true size at the top-left, in CSS px for the display ratio', () => {
    expect(smdBox(1920, 1080, 1, { width: 512, height: 256, fit: 'pixel' })).toEqual({ x: 0, y: 0, w: 512, h: 256 });
    expect(smdBox(1920, 1080, 2, { width: 512, height: 256, fit: 'pixel' })).toEqual({ x: 0, y: 0, w: 256, h: 128 });
  });
});

describe('LED output settings', () => {
  it('default to a safe, unchanged picture with a 3 per second flash limit', () => {
    const d = defaultSmd();
    expect(d).toMatchObject({ maxBrightness: 1, gamma: 1, warmth: 0, flashLimit: 3 });
    expect(ledOf(d)).toBeNull();
  });
  it('are clamped when loaded', () => {
    const s = sanitizeSmd({ maxBrightness: 0, gamma: 99, warmth: -5, flashLimit: 7 }, okSource, okBand);
    expect(s).toMatchObject({ maxBrightness: 0.1, gamma: 3, warmth: -1, flashLimit: 3 });
    expect(sanitizeSmd({ flashLimit: 0, maxBrightness: 'x' }, okSource, okBand)).toMatchObject({ flashLimit: 0, maxBrightness: 1 });
  });
  it('ledOf is active as soon as any correction changes the picture', () => {
    const d = defaultSmd();
    expect(ledOf({ ...d, maxBrightness: 0.6 })).toEqual({ cap: 0.6, gamma: 1, warmth: 0 });
    expect(ledOf({ ...d, gamma: 2.2 })).not.toBeNull();
    expect(ledOf({ ...d, warmth: 0.3 })).not.toBeNull();
  });
});

describe('saved screens', () => {
  const cfg = { ...defaultSmd(), width: 512, height: 512, gamma: 2, maxBrightness: 0.6 };
  it('keep shape, fit and LED settings but not the content', () => {
    const p = presetOf('  Club  ', { ...cfg, source: 'fx:water' });
    expect(p).toEqual({ name: 'Club', width: 512, height: 512, fit: 'fit', maxBrightness: 0.6, gamma: 2, warmth: 0, flashLimit: 3 });
    expect('source' in p).toBe(false);
  });
  it('replace a preset of the same name whatever its letter case, and drop the oldest when full', () => {
    const a = presetOf('Club', cfg);
    const b = presetOf('club', { ...cfg, width: 640, height: 640 });
    expect(withPreset([a], b)).toEqual([b]);
    expect(withPreset([a], presetOf('  ', cfg))).toEqual([a]);
    let list = [] as ReturnType<typeof withPreset>;
    for (let i = 0; i < MAX_SMD_PRESETS + 3; i++) list = withPreset(list, presetOf(`v${i}`, cfg));
    expect(list).toHaveLength(MAX_SMD_PRESETS);
    expect(list[0].name).toBe('v3');
  });
  it('are repaired when loaded and junk is dropped', () => {
    const out = sanitizePresets([{ name: 'A', width: 99999, height: 'x', gamma: 99 }, null, { name: '' }, { width: 5 }, 'junk', { name: 'a', width: 300, height: 300 }], okSource, okBand);
    expect(out).toHaveLength(1); // 'a' replaced 'A'
    expect(out[0]).toMatchObject({ name: 'a', width: 300, height: 300 });
    expect(sanitizePresets('nope', okSource, okBand)).toEqual([]);
  });
});

describe('SMD slideshow', () => {
  it('is kept when loaded, with its hard-cut choice, and absent by default', () => {
    expect(defaultSmd().playlist).toBeUndefined();
    const s = sanitizeSmd({ playlist: { items: ['vid:a', 'img:b', 'bad'], beats: 0.5, cut: true, order: 'shuffle' } }, okSource, okBand);
    expect(s.playlist).toEqual({ on: true, items: ['vid:a', 'img:b'], beats: 0.5, order: 'shuffle', cut: true });
  });
  it('is not saved in a screen preset', () => {
    const p = presetOf('x', sanitizeSmd({ playlist: { items: ['vid:a'] } }, okSource, okBand));
    expect('playlist' in p).toBe(false);
  });
});
