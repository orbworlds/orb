'use client';
// The start screen's row: friends' worlds and your own (nothing without them). It also keeps
// StartFrom's local copy of the trending feed fresh.

import { useEffect, useMemo, useRef, useState } from 'react';
import { track } from '@/lib/analytics';
import { api, worldHref } from '@/lib/api';
import { readJSON, writeJSON } from '@/lib/local';
import { previewVideo } from '@/lib/previews';
import type { WorldCard as WorldCardData } from '@/lib/types';
import { Icon } from '@/components/ui/Icon';
import { showFriends, useFriends } from '@/state/friends';
import { useUi } from '@/state/ui';
import { useWorld } from '@/state/world';
import { useSession } from './AccountCard';
import { POPULAR_KEY } from './StartFrom';
import { onPlainClick, Thumb, timeAgo, useHydrated } from './WorldCard';

type Tab = 'friends' | 'mine';

const TAB_KEY = 'orb:home-tab';
const LIMIT = 12;
const CARD_W = 'w-[min(54vw,224px)] sm:w-[198px]';
const FADE = 56;

const named = (w: WorldCardData) => !!w.name && w.name !== 'Untitled world';

export function WorldStrip({ onOpenWorld, onOpenMine, className = '' }: { onOpenWorld(id: string): void; onOpenMine(): void; className?: string }) {
  const hydrated = useHydrated();
  const [mine, setMine] = useState<WorldCardData[] | null>(null);
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab = chosen ?? (hydrated ? readJSON<Tab | null>(TAB_KEY, null) : null);
  const friends = useFriendWorlds();

  // Keeps StartFrom's local copy fresh, for its instant first paint.
  useEffect(() => {
    api.listWorlds({ sort: 'trending', limit: LIMIT }).then((r) => writeJSON(POPULAR_KEY, r.worlds), () => {});
  }, []);

  // Their own worlds, again each time home shows (they may have made one meanwhile).
  const done = useUi((s) => s.heroDone);
  const inWorld = useWorld((s) => !!s.world);
  const away = done || inWorld;
  useEffect(() => {
    if (away) return;
    let alive = true;
    api
      .listWorlds({ mine: true, limit: LIMIT })
      .then((r) => alive && setMine(r.worlds.filter(named)))
      .catch(() => alive && setMine((m) => m ?? []));
    return () => {
      alive = false;
    };
  }, [away]);

  const hasMine = !!mine?.length;
  const hasFriends = friends.worlds.length > 0;
  const shown: Tab = hasFriends && !(tab === 'mine' && hasMine) ? 'friends' : 'mine';
  const pick = (t: Tab) => {
    if (t !== tab) track('home_tab', { tab: t });
    setChosen(t);
    writeJSON(TAB_KEY, t);
  };

  if (!hasMine && !hasFriends) return null;
  return (
    <section aria-label="Worlds to play" className={className}>
      <div className="mb-2 flex items-center gap-4 px-1">
        {hasMine && hasFriends ? (
          <div role="tablist" aria-label="Which worlds" className="flex gap-4">
            <TabButton on={shown === 'mine'} onClick={() => pick('mine')}>
              Your worlds
            </TabButton>
            <TabButton on={shown === 'friends'} onClick={() => pick('friends')} live={friends.here.size > 0}>
              Friends
            </TabButton>
          </div>
        ) : (
          <h2 className={`${TITLE} text-ink`}>{hasMine ? 'Your worlds' : 'Friends’ worlds'}</h2>
        )}
        <button
          type="button"
          onClick={shown === 'mine' ? onOpenMine : showFriends}
          className="group -mr-1 ml-auto inline-flex h-8 items-center gap-0.5 rounded-full pr-1 pl-2 text-[13.5px] font-medium text-ink-2 transition-colors hover:text-ink"
        >
          See all
          <Icon name="chevron-right" size={14} className="transition-transform duration-300 ease-[var(--ease)] group-hover:translate-x-0.5" />
        </button>
      </div>
      <Row key={shown} worlds={shown === 'mine' ? mine! : friends.worlds} tab={shown} here={friends.here} onOpenWorld={onOpenWorld} />
    </section>
  );
}

/**
 * Friends' worlds for the row: the ones friends are in right now first (with who's there), then
 * what they made lately. Empty when signed out or without friends.
 */
function useFriendWorlds(): { worlds: WorldCardData[]; here: Map<string, string[]> } {
  const signedIn = useSession((s) => !!s.me?.user);
  const data = useFriends((s) => s.data);
  const count = data?.friends.length ?? 0;
  const [made, setMade] = useState<WorldCardData[] | null>(null);
  useEffect(() => {
    if (!signedIn || !count) return;
    let alive = true;
    api
      .friendsWorlds()
      .then((r) => alive && setMade(r.worlds))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [signedIn, count]);
  return useMemo(() => {
    const here = new Map<string, string[]>();
    const live: WorldCardData[] = [];
    if (!signedIn || !count) return { worlds: [], here };
    for (const f of data?.friends ?? []) {
      if (!f.world) continue;
      const names = here.get(f.world.id);
      if (names) names.push(f.name);
      else {
        here.set(f.world.id, [f.name]);
        live.push(f.world);
      }
    }
    return { worlds: [...live, ...(made ?? []).filter((w) => !here.has(w.id))], here };
  }, [signedIn, count, data, made]);
}

const TITLE = 'text-[15px] font-semibold tracking-[-0.01em]';

function TabButton({ on, onClick, live = false, children }: { on: boolean; onClick(): void; /** A green dot: something is happening there right now. */ live?: boolean; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={`flex h-8 items-center gap-1.5 transition-colors duration-200 focus-visible:rounded-md ${TITLE} ${on ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
    >
      {children}
      {live && <span aria-label="(friends playing now)" className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />}
    </button>
  );
}

/** "Lea is here", "Lea and Sam are here", "Lea and 2 friends are here". */
function hereLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is here`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
  return `${names[0]} and ${names.length - 1} friends are here`;
}

/** One scrolling row of cards, with arrows on screens that have a mouse. */
function Row({ worlds, tab, here, onOpenWorld }: { worlds: WorldCardData[]; tab: Tab; here: Map<string, string[]>; onOpenWorld(id: string): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const measure = () => {
    const el = ref.current;
    if (el) setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [worlds]);
  const page = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: 'smooth' });
  // Cards that run past an edge fade out instead of being cut off.
  const mask = `linear-gradient(to right, ${edges.start ? '#000' : 'transparent'} 0, #000 ${edges.start ? 0 : FADE}px, #000 calc(100% - ${edges.end ? 0 : FADE}px), ${edges.end ? '#000' : 'transparent'} 100%)`;

  return (
    <div className="group/row relative">
      <div
        ref={ref}
        onScroll={measure}
        role="list"
        className="scroll-none -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto px-4 pt-1 pb-2 sm:mx-0 sm:scroll-px-0 sm:px-0"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        {worlds.map((w, i) => (
          <Card key={w.id} world={w} tab={tab} here={tab === 'friends' ? here.get(w.id) : undefined} index={i} onOpen={onOpenWorld} />
        ))}
      </div>
      <Arrow dir={-1} hidden={edges.start} onClick={() => page(-1)} />
      <Arrow dir={1} hidden={edges.end} onClick={() => page(1)} />
    </div>
  );
}

function Arrow({ dir, hidden, onClick }: { dir: 1 | -1; hidden: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={onClick}
      className={`glass absolute top-[calc(50%-24px)] z-[2] hidden h-9 w-9 items-center justify-center rounded-full text-ink transition-[opacity,transform] duration-200 ease-[var(--ease)] hover:scale-105 active:scale-95 [@media(pointer:fine)]:flex ${dir < 0 ? '-left-4' : '-right-4'} ${hidden ? 'pointer-events-none opacity-0' : 'opacity-0 group-hover/row:opacity-100'}`}
    >
      <Icon name={dir < 0 ? 'chevron-left' : 'chevron-right'} size={18} strokeWidth={2} />
    </button>
  );
}

function Card({ world, tab, here, index, onOpen }: { world: WorldCardData; tab: Tab; /** Friends in this world right now. */ here?: string[]; index: number; onOpen(id: string): void }) {
  const mine = tab === 'mine';
  return (
    <div role="listitem" className={`shrink-0 snap-start ${CARD_W}`}>
      <a
        href={worldHref(world)}
        onClick={onPlainClick(() => {
          track('world_open', { world_id: world.id, source: 'home', tab, position: index + 1 });
          onOpen(world.id);
        })}
        aria-label={`Open ${world.name}`}
        className="group glass-soft animate-fade-up block w-full rounded-[18px] p-1.5 text-left focus-visible:rounded-[18px] transition-[transform,box-shadow,background] duration-300 ease-[var(--ease)] hover:-translate-y-0.5 hover:bg-[var(--glass-bg)] hover:shadow-[inset_0_0_0_1px_var(--glass-hairline),0_0_0_1px_var(--glass-edge),var(--shadow-lift)] active:scale-[.98]"
        style={{ animationDelay: `${120 + Math.min(index, 6) * 45}ms` }}
      >
        <span className="relative block">
          <Thumb src={world.thumbUrl} seed={world.id} name={world.name} initialSize={36} video={previewVideo(world.id)} className="aspect-[16/10] rounded-[13px]" />
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <span className="glass flex h-10 w-10 scale-90 items-center justify-center rounded-full text-ink transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-100">
              <Icon name="play" size={15} className="translate-x-[1px]" fill="currentColor" />
            </span>
          </span>
        </span>
        <span className="block px-1.5 pt-2 pb-1">
          <span className="block truncate text-[13.5px] leading-tight font-semibold text-ink">{world.name}</span>
          <span className={`mt-0.5 flex items-center gap-1 truncate text-[12px] leading-[1.35] ${here ? 'font-medium text-[var(--ok)]' : 'text-ink-2'}`}>
            {mine && world.visibility === 'private' && <Icon name="lock" size={11} strokeWidth={2} className="shrink-0" />}
            {here && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ok)]" />}
            <span className="truncate">{here ? hereLine(here) : mine ? `Edited ${timeAgo(world.updatedAt)}` : `by ${world.authorName || 'someone'}`}</span>
          </span>
        </span>
      </a>
    </div>
  );
}
