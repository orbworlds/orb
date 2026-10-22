'use client';
// Dev-only preview of the Explore / You / Share / History panels with fixture data.
// Query params (all optional):
//   open=explore|you|share|history   panel to show on load
//   mock=0      don't install the in-page /api mock (e.g. when Playwright routes /api/** itself)
//   signed=1    signed-in session        oauth=1   GitHub OAuth configured
//   empty=1     no worlds / versions      error=1   list/me/versions requests fail
//   slow=1      2.5 s API latency         bare=1    hide the dev toolbar

import { useState } from 'react';
import { ExploreSheet } from '@/components/orb/ExploreSheet';
import { YouView } from '@/components/orb/YouView';
import { HistorySheet } from '@/components/world/HistorySheet';
import { ShareSheet } from '@/components/world/ShareSheet';
import { Toaster } from '@/components/ui/Toaster';
import { toast } from '@/state/toast';
import type { WorldFull } from '@/lib/types';
import { createMockApi, sampleWorld, sceneDataUrl } from './fixtures';

type Panel = 'explore' | 'you' | 'share' | 'history' | null;

// Install the /api mock before any component effect can fetch (module evaluation order).
function installMock(params: URLSearchParams) {
  if (params.get('mock') === '0') return;
  const handle = createMockApi({
    latency: params.get('slow') ? 2500 : 450,
    signedIn: params.get('signed') === '1',
    oauth: params.get('oauth') === '1',
    empty: params.get('empty') === '1',
    error: params.get('error') === '1',
  });
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href);
    if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) return handle(url, init);
    return real(input, init);
  };
}
if (typeof window !== 'undefined') installMock(new URLSearchParams(window.location.search));

export default function Preview({ params }: { params: Record<string, string> }) {
  const [panel, setPanel] = useState<Panel>((params.open as Panel) || null);
  const [world, setWorld] = useState<WorldFull>(() => sampleWorld());
  const bare = params.bare === '1';

  const close = () => setPanel(null);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* A stand-in "world" so the glass has something to glow over. */}
      <div aria-hidden="true" className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${sceneDataUrl('hills', 7)}")` }} />

      {!bare && (
        <nav className="glass fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-24px)] -translate-x-1/2 gap-1 overflow-x-auto rounded-full p-1.5 text-[13px] font-medium">
          {(['explore', 'you', 'share', 'history'] as const).map((p) => (
            <button key={p} type="button" onClick={() => setPanel(panel === p ? null : p)} className={`shrink-0 rounded-full px-3 py-1.5 capitalize ${panel === p ? 'bg-ink text-paper' : 'text-ink-2 hover:text-ink'}`}>
              {p}
            </button>
          ))}
        </nav>
      )}

      <ExploreSheet
        open={panel === 'explore'}
        intro={null}
        building={false}
        onOpenWorld={(id) => toast(`Open ${id}`)}
        onRemix={(w) => toast(`Remix ${w.name}`)}
      />

      {panel === 'you' && (
        <aside className="glass-strong animate-fade-up fixed inset-x-0 bottom-0 z-40 flex h-[86dvh] flex-col overflow-hidden rounded-t-[var(--r-panel)] sm:inset-auto sm:top-3 sm:right-3 sm:bottom-3 sm:h-auto sm:w-[400px] sm:rounded-[var(--r-panel)]">
          <div className="flex shrink-0 items-center gap-1 px-3 pt-3 pb-1 text-[13px] font-medium">
            {['Chat', 'Explore', 'You'].map((t) => (
              <span key={t} className={`rounded-full px-3 py-1.5 ${t === 'You' ? 'bg-ink text-paper' : 'text-ink-2'}`}>
                {t}
              </span>
            ))}
            <button type="button" onClick={close} className="ml-auto rounded-full px-3 py-1.5 text-ink-2 hover:text-ink">
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <YouView onOpenWorld={(id) => toast(`Open ${id}`)} />
          </div>
        </aside>
      )}

      <ShareSheet
        open={panel === 'share'}
        onClose={close}
        world={world}
        onChange={(patch) => {
          setWorld((w) => ({ ...w, ...patch }));
          toast('Saved', 'success');
        }}
      />

      <HistorySheet open={panel === 'history'} onClose={close} worldId={world.id} currentVersion={world.version} onRestore={(v) => toast(`Restored v${v}`, 'success')} />


      <Toaster />
    </div>
  );
}
