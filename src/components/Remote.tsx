'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/lib/hooks';
import { PARAM_GROUPS } from '@/lib/params';
import { FADER_SEND_MS, makeThrottle } from '@/lib/remote';
import { connectRemote, disconnectRemote, remoteClient, sendToHost } from '@/lib/remoteClient';
import { SCENES } from '@/lib/types';
import RemoteMap from './RemoteMap';

/** A touch remote for the Mac running the show: scenes, cues, blackout, flash and faders. */

function Fader({ id, label, value, min = 0, max = 1, disabled }: { id: string; label: string; value: number; min?: number; max?: number; disabled: boolean }) {
  const [local, setLocal] = useState(value);
  const active = useRef(false);
  const throttle = useRef(makeThrottle<number>((v) => sendToHost({ t: 'act', id, v }), FADER_SEND_MS));
  // While a finger is on the fader its own value wins; otherwise follow the Mac.
  useEffect(() => { if (!active.current) setLocal(value); }, [value]);
  useEffect(() => { const t = throttle.current; return () => t.cancel(); }, []);
  const norm = (x: number) => (max > min ? (x - min) / (max - min) : 0);
  const end = () => { active.current = false; throttle.current.flush(); };
  return (
    <label className="rfader">
      <span>{label}</span>
      <input
        type="range" min={0} max={1} step={0.005} value={norm(local)} disabled={disabled}
        onPointerDown={() => { active.current = true; }}
        onPointerUp={end} onPointerCancel={end} onBlur={end}
        onChange={(e) => {
          const n = +e.target.value;
          setLocal(min + n * (max - min));
          throttle.current.push(n);
        }}
      />
    </label>
  );
}

export default function Remote() {
  const c = useStore(remoteClient);
  useEffect(() => {
    connectRemote(window.location.hash);
    const onHash = () => connectRemote(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => { window.removeEventListener('hashchange', onHash); disconnectRemote(); };
  }, []);

  const s = c.snap;
  const live = c.status === 'connected' && c.hostOnline && !!s;
  // 'View only' on the Mac: the remote watches but sends nothing that does anything.
  const ctl = live && s.lock !== 'view';
  const [tab, setTab] = useState<'perform' | 'map'>('perform');
  const act = (id: string) => sendToHost({ t: 'act', id });

  let state = 'Connected to the show';
  if (!c.codeOk) state = 'No pairing code. Scan the QR code in the Remote section on the Mac.';
  else if (c.status === 'failed') state = c.detail ? `Can’t connect: ${c.detail}` : 'Can’t connect.';
  else if (c.status === 'offline') state = 'Reconnecting…';
  else if (c.status === 'connecting') state = 'Connecting…';
  else if (!c.hostOnline) state = s ? 'The Mac went quiet. Waiting…' : 'Waiting for the Mac. Is Remote switched on there?';
  else if (s?.lock === 'view') state = 'Connected, view only (set on the Mac)';

  return (
    <main className="remote">
      <header>
        <h1>Remote</h1>
        <p className={`rstate ${live ? 'ok' : 'wait'}`} role="status"><i aria-hidden />{state}</p>
        {c.kind === 'local' && <p className="rnote">Test mode: only works between two tabs of this browser. Add an Ably key to connect other devices.</p>}
      </header>

      <div className="rtabs" role="tablist">
        {([['perform', 'Perform'], ['map', 'Map']] as const).map(([id, name]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{name}</button>
        ))}
      </div>

      {tab === 'map' && <RemoteMap canEdit={live && s?.lock === 'edit'} />}

      {tab === 'perform' && <>
      <div className="rtop">
        <button className={`big${s?.blackout ? ' on' : ''}`} disabled={!ctl} onClick={() => act('blackout')}>
          {s?.blackout ? 'Blackout ON' : 'Blackout'}
        </button>
        <button
          className="big" disabled={!ctl}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); sendToHost({ t: 'act', id: 'flash', v: 1 }); }}
          onPointerUp={() => sendToHost({ t: 'act', id: 'flash', v: 0 })}
          onPointerCancel={() => sendToHost({ t: 'act', id: 'flash', v: 0 })}
        >
          Flash (hold)
        </button>
        <button className="big" disabled={!ctl} onClick={() => act('tap')}>Tap{s ? ` · ${Math.round(s.bpm)}` : ''}</button>
      </div>

      <h2>Scenes</h2>
      <div className="rgrid scenes">
        {SCENES.map((n, i) => (
          <button key={n} className={s?.scene === i ? 'on' : ''} disabled={!ctl} aria-pressed={s?.scene === i} onClick={() => act(`scene:${i}`)}>
            <span>{i + 1}</span><small>{n}</small>
          </button>
        ))}
        <button disabled={!ctl} onClick={() => act('scene:next')}><span>›</span><small>Next</small></button>
      </div>

      <h2>Cues</h2>
      <div className="rgrid cues">
        {Array.from({ length: Math.max(8, s?.cues.length ?? 0) }, (_, i) => {
          const name = s?.cues[i] ?? null;
          return (
            <button key={i} className={name ? 'filled' : ''} disabled={!ctl || !name} onClick={() => act(`cue:${i}`)}>
              <span>{i + 1}</span><small>{name ?? 'Empty'}</small>
            </button>
          );
        })}
      </div>

      <h2>Levels</h2>
      <Fader id="master" label="Master" value={s?.master ?? 1} disabled={!ctl} />
      <Fader id="react" label="Reactivity" value={s?.react ?? 1} disabled={!ctl} />
      <Fader id="rgb" label="RGB split" value={s?.rgb ?? 0} disabled={!ctl} />

      <h2>Effects</h2>
      {PARAM_GROUPS.map((g) => (
        <details key={g.id}>
          <summary>{g.name}</summary>
          {(g.triggers ?? []).map((t) => (
            <button key={t.id} className="rtrig" disabled={!ctl} onClick={() => act(`fxtrigger:${g.id}:${t.id}`)}>{t.label}</button>
          ))}
          {g.params.map((p) => (
            <Fader key={p.name} id={`param:${g.id}:${p.name}`} label={p.label} value={s?.params[g.id]?.[p.name] ?? p.default} min={p.min} max={p.max} disabled={!ctl} />
          ))}
        </details>
      ))}
      </>}
    </main>
  );
}
