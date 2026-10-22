/**
 * A two-way message pipe between the host and its remotes. The protocol doesn't care what
 * carries it: Ably between devices, or a BroadcastChannel between tabs of one browser for testing.
 */
export type TransportStatus = 'connecting' | 'connected' | 'offline' | 'failed';

export interface Transport {
  send(msg: unknown): void;
  onMessage(fn: (msg: unknown) => void): () => void;
  onStatus(fn: (s: TransportStatus, detail?: string) => void): () => void;
  close(): void;
}

/** Same-browser transport: a host tab and a remote tab. No key or internet needed. */
export function createBroadcastTransport(channel: string): Transport {
  const bc = new BroadcastChannel(channel);
  const msgs = new Set<(m: unknown) => void>();
  const stats = new Set<(s: TransportStatus, d?: string) => void>();
  let closed = false;
  bc.onmessage = (e) => msgs.forEach((f) => f(e.data));
  return {
    send: (m) => { if (!closed) bc.postMessage(m); },
    onMessage: (fn) => { msgs.add(fn); return () => { msgs.delete(fn); }; },
    // Reported on a microtask so the caller has finished setting up, unless it has already let go.
    onStatus: (fn) => { stats.add(fn); queueMicrotask(() => { if (stats.has(fn)) fn('connected'); }); return () => { stats.delete(fn); }; },
    close: () => { closed = true; bc.close(); msgs.clear(); stats.clear(); },
  };
}

/** Two linked transports in memory, for tests. */
export function createMemoryPair(): [Transport, Transport] {
  const mk = () => ({ msgs: new Set<(m: unknown) => void>(), stats: new Set<(s: TransportStatus, d?: string) => void>() });
  const a = mk(), b = mk();
  const side = (me: ReturnType<typeof mk>, peer: ReturnType<typeof mk>): Transport => ({
    // Structured clone, like a real wire: nothing shared between the two ends.
    send: (m) => { const c = JSON.parse(JSON.stringify(m)); queueMicrotask(() => peer.msgs.forEach((f) => f(c))); },
    onMessage: (fn) => { me.msgs.add(fn); return () => { me.msgs.delete(fn); }; },
    onStatus: (fn) => { me.stats.add(fn); fn('connected'); return () => { me.stats.delete(fn); }; },
    close: () => { me.msgs.clear(); me.stats.clear(); },
  });
  return [side(a, b), side(b, a)];
}

/** The Ably key built into this deployment, or '' when none was set. */
export const ABLY_KEY: string = process.env.NEXT_PUBLIC_ABLY_KEY ?? '';

/** Where the self-hosted Ably browser build lives (see the `vendor` script in package.json). */
export const ABLY_SCRIPT = '/vendor/ably.min.js';

type AblyGlobal = { Realtime: new (o: { key: string; echoMessages: boolean }) => import('ably').Realtime };
let ablyLoad: Promise<AblyGlobal> | null = null;

/**
 * Ably's own code doesn't survive Next's compiler, so the SDK isn't bundled: its prebuilt
 * browser file is served from /vendor and loaded when a remote is first used.
 */
function loadAbly(): Promise<AblyGlobal> {
  ablyLoad ??= new Promise((resolve, reject) => {
    const have = (window as unknown as { Ably?: AblyGlobal }).Ably;
    if (have) { resolve(have); return; }
    const el = document.createElement('script');
    el.src = ABLY_SCRIPT;
    el.async = true;
    el.onload = () => {
      const a = (window as unknown as { Ably?: AblyGlobal }).Ably;
      if (a) resolve(a); else reject(new Error('The connection library loaded but isn’t usable.'));
    };
    el.onerror = () => { ablyLoad = null; reject(new Error('Couldn’t load the connection library. Check the internet connection.')); };
    document.head.appendChild(el);
  });
  return ablyLoad;
}

/** Carries messages through Ably. */
export function createAblyTransport(key: string, channel: string): Transport {
  const msgs = new Set<(m: unknown) => void>();
  const stats = new Set<(s: TransportStatus, d?: string) => void>();
  let status: TransportStatus = 'connecting';
  let detail: string | undefined;
  let closed = false;
  let client: import('ably').Realtime | null = null;
  let ch: import('ably').RealtimeChannel | null = null;
  const queue: unknown[] = [];
  const setStatus = (s: TransportStatus, d?: string) => { status = s; detail = d; stats.forEach((f) => f(s, d)); };

  loadAbly().then((Ably) => {
    if (closed) return;
    // echoMessages off: a device never hears its own messages back.
    client = new Ably.Realtime({ key, echoMessages: false });
    ch = client.channels.get(channel);
    ch.subscribe((m) => msgs.forEach((f) => f(m.data)));
    client.connection.on((c) => {
      if (c.current === 'connected') { setStatus('connected'); queue.splice(0).forEach((q) => ch?.publish('m', q)); }
      else if (c.current === 'failed') setStatus('failed', c.reason?.message);
      else if (c.current === 'disconnected' || c.current === 'suspended') setStatus('offline');
      else if (c.current === 'connecting') setStatus('connecting');
    });
  }).catch((e) => setStatus('failed', e instanceof Error ? e.message : 'Couldn’t load the connection library.'));

  return {
    send: (m) => {
      if (closed) return;
      if (ch && status === 'connected') ch.publish('m', m);
      else if (queue.length < 20) queue.push(m);
    },
    onMessage: (fn) => { msgs.add(fn); return () => { msgs.delete(fn); }; },
    onStatus: (fn) => { stats.add(fn); fn(status, detail); return () => { stats.delete(fn); }; },
    close: () => { closed = true; msgs.clear(); stats.clear(); try { client?.close(); } catch { /* already closed */ } },
  };
}

/** Ably when a key is built in, otherwise the same-browser test transport. */
export function createTransport(channel: string): { transport: Transport; kind: 'ably' | 'local' } {
  return ABLY_KEY
    ? { transport: createAblyTransport(ABLY_KEY, channel), kind: 'ably' }
    : { transport: createBroadcastTransport(channel), kind: 'local' };
}
