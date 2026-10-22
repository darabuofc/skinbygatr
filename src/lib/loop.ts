/*
 * Keeps the render loop alive through a bad frame. An exception in one frame used to skip
 * scheduling the next, freezing the wall until the watchdog, which then hit the same error.
 * Pure, so the reporting rules are unit tested; the engine runs each frame through it.
 */

/** A repeating error is reported at most this often, so the message doesn't flood the UI. */
export const REPORT_EVERY_MS = 5000;

export class FrameGuard {
  private lastReport = -Infinity;
  private lastMsg = '';
  /** Frames that threw since the last clean one. */
  failing = 0;

  constructor(private readonly report: (msg: string) => void) {}

  /** Runs one frame. Returns false if it threw; the caller schedules the next frame either way. */
  run(fn: () => void, now = performance.now()): boolean {
    try {
      fn();
      this.failing = 0;
      return true;
    } catch (e) {
      this.failing++;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== this.lastMsg || now - this.lastReport >= REPORT_EVERY_MS) {
        this.lastMsg = msg;
        this.lastReport = now;
        this.report(msg);
      }
      return false;
    }
  }
}
