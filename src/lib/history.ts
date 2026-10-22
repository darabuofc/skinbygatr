import type { Panel } from './types';

/*
 * Undo for mapping: corner drags, nudges, moving, adding and removing panels, moving a panel to another
 * projector, mesh warps, and mask outlines (points and feather; masks are geometry, not part of cues).
 * Only geometry is restored. A panel that still exists keeps its current source,
 * band and softness, so undoing a drag never reverts a cue recall or a source change.
 */

export const HISTORY_LIMIT = 100;
/** Repeated nudges of the same corner within this window collapse into one undo step. */
export const COALESCE_MS = 1000;

type Snapshot = Panel[];

/** Applies a snapshot's panel set, order, corners and projector, keeping current content for panels that still exist. */
export function restoreGeometry(current: Panel[], snap: Snapshot): Panel[] {
  const byId = new Map(current.map((p) => [p.id, p]));
  return snap.map((s) => {
    const now = byId.get(s.id);
    if (!now) return s;
    const { mask: _m, mesh: _g, ...rest } = now;
    return { ...rest, corners: s.corners, output: s.output, ...(s.mesh ? { mesh: s.mesh } : {}), ...(s.mask ? { mask: s.mask } : {}) };
  });
}

const sameGeometry = (a: Panel[], b: Panel[]) =>
  a.length === b.length && a.every((p, i) => p.id === b[i].id && p.output === b[i].output && p.mask === b[i].mask && p.mesh === b[i].mesh && p.corners.every((q, c) => q[0] === b[i].corners[c][0] && q[1] === b[i].corners[c][1]));

export class MapHistory {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private lastKey = '';
  private lastAt = -Infinity;

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  /**
   * Records the state before an edit. Pass a key (such as the nudged corner) to merge a
   * burst of small edits into one step.
   */
  push(before: Panel[], key = '', now = Date.now()) {
    const merge = key !== '' && key === this.lastKey && now - this.lastAt < COALESCE_MS;
    this.lastKey = key;
    this.lastAt = now;
    if (merge) return;
    const top = this.past[this.past.length - 1];
    if (top && sameGeometry(top, before)) return;
    this.past.push(before);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  undo(current: Panel[]): Panel[] | null {
    const snap = this.past.pop();
    if (!snap) return null;
    this.future.push(current);
    this.lastKey = '';
    return restoreGeometry(current, snap);
  }

  redo(current: Panel[]): Panel[] | null {
    const snap = this.future.pop();
    if (!snap) return null;
    this.past.push(current);
    this.lastKey = '';
    return restoreGeometry(current, snap);
  }

  clear() { this.past = []; this.future = []; this.lastKey = ''; }
}
