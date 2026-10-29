'use client';
// In the chat while a build takes a while: the three most played games, to play meanwhile. The build
// keeps going in the background, and a note says when the world is ready (Shell's onBackgroundDone).

import { useEffect, useState } from 'react';
import { track } from '@/lib/analytics';
import { api } from '@/lib/api';
import { needsKeyboard, onPhone } from '@/lib/keyboard';
import type { WorldCard } from '@/lib/types';
import { useUi } from '@/state/ui';
import { playsLabel, Thumb } from './WorldCard';

/** Shown once a build has run this long. */
export const PLAY_AFTER_MS = 30_000;
const SHOWN = 3;

let mostPlayed: Promise<WorldCard[]> | null = null;
/** The most played games (asked once a page view). */
function games(): Promise<WorldCard[]> {
  mostPlayed ??= api.listWorlds({ sort: 'played', tag: 'game', limit: 8 }).then(
    (r) => r.worlds,
    () => {
      mostPlayed = null;
      return [];
    },
  );
  return mostPlayed;
}

export function PlayWhileBuilding({ since, worldId, onOpen }: { since: number; worldId?: string; onOpen(id: string): void }) {
  const [worlds, setWorlds] = useState<WorldCard[]>([]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () =>
        void games().then((all) => {
          // Games a phone can play, on a phone; never the world being built.
          if (alive) setWorlds(all.filter((w) => w.id !== worldId && !(onPhone() && needsKeyboard(w))).slice(0, SHOWN));
        }),
      Math.max(0, since + PLAY_AFTER_MS - Date.now()),
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [since, worldId]);

  if (worlds.length < SHOWN) return null;
  return (
    <div className="animate-fade-up pl-7">
      <p className="mb-2 text-[13px] text-ink-2">Play while it builds</p>
      <div className="grid grid-cols-3 gap-2">
        {worlds.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => {
              track('world_open', { world_id: w.id, source: 'while_building' });
              useUi.getState().closePanel(); // the game gets the screen
              onOpen(w.id);
            }}
            className="group min-w-0 rounded-[14px] bg-[var(--chip-bg)] p-1 text-left shadow-[inset_0_0_0_1px_var(--ink-5)] transition-[background-color,transform] duration-200 ease-[var(--ease)] hover:bg-[var(--chip-bg-hover)] active:scale-[.97]"
          >
            <Thumb src={w.thumbUrl} seed={w.id} name={w.name} initialSize={22} className="aspect-[4/3] w-full rounded-[10px]" />
            <span className="block truncate px-1 pt-1 text-[12.5px] font-medium text-ink">{w.name}</span>
            <span className="block truncate px-1 pb-0.5 text-[11.5px] text-ink-3 tabular-nums">{playsLabel(w.plays)}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12.5px] text-ink-3">Your world keeps building. You’ll get a note when it’s ready.</p>
    </div>
  );
}
