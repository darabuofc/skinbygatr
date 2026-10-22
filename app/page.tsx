'use client';
import dynamic from 'next/dynamic';

// Everything touches browser APIs (WebGL, Web Audio, MIDI, IndexedDB), so skip server rendering.
const App = dynamic(() => import('@/components/App'), {
  ssr: false,
  loading: () => <div className="boot">Loading Panel Mapper</div>,
});

export default function Page() {
  return <App />;
}
