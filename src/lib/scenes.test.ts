import { describe, expect, it } from 'vitest';
import { SCENE_FS } from './shaders';
import { ACTIONS, SCENES, SCENE_KEYS, sceneForKey } from './types';
import { sanitize, setScene, settings } from './store';

describe('scenes', () => {
  it('has a shader branch for every scene', () => {
    for (let i = 1; i < SCENES.length - 1; i++) expect(SCENE_FS).toContain(`uScene == ${i})`);
    expect(SCENE_FS).not.toContain(`uScene == ${SCENES.length - 1})`);
  });

  it('gives every scene a unique key', () => {
    expect(SCENE_KEYS.length).toBeGreaterThanOrEqual(SCENES.length);
    expect(new Set(SCENE_KEYS).size).toBe(SCENE_KEYS.length);
    SCENES.forEach((_, i) => expect(sceneForKey(SCENE_KEYS[i])).toBe(i));
    expect(sceneForKey('0')).toBe(9);
    expect(sceneForKey('=')).toBe(11);
    expect(sceneForKey('q')).toBeNull();
  });

  it('lets you select and restore the new scenes', () => {
    setScene(11);
    expect(settings.get().scene).toBe(11);
    setScene(99);
    expect(settings.get().scene).toBe(SCENES.length - 1);
    expect(sanitize({ scene: 10 }).scene).toBe(10);
  });

  it('offers a MIDI action for every scene', () => {
    SCENES.forEach((_, i) => expect(ACTIONS.some((a) => a.id === `scene:${i}`)).toBe(true));
  });
});
