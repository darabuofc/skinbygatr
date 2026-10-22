'use client';
import { useEffect } from 'react';
import { showPreview, startEngine } from '@/lib/engine';
import { useStore } from '@/lib/hooks';
import { resumeRemoteHost } from '@/lib/remoteHost';
import { runtime, settings } from '@/lib/store';
import Controls from './Controls';

export default function App() {
  useEffect(() => { startEngine(); resumeRemoteHost(); }, []);
  const r = useStore(runtime);
  const s = useStore(settings);
  const names = Object.fromEntries(s.outputs.map((o) => [o.id, o.name]));
  const hideControls = r.hideUi || (r.showMode && !r.outputOpen);
  return (
    <>
      <div id="pm-host" />
      <Controls hidden={hideControls} />
      {r.outputOpen && (
        <div className={`mirror-bar${r.hideUi ? ' full' : ''}`}>
          <span className="live-dot" aria-hidden />
          <p>
            <strong>Live copy of {s.outputs.length > 1 ? names[r.previewOutput] ?? 'the projector' : 'the projector window'}.</strong>{' '}
            Changes here go to the wall straight away. Keep this window open; closing it stops the visuals.
          </p>
          {r.openOutputs.length > 1 && (
            <div className="tabs" role="group" aria-label="Projector shown here">
              {r.openOutputs.map((id) => (
                <button key={id} className={id === r.previewOutput ? 'on' : ''} aria-pressed={id === r.previewOutput} onClick={() => showPreview(id)}>
                  {names[id] ?? id}
                </button>
              ))}
            </div>
          )}
          <label>
            <input type="checkbox" checked={r.wallDots} onChange={(e) => runtime.set({ wallDots: e.target.checked })} />
            Dots on the wall
          </label>
        </div>
      )}
    </>
  );
}
