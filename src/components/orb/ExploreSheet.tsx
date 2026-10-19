'use client';
// Explore: the worlds, edge to edge, over a frosted glass layer above the world. A slim header that
// slips away while you scroll down (search, filter chips, sort) and one infinite grid of every world,
// trending first unless sorted otherwise (Orb's picks, what people play right now, and a nudge for
// brand-new worlds — see trendExpr in src/server/worlds.ts). A world's name, maker and numbers show
// when a tile is hovered. Once opened, Explore stays mounted while closed, so coming back from a
// world finds it as it was left: the same filter, sort, search and scroll position.

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { track } from '@/lib/analytics';
import { api } from '@/lib/api';
import { curatedRank } from '@/lib/curation';
import { GITHUB_URL } from '@/lib/site';
import { onPhone, touchFirst } from '@/lib/keyboard';
import type { WorldCard as WorldCardData } from '@/lib/types';
import { Button, IconButton } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { Spinner } from '@/components/ui/Spinner';
import { useUi } from '@/state/ui';
import { ExploreTile, ExploreTileSkeleton } from './WorldCard';

type ListParams = NonNullable<Parameters<typeof api.listWorlds>[0]>;
type FilterId = 'all' | 'games' | 'worlds' | 'art' | 'remix';
export type SortId = 'trending' | 'played' | 'liked' | 'views' | 'new';

interface Filter {
  id: FilterId;
  label: string;
  /** One or more list queries whose results are merged (e.g. art + toy). */
  queries: ListParams[];
}

const FILTERS: Filter[] = [
  { id: 'all', label: 'All', queries: [{}] },
  { id: 'games', label: 'Games', queries: [{ tag: 'game' }] },
  { id: 'worlds', label: 'Worlds', queries: [{ tag: 'world' }] },
  { id: 'art', label: 'Art & toys', queries: [{ tag: 'art,toy' }] },
  { id: 'remix', label: 'Remix', queries: [{ remixable: true }] },
];

const SORTS: { id: SortId; label: string; icon: IconName; hint: string }[] = [
  { id: 'trending', label: 'Trending', icon: 'bolt', hint: 'What people play right now' },
  { id: 'played', label: 'Most played', icon: 'play', hint: 'Plays on Orb, all time' },
  { id: 'liked', label: 'Most liked', icon: 'heart', hint: 'Likes on Orb' },
  { id: 'views', label: 'Most viewed', icon: 'eye', hint: 'Views of the maker’s post, or plays' },
  { id: 'new', label: 'Newest', icon: 'sparkle', hint: 'Just made' },
];

const isFilter = (v: string | null | undefined): v is FilterId => FILTERS.some((f) => f.id === v);
const isSort = (v: string | null | undefined): v is SortId => SORTS.some((s) => s.id === v);

const PAGE = 24;
const EXIT_MS = 240;

// ---------------------------------------------------------------------------------------------
// Data: paginated, possibly merged world feeds

function sortValue(w: WorldCardData, sort: ListParams['sort']): number {
  if (sort === 'new') return Date.parse(w.createdAt) || 0;
  if (sort === 'featured') return w.featured * 1e9 + w.plays;
  if (sort === 'played') return w.plays;
  if (sort === 'liked') return w.likes;
  if (sort === 'views') return Math.max(w.origin?.views ?? 0, w.plays);
  const rank = curatedRank(w.id);
  return rank >= 0 ? 1e12 - rank : w.plays;
}

interface FeedState {
  key: string;
  items: WorldCardData[];
  /** Per query: next cursor, or null when exhausted. */
  cursors: (string | null)[];
  error: boolean;
}

interface Feed {
  items: WorldCardData[];
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: boolean;
  loadMore(): void;
  retry(): void;
}

async function fetchPage(queries: ListParams[], cursors: (string | null)[] | null, limit: number) {
  const results = await Promise.all(
    queries.map((q, i) => {
      const cursor = cursors ? cursors[i] : undefined;
      if (cursor === null) return Promise.resolve({ worlds: [] as WorldCardData[], nextCursor: undefined });
      return api.listWorlds({ ...q, limit, cursor: cursor || undefined });
    }),
  );
  let items = results.flatMap((r) => r.worlds);
  // Merged feeds are re-sorted by the shared sort key (single feeds keep the server's order).
  if (queries.length > 1) items = [...items].sort((a, b) => sortValue(b, queries[0].sort) - sortValue(a, queries[0].sort));
  // A search shows what was asked for, in order.
  if (onPhone() && !queries[0].q && queries[0].sort === 'trending') items = touchFirst(items);
  const next = results.map((r, i) => (cursors && cursors[i] === null ? null : (r.nextCursor ?? null)));
  return { items, cursors: next };
}

function dedupe(prev: WorldCardData[], next: WorldCardData[]) {
  const seen = new Set(prev.map((w) => w.id));
  const out = [...prev];
  for (const w of next)
    if (!seen.has(w.id)) {
      seen.add(w.id);
      out.push(w);
    }
  return out;
}

/** Fetches `queries` whenever `enabled` and the query identity change. `limit` caps a single-page feed. */
function useFeed(queries: ListParams[] | null, { paged = true, limit = PAGE }: { paged?: boolean; limit?: number } = {}): Feed {
  const [nonce, setNonce] = useState(0);
  // The serialized queries are the feed's identity (callers may pass fresh arrays each render).
  const spec = queries ? JSON.stringify(queries) : '';
  const key = spec ? `${spec}|${limit}|${paged}|${nonce}` : '';
  const [state, setState] = useState<FeedState | null>(null);
  const [more, setMore] = useState<{ key: string; status: 'loading' | 'error' } | null>(null);
  const current = state && state.key === key ? state : null;

  useEffect(() => {
    if (!key) return;
    let alive = true;
    fetchPage(JSON.parse(spec) as ListParams[], null, limit)
      .then((p) => alive && setState({ key, items: dedupe([], p.items), cursors: paged ? p.cursors : p.cursors.map(() => null), error: false }))
      .catch(() => alive && setState({ key, items: [], cursors: [], error: true }));
    return () => {
      alive = false;
    };
  }, [key, spec, limit, paged]);

  const hasMore = !!current && !current.error && current.cursors.some((c) => c !== null);
  const loadingMore = more?.key === key && more.status === 'loading';

  const loadMore = useCallback(() => {
    if (!current || !hasMore || loadingMore || !spec) return;
    const k = current.key;
    setMore({ key: k, status: 'loading' });
    fetchPage(JSON.parse(spec) as ListParams[], current.cursors, limit)
      .then((p) => {
        setState((s) => (s && s.key === k ? { ...s, items: dedupe(s.items, p.items), cursors: p.cursors } : s));
        setMore(null);
      })
      .catch(() => setMore({ key: k, status: 'error' }));
  }, [current, hasMore, loadingMore, spec, limit]);

  return {
    items: current?.items ?? [],
    loading: !!key && !current,
    error: !!current?.error,
    hasMore,
    loadingMore,
    moreError: more?.key === key && more.status === 'error',
    loadMore,
    retry: () => setNonce((n) => n + 1),
  };
}

// ---------------------------------------------------------------------------------------------
// Presence: mounted from the first open on; after a close animates out, it's hidden (not unmounted),
// so its state survives until Explore opens again.

function usePresence(open: boolean, exitMs: number) {
  const [ever, setEver] = useState(open);
  const [shown, setShown] = useState(open);
  if (open && !ever) setEver(true);
  if (open && !shown) setShown(true);
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => setShown(false), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);
  return { mounted: ever, hidden: !open && !shown, closing: !open };
}

/** Explore's place in the address bar (/explore?sort=…&filter=…&q=…), while it's at /explore. */
function readExploreParams(): { sort?: SortId; filter?: FilterId; q?: string } {
  if (typeof window === 'undefined' || !window.location.pathname.startsWith('/explore')) return {};
  const sp = new URLSearchParams(window.location.search);
  const sort = sp.get('sort');
  const filter = sp.get('filter');
  return { sort: isSort(sort) ? sort : undefined, filter: isFilter(filter) ? filter : undefined, q: sp.get('q')?.slice(0, 100) || undefined };
}

/** Explore's address for what it shows (/explore?filter=…&sort=…&q=…). */
function exploreAddress(sort: SortId, filter: FilterId, q: string): string {
  const sp = new URLSearchParams();
  if (filter !== 'all') sp.set('filter', filter);
  if (sort !== 'trending') sp.set('sort', sort);
  if (q) sp.set('q', q);
  return `/explore${sp.size ? `?${sp}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// ExploreSheet

export function ExploreSheet({
  open,
  onClose,
  onOpenWorld,
  onRemix,
  onNewWorld,
  onPlace,
  intro,
}: {
  open: boolean;
  onClose(): void;
  onOpenWorld(id: string): void;
  onRemix?(world: WorldCardData): void;
  onNewWorld?(): void;
  /** Explore's address for what it shows now. */
  onPlace?(address: string): void;
  /** The home page: Explore under this invitation to make a world (no closing it, no New world). */
  intro?: ReactNode;
}) {
  const { mounted, hidden, closing } = usePresence(open, EXIT_MS);
  if (!mounted) return null;
  return <ExploreOverlay open={open} hidden={hidden} closing={closing} onClose={onClose} onOpenWorld={onOpenWorld} onRemix={onRemix} onNewWorld={onNewWorld} onPlace={onPlace} intro={intro} />;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

function ExploreOverlay({
  open,
  hidden,
  closing,
  onClose,
  onOpenWorld,
  onRemix,
  onNewWorld,
  onPlace,
  intro,
}: {
  open: boolean;
  hidden: boolean;
  closing: boolean;
  onClose(): void;
  onOpenWorld(id: string): void;
  onRemix?(world: WorldCardData): void;
  onNewWorld?(): void;
  onPlace?(address: string): void;
  intro?: ReactNode;
}) {
  const home = !!intro;
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [initial] = useState(readExploreParams);
  const [input, setInput] = useState(initial.q ?? '');
  const [q, setQ] = useState(initial.q ?? '');
  const [filter, setFilter] = useState<FilterId>(() => {
    const asked = useUi.getState().exploreFilter;
    return isFilter(asked) ? asked : (initial.filter ?? 'all');
  });
  const [sort, setSort] = useState<SortId>(initial.sort ?? 'trending');
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // The header slips away while scrolling down through the worlds and comes back on the way up.
  const [tucked, setTucked] = useState(false);
  const lastTop = useRef(0);
  const headerRef = useRef<HTMLElement>(null);

  // Opened again for a filter (e.g. "See more" → Remix): show that one.
  const askedFilter = useUi((s) => s.exploreFilter);
  const [seenAsk, setSeenAsk] = useState(askedFilter);
  if (open && askedFilter !== seenAsk) {
    setSeenAsk(askedFilter);
    if (isFilter(askedFilter)) setFilter(askedFilter);
  }

  // Debounce typing → query (250 ms).
  useEffect(() => {
    const next = input.trim();
    if (next === q) return;
    const t = setTimeout(() => setQ(next), 250);
    return () => clearTimeout(t);
  }, [input, q]);

  // Hidden while closed (display: none), the feed forgets where it was scrolled to: keep it.
  const savedTop = useRef(0);
  useLayoutEffect(() => {
    if (!hidden && open && scrollRef.current && savedTop.current) scrollRef.current.scrollTop = savedTop.current;
  }, [hidden, open]);

  // Asked for Explore (the Orb's tab, a world's back arrow, "See all"): at home, down to its worlds,
  // unless they were already further down (back from a world, where they left off). Once per ask.
  const exploreRequest = useUi((s) => s.exploreRequest);
  const handledAsk = useRef(0);
  useEffect(() => {
    if (!exploreRequest || exploreRequest === handledAsk.current || !home || hidden) return;
    const t = setTimeout(() => {
      handledAsk.current = exploreRequest;
      const el = scrollRef.current, header = headerRef.current;
      if (el && header && el.scrollTop < header.offsetTop - 4) el.scrollTo({ top: header.offsetTop, behavior: 'smooth' });
    }, 80);
    return () => clearTimeout(t);
  }, [exploreRequest, home, hidden]);

  // A new result set starts at the top.
  useEffect(() => {
    savedTop.current = 0;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [q, filter, sort]);

  // The address follows what's shown (while Explore is at /explore), and the shell knows it, to come
  // back to it from a world.
  useEffect(() => {
    const next = exploreAddress(sort, filter, q);
    onPlace?.(next);
    if (open && window.location.pathname.startsWith('/explore') && next !== window.location.pathname + window.location.search) window.history.replaceState(window.history.state, '', next);
  }, [open, sort, filter, q, onPlace]);

  // Focus: search on devices with a keyboard (not on touch, to avoid popping the keyboard), unless
  // coming back to a scrolled feed; restore focus to whatever opened Explore when it closes.
  useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const prev = document.activeElement as HTMLElement | null;
    const atTop = (scrollRef.current?.scrollTop ?? 0) < 8;
    // At home the composer has the focus.
    if (home) return;
    if (atTop && window.matchMedia('(pointer: fine)').matches) searchRef.current?.focus({ preventScroll: true });
    else root?.focus({ preventScroll: true });
    return () => {
      if (prev && document.contains(prev) && !root?.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [open, home]);

  // Esc: clear a focused, non-empty search first; otherwise close.
  const onEscape = useEffectEvent((e: KeyboardEvent) => {
    if (!open || e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    if (input && document.activeElement === searchRef.current) {
      setInput('');
      setQ('');
    } else if (!home) onClose();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onEscape(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep Tab inside the dialog.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !rootRef.current) return;
    const els = focusables(rootRef.current);
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === rootRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const frostRef = useRef<HTMLDivElement>(null);
  const onScroll = (el: HTMLDivElement) => {
    const top = el.scrollTop;
    // At home: frosted once the worlds' header is a little way up the screen.
    if (home && frostRef.current) frostRef.current.style.opacity = String(Math.min(1, top / Math.max(1, (headerRef.current?.offsetTop ?? 400) * 0.6)));
    if (open) savedTop.current = top;
    setScrolled(top > (home ? (headerRef.current?.offsetTop ?? 0) - 4 : 8));
    const dy = top - lastTop.current;
    if (Math.abs(dy) > 6) {
      // Not while typing a search: the field stays in reach.
      setTucked(dy > 0 && top > (home ? (headerRef.current?.offsetTop ?? 0) + 160 : 160) && document.activeElement !== searchRef.current);
      lastTop.current = top;
    }
  };

  const activeFilter = FILTERS.find((f) => f.id === filter)!;
  const activeSort = SORTS.find((x) => x.id === sort)!;
  const pickSort = (id: SortId) => {
    setSort(id);
    track('explore_sort', { sort: id, filter });
  };

  return (
    <div
      ref={rootRef}
      role={home ? 'region' : 'dialog'}
      aria-modal={home ? undefined : true}
      aria-labelledby="orb-explore-title"
      tabIndex={-1}
      hidden={hidden}
      inert={!open}
      onKeyDown={onKeyDown}
      // At home it's the page, under the Orb and its panel; otherwise a sheet over everything.
      className={`fixed inset-0 ${home ? 'z-[35]' : 'z-[60]'} outline-none transition-opacity ease-[var(--ease)] starting:opacity-0 ${closing ? 'pointer-events-none opacity-0 duration-[240ms]' : 'opacity-100 duration-[380ms]'}`}
    >
      {/* At home a light veil leaves the world behind the headline in view; the heavy frosted backdrop
          (the world only glows through) comes in as the worlds scroll up. */}
      {home && <div aria-hidden="true" className="absolute inset-0 bg-[color-mix(in_oklab,var(--paper)_30%,transparent)] backdrop-blur-[3px]" />}
      <div
        ref={frostRef}
        aria-hidden="true"
        style={home ? { opacity: 0 } : undefined}
        className="absolute inset-0 bg-[color-mix(in_oklab,var(--paper)_62%,transparent)] backdrop-blur-[44px] backdrop-saturate-[1.6]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[360px] opacity-[.22] [background:radial-gradient(60%_100%_at_15%_0%,var(--iris-1),transparent_70%),radial-gradient(50%_90%_at_85%_0%,var(--iris-2),transparent_70%)] dark:opacity-[.14]"
      />

      <div
        ref={scrollRef}
        onScroll={(e) => onScroll(e.currentTarget)}
        className={`scroll-soft relative h-full overflow-x-hidden overflow-y-auto overscroll-contain transition-[transform] ease-[var(--ease)] starting:scale-[.985] ${closing ? 'scale-[.985] duration-[240ms]' : 'scale-100 duration-[420ms]'}`}
      >
        {intro}
        <header
          ref={headerRef}
          className={`sticky top-0 z-10 transition-[transform,background,box-shadow,backdrop-filter] duration-300 ease-[var(--ease)] ${tucked ? '-translate-y-full' : 'translate-y-0'} ${
            scrolled ? 'bg-[color-mix(in_oklab,var(--paper)_60%,transparent)] shadow-[0_1px_0_color-mix(in_oklab,var(--ink)_7%,transparent)] backdrop-blur-[24px] backdrop-saturate-150' : ''
          }`}
        >
          <div className="px-3 pt-[max(12px,env(safe-area-inset-top))] pb-3 sm:px-5 lg:px-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 lg:flex-nowrap">
              <h2 id="orb-explore-title" className="font-display order-1 pr-2 text-[30px] leading-none tracking-[-0.015em] text-ink sm:text-[34px]">
                Explore
              </h2>
              <div className="order-5 -mx-3 flex min-w-0 basis-full items-center gap-1.5 overflow-x-auto px-3 [scrollbar-width:none] sm:order-4 sm:-mx-5 sm:px-5 lg:order-2 lg:mx-0 lg:basis-auto lg:px-0 [&::-webkit-scrollbar]:hidden">
                <Chips
                  value={filter}
                  onChange={(f) => {
                    setFilter(f);
                    track('explore_filter', { filter: f });
                  }}
                />
                <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-[color-mix(in_oklab,var(--ink)_12%,transparent)] lg:hidden" />
                <div className="lg:hidden">
                  <SortMenu value={sort} onChange={pickSort} />
                </div>
              </div>
              <div className="hidden lg:order-3 lg:ml-auto lg:block">
                <SortMenu value={sort} onChange={pickSort} />
              </div>
              {/* Phones: search sits behind an icon until it's wanted, so the worlds get the screen. */}
              <div className={`order-4 basis-full sm:order-2 sm:ml-auto sm:block sm:basis-auto sm:w-[min(340px,40vw)] lg:order-4 lg:ml-0 lg:w-[min(320px,24vw)] ${searchOpen || input ? '' : 'hidden'}`}>
                <SearchField inputRef={searchRef} value={input} onChange={setInput} onSubmit={() => setQ(input.trim())} />
              </div>
              <div className="order-2 ml-auto flex items-center gap-2 sm:order-3 sm:ml-0 lg:order-5">
                {!searchOpen && !input && (
                  <IconButton
                    icon="search"
                    label="Search worlds"
                    variant="glass"
                    size={40}
                    className="sm:hidden"
                    onClick={() => {
                      setSearchOpen(true);
                      requestAnimationFrame(() => searchRef.current?.focus());
                    }}
                  />
                )}
                {onNewWorld && !home && (
                  <Button variant="primary" icon="sparkle" onClick={onNewWorld} className="shrink-0">
                    New world
                  </Button>
                )}
                {!home && <IconButton icon="x" label="Close Explore" variant="glass" size={40} onClick={onClose} />}
              </div>
            </div>
          </div>
        </header>

        <main className={`px-3 pt-1 sm:px-5 lg:px-6 ${home ? 'pb-10' : 'pb-[max(40px,env(safe-area-inset-bottom))]'}`}>
          <ResultsGrid
            key={`${filter}|${sort}|${q}`}
            queries={activeFilter.queries.map((p) => ({ ...(q && filter === 'all' ? {} : p), sort, ...(q ? { q } : {}) }))}
            q={q}
            lead={!q && sort === 'trending'}
            sortLabel={sort === 'trending' ? null : activeSort.label}
            filterLabel={filter === 'all' ? null : activeFilter.label}
            scrollRef={scrollRef}
            onOpen={(id) => {
              track('world_open', { world_id: id, source: home ? 'home' : 'explore', filter, sort, q: q || undefined });
              onOpenWorld(id);
            }}
            onRemix={onRemix}
            onClear={() => {
              setInput('');
              setQ('');
              setFilter('all');
              setSort('trending');
              searchRef.current?.focus();
            }}
          />
        </main>
        {home && <Footer onTop={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })} />}
      </div>
    </div>
  );
}

/** The home page's foot, past the last world: Orb's name, its plans, the kit, llms.txt for agents, GitHub and a way back up. */
function Footer({ onTop }: { onTop(): void }) {
  const link = 'rounded-full px-2.5 py-1.5 text-ink-2 transition-colors hover:text-ink';
  return (
    <footer className="mx-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[color-mix(in_oklab,var(--ink)_8%,transparent)] py-5 pb-[max(20px,env(safe-area-inset-bottom))] text-[13px] sm:mx-5 lg:mx-6">
      <span className="font-display text-[17px] text-ink">orbworlds</span>
      <nav aria-label="About Orb" className="-mr-2.5 flex flex-wrap items-center">
        <button type="button" className={link} onClick={() => useUi.getState().setPlans(true)}>
          Plans
        </button>
        <a className={link} href="https://www.npmjs.com/package/@orbworlds/kit" target="_blank" rel="noopener noreferrer" title="Make worlds on your own computer">
          Orb kit
        </a>
        <a className={link} href="/llms.txt" title="How to make Orb worlds, for AI agents">
          llms.txt
        </a>
        <a className={`${link} inline-flex items-center gap-1.5`} href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          <Icon name="github" size={14} /> GitHub
        </a>
        <button type="button" className={`${link} inline-flex items-center gap-1`} onClick={onTop}>
          Back to top <Icon name="arrow-up" size={13} />
        </button>
      </nav>
    </footer>
  );
}

// ---------------------------------------------------------------------------------------------
// Header bits

function SearchField({ inputRef, value, onChange, onSubmit }: { inputRef: RefObject<HTMLInputElement | null>; value: string; onChange(v: string): void; onSubmit(): void }) {
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
        inputRef.current?.blur();
      }}
      className="glass group relative flex h-10 items-center rounded-full transition-shadow duration-200 focus-within:shadow-[inset_0_0_0_1px_var(--glass-hairline),0_0_0_1px_var(--glass-edge),0_0_0_5px_color-mix(in_oklab,var(--iris-1)_20%,transparent),var(--shadow-soft)]"
    >
      <Icon name="search" size={17} className="pointer-events-none absolute left-3.5 text-ink-3" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search worlds, games, makers…"
        aria-label="Search worlds"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="h-full w-full min-w-0 rounded-full bg-transparent pr-10 pl-10 text-[14.5px] text-ink outline-none placeholder:text-ink-3 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onChange('');
            onSubmit();
            inputRef.current?.focus();
          }}
          className="absolute right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--field-bg)] text-ink-2 transition-colors hover:text-ink focus-visible:rounded-full"
        >
          <Icon name="x" size={14} strokeWidth={2.2} />
        </button>
      )}
    </form>
  );
}

function Chips({ value, onChange }: { value: FilterId; onChange(v: FilterId): void }) {
  return (
    <div role="tablist" aria-label="Filter worlds" className="flex shrink-0 gap-1.5">
      {FILTERS.map((f) => {
        const on = f.id === value;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(f.id)}
            className={`flex h-9 shrink-0 items-center rounded-full px-3.5 text-[13.5px] font-medium transition-[background,color,box-shadow,transform] duration-200 ease-[var(--ease)] focus-visible:rounded-full active:scale-[.97] ${
              on ? 'bg-ink text-paper shadow-[0_6px_18px_-8px_rgba(12,12,20,.5)]' : 'glass-soft text-ink-2 hover:text-ink'
            }`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function SortMenu({ value, onChange }: { value: SortId; onChange(v: SortId): void }) {
  const current = SORTS.find((x) => x.id === value)!;
  return (
    <Menu
      align="end"
      width={268}
      className="shrink-0"
      items={[
        { kind: 'label', label: 'Sort by' },
        ...SORTS.map((x) => ({ label: x.label, icon: x.icon, hint: x.hint, stacked: true, checked: x.id === value, onSelect: () => onChange(x.id) })),
      ]}
      renderTrigger={(props, open) => (
        <button
          type="button"
          {...props}
          aria-label={`Sort: ${current.label}`}
          className={`glass-soft flex h-9 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-3 text-[13.5px] font-medium text-ink transition-[background,transform] duration-200 ease-[var(--ease)] hover:text-ink focus-visible:rounded-full active:scale-[.97] ${open ? 'bg-[var(--glass-bg)]' : ''}`}
        >
          <Icon name={current.icon} size={14} strokeWidth={2} className="text-ink-2" />
          {current.label}
          <Icon name="chevron-down" size={14} strokeWidth={2} className={`text-ink-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        </button>
      )}
    />
  );
}

/** Tiles fill the width: as many ~340px columns as fit, so a wide screen shows more worlds, not wider margins. */
function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-flow-row-dense grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-2.5 sm:gap-3 xl:grid-cols-[repeat(auto-fill,minmax(340px,1fr))] 2xl:gap-4">{children}</div>;
}

function Skeletons({ n, lead = false }: { n: number; lead?: boolean }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <ExploreTileSkeleton key={`sk${i}`} big={lead && i === 0} />
      ))}
    </>
  );
}

function ResultsGrid({
  queries,
  q,
  lead,
  sortLabel,
  filterLabel,
  scrollRef,
  onOpen,
  onRemix,
  onClear,
}: {
  queries: ListParams[];
  q: string;
  /** The first world leads, two columns by two rows (wide screens). */
  lead: boolean;
  sortLabel: string | null;
  filterLabel: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onOpen(id: string): void;
  onRemix?(w: WorldCardData): void;
  onClear(): void;
}) {
  const feed = useFeed(queries);
  const searched = useRef(false);
  useEffect(() => {
    if (!q || feed.loading || searched.current) return;
    searched.current = true;
    track('explore_search', { q: q.slice(0, 100), results: feed.error ? null : feed.items.length });
  }, [q, feed.loading, feed.error, feed.items.length]);

  if (feed.error)
    return (
      <EmptyState
        icon="refresh"
        title="Couldn’t load worlds"
        body="Check your connection and try again."
        action={
          <Button variant="primary" icon="refresh" onClick={feed.retry}>
            Try again
          </Button>
        }
      />
    );

  if (!feed.loading && feed.items.length === 0)
    return q ? (
      <EmptyState
        icon="search"
        title={`Nothing called “${q}” yet`}
        body="Try another word, or ask the Orb to make it."
        action={
          <Button variant="glass" onClick={onClear}>
            Clear search
          </Button>
        }
      />
    ) : (
      <EmptyState icon="sparkle" title="Nothing here yet" body="Be the first to make one." />
    );

  return (
    <div className="pt-1">
      {q && (
        <div className="mb-3 flex items-baseline gap-2 px-1">
          <h3 className="font-display text-[26px] leading-none tracking-[-0.01em] text-ink">
            Results for <span className="italic">“{q}”</span>
          </h3>
          {(filterLabel || sortLabel) && <span className="text-[13.5px] text-ink-2">{[filterLabel && `in ${filterLabel}`, sortLabel?.toLowerCase()].filter(Boolean).join(' · ')}</span>}
        </div>
      )}
      <Grid>
        {feed.loading ? (
          <Skeletons n={12} lead={lead} />
        ) : (
          feed.items.map((w, i) => {
            const big = lead && i === 0;
            return <ExploreTile key={w.id} world={w} big={big} onOpen={onOpen} onRemix={onRemix} className={big ? 'xl:col-span-2 xl:row-span-2' : ''} />;
          })
        )}
        {feed.loadingMore && <Skeletons n={4} />}
      </Grid>
      <MoreSentinel feed={feed} scrollRef={scrollRef} />
    </div>
  );
}

/** Loads the next page when it scrolls into view (600px early); shows a retry on failure. */
function MoreSentinel({ feed, scrollRef }: { feed: Feed; scrollRef: RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const { hasMore, loadingMore, moreError, loadMore } = feed;
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore || loadingMore || moreError) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { root: scrollRef.current, rootMargin: '0px 0px 600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, moreError, loadMore, scrollRef]);

  if (moreError)
    return (
      <div className="mt-8 flex justify-center">
        <Button variant="glass" size="sm" icon="refresh" onClick={loadMore}>
          Couldn’t load more — try again
        </Button>
      </div>
    );
  if (!hasMore) return null;
  return (
    <div ref={ref} className="mt-8 flex h-10 items-center justify-center" aria-hidden={!loadingMore}>
      {loadingMore && <Spinner size={18} />}
    </div>
  );
}

function EmptyState({ icon, title, body, action }: { icon: IconName; title: ReactNode; body: string; action?: ReactNode }) {
  return (
    <div className="animate-fade-up mx-auto flex max-w-[420px] flex-col items-center px-4 py-20 text-center sm:py-28">
      <span className="glass mb-5 flex h-14 w-14 items-center justify-center rounded-full text-ink-2">
        <Icon name={icon} size={22} />
      </span>
      <h3 className="font-display text-[30px] leading-tight tracking-[-0.01em] break-words text-ink">{title}</h3>
      <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
