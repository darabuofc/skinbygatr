import type { AudioState } from './audio';

/*
 * The pre-show check: a snapshot of everything that can quietly go wrong before doors,
 * turned into a list of plain-language results. Pure, so every rule is unit tested;
 * the engine gathers the snapshot and the sidebar renders the results.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  /** What's wrong and how to fix it. Empty when the check passes. */
  hint: string;
}

export interface VideoHealth {
  name: string;
  /** 'paused' is usually autoplay waiting for a click; 'broken' is a file the browser can't decode. */
  state: 'ok' | 'paused' | 'broken';
}

export interface PreflightInput {
  outputOpen: boolean;
  /** Names of projectors with no window open, when the show has more than one. */
  closedOutputs: string[];
  /** The output window fills its screen (fullscreen, or maximised to the same size). */
  outputFullscreen: boolean;
  fps: number;
  audioState: AudioState;
  /** A test track is feeding the visuals instead of the live input. */
  testTrack: boolean;
  autoBpm: boolean;
  wakeLock: boolean;
  offlineReady: boolean;
  /** Offline caching only runs in production builds. */
  isDev: boolean;
  /** Null when the browser doesn't report battery state. */
  charging: boolean | null;
  /** Null when the browser can't tell whether storage is protected from clean-up. */
  storagePersisted: boolean | null;
  /** Videos assigned to at least one panel, with whether each is decoding. */
  videosInUse: VideoHealth[];
  /** Panels pointing at a video no longer in the library. */
  missingVideos: number;
  showMode: boolean;
  /** "Dots on the wall" is ticked while the projector window is open. */
  wallDots: boolean;
  blackout: boolean;
  testGrid: boolean;
  master: number;
}

export const FPS_GOOD = 50;
export const FPS_POOR = 30;

const ok = (id: string, label: string): Check => ({ id, label, status: 'ok', hint: '' });

export function runChecks(i: PreflightInput): Check[] {
  const checks: Check[] = [];
  const add = (id: string, label: string, status: CheckStatus, hint: string) =>
    checks.push(status === 'ok' ? ok(id, label) : { id, label, status, hint });

  if (i.closedOutputs.length) {
    const names = i.closedOutputs.join(' and ');
    add('output', 'Every projector window open', 'warn',
      `${names} ${i.closedOutputs.length > 1 ? 'have' : 'has'} no window open, so ${i.closedOutputs.length > 1 ? 'they show' : 'it shows'} nothing. Click Open window under Projectors.`);
  } else {
    add('output', 'Projector window open', i.outputOpen ? 'ok' : 'warn',
      'Output is in this window. Fine if the projector mirrors the laptop; otherwise click Open projector window.');
  }

  add('fullscreen', 'Output is fullscreen', i.outputFullscreen ? 'ok' : 'warn',
    i.outputOpen
      ? 'Click inside the projector window and press F, or the window frame shows on the wall.'
      : 'Press F so the browser bars don’t show on the wall.');

  const f = Math.round(i.fps);
  add('fps', `Smooth playback (${f} fps)`, f >= FPS_GOOD ? 'ok' : f >= FPS_POOR ? 'warn' : 'fail',
    'The laptop is struggling. Plug in power, close other apps and browser tabs, or use fewer video panels.');

  if (i.testTrack) {
    add('audio', 'Following the live input', 'warn',
      'Visuals are following a test track, not the mixer. Click Stop, then Start audio input before the set.');
  } else if (i.audioState === 'listening') add('audio', 'Audio input has sound', 'ok', '');
  else if (i.audioState === 'silent') {
    add('audio', 'Audio input has sound', 'warn',
      'The input is on but silent. Check the cable, the mixer send and the input gain. The auto beat is covering for now.');
  } else if (i.audioState === 'lost') {
    add('audio', 'Audio input connected', 'fail',
      'The interface disconnected. Plug it back in; it reconnects on its own. The auto beat is covering for now.');
  } else {
    add('audio', 'Audio input on', i.autoBpm ? 'warn' : 'fail',
      i.autoBpm
        ? 'Audio is off, so visuals follow the auto beat only. Click Start audio input to follow the music.'
        : 'Audio is off and Auto beat is off, so visuals only idle. Click Start audio input.');
  }

  add('power', 'Laptop on power', i.charging === null ? 'skip' : i.charging ? 'ok' : 'warn',
    i.charging === null
      ? 'This browser doesn’t report battery state. Check the charger by eye.'
      : 'Running on battery. Plug in: laptops slow down to save power.');

  add('wake', 'Screen stays awake', i.wakeLock ? 'ok' : 'warn',
    'The browser hasn’t granted wake lock. Turn off display sleep and screen saver in system settings.');

  add('offline', 'Works without internet', i.isDev ? 'skip' : i.offlineReady ? 'ok' : 'warn',
    i.isDev
      ? 'Only checked on the deployed app, not the dev server.'
      : 'Not cached yet. Reload once while online and wait for “Works offline”.');

  const broken = i.videosInUse.filter((v) => v.state === 'broken');
  const paused = i.videosInUse.filter((v) => v.state === 'paused');
  if (i.missingVideos > 0) {
    add('videos', 'Videos ready', 'fail',
      `${i.missingVideos === 1 ? 'A panel uses a video' : `${i.missingVideos} panels use videos`} no longer in the library. Choose another source for ${i.missingVideos === 1 ? 'it' : 'them'}.`);
  } else if (broken.length) {
    add('videos', 'Videos ready', 'fail',
      `${broken.map((v) => v.name).join(', ')} won’t play. Re-export as MP4 (H.264) and add it again.`);
  } else if (paused.length) {
    add('videos', 'Videos ready', 'warn',
      `${paused.map((v) => v.name).join(', ')} ${paused.length === 1 ? 'is' : 'are'} paused. Click once inside the output window to start playback.`);
  } else if (i.videosInUse.length) add('videos', 'Videos ready', 'ok', '');

  if (i.videosInUse.length || i.missingVideos) {
    add('storage', 'Videos protected from clean-up', i.storagePersisted === null ? 'skip' : i.storagePersisted ? 'ok' : 'warn',
      i.storagePersisted === null
        ? 'This browser can’t say whether stored videos are protected.'
        : 'The browser may clear stored videos when the disk is low. Install the app (address bar icon) to protect them.');
  }

  if (i.blackout) add('blackout', 'Blackout off', 'warn', 'Blackout is on, so the wall is dark. Press B.');
  if (i.master < 0.5) add('master', 'Master brightness up', 'warn', `Master brightness is at ${Math.round(i.master * 100)}%.`);
  if (i.testGrid) add('grid', 'Test grid off', 'warn', 'The test grid is showing. Press G.');
  // With the projector window open the wall only shows dots when asked; the live copy here keeps its own.
  const dotsHidden = i.showMode || (i.outputOpen && !i.wallDots);
  add('show', 'Mapping dots hidden', dotsHidden ? 'ok' : 'warn',
    i.outputOpen ? 'The corner dots show on the wall. Untick “Dots on the wall” or press E before doors.'
      : 'The corner dots show on the wall. Press E before doors.');

  return checks;
}

/** Counts of results that still need attention. */
export function summarize(checks: Check[]) {
  const fail = checks.filter((c) => c.status === 'fail').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  return { fail, warn, clear: fail === 0 && warn === 0 };
}
