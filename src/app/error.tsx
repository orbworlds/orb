'use client';

import { useEffect } from 'react';
import { reportError } from '@/lib/report';

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error('[orb] page error', error);
    reportError(error, { where: error.digest ? `digest ${error.digest}` : '' });
  }, [error]);

  return (
    <main className="fixed inset-0 flex items-center justify-center p-6" style={{ background: 'linear-gradient(180deg, #b9c6f2 0%, #e7d6ef 55%, #fde3cf 100%)' }}>
      <div className="glass-strong rounded-[var(--r-panel)] p-8 text-center">
        <div
          aria-hidden
          className="mx-auto mb-4 h-11 w-11 rounded-full"
          style={{ background: 'radial-gradient(circle at 32% 28%, #fff 0, rgba(255,255,255,.4) 18%, transparent 42%), var(--iris-conic)', boxShadow: '0 8px 30px -6px rgba(139,123,255,.6)' }}
        />
        <h1 className="font-display text-[32px] leading-tight">Something went wobbly</h1>
        <p className="mt-2 text-[14px] text-ink-2">Orb tripped over this page. Your worlds are safe.</p>
        <div className="mt-5 flex justify-center gap-2">
          <button type="button" onClick={() => retry()} className="inline-flex h-10 items-center rounded-full bg-ink px-5 text-[14px] font-medium text-paper">
            Try again
          </button>
          {/* A full load: client navigation keeps the state that broke, and on / the boundary stays up. */}
          <button type="button" onClick={() => window.location.assign(window.location.origin)} className="glass inline-flex h-10 items-center rounded-full px-5 text-[14px] font-medium text-ink">
            Home
          </button>
        </div>
      </div>
    </main>
  );
}
