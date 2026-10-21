'use client';
// Under the Orb's first message on a new world: three popular worlds that can be remixed, so
// starting from one is as close as describing one, and the way to more of them (Explore).
// From the start screen's local copy of the popular feed right away, then the remixable feed.

import { useEffect, useMemo, useState } from 'react';
import { track } from '@/lib/analytics';
import { api } from '@/lib/api';
import { readJSON } from '@/lib/local';
import { useUi } from '@/state/ui';
import { Icon } from '@/components/ui/Icon';
import type { WorldCard } from '@/lib/types';
import { Thumb, useHydrated } from './WorldCard';

/** The start screen's local copy of the trending feed (src/components/orb/WorldStrip.tsx keeps it fresh). */
export const POPULAR_KEY = 'orb:home-popular';
const SHOWN = 3;

const startable = (worlds: WorldCard[] | null) => (worlds ?? []).filter((w) => w.forkable && w.kind === 'native').slice(0, SHOWN);

export function StartFrom({ onStart }: { onStart(id: string): void }) {
  const hydrated = useHydrated();
  const [fresh, setFresh] = useState<WorldCard[] | null>(null);
  const cached = useMemo(() => (hydrated ? readJSON<WorldCard[] | null>(POPULAR_KEY, null) : null), [hydrated]);
  const worlds = startable(fresh ?? (Array.isArray(cached) ? cached : null));

  useEffect(() => {
    let alive = true;
    api.listWorlds({ sort: 'trending', remixable: true, limit: 6 }).then(
      (r) => alive && setFresh(r.worlds),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  if (worlds.length < SHOWN) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[13px] text-ink-2">Or start from an existing world</p>
        <button
          type="button"
          onClick={() => {
            track('start_from_more');
            useUi.getState().requestExplore();
          }}
          className="group -mr-1 inline-flex h-7 items-center gap-0.5 rounded-full pr-1 pl-2 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink"
        >
          See more
          <Icon name="chevron-right" size={13} className="transition-transform duration-300 ease-[var(--ease)] group-hover:translate-x-0.5" />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {worlds.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => {
              track('start_from', { world_id: w.id });
              onStart(w.id);
            }}
            className="group min-w-0 rounded-[14px] bg-[var(--chip-bg)] p-1 text-left shadow-[inset_0_0_0_1px_var(--ink-5)] transition-[background-color,transform] duration-200 ease-[var(--ease)] hover:bg-[var(--chip-bg-hover)] active:scale-[.97]"
          >
            <Thumb src={w.thumbUrl} seed={w.id} name={w.name} initialSize={22} className="aspect-[4/3] w-full rounded-[10px]" />
            <span className="block truncate px-1 pt-1 pb-0.5 text-[12.5px] font-medium text-ink">{w.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
