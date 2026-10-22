'use client';
import { useEffect, useState } from 'react';
import { useStore } from '@/lib/hooks';
import { remoteUrl } from '@/lib/remote';
import { newRemoteCode, remoteHost, setRemoteLock, startRemoteHost, stopRemoteHost } from '@/lib/remoteHost';
import { LOCKS, type Lock } from '@/lib/remote';

const LOCK_TEXT: Record<Lock, string> = { view: 'Only watch', control: 'Run the show', edit: 'Run the show and edit mapping' };
const STATUS_TEXT = { connecting: 'Connecting…', connected: 'Ready for a remote', offline: 'Offline, reconnecting…', failed: 'Couldn’t connect' } as const;

/** Pairing for the phone remote: switch it on, scan the code. Shown inside a Setup section. */
export default function RemotePanel() {
  const h = useStore(remoteHost);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const url = h.on && h.code ? remoteUrl(window.location.origin, h.code) : '';
  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

  useEffect(() => {
    let live = true;
    setQr('');
    if (!url) return;
    import('qrcode').then((m) => m.toDataURL(url, { margin: 1, width: 220, color: { dark: '#000000', light: '#ffffff' } }))
      .then((d) => { if (live) setQr(d); })
      .catch(() => { /* the link below still works */ });
    return () => { live = false; };
  }, [url]);

  return (
    <>
      <div className="btns">
        <button className={h.on ? 'on' : ''} aria-pressed={h.on} onClick={() => (h.on ? stopRemoteHost() : startRemoteHost())}>
          {h.on ? 'Remote on' : 'Turn remote on'}
        </button>
        {h.on && <button onClick={() => { if (confirm('Make a new code? Every phone using the old one is cut off and has to scan again.')) newRemoteCode(); }}>New code</button>}
      </div>
      {h.on && (
        <>
          <p className="note" role="status">{STATUS_TEXT[h.status]}{h.detail ? `: ${h.detail}` : ''}</p>
          {h.kind === 'local' && <p className="note">Test mode: no Ably key is set in this build, so the remote only works from another tab of this browser.</p>}
          {isLocalHost && h.kind === 'ably' && <p className="note">You’re on localhost, which a phone can’t reach. Open the deployed address on this Mac to get a code a phone can use.</p>}
          <label className="row">
            <span>Remote may</span>
            <select value={h.lock} onChange={(e) => setRemoteLock(e.target.value as Lock)}>
              {LOCKS.map((l) => <option key={l} value={l}>{LOCK_TEXT[l]}</option>)}
            </select>
          </label>
          {h.lock === 'edit' && <p className="note">The phone can move panels and corners. Switch back to “Run the show” before the doors open.</p>}
          {qr && <img src={qr} width={220} height={220} alt="QR code that opens the remote on a phone" style={{ display: 'block', margin: '10px 0', borderRadius: 6 }} />}
          <div className="btns">
            <button onClick={() => { navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <a href={url} target="_blank" rel="noreferrer"><button>Open here</button></a>
          </div>
        </>
      )}
    </>
  );
}
