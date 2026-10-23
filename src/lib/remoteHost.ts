import { outputPixelSizes, peekLoupes, runAction } from './engine';
import { Store } from './observable';
import { params } from './params';
import {
  buildGeo, buildSnapshot, channelName, HEARTBEAT_MS, LOCKS, newSessionCode, parseToHost, permits, validSessionCode, type Lock, type RemoteSnapshot, type ToHost,
} from './remote';
import { applyEdit, resetEdits } from './remoteApply';
import { runtime, settings } from './store';
import { createTransport, type Transport, type TransportStatus } from './transport';

/** The Mac's side of the remote: listens for actions and reports state. */

export interface RemoteHostState {
  on: boolean;
  code: string;
  kind: 'ably' | 'local';
  status: TransportStatus;
  detail: string;
  /** What a remote may do: nothing, run the show, or also edit the mapping. */
  lock: Lock;
}

const CODE_KEY = 'panelmapper.remote.code';
const ON_KEY = 'panelmapper.remote.on';
const LOCK_KEY = 'panelmapper.remote.lock';

/** A held flash lets go by itself after this long, so a dropped connection can't leave the strobe on. */
export const FLASH_MAX_MS = 8000;

function readLS(k: string): string {
  try { return localStorage.getItem(k) ?? ''; } catch { return ''; }
}
function writeLS(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* no storage: the code just won't survive a reload */ }
}

function readLock(): Lock {
  const v = readLS(LOCK_KEY);
  return (LOCKS as string[]).includes(v) ? (v as Lock) : 'control';
}

// Mapping from a phone is opt-in: a stray touch must never move a panel during a show.
export const remoteHost = new Store<RemoteHostState>({ on: false, code: '', kind: 'local', status: 'connecting', detail: '', lock: readLock() });

let transport: Transport | null = null;
let unsubs: (() => void)[] = [];
let heartbeat: ReturnType<typeof setInterval> | undefined;
let sendTimer: ReturnType<typeof setTimeout> | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let lastSent = '';
let lastGeo = '';

function snapshot(): RemoteSnapshot {
  return buildSnapshot(settings.get(), runtime.get().blackout, params.get(), remoteHost.get().lock);
}

function sendState(force: boolean) {
  if (!transport) return;
  const s = snapshot();
  const sig = JSON.stringify(s);
  if (!force && sig === lastSent) return;
  lastSent = sig;
  transport.send({ t: 'state', s });
}

function sendGeo(force: boolean) {
  if (!transport) return;
  try {
    const r = runtime.get();
    const g = buildGeo(settings.get(), outputPixelSizes(), r.canUndo, r.canRedo);
    const sig = JSON.stringify(g);
    if (!force && sig === lastGeo) return;
    lastGeo = sig;
    transport.send({ t: 'geo', g });
  } catch (e) {
    // State still goes out, so a failure here would otherwise leave the phone waiting with no clue why.
    console.error('Remote mapping not sent:', e);
  }
}

/** Changes arrive in bursts (a fader drag), so state goes out at most five times a second. */
function scheduleState() {
  if (sendTimer !== undefined) return;
  sendTimer = setTimeout(() => { sendTimer = undefined; sendState(false); sendGeo(false); }, 200);
}

/** Runs a checked message from a remote. */
export function applyToHost(m: ToHost) {
  if (m.t === 'hello') { sendState(true); sendGeo(true); return; }
  if (!permits(remoteHost.get().lock, m)) return;
  if (m.t !== 'act') {
    applyEdit(m, { moved: peekLoupes, aspect: (id) => { const [w, h] = outputPixelSizes()[id] ?? [1920, 1080]; return w / Math.max(1, h); } });
    return;
  }
  if (m.id === 'flash') {
    clearTimeout(flashTimer);
    runtime.set({ flashHold: !!m.v });
    if (m.v) flashTimer = setTimeout(() => runtime.set({ flashHold: false }), FLASH_MAX_MS);
    return;
  }
  runAction(m.id, m.v ?? 0);
}

export function startRemoteHost() {
  if (transport) return;
  let code = readLS(CODE_KEY);
  if (!validSessionCode(code)) { code = newSessionCode(); writeLS(CODE_KEY, code); }
  const { transport: t, kind } = createTransport(channelName(code));
  transport = t;
  writeLS(ON_KEY, '1');
  remoteHost.set({ on: true, code, kind, status: 'connecting', detail: '' });
  unsubs = [
    t.onStatus((status, detail) => {
      remoteHost.set({ status, detail: detail ?? '' });
      if (status === 'connected') { sendState(true); sendGeo(true); }
    }),
    t.onMessage((raw) => { const m = parseToHost(raw); if (m) applyToHost(m); }),
    settings.subscribe(scheduleState),
    runtime.subscribe(scheduleState),
    params.subscribe(scheduleState),
  ];
  heartbeat = setInterval(() => { sendState(true); sendGeo(true); }, HEARTBEAT_MS);
}

export function stopRemoteHost() {
  unsubs.forEach((u) => u());
  unsubs = [];
  clearInterval(heartbeat);
  clearTimeout(sendTimer);
  clearTimeout(flashTimer);
  sendTimer = undefined;
  transport?.close();
  transport = null;
  lastSent = '';
  lastGeo = '';
  resetEdits();
  writeLS(ON_KEY, '');
  remoteHost.set({ on: false, status: 'connecting', detail: '' });
}

/** Sets what remotes may do. Takes effect at once and is kept for next time. */
export function setRemoteLock(lock: Lock) {
  writeLS(LOCK_KEY, lock);
  remoteHost.set({ lock });
  if (remoteHost.get().on) { sendState(true); sendGeo(true); }
}

/** A new code cuts off every remote that had the old one; they have to scan again. */
export function newRemoteCode() {
  const wasOn = remoteHost.get().on;
  if (wasOn) stopRemoteHost();
  writeLS(CODE_KEY, newSessionCode());
  remoteHost.set({ code: readLS(CODE_KEY) });
  if (wasOn) startRemoteHost();
}

/** Brings the remote back after a reload if it was on. */
export function resumeRemoteHost() {
  if (readLS(ON_KEY) === '1') startRemoteHost();
}
