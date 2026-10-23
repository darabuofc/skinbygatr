import { AudioEngine, SILENCE_SEC } from './audio';
import { splitOffset } from './effects';
import { fitImageSize } from './fx';
import { deleteImage, deleteVideo, listImages, listVideos, putImage, putVideo, type ImageRecord, type VideoRecord } from './library';
import { FrameGuard } from './loop';
import { MidiEngine, type MidiMessage } from './midi';
import { postActive, postGroupId, type PostValues } from './post';
import { EyeAutomation } from './automation';
import {
  allActions, ParamSmoother, params, parseParamAction, parseTriggerAction, resetParams, sanitizeParams, setParamFromFader,
} from './params';
import { Output } from './output';
import { nextSource, PlaylistCounter } from './playlist';
import { runChecks, type PreflightInput } from './preflight';
import {
  BarCounter, beatPeriod, Crossfade, glideAt, MAX_CUE_FADE_SEC, MAX_FADE_SEC, needsFade, type Glide, type WallLook,
} from './transitions';
import { Renderer, type FrameInput } from './renderer';
import { mainView, pickDriver, windowName } from './surfaces';
import {
  clamp, cueFadeInProgress, cueTransitionInProgress, defaultSettings, moveMaskPoint, moveMeshPoint, onCueRecall, recallCue, recordMapping, redoMapping, runtime, sanitize, setScene, settings, uid, undoMapping,
} from './store';
import { SCENES, sceneForKey, type OutputConfig, type Panel, type Pt, type Quad, type Settings } from './types';

/*
 * The engine ties everything together outside React: one render loop for every
 * projector window, audio, MIDI, the video library, wake lock and offline caching.
 * React only reads the stores and calls the exported actions.
 */

const audio = new AudioEngine();
const midi = new MidiEngine();

/**
 * An output being drawn: in its own projector window, or the first one in this window when no
 * projector window is open. Each has its own WebGL context; all are drawn by the same loop,
 * with the same clock and audio, so they move together.
 */
interface Surface { id: string; output: Output; renderer: Renderer | null; }
const surfaces = new Map<string, Surface>();
/** Live, editable copy of one projector window in the control window while any is open. */
const preview = new Output('', true);
/** Where the video elements live: a projector window when one is open, so decoding keeps going. */
let videoHost: Output | null = null;

const blobs = new Map<string, Blob>();
/** Decoded library images, shared by every projector's renderer. */
const bitmaps = new Map<string, ImageBitmap>();
const smoother = new ParamSmoother();
/** Blinks and wandering gaze for the eye shader; one for both eyes, so they move together. */
const eyeAuto = new EyeAutomation();
/** Uniforms the automation drives this frame, by `shader.uniform`. */
const live = new Map<string, number>();
/** Panel opacities fading during a cue recall, by panel id. */
const opacityGlides = new Map<string, Glide>();
const videoEls = new Map<string, { el: HTMLVideoElement; url: string }>();

let started = false;
let gen = 0;
let lastFrameMs = 0;
/** Until then the loop runs on a timer, after animation frames stalled (a hidden or covered window). */
let timerUntil = 0;
let lastT = 0;
/** Kicks towards the next automatic scene change. */
const bars = new BarCounter();
const playlistBeats = new PlaylistCounter();
const fader = new Crossfade();
/** What the wall is showing (or fading to), to fade from on the next change. */
let shown: WallLook | null = null;
/** True while the engine itself changes scene, so it doesn't restart the bar count. */
let autoChanging = false;
let phaseA = 0;
let phaseB = 0;
let panelSig = '';
let outputSig = '';
let prevSelected = -1;
let prevPanels: Panel[] | null = null;
let prevOutputs: Settings['outputs'] | null = null;
let prevSel: unknown = null;
let prevStageSig = '';
/** Smoothed frames per second of the output loop. */
let fps = 60;
const wakeLocks = new Map<Window, { release: () => Promise<void> }>();
const guard = new FrameGuard((msg) => {
  console.error('Frame failed:', msg);
  runtime.set({ outMsg: `A frame failed to draw (${msg}). Output keeps running; export your layout and reload when there's a gap.` });
});
const lastCC = new Map<string, number>();

export const getLevels = () => audio.L;

function hexToRgb(h: string) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function fmtBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function levelFor(p: Panel) {
  const s = settings.get(), L = audio.L;
  if (p.band === 'none' || !L.live) return 1;
  const v = p.band === 'all' ? ((L.bass + L.mid + L.high) / 3) * 1.4 : L[p.band];
  return clamp(1 - s.react + s.react * Math.min(1, v * 1.3), 0, 1);
}

/* ---------- outputs ---------- */

const outputCfg = (id: string): OutputConfig | undefined => settings.get().outputs.find((o) => o.id === id);
const outputName = (id: string) => outputCfg(id)?.name ?? 'The projector';

const isOpenPopup = (sf: Surface) => {
  try { return sf.output.isPopup() && !sf.output.win.closed; } catch { return false; }
};
const popups = () => [...surfaces.values()].filter(isOpenPopup);
const openIds = () => popups().map((sf) => sf.id);

function makeRenderer(sf: Surface) {
  sf.renderer?.destroy();
  sf.renderer = null;
  try {
    sf.renderer = new Renderer(sf.output.canvas);
    if (sf.renderer.problems.length) runtime.set({ outMsg: sf.renderer.problems.join(' ') });
  } catch (e) {
    runtime.set({ outMsg: (e as Error).message });
  }
}

function dropSurface(id: string) {
  const sf = surfaces.get(id);
  if (!sf) return;
  if (videoHost === sf.output) { detachVideos(); videoHost = null; }
  try { sf.renderer?.destroy(); } catch { /* context already gone with its window */ }
  sf.output.unmount();
  surfaces.delete(id);
}

function detachVideos() {
  videoEls.forEach(({ el, url }) => { try { el.pause(); el.remove(); } catch { /* window gone */ } URL.revokeObjectURL(url); });
  videoEls.clear();
}

/**
 * Video elements live in a projector window when one is open, so the browser keeps decoding them
 * while that window is visible; otherwise in this window. Moved, and restarted, when that changes.
 */
function syncVideos() {
  const host = popups()[0]?.output ?? [...surfaces.values()][0]?.output ?? null;
  if (host === videoHost) return;
  detachVideos();
  videoHost = host;
  if (host) blobs.forEach((blob, id) => attachVideo(id, blob));
}

function attachVideo(id: string, blob: Blob) {
  if (!videoHost) return;
  const el = videoHost.doc.createElement('video');
  const url = URL.createObjectURL(blob);
  el.src = url;
  el.loop = true;
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  videoHost.media.appendChild(el);
  el.play().catch(() => { /* retried on next user gesture */ });
  videoEls.set(id, { el, url });
}

/**
 * Lays out this window's stage. With no projector window open it draws the first projector itself;
 * with any open it shows a live copy of one of them (the one asked for, if it's open).
 */
function arrangeMain(prefer: string | null = runtime.get().previewOutput || null) {
  const host = document.getElementById('pm-host');
  if (!host) return;
  const s = settings.get();
  const view = mainView(openIds(), s.outputs[0].id, prefer);
  // Whatever this window was drawing itself stops, unless it's still the right thing.
  for (const sf of [...surfaces.values()]) {
    if (!sf.output.isPopup() && !(view.kind === 'surface' && sf.id === view.id)) dropSurface(sf.id);
  }
  if (view.kind === 'surface') {
    preview.setSource(null);
    preview.unmount();
    if (!surfaces.has(view.id)) {
      const sf: Surface = { id: view.id, output: new Output(view.id), renderer: null };
      sf.output.mount(window, host);
      surfaces.set(view.id, sf);
      makeRenderer(sf);
    }
  } else {
    const src = surfaces.get(view.id)!.output;
    if (preview.sourceOutput !== src || !host.contains(preview.canvas ?? null)) {
      preview.unmount();
      preview.setSource(src);
      preview.mount(window, host);
    }
  }
  syncVideos();
  const open = openIds();
  runtime.set({ outputOpen: open.length > 0, openOutputs: open, previewOutput: view.kind === 'preview' ? view.id : '' });
}

/** Shows another open projector in the live copy here. */
export function showPreview(id: string) {
  if (openIds().includes(id) && runtime.get().previewOutput !== id) arrangeMain(id);
}

export function openOutput(id: string = settings.get().outputs[0].id) {
  runtime.set({ outMsg: '' });
  const cfg = outputCfg(id);
  if (!cfg) return;
  const cur = surfaces.get(id);
  if (cur && isOpenPopup(cur)) { cur.output.win.focus(); return; }
  let w: Window | null = null;
  try {
    w = window.open('', windowName(id), 'width=1280,height=720');
    if (!w) {
      runtime.set({ outMsg: 'The browser blocked the window. Allow pop-ups for this site and try again.' });
      return;
    }
    w.document.title = `${cfg.name} · Panel Mapper`;
    w.document.body.innerHTML = '';
    w.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
  } catch {
    runtime.set({ outMsg: 'This browser won’t let the page drive a second window. Use Chrome or Edge, or map in this window.' });
    return;
  }
  dropSurface(id);
  const sf: Surface = { id, output: new Output(id), renderer: null };
  sf.output.mount(w, w.document.body);
  sf.output.setDots(runtime.get().wallDots);
  surfaces.set(id, sf);
  makeRenderer(sf);
  bindKeys(w.document);
  const popup = w;
  popup.document.addEventListener('visibilitychange', () => { if (popup.document.visibilityState === 'visible') requestWake(popup); });
  // The preview takes the projector window's shape, so follow it when that window resizes.
  popup.addEventListener('resize', () => { if (preview.sourceOutput === sf.output) preview.layout(); });
  // React the moment the projector window closes instead of waiting for the watchdog.
  popup.addEventListener('pagehide', () => setTimeout(() => { if (popup.closed && surfaces.get(id) === sf) popupClosed(id); }, 30));
  arrangeMain(id);
  requestWake(popup);
  gen++;
  schedule(gen);
}

/** Closes a projector window from the controls. */
export function closeOutput(id: string) {
  const sf = surfaces.get(id);
  if (!sf || !isOpenPopup(sf)) return;
  sf.output.win.close();
  popupClosed(id);
}

function popupClosed(id: string) {
  const sf = surfaces.get(id);
  if (!sf || !sf.output.isPopup()) return;
  dropSurface(id);
  const left = openIds().length;
  arrangeMain();
  runtime.set({
    outMsg: left
      ? `${outputName(id)}’s window was closed, so it isn’t showing anywhere. Open it again from Projectors.`
      : 'The projector window was closed, so output is back in this window.',
  });
  gen++;
  schedule(gen);
}

/** Follows changes to the projector list: a removed projector's window closes; the stage re-arranges. */
function syncOutputs(s: Settings) {
  const ids = new Set(s.outputs.map((o) => o.id));
  for (const sf of [...surfaces.values()]) {
    if (ids.has(sf.id)) continue;
    if (isOpenPopup(sf)) { try { sf.output.win.close(); } catch { /* already closing */ } }
    dropSurface(sf.id);
  }
  for (const sf of popups()) {
    try { sf.output.win.document.title = `${outputName(sf.id)} · Panel Mapper`; } catch { /* closing */ }
  }
  arrangeMain();
}

/* ---------- render loop ---------- */

function schedule(g: number) {
  const w = performance.now() < timerUntil ? null : pickDriver([...popups().map((sf) => sf.output.win), window]);
  if (w) w.requestAnimationFrame(() => frame(g));
  else setTimeout(() => frame(g), 16);
}

function frame(g: number) {
  if (g !== gen) return;
  lastFrameMs = performance.now();
  for (const sf of [...surfaces.values()]) {
    if (sf.output.isPopup() && !isOpenPopup(sf)) { popupClosed(sf.id); return; }
  }
  // A frame that throws must not stop the loop: report it and carry on with the next one.
  guard.run(drawFrame, lastFrameMs);
  schedule(g);
}

function drawFrame() {
  const t = lastFrameMs / 1000;
  const rawDt = t - lastT;
  const dt = Math.min(0.1, Math.max(0, rawDt));
  lastT = t;
  if (rawDt > 0 && rawDt < 1) fps += (1 / rawDt - fps) * 0.05;
  const s = settings.get(), r = runtime.get();
  audio.update(t, s);
  if (audio.state !== r.audioState) audioStateChanged(audio.state);
  const L = audio.L;
  // Panel shader parameters ease towards their set values; speed clocks advance by the real
  // frame time, so at speed 1 they keep exact step with the scene clock.
  smoother.update(params.get(), Math.max(0, rawDt), t);
  const eye = eyeAuto.update(t, Math.max(0, rawDt), {
    perMin: smoother.value('eye', 'uBlinkRate'), wander: smoother.value('eye', 'uWander'), pace: smoother.value('eye', 'uWanderPace'),
  });
  live.set('eye.uBlink', eye.blink);
  live.set('eye.uWanderX', eye.x);
  live.set('eye.uWanderY', eye.y);
  phaseA += dt * (0.12 + L.mid * 1.2);
  phaseB += dt * (0.2 + L.bass * 1.5);
  if (!s.autoCycle) bars.reset();
  else if (L.kick && bars.kick(s.cycleBars)) {
    autoChanging = true;
    setScene((s.scene + 1) % SCENES.length);
    autoChanging = false;
  }
  stepPlaylists(s, L.kick);
  const mix = fader.mix(t);
  const from = mix !== null ? fader.from : null;
  // Everything but the panels and flip is the same for every projector: one clock, one look.
  const common: Omit<FrameInput, 'panels' | 'flip'> = {
    scene: s.scene,
    c1: hexToRgb(s.c1),
    c2: hexToRgb(s.c2),
    L, t, bpm: s.bpm, phaseA, phaseB,
    span: s.span,
    testGrid: s.testGrid,
    blackout: r.blackout,
    flash: r.flashHold ? 1 : s.strobe ? L.kickEnv * 0.85 : 0,
    master: s.master,
    split: r.blackout ? 0 : splitOffset(L, s.rgbSplit, s.rgbDrive),
    react: s.react,
    levelFor,
    getVideo: (id) => videoEls.get(id)?.el ?? null,
    getImage: (id) => bitmaps.get(id) ?? null,
    fxParam: (fx, name) => smoother.value(fx, name),
    fxClock: (fx, name) => smoother.clock(fx, name),
    fxLive: (fx, name) => live.get(`${fx}.${name}`) ?? 0,
    fade: from && mix !== null
      ? { scene: from.scene, c1: hexToRgb(from.c1), c2: hexToRgb(from.c2), sources: from.sources, mix, mode: fader.mode }
      : null,
  };
  // Panels whose opacity is mid-fade draw at their fading value; a hand change to the setting ends the fade.
  let panels = s.panels;
  if (opacityGlides.size) {
    panels = s.panels.map((p) => {
      const g = opacityGlides.get(p.id);
      if (!g) return p;
      const { v, done } = glideAt(g, t);
      if (done || g.to !== p.opacity) { opacityGlides.delete(p.id); return p; }
      return { ...p, opacity: v };
    });
  }
  for (const sf of surfaces.values()) {
    const cfg = outputCfg(sf.id);
    if (!cfg) continue;
    sf.renderer?.render({
      ...common, panels: panels.filter((p) => p.output === sf.id), flip: { h: cfg.flipH, v: cfg.flipV }, post: postFor(s, sf.id),
    });
    // Straight after rendering, while the WebGL frame is still readable.
    sf.output.drawLoupe(s.loupe && !r.showMode);
  }
  preview.copyFrame();
  preview.drawLoupe(s.loupe);
}

/** A projector's post effects this frame (eased, like shader settings), or null when they're all at rest. */
function postFor(s: Settings, outputId: string): PostValues | null {
  const g = postGroupId(Math.max(0, s.outputs.findIndex((o) => o.id === outputId)));
  const v = (name: string) => smoother.value(g, name);
  const values: PostValues = {
    bloom: v('uBloom'), ripple: v('uRipple'), rippleT: smoother.clock(g, 'uRippleT'), tint: v('uTint'),
    tintHue: v('uTintHue'), saturation: v('uSaturation'), vignette: v('uVignette'),
  };
  return postActive(values) ? values : null;
}

/** Stall after which the loop restarts, and how long it then runs on a timer before trying frames again. */
const STALL_MS = 700;
const TIMER_MS = 3000;

/**
 * Restarts the loop if a window closed mid-frame or the browser stopped delivering animation frames
 * (the window driving it got hidden or covered). Runs on a timer for a while, then tries frames again.
 */
function watchdog() {
  for (const sf of [...surfaces.values()]) if (sf.output.isPopup() && !isOpenPopup(sf)) popupClosed(sf.id);
  const now = performance.now();
  if (now - lastFrameMs > STALL_MS) { timerUntil = now + TIMER_MS; gen++; schedule(gen); }
}

/* ---------- panel playlists ---------- */

/** The panel without a removed library item in its playlist. */
function withoutItem(p: Panel, source: string): Panel {
  return p.playlist?.items.includes(source) ? { ...p, playlist: { ...p.playlist, items: p.playlist.items.filter((x) => x !== source) } } : p;
}

/** On a kick, moves each panel with a running playlist on to its next item once its beats are up; one settings change, so one fade. */
function stepPlaylists(s: Settings, kick: boolean) {
  const running = s.panels.filter((p) => p.playlist?.on && p.playlist.items.length > 1);
  playlistBeats.keepOnly(new Set(running.map((p) => p.id)));
  if (!kick) return;
  const due = new Map<string, string>();
  for (const p of running) {
    const pl = p.playlist!;
    if (playlistBeats.kick(p.id, pl.beats)) due.set(p.id, nextSource(pl, p.source));
  }
  if (due.size) settings.set((cur) => ({ panels: cur.panels.map((p) => (due.has(p.id) ? { ...p, source: due.get(p.id)! } : p)) }));
}

/* ---------- scene transitions ---------- */

function lookOf(s: Settings): WallLook {
  return { scene: s.scene, c1: s.c1, c2: s.c2, sources: Object.fromEntries(s.panels.map((p) => [p.id, p.source])) };
}

/** Starts a crossfade when the scene or a panel's content changes, and restarts the bar count on manual changes. */
function lookChanged(s: Settings) {
  const next = lookOf(s);
  const prev = shown ?? next;
  if (next.scene !== prev.scene && !autoChanging) bars.reset();
  if (needsFade(prev, next)) {
    const t = performance.now() / 1000;
    // Changed again mid-fade: start from whichever look is mostly on the wall right now.
    const mix = fader.mix(t);
    const from = mix !== null && mix < 0.5 && fader.from ? fader.from : prev;
    // A cue saved with a fade time uses it (seconds, up to a minute); scene changes and older cues use beats.
    const cueSec = cueFadeInProgress();
    // A cue brings its own transition; older cues and scene changes use the current one.
    const mode = cueTransitionInProgress() ?? s.transition;
    if (cueSec !== null) fader.begin(from, t, cueSec, MAX_CUE_FADE_SEC, mode);
    else fader.begin(from, t, s.fadeBeats * beatPeriod(audio.L.kicks, s.bpm), MAX_FADE_SEC, mode);
  }
  shown = next;
}

/** Seconds a cue recall fades over: the cue's own time, or the beat-based scene fade for older cues. */
function recallFadeSec(fadeSec: number | null): number {
  if (fadeSec !== null) return Math.min(MAX_CUE_FADE_SEC, fadeSec);
  const s = settings.get();
  return Math.min(MAX_FADE_SEC, s.fadeBeats * beatPeriod(audio.L.kicks, s.bpm));
}

/**
 * After a cue recall: fade shader settings and panel opacities from what was showing to the cue's
 * values, over the cue's fade time. The scene and panel content crossfade separately (lookChanged).
 */
function cueRecalled(prevOpacity: Record<string, number>, fadeSec: number | null) {
  const t = performance.now() / 1000;
  const dur = recallFadeSec(fadeSec);
  smoother.glide(params.get(), t, dur);
  for (const p of settings.get().panels) {
    const before = opacityGlides.has(p.id) ? glideAt(opacityGlides.get(p.id)!, t).v : prevOpacity[p.id];
    if (before === undefined || dur <= 0 || Math.abs(before - p.opacity) < 1e-6) { opacityGlides.delete(p.id); continue; }
    opacityGlides.set(p.id, { from: before, to: p.opacity, start: t, dur });
  }
}

/* ---------- show controls ---------- */

export function toggleShow() {
  const on = !runtime.get().showMode;
  runtime.set({ showMode: on });
  surfaces.forEach((sf) => sf.output.setShow(on));
  if (on) { requestWake(); popups().forEach((sf) => requestWake(sf.output.win)); }
}

export function toggleBlackout() { runtime.set((r) => ({ blackout: !r.blackout })); }

export function tap() {
  const bpm = audio.tap(performance.now() / 1000);
  if (bpm) settings.set({ bpm });
}

function toggleFullscreen(d: Document) {
  if (d === document && popups().length) {
    runtime.set({ outMsg: 'Click inside a projector window first, then press F there.' });
    return;
  }
  if (d.fullscreenElement) d.exitFullscreen().catch(() => {});
  else d.documentElement.requestFullscreen?.().catch(() => {});
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'color', 'button'].includes((el as HTMLInputElement).type);
  return el.tagName === 'SELECT' || el.tagName === 'TEXTAREA';
}

/** Projector picture size in pixels per output, so a remote can nudge in real pixels. 1080p until a window is open. */
export function outputPixelSizes(): Record<string, [number, number]> {
  return Object.fromEntries(settings.get().outputs.map((o) => {
    const sf = surfaces.get(o.id);
    if (!sf) return [o.id, [1920, 1080] as [number, number]];
    const r = sf.output.stageRect();
    return [o.id, [Math.round(r.w), Math.round(r.h)] as [number, number]];
  }));
}

/** Shows the magnifier around the selected handle for a moment, as after an arrow-key nudge. */
export function peekLoupes() {
  surfaces.forEach((sf) => sf.output.peekLoupe());
  preview.peekLoupe();
}

/**
 * Moves the selected corner with the arrow keys. `keyDoc` is where the key was pressed: in the window
 * showing that panel's projector picture, arrows on a flipped output follow the mirrored picture.
 */
function nudge(key: string, big: boolean, keyDoc: Document) {
  const sc = runtime.get().selCorner;
  const panel = sc ? settings.get().panels[sc.p] : undefined;
  if (!sc || !panel) return;
  const o = outputCfg(panel.output);
  const sf = surfaces.get(panel.output);
  const onOutput = !!sf && sf.output.doc === keyDoc;
  const sx = onOutput && o?.flipH ? -1 : 1, sy = onOutput && o?.flipV ? -1 : 1;
  const step = big ? 10 : 1;
  recordMapping(`nudge:${sc.p}:${sc.c}:${sc.m ?? ''}:${sc.g ?? ''}`);
  sf?.output.peekLoupe();
  preview.peekLoupe();
  // Steps are projector pixels, even when nudging from the preview.
  const { w: W, h: H } = sf ? sf.output.stageRect() : { w: window.innerWidth, h: window.innerHeight };
  const shift = ([x, y]: Pt): Pt => {
    if (key === 'ArrowLeft') x -= (sx * step) / W;
    if (key === 'ArrowRight') x += (sx * step) / W;
    if (key === 'ArrowUp') y -= (sy * step) / H;
    if (key === 'ArrowDown') y += (sy * step) / H;
    return [x, y];
  };
  const g = sc.g;
  if (g !== undefined) {
    const gp = panel.mesh?.pts[g];
    if (gp) moveMeshPoint(sc.p, g, shift(gp));
    return;
  }
  const m = sc.m;
  if (m !== undefined) {
    const mp = panel.mask?.points[m];
    if (mp) moveMaskPoint(sc.p, m, shift(mp.p));
    return;
  }
  settings.set((s) => ({
    panels: s.panels.map((p, j) => {
      if (j !== sc.p) return p;
      const corners = p.corners.map((q, c) => (c === sc.c ? shift(q) : q)) as Quad;
      return { ...p, corners };
    }),
  }));
}

function onKeyDown(e: KeyboardEvent) {
  if (isTyping(e.target)) return;
  const k = e.key;
  if (e.shiftKey && /^Digit[1-8]$/.test(e.code)) { recallCue(+e.code.slice(5) - 1); return; }
  if (k === ' ') { e.preventDefault(); if (!e.repeat) runtime.set({ flashHold: true }); return; }
  if (k.startsWith('Arrow') && runtime.get().selCorner) { e.preventDefault(); nudge(k, e.shiftKey, (e.target as Node)?.ownerDocument ?? document); return; }
  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
    const key = k.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undoMapping(); }
    else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redoMapping(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const sk = sceneForKey(k);
  if (sk !== null) { setScene(sk); return; }
  switch (k.toLowerCase()) {
    case 'e': toggleShow(); break;
    case 'f': toggleFullscreen((e.target as Node)?.ownerDocument ?? document); break;
    case 'h': runtime.set((r) => ({ hideUi: !r.hideUi })); break;
    case 'b': toggleBlackout(); break;
    case 'g': settings.set((s) => ({ testGrid: !s.testGrid })); break;
    case 't': tap(); break;
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key === ' ' && !isTyping(e.target)) { e.preventDefault(); runtime.set({ flashHold: false }); }
}

function bindKeys(d: Document) {
  d.addEventListener('keydown', onKeyDown);
  d.addEventListener('keyup', onKeyUp);
}

/* ---------- wake lock ---------- */

async function requestWake(w: Window = window) {
  if (w.document.visibilityState !== 'visible' || wakeLocks.has(w)) return;
  try {
    const nav = w.navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<EventTarget & { release: () => Promise<void> }> } };
    const lock = await nav.wakeLock?.request('screen');
    if (!lock) return;
    wakeLocks.set(w, lock);
    runtime.set({ wakeLock: true });
    lock.addEventListener('release', () => { wakeLocks.delete(w); runtime.set({ wakeLock: wakeLocks.size > 0 }); });
  } catch { /* denied or unsupported; the gig checklist covers sleep settings */ }
}

/* ---------- audio ---------- */

function fallbackMsg(why: string) {
  return `${why} Visuals switched to the auto beat at ${Math.round(settings.get().bpm)} BPM; tap T to match the music.`;
}

function audioStateChanged(state: typeof audio.state) {
  const track = runtime.get().trackName;
  const msg = state === 'silent'
    ? track
      ? fallbackMsg('The test track is paused.') + ' Press Play to follow it again.'
      : fallbackMsg(`No sound on the input for ${SILENCE_SEC} seconds.`) + ' It switches back as soon as sound returns.'
    : state === 'lost'
      ? fallbackMsg('The audio input disconnected.') + ' Plug it back in and it reconnects on its own.'
      : undefined;
  const prev = runtime.get().audioState;
  runtime.set({
    audioState: state,
    audioOn: state === 'listening' || state === 'silent',
    ...(msg ? { audioMsg: msg } : prev === 'silent' && state === 'listening'
      ? { audioMsg: track ? `Following ${track} again.` : 'Sound is back. Following the input again.' } : {}),
  });
}

/** After an unplug, try the saved input again whenever the device list changes. */
async function reconnectAudio() {
  if (!audio.lost) return;
  const want = settings.get().audioDevice;
  const devices = await audio.devices();
  runtime.set({ devices });
  if (want && !devices.some((d) => d.id === want)) return;
  if (!devices.length) return;
  try {
    const label = await audio.start(want);
    runtime.set({ audioMsg: `Reconnected to ${label}.` });
  } catch { /* still unplugged; the next device change tries again */ }
}

export async function startAudio(deviceId?: string) {
  const id = deviceId ?? settings.get().audioDevice;
  try {
    const label = await audio.start(id);
    const devices = await audio.devices();
    runtime.set({ audioOn: true, trackName: '', trackPlaying: false, devices, audioMsg: `Listening to ${label}. Set the gain so bass peaks around three quarters.` });
    if (deviceId !== undefined) settings.set({ audioDevice: deviceId });
  } catch (e) {
    audio.stop();
    runtime.set({
      audioOn: false,
      trackName: '',
      trackPlaying: false,
      audioMsg: (e as Error).message === 'unsupported'
        ? 'This browser can’t read audio input. Use Chrome or Edge, or turn on Auto beat.'
        : 'Audio input is blocked or unavailable. Allow microphone access from the address bar, check the interface is plugged in, or turn on Auto beat.',
    });
  }
}

export function stopAudio() {
  audio.stop();
  audio.lost = false;
  runtime.set({ audioOn: false, trackName: '', trackPlaying: false, audioMsg: '' });
}

/** Feeds an audio file into the analysis instead of the live input, for testing reactivity at home. */
export async function playTrack(file: File) {
  try {
    const name = await audio.startTrack(file);
    runtime.set({
      audioOn: true, trackName: name, trackPlaying: true,
      audioMsg: `Playing ${name} on a loop. Visuals follow it exactly as they would a line input from the mixer.`,
    });
  } catch {
    runtime.set({
      audioOn: false, trackName: '', trackPlaying: false,
      audioMsg: 'That file won’t play in this browser. Try an MP3, WAV, AAC/M4A or FLAC.',
    });
  }
}

export function toggleTrack() {
  runtime.set({ trackPlaying: audio.toggleTrack() });
}

/* ---------- video library ---------- */

async function updateStorage() {
  try {
    const e = await navigator.storage?.estimate?.();
    if (e && e.usage != null && e.quota) runtime.set({ storageMsg: `Using ${fmtBytes(e.usage)} of about ${fmtBytes(e.quota)} available.` });
  } catch { /* estimate unsupported */ }
}

async function loadLibrary() {
  try {
    const recs = (await listVideos()).sort((a, b) => a.added - b.added);
    recs.forEach((r) => { blobs.set(r.id, r.blob); attachVideo(r.id, r.blob); });
    runtime.set({ videos: recs.map((r) => ({ id: r.id, name: r.name, size: r.size })) });
    updateStorage();
  } catch {
    runtime.set({ libraryMsg: 'The video library couldn’t open. Private browsing windows block it, so use a normal window.' });
  }
}

export async function addVideoFiles(files: FileList | File[]) {
  const list = Array.from(files).filter((f) => f.type.startsWith('video/') || /\.(mp4|m4v|webm|mov)$/i.test(f.name));
  if (!list.length) {
    runtime.set({ libraryMsg: 'Those files aren’t videos. Add MP4, WebM or MOV files.' });
    return;
  }
  runtime.set({ libraryMsg: '' });
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  for (const f of list) {
    const rec: VideoRecord = { id: uid(), name: f.name, type: f.type, size: f.size, blob: f, added: Date.now() };
    try {
      await putVideo(rec);
      blobs.set(rec.id, f);
      attachVideo(rec.id, f);
      runtime.set((r) => ({ videos: [...r.videos, { id: rec.id, name: rec.name, size: rec.size }] }));
    } catch {
      runtime.set({ libraryMsg: `${f.name} couldn’t be saved. The browser may be out of storage space.` });
    }
  }
  updateStorage();
}

export async function removeVideo(id: string) {
  try { await deleteVideo(id); } catch { /* already gone */ }
  const v = videoEls.get(id);
  if (v) { v.el.pause(); v.el.remove(); URL.revokeObjectURL(v.url); videoEls.delete(id); }
  blobs.delete(id);
  surfaces.forEach((sf) => sf.renderer?.dropVideo(id));
  runtime.set((r) => ({ videos: r.videos.filter((x) => x.id !== id) }));
  settings.set((s) => ({ panels: s.panels.map((p) => withoutItem(p.source === `vid:${id}` ? { ...p, source: 'gen' } : p, `vid:${id}`)) }));
  updateStorage();
}

/* ---------- shader triggers ---------- */

/** Runs a shader's one-shot action now, such as the eye's blink. */
export function triggerFx(fx: string, trigger: string) {
  if (fx === 'eye' && trigger === 'blink') eyeAuto.blink(performance.now() / 1000);
}

/* ---------- image library ---------- */

/**
 * Decodes an image as stored: no colour management or premultiplying, so a height map's greys
 * reach the shader unchanged, and scaled down if it's larger than the GPU limit we use.
 * Browsers decode to 8 bits per channel, so a 16-bit height map loses its finer steps.
 */
async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  const probe = await createImageBitmap(blob);
  const [w, h] = fitImageSize(probe.width, probe.height);
  if (w === probe.width && h === probe.height) {
    probe.close();
    return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'none' });
  }
  probe.close();
  return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none', imageOrientation: 'none', resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
}

async function loadImages() {
  try {
    const recs = (await listImages()).sort((a, b) => a.added - b.added);
    const items = [];
    for (const r of recs) {
      try {
        const bmp = await decodeImage(r.blob);
        bitmaps.set(r.id, bmp);
        items.push({ id: r.id, name: r.name, size: r.size, w: bmp.width, h: bmp.height });
      } catch {
        runtime.set({ imageMsg: `${r.name} couldn’t be decoded, so panels using it show flat grey. Remove it and add it again.` });
      }
    }
    runtime.set({ images: items });
  } catch {
    runtime.set({ imageMsg: 'The image library couldn’t open. Private browsing windows block it, so use a normal window.' });
  }
}

export async function addImageFiles(files: FileList | File[]) {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(f.name));
  if (!list.length) {
    runtime.set({ imageMsg: 'Those files aren’t images. Add PNG, JPEG or WebP files.' });
    return;
  }
  runtime.set({ imageMsg: '' });
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  for (const f of list) {
    let bmp: ImageBitmap;
    try { bmp = await decodeImage(f); } catch {
      runtime.set({ imageMsg: `${f.name} couldn’t be read as an image.` });
      continue;
    }
    const rec: ImageRecord = { id: uid(), name: f.name, type: f.type, size: f.size, blob: f, added: Date.now() };
    try {
      await putImage(rec);
      bitmaps.set(rec.id, bmp);
      runtime.set((r) => ({ images: [...r.images, { id: rec.id, name: rec.name, size: rec.size, w: bmp.width, h: bmp.height }] }));
    } catch {
      bmp.close();
      runtime.set({ imageMsg: `${f.name} couldn’t be saved. The browser may be out of storage space.` });
    }
  }
  updateStorage();
}

/** Removes an image from the library; panels that used it go back to flat grey. */
export async function removeImage(id: string) {
  try { await deleteImage(id); } catch { /* already gone */ }
  bitmaps.get(id)?.close();
  bitmaps.delete(id);
  surfaces.forEach((sf) => sf.renderer?.dropImage(id));
  runtime.set((r) => ({ images: r.images.filter((x) => x.id !== id) }));
  settings.set((s) => ({ panels: s.panels.map((p) => withoutItem(p.source === `img:${id}` ? { ...p, source: 'gen' } : p, `img:${id}`)) }));
  settings.set((s) => ({
    panels: s.panels.map((p) => {
      if (!p.inputs || !Object.values(p.inputs).includes(id)) return p;
      const inputs = Object.fromEntries(Object.entries(p.inputs).filter(([, v]) => v !== id));
      const { inputs: _old, ...rest } = p;
      return Object.keys(inputs).length ? { ...rest, inputs } : rest;
    }),
  }));
  updateStorage();
}

/* ---------- MIDI ---------- */

export function runAction(id: string, value = 0) {
  if (id === 'scene:next') setScene((settings.get().scene + 1) % SCENES.length);
  else if (id.startsWith('scene:')) setScene(+id.slice(6));
  else if (id === 'blackout') toggleBlackout();
  else if (id === 'tap') tap();
  else if (id.startsWith('cue:')) recallCue(+id.slice(4));
  else if (id === 'master') settings.set({ master: value });
  else if (id === 'react') settings.set({ react: value });
  else if (id === 'rgb') settings.set({ rgbSplit: value });
  else {
    const pa = parseParamAction(id);
    if (pa) setParamFromFader(pa.fx, pa.name, value);
    const ta = parseTriggerAction(id);
    if (ta) triggerFx(ta.fx, ta.trigger);
  }
}

function onMidi(m: MidiMessage) {
  const learning = runtime.get().midiLearn;
  if (learning) {
    if (m.kind === 'note' && !m.on) return;
    const b = { kind: m.kind, channel: m.channel, num: m.num };
    settings.set((s) => {
      const midiMap = Object.fromEntries(Object.entries(s.midi).filter(([, v]) => !(v.kind === b.kind && v.channel === b.channel && v.num === b.num)));
      midiMap[learning] = b;
      return { midi: midiMap };
    });
    runtime.set({ midiLearn: null });
    return;
  }
  const s = settings.get();
  const key = `${m.kind}:${m.channel}:${m.num}`;
  const prev = lastCC.get(key) ?? 0;
  if (m.kind === 'cc') lastCC.set(key, m.value);
  for (const a of allActions()) {
    const b = s.midi[a.id];
    if (!b || b.kind !== m.kind || b.channel !== m.channel || b.num !== m.num) continue;
    if (a.type === 'fader') { if (m.kind === 'cc') runAction(a.id, m.value / 127); continue; }
    if (a.type === 'hold') { runtime.set({ flashHold: m.on }); continue; }
    const pressed = m.kind === 'cc' ? m.value > 63 && prev <= 63 : m.on;
    if (pressed) runAction(a.id);
  }
}

export async function connectMidi() {
  const msg = await midi.init();
  runtime.set({ midiMsg: msg, midiOn: midi.ready });
}

export function learn(id: string) { runtime.set((r) => ({ midiLearn: r.midiLearn === id ? null : id })); }

export function clearBinding(id: string) {
  settings.set((s) => {
    const m = { ...s.midi };
    delete m[id];
    return { midi: m };
  });
}

/* ---------- layout files ---------- */

export function exportLayout() {
  // Shader parameter values travel with the layout, so a venue's look comes back with its mapping.
  const blob = new Blob([JSON.stringify({ ...settings.get(), params: params.get() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'panel-mapper-layout.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importLayout(f: File) {
  try {
    const o = JSON.parse(await f.text());
    if (!o || !Array.isArray(o.panels) || !o.panels.length) throw new Error('not a layout');
    recordMapping();
    settings.set(sanitize(o));
    if (o.params) params.set(sanitizeParams(o.params));
    runtime.set({ outMsg: '', selCorner: null });
  } catch {
    runtime.set({ outMsg: 'That file isn’t a Panel Mapper layout. Choose a file saved with Export layout.' });
  }
}

export function resetAll() {
  recordMapping();
  settings.set(defaultSettings());
  resetParams();
  runtime.set({ selCorner: null });
}

/* ---------- pre-show check ---------- */

type BatteryManager = { charging: boolean };

async function charging(): Promise<boolean | null> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
    if (!nav.getBattery) return null;
    return (await nav.getBattery()).charging;
  } catch { return null; }
}

async function storagePersisted(): Promise<boolean | null> {
  try { return (await navigator.storage?.persisted?.()) ?? null; } catch { return null; }
}

function isFullscreen(w: Window) {
  if (w.document.fullscreenElement) return true;
  // A window dragged to the projector and maximised to its full size counts too.
  return w.innerWidth >= w.screen.width - 2 && w.innerHeight >= w.screen.height - 2;
}

/** Every open projector window fills its screen, or this window does when none is open. */
function outputFullscreen() {
  const open = popups();
  try {
    return open.length ? open.every((sf) => isFullscreen(sf.output.win)) : isFullscreen(window);
  } catch { return false; }
}

/** Gathers a fresh snapshot and runs the checks. Called about once a second while the sidebar is open. */
export async function preflight() {
  const s = settings.get(), r = runtime.get();
  const ids = new Set(s.panels.filter((p) => p.source.startsWith('vid:')).map((p) => p.source.slice(4)));
  const library = new Map(r.videos.map((v) => [v.id, v.name]));
  const missing = s.panels.filter((p) => p.source.startsWith('vid:') && !library.has(p.source.slice(4))).length;
  const videosInUse = [...ids].filter((id) => library.has(id)).map((id) => {
    const el = videoEls.get(id)?.el;
    // Broken: missing element or a decode error. Paused: loaded but waiting on autoplay.
    const state = !el || el.error ? 'broken' as const : el.paused || el.readyState < 2 ? 'paused' as const : 'ok' as const;
    return { name: library.get(id)!, state };
  });
  const input: PreflightInput = {
    outputOpen: r.outputOpen,
    closedOutputs: s.outputs.length > 1 ? s.outputs.filter((o) => !r.openOutputs.includes(o.id)).map((o) => o.name) : [],
    outputFullscreen: outputFullscreen(),
    fps,
    audioState: audio.state,
    testTrack: !!r.trackName,
    autoBpm: s.autoBpm,
    wakeLock: r.wakeLock,
    offlineReady: r.offlineReady,
    isDev: process.env.NODE_ENV !== 'production',
    charging: await charging(),
    storagePersisted: await storagePersisted(),
    videosInUse,
    missingVideos: missing,
    showMode: r.showMode,
    wallDots: r.wallDots,
    blackout: r.blackout,
    testGrid: s.testGrid,
    master: s.master,
  };
  return runChecks(input);
}

/* ---------- offline ---------- */

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || process.env.NODE_ENV !== 'production') return;
  try {
    await navigator.serviceWorker.register('/sw.js');
    const reg = await navigator.serviceWorker.ready;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'CACHED') runtime.set({ offlineReady: true });
    });
    // Cache everything this page has loaded, so the first visit is enough to work offline.
    const urls = new Set<string>([`${location.origin}/`]);
    performance.getEntriesByType('resource').forEach((en) => { if (en.name.startsWith(location.origin)) urls.add(en.name); });
    reg.active?.postMessage({ type: 'CACHE_URLS', urls: [...urls] });
  } catch { /* offline support is best effort */ }
}

/* ---------- start ---------- */

/** Changes when panels are added, removed, reordered or moved to another output, so handles get rebuilt. */
const panelSignature = (s: Settings) => s.panels.map((p) => `${p.id}@${p.output}`).join('|');
/** Changes when a projector is added, removed or renamed. */
const outputSignature = (s: Settings) => s.outputs.map((o) => `${o.id}:${o.name}`).join('|');

const allOutputs = () => [...[...surfaces.values()].map((sf) => sf.output), preview];

export function startEngine() {
  if (started) return;
  started = true;
  const s0 = settings.get();
  panelSig = panelSignature(s0);
  outputSig = outputSignature(s0);
  prevSelected = s0.selected;
  shown = lookOf(s0);
  lastT = performance.now() / 1000;

  arrangeMain();
  bindKeys(document);

  settings.subscribe(() => {
    const s = settings.get();
    const osig = outputSignature(s);
    if (osig !== outputSig) { outputSig = osig; syncOutputs(s); }
    const sig = panelSignature(s);
    if (sig !== panelSig) { panelSig = sig; allOutputs().forEach((o) => o.rebuild()); }
    // Handles only move when the mapping, the selection or a flip changes; a brightness or
    // reactivity fader streaming from MIDI leaves them alone.
    else if (s.panels !== prevPanels || s.selected !== prevSelected || s.outputs !== prevOutputs) allOutputs().forEach((o) => o.layout());
    prevPanels = s.panels;
    prevOutputs = s.outputs;
    // Picking a panel on another open projector brings that projector into the live copy.
    if (s.selected !== prevSelected) {
      prevSelected = s.selected;
      const out = s.panels[s.selected]?.output;
      if (out) showPreview(out);
    }
    lookChanged(s);
  });
  runtime.subscribe(() => {
    const r = runtime.get();
    const stageSig = `${r.hideUi}|${r.showMode}|${r.outputOpen}|${r.wallDots}|${r.maskEdit}`;
    if (r.selCorner !== prevSel || stageSig !== prevStageSig) {
      prevSel = r.selCorner; prevStageSig = stageSig;
      surfaces.forEach((sf) => sf.output.setDots(r.wallDots));
      allOutputs().forEach((o) => o.layout());
    }
  });

  onCueRecall((r) => cueRecalled(r.prevOpacity, r.fadeSec));

  midi.onMessage = onMidi;
  midi.onStatus = (msg) => runtime.set({ midiMsg: msg });
  if (Object.keys(s0.midi).length) connectMidi();

  audio.onLost = () => audioStateChanged('lost');
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    if (audio.lost) reconnectAudio();
    else if (runtime.get().audioOn) runtime.set({ devices: await audio.devices() });
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWake(); });
  // Browsers block autoplay until a gesture; nudge any paused clips on the first click.
  document.addEventListener('pointerdown', () => videoEls.forEach(({ el }) => { if (el.paused) el.play().catch(() => {}); }));
  window.addEventListener('beforeunload', () => { popups().forEach((sf) => sf.output.win.close()); });

  loadLibrary();
  loadImages();
  registerServiceWorker();
  requestWake();
  setInterval(watchdog, 250);
  schedule(gen);
}
