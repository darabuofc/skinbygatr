/*
 * Which window shows what, with one or two projectors. Pure, so the rules are unit tested;
 * the engine owns the windows and follows these answers.
 *
 * - No projector window open: this window draws the first projector, as before.
 * - Any projector window open: each open window draws its own projector, this window shows a live,
 *   editable copy of one of them, and projectors without a window aren't drawn anywhere.
 */

/** What the control window's stage holds. */
export type MainView = { kind: 'surface'; id: string } | { kind: 'preview'; id: string };

export function mainView(openIds: readonly string[], firstId: string, preferred: string | null): MainView {
  if (!openIds.length) return { kind: 'surface', id: firstId };
  return { kind: 'preview', id: preferred && openIds.includes(preferred) ? preferred : openIds[0] };
}

/** The bit of a window the render loop needs to choose one to follow. */
export interface DriverCandidate { closed: boolean; document: { visibilityState: string } }

/**
 * The window whose display refresh drives the render loop: the first open, visible one.
 * Null when none is visible, so the loop falls back to a timer instead of waiting on a hidden
 * window's animation frames, which browsers pause.
 */
export function pickDriver<W extends DriverCandidate>(wins: readonly W[]): W | null {
  for (const w of wins) {
    try {
      if (!w.closed && w.document.visibilityState === 'visible') return w;
    } catch { /* window torn down mid-check */ }
  }
  return null;
}

/** Window name per projector, so opening the second one doesn't just focus the first. */
export const windowName = (outputId: string) => `pm_output_${outputId}`;
