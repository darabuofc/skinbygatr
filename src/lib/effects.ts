import type { Levels } from './audio';

/** What drives the RGB split: the kick envelope or one of the band levels. */
export type SplitDrive = 'kick' | 'bass' | 'mid' | 'high';

export const SPLIT_DRIVES: [SplitDrive, string][] = [
  ['kick', 'Kick'],
  ['bass', 'Bass'],
  ['mid', 'Mids'],
  ['high', 'Highs'],
];

/** Widest channel offset at full amount and full level, as a fraction of the panel width. */
export const MAX_SPLIT = 0.025;

/**
 * How far the red and blue channels pull apart this frame, as a signed fraction of the panel width.
 * On the kick the direction flips every beat, so consecutive hits tear left then right.
 * Zero without real audio or the auto beat, matching how panels hold steady then.
 */
export function splitOffset(L: Levels, amount: number, drive: SplitDrive): number {
  if (amount <= 0 || !L.live) return 0;
  const v = drive === 'kick' ? L.kickEnv : Math.min(1, L[drive] * 1.3);
  const dir = drive === 'kick' && L.beat % 2 === 1 ? -1 : 1;
  return dir * Math.min(1, amount) * v * MAX_SPLIT;
}
