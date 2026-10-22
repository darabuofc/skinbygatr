import { Store } from './observable';
import { channelName, OFFLINE_AFTER_MS, parseToRemote, validSessionCode, type RemoteGeo, type RemoteSnapshot, type ToHost } from './remote';
import { createTransport, type Transport, type TransportStatus } from './transport';

/** The remote's side: connects with a session code, sends actions, shows the host's state. */

export interface RemoteClientState {
  status: TransportStatus;
  detail: string;
  kind: 'ably' | 'local';
  /** The latest state from the Mac, or null before the first one. */
  snap: RemoteSnapshot | null;
  /** The latest mapping from the Mac, or null before the first one. */
  geo: RemoteGeo | null;
  /** The Mac has been heard from recently. */
  hostOnline: boolean;
  codeOk: boolean;
}

const LAST_KEY = 'panelmapper.remote.lastcode';

export const remoteClient = new Store<RemoteClientState>({ status: 'connecting', detail: '', kind: 'local', snap: null, geo: null, hostOnline: false, codeOk: true });

let transport: Transport | null = null;
let unsubs: (() => void)[] = [];
let lastHeard = 0;
let watch: ReturnType<typeof setInterval> | undefined;
let helloTimer: ReturnType<typeof setInterval> | undefined;

/** The code from the link, or the one used last time on this device. */
export function codeFromLocation(hash: string, stored: string): string {
  const h = hash.replace(/^#/, '').trim().toLowerCase();
  return validSessionCode(h) ? h : validSessionCode(stored) ? stored : '';
}

export function connectRemote(hash: string) {
  disconnectRemote();
  let stored = '';
  try { stored = localStorage.getItem(LAST_KEY) ?? ''; } catch { /* private mode */ }
  const code = codeFromLocation(hash, stored);
  if (!code) { remoteClient.set({ codeOk: false, status: 'failed', snap: null, geo: null, hostOnline: false }); return; }
  try { localStorage.setItem(LAST_KEY, code); } catch { /* the link still works this time */ }
  const { transport: t, kind } = createTransport(channelName(code));
  transport = t;
  remoteClient.set({ codeOk: true, kind, status: 'connecting', detail: '', snap: null, geo: null, hostOnline: false });
  unsubs = [
    t.onStatus((status, detail) => {
      remoteClient.set({ status, detail: detail ?? '' });
      if (status === 'connected') t.send({ t: 'hello' });
    }),
    t.onMessage((raw) => {
      const m = parseToRemote(raw);
      if (!m) return;
      lastHeard = Date.now();
      if (m.t === 'state') remoteClient.set({ snap: m.s, hostOnline: true });
      else remoteClient.set({ geo: m.g, hostOnline: true });
    }),
  ];
  // Until the Mac answers, keep asking: it may start after the remote does.
  helloTimer = setInterval(() => { if (!remoteClient.get().hostOnline) t.send({ t: 'hello' }); }, 2000);
  watch = setInterval(() => {
    if (remoteClient.get().hostOnline && Date.now() - lastHeard > OFFLINE_AFTER_MS) remoteClient.set({ hostOnline: false });
  }, 1000);
}

export function sendToHost(m: ToHost) { transport?.send(m); }

export function disconnectRemote() {
  unsubs.forEach((u) => u());
  unsubs = [];
  clearInterval(watch);
  clearInterval(helloTimer);
  transport?.close();
  transport = null;
}
