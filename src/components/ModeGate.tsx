'use client';
import { useEffect, useState } from 'react';
import * as E from '@/lib/engine';
import { useStore } from '@/lib/hooks';
import { settings } from '@/lib/store';

/** The first thing the app asks: an SMD (LED) screen, or projection mapping. */
export default function ModeGate() {
  const s = useStore(settings);
  const [last, setLast] = useState<'mapping' | 'smd' | null>(null);
  useEffect(() => setLast(E.lastMode()), []);
  return (
    <div className="gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <div className="gate-box">
        <h1 id="gate-title">What are you running tonight?</h1>
        <div className="gate-cards">
          <button className={`gate-card${last === 'smd' ? ' last' : ''}`} onClick={() => E.setMode('smd')} autoFocus={last === 'smd'}>
            <strong>SMD screen</strong>
            <span>One LED screen. Visuals fill it edge to edge at its own pixel size ({s.smd.width} × {s.smd.height}).</span>
            {last === 'smd' && <small>Used last time</small>}
          </button>
          <button className={`gate-card${last === 'mapping' ? ' last' : ''}`} onClick={() => E.setMode('mapping')} autoFocus={last === 'mapping'}>
            <strong>Mapping</strong>
            <span>Projectors onto panels and surfaces. Drag corners, masks and meshes onto the wall.</span>
            {last === 'mapping' && <small>Used last time</small>}
          </button>
        </div>
        <p className="gate-note">You can switch any time from Setup. Your mapping and your SMD screen are kept separately.</p>
      </div>
    </div>
  );
}
