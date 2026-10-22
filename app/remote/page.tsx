'use client';
import dynamic from 'next/dynamic';
import './remote.css';

// Browser-only (BroadcastChannel, localStorage), so skip server rendering like the main page.
const Remote = dynamic(() => import('@/components/Remote'), {
  ssr: false,
  loading: () => <div className="boot">Loading remote</div>,
});

export default function RemotePage() {
  return <Remote />;
}
