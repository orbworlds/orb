'use client';
// The home page: the invitation to make a world (a header row with the Orb, and `intro`) over
// Explore, the worlds edge to edge, trending first unless sorted otherwise (Orb's picks, what people
// play right now, and a nudge for brand-new worlds — see trendExpr in src/server/worlds.ts).
// Explore's header (filters, sort, search) sticks at the top once the worlds reach it. At / the
// worlds fill a few rows, then "See all worlds" goes on to /explore, where they go on as far as
// there are worlds. Once opened, it stays mounted while a world plays, so coming back finds it as it
// was left: the same filter, sort, search and scroll position.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { track } from '@/lib/analytics';
import { api } from '@/lib/api';
import { GITHUB_URL } from '@/lib/site';
import { onPhone, touchFirst } from '@/lib/keyboard';
import type { WorldCard as WorldCardData } from '@/lib/types';
import { Button, IconButton } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { useUi } from '@/state/ui';
import { HomeHeader, OrbButton } from './Hero';
import { ExploreTile, ExploreTileSkeleton, onPlainClick } from './WorldCard';

type ListParams = NonNullable<Parameters<typeof api.listWorlds>[0]>;
type FilterId = 'all' | 'games' | 'places' | 'art';
type SortId = 'trending' | 'new';

const FILTERS: { id: FilterId; label: string; query: ListParams }[] = [
  { id: 'all', label: 'All', query: {} },
  { id: 'games', label: 'Games', query: { tag: 'game' } },
  { id: 'places', label: 'Places', query: { tag: 'world' } },
  { id: 'art', label: 'Art & toys', query: { tag: 'art,toy' } },
];

const SORTS: { id: SortId; label: string }[] = [
  { id: 'trending', label: 'Trending' },
  { id: 'new', label: 'New' },
];

const isFilter = (v: string | undefined): v is FilterId => FILTERS.some((f) => f.id === v);
const isSort = (v: string | undefined): v is SortId => SORTS.some((s) => s.id === v);

const PAGE = 24;
const EXIT_MS = 240;

// ---------------------------------------------------------------------------------------------
// Data: a paginated world feed

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

async function fetchPage(query: ListParams, cursor?: string) {
  const r = await api.listWorlds({ ...query, limit: PAGE, cursor });
  // On touch screens, worlds that need a keyboard come after the others; a search shows what was
  // asked for, in order.
  return { items: onPhone() && !query.q ? touchFirst(r.worlds) : r.worlds, cursor: r.nextCursor };
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

/** Fetches `query` (its caller is keyed by it, so it never changes while mounted), a page at a time. */
function useFeed(query: ListParams): Feed {
  const [nonce, setNonce] = useState(0);
  const spec = JSON.stringify(query);
  const [state, setState] = useState<{ items: WorldCardData[]; cursor?: string; error: boolean } | null>(null);
  const [more, setMore] = useState<'loading' | 'error' | null>(null);

  useEffect(() => {
    let alive = true;
    fetchPage(JSON.parse(spec) as ListParams)
      .then((p) => alive && setState({ items: p.items, cursor: p.cursor, error: false }))
      .catch(() => alive && setState({ items: [], error: true }));
    return () => {
      alive = false;
    };
  }, [spec, nonce]);

  const cursor = state?.cursor;
  const loadMore = useCallback(() => {
    if (!cursor || more === 'loading') return;
    setMore('loading');
    fetchPage(JSON.parse(spec) as ListParams, cursor)
      .then((p) => {
        setState((s) => s && { ...s, items: dedupe(s.items, p.items), cursor: p.cursor });
        setMore(null);
      })
      .catch(() => setMore('error'));
  }, [cursor, more, spec]);

  return {
    items: state?.items ?? [],
    loading: !state,
    error: !!state?.error,
    hasMore: !!cursor,
    loadingMore: more === 'loading',
    moreError: more === 'error',
    loadMore,
    retry: () => {
      setState(null);
      setNonce((n) => n + 1);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Presence: mounted from the first open on; after a close animates out, it's hidden (not unmounted),
// so its state survives until it opens again.

function usePresence(open: boolean) {
  const [ever, setEver] = useState(open);
  const [shown, setShown] = useState(open);
  if (open && !ever) setEver(true);
  if (open && !shown) setShown(true);
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => setShown(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);
  return { mounted: ever, hidden: !open && !shown };
}

/** Explore's address for what it shows (/explore?filter=…&sort=…&q=…). */
function exploreAddress(sort: SortId, filter: FilterId, q: string): string {
  const sp = new URLSearchParams();
  if (filter !== 'all') sp.set('filter', filter);
  if (sort !== 'trending') sp.set('sort', sort);
  if (q) sp.set('q', q);
  return `/explore${sp.size ? `?${sp}` : ''}`;
}

/** Where Explore's header sits before it sticks (a stuck header's own offsetTop is the scroll position). */
const headerTop = (header: HTMLElement) => (header.nextElementSibling as HTMLElement).offsetTop - header.offsetHeight;

// ---------------------------------------------------------------------------------------------
// ExploreSheet

interface ExploreProps {
  open: boolean;
  /** The invitation to make a world, above the worlds. */
  intro: ReactNode;
  /** A build is running (the Orb in the header swirls). */
  building: boolean;
  /** The page loaded at /explore: its address (what to show), and all the worlds, not a few rows. */
  start?: { filter?: string; sort?: string; q?: string };
  onOpenWorld(id: string): void;
  onRemix?(world: WorldCardData): void;
}

export function ExploreSheet(props: ExploreProps) {
  const { mounted, hidden } = usePresence(props.open);
  return mounted ? <ExploreOverlay {...props} hidden={hidden} /> : null;
}

function ExploreOverlay({ open, hidden, intro, building, start, onOpenWorld, onRemix }: ExploreProps & { hidden: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState(start?.q ?? '');
  const [q, setQ] = useState(start?.q ?? '');
  const [filter, setFilter] = useState<FilterId>(isFilter(start?.filter) ? start.filter : 'all');
  const [sort, setSort] = useState<SortId>(isSort(start?.sort) ? start.sort : 'trending');
  // All the worlds (/explore), or a few rows of them (/).
  const [all, setAll] = useState(!!start);
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

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

  // Asked for Explore (a world's way back, a missing world's Explore, /explore): down to its worlds,
  // unless they were already further down (back from a world, where they left off). Once per ask.
  const exploreRequest = useUi((s) => s.exploreRequest);
  const handledAsk = useRef(0);
  useEffect(() => {
    if (!exploreRequest || exploreRequest === handledAsk.current || hidden) return;
    const t = setTimeout(() => {
      handledAsk.current = exploreRequest;
      const el = scrollRef.current;
      const top = headerRef.current ? headerTop(headerRef.current) : 0;
      // At once: anything that loads above afterwards (their own worlds' row) keeps them in place.
      if (el && el.scrollTop < top - 4) el.scrollTo({ top });
    }, 80);
    return () => clearTimeout(t);
  }, [exploreRequest, hidden]);

  // A new result set starts right under the header, which stays where it is.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !headerRef.current) return;
    const top = Math.min(el.scrollTop, headerTop(headerRef.current));
    savedTop.current = top;
    el.scrollTo({ top });
  }, [q, filter, sort]);

  // The address follows what's shown, while it's /explore's.
  useEffect(() => {
    const next = exploreAddress(sort, filter, q);
    if (open && location.pathname.startsWith('/explore') && next !== location.pathname + location.search) history.replaceState(history.state, '', next);
  }, [open, sort, filter, q]);

  const onScroll = (el: HTMLDivElement) => {
    if (open) savedTop.current = el.scrollTop;
    const down = el.scrollTop > headerTop(headerRef.current!) - 4;
    setScrolled(down);
    useUi.getState().setExploreScrolled(down);
  };

  const clearSearch = () => {
    setInput('');
    setQ('');
    searchRef.current?.focus({ preventScroll: true });
  };

  const seeAll = (
    <div className="mt-6 flex justify-center sm:mt-8">
      <a
        href={exploreAddress(sort, filter, q)}
        // In place: the address says so, but the browser's back doesn't step through it.
        onClick={onPlainClick(() => {
          setAll(true);
          history.replaceState(history.state, '', exploreAddress(sort, filter, q));
        })}
        className="glass-soft group inline-flex h-11 items-center gap-1 rounded-full pr-4 pl-5 text-[14.5px] font-medium text-ink transition-[background,transform] duration-200 ease-[var(--ease)] hover:bg-[var(--glass-bg)] focus-visible:rounded-full active:scale-[.97]"
      >
        See all worlds
        <Icon name="chevron-right" size={16} className="text-ink-2 transition-transform duration-300 ease-[var(--ease)] group-hover:translate-x-0.5" />
      </a>
    </div>
  );

  return (
    <div
      hidden={hidden}
      inert={!open}
      // The page itself, under the Orb's panel; it fades as a world opens over it.
      className={`fixed inset-0 z-[35] bg-paper transition-opacity ease-[var(--ease)] starting:opacity-0 ${open ? 'opacity-100 duration-[380ms]' : 'pointer-events-none opacity-0 duration-[240ms]'}`}
    >
      <div
        ref={scrollRef}
        onScroll={(e) => onScroll(e.currentTarget)}
        className={`scroll-soft relative h-full overflow-x-hidden overflow-y-auto overscroll-contain transition-[transform] ease-[var(--ease)] starting:scale-[.985] ${open ? 'scale-100 duration-[420ms]' : 'scale-[.985] duration-[240ms]'}`}
      >
        {/* Light: the sky with a soft iris glow, fading into the paper the worlds sit on. Dark: the
            same glow, low, on the deep dark. */}
        <div className="relative isolate">
          <div aria-hidden="true" className="sky absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,#000_55%,transparent)] dark:hidden" />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[360px] opacity-[.22] [background:radial-gradient(60%_100%_at_15%_0%,var(--iris-1),transparent_70%),radial-gradient(50%_90%_at_85%_0%,var(--iris-2),transparent_70%)] dark:opacity-[.12]"
          />
          <HomeHeader building={building} />
          {intro}
        </div>

        {/* At least a screen tall, so the header can stay at the top over a few results. */}
        <section aria-labelledby="orb-explore-title" className="min-h-full">
          <header
            ref={headerRef}
            className={`sticky top-0 z-10 transition-[background-color,box-shadow] duration-300 ease-[var(--ease)] ${scrolled ? 'bg-paper shadow-[0_1px_0_color-mix(in_oklab,var(--ink)_8%,transparent)]' : ''}`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5 px-3 pt-[max(12px,env(safe-area-inset-top))] pb-3 sm:gap-x-3 sm:px-5 lg:flex-nowrap lg:px-6">
              <h2 id="orb-explore-title" className="font-display mr-auto pl-1 text-[30px] leading-none tracking-[-0.015em] text-ink sm:text-[34px] lg:mr-1">
                Explore
              </h2>
              {/* A search looks through all the worlds: no filter shows as picked, and picking one ends it. */}
              <Chips
                value={q ? null : filter}
                onChange={(f) => {
                  setFilter(f);
                  if (input || q) {
                    setInput('');
                    setQ('');
                  }
                  track('explore_filter', { filter: f });
                }}
                className="order-2 basis-full lg:order-none lg:basis-auto"
              />
              <SortToggle
                value={sort}
                onChange={(id) => {
                  setSort(id);
                  track('explore_sort', { sort: id, filter });
                }}
                className="lg:ml-auto"
              />
              {/* Phones: search sits behind an icon until it's wanted, so the worlds get the screen. */}
              {!searchOpen && !input && (
                <IconButton
                  icon="search"
                  label="Search worlds"
                  variant="glass"
                  size={40}
                  className="sm:hidden"
                  onClick={() => {
                    setSearchOpen(true);
                    requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
                  }}
                />
              )}
              <div className={`sm:block sm:w-[min(280px,34vw)] lg:w-[min(320px,24vw)] ${searchOpen || input ? 'order-1 basis-full sm:order-none sm:basis-auto' : 'hidden'}`}>
                <SearchField inputRef={searchRef} value={input} onChange={setInput} onSubmit={() => setQ(input.trim())} onClear={clearSearch} />
              </div>
              {/* The Orb, once the header row above has scrolled away. */}
              <div className={`flex shrink-0 justify-end transition-[width,margin,opacity,visibility] duration-300 ease-[var(--ease)] ${scrolled ? 'w-10' : 'invisible -ml-2 w-0 opacity-0 sm:-ml-3'}`}>
                <OrbButton building={building} />
              </div>
            </div>
          </header>

          <div className="px-3 pt-1 pb-10 sm:px-5 lg:px-6">
            <ResultsGrid
              key={`${filter}|${sort}|${q}`}
              filter={filter}
              sort={sort}
              q={q}
              lead={!q && sort === 'trending'}
              all={all}
              seeAll={seeAll}
              scrollRef={scrollRef}
              onOpen={(id) => {
                track('world_open', { world_id: id, source: 'home', filter: q ? 'all' : filter, sort, q: q || undefined });
                onOpenWorld(id);
              }}
              onRemix={onRemix}
            />
          </div>
        </section>
        <Footer onTop={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })} />
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

function SearchField({
  inputRef,
  value,
  onChange,
  onSubmit,
  onClear,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange(v: string): void;
  onSubmit(): void;
  onClear(): void;
}) {
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
        // Esc clears a search first.
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !value) return;
          e.preventDefault();
          onClear();
        }}
        placeholder="Search worlds…"
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
          onClick={onClear}
          className="absolute right-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--field-bg)] text-ink-2 transition-colors hover:text-ink focus-visible:rounded-full"
        >
          <Icon name="x" size={14} strokeWidth={2.2} />
        </button>
      )}
    </form>
  );
}

function Chips({ value, onChange, className }: { value: FilterId | null; onChange(v: FilterId): void; className: string }) {
  return (
    <div role="tablist" aria-label="Filter worlds" className={`flex flex-wrap gap-1.5 ${className}`}>
      {FILTERS.map((f) => {
        const on = f.id === value;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => on || onChange(f.id)}
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

/** Trending or New, side by side (always in view: no menu to open). */
function SortToggle({ value, onChange, className }: { value: SortId; onChange(v: SortId): void; className: string }) {
  return (
    <div role="group" aria-label="Sort worlds" className={`flex h-9 shrink-0 items-center rounded-full bg-[var(--field-bg)] p-0.5 ${className}`}>
      {SORTS.map((s) => {
        const on = s.id === value;
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={on}
            onClick={() => on || onChange(s.id)}
            className={`h-8 rounded-full px-3 text-[13.5px] font-medium transition-[background,color,box-shadow] duration-200 ease-[var(--ease)] focus-visible:rounded-full ${on ? 'bg-[var(--chip-bg-hover)] text-ink shadow-[0_1px_3px_rgba(12,12,20,.14)]' : 'text-ink-2 hover:text-ink'}`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Results

/**
 * At /, the worlds fill four rows (under the lead, which is two rows tall from md) at every width:
 * 2 columns, 3 from md, 4 from xl, 5 from 1800px. The class that shows tile `i` only where it is in
 * those rows, or null where it never is.
 */
function fourRows(i: number, lead: boolean): string | null {
  const ends = lead ? [9, 9, 13, 17] : [8, 12, 16, 20];
  if (i < ends[0]) return '';
  if (i < ends[1]) return 'hidden md:block';
  if (i < ends[2]) return 'hidden xl:block';
  if (i < ends[3]) return 'hidden min-[112.5rem]:block';
  return null;
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
  filter,
  sort,
  q,
  lead,
  all,
  seeAll,
  scrollRef,
  onOpen,
  onRemix,
}: {
  filter: FilterId;
  sort: SortId;
  q: string;
  /** The first world leads: two columns wide (and two rows tall from md). */
  lead: boolean;
  /** All of them (endless), or four rows and then `seeAll` (a search always shows all it found). */
  all: boolean;
  seeAll: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  onOpen(id: string): void;
  onRemix?(w: WorldCardData): void;
}) {
  const feed = useFeed(q ? { sort, q } : { ...FILTERS.find((f) => f.id === filter)!.query, sort });
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
      // Nothing found: one line, then what's trending.
      <>
        <p className="px-1 pt-1 pb-4 text-[15px] text-ink-2">
          Nothing called <span className="text-ink">“{q}”</span> yet. Here’s what’s trending.
        </p>
        <ResultsGrid filter="all" sort="trending" q="" lead={false} all={all} seeAll={seeAll} scrollRef={scrollRef} onOpen={onOpen} onRemix={onRemix} />
      </>
    ) : (
      <EmptyState icon="sparkle" title="Nothing here yet" body="Be the first to make one." />
    );

  const rows = !all && !q;
  return (
    <div className="pt-1">
      {q && (
        <div className="mb-3 flex items-baseline gap-2 px-1">
          <h3 className="font-display text-[26px] leading-none tracking-[-0.01em] text-ink">
            Results for <span className="italic">“{q}”</span>
          </h3>
          {sort === 'new' && <span className="text-[13.5px] text-ink-2">newest first</span>}
        </div>
      )}
      {/* Tiles fill the width, so a wide screen shows more worlds, not wider margins. */}
      <div className="grid grid-flow-row-dense grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:gap-4 min-[112.5rem]:grid-cols-5">
        {feed.loading ? (
          <Skeletons n={12} lead={lead} />
        ) : (
          feed.items.map((w, i) => {
            const shown = rows ? fourRows(i, lead) : '';
            return shown === null ? null : <ExploreTile key={w.id} world={w} big={lead && i === 0} priority={i < 3} className={shown} onOpen={onOpen} onRemix={onRemix} />;
          })
        )}
        {feed.loadingMore && <Skeletons n={4} />}
      </div>
      {!feed.loading && !rows && <MoreSentinel feed={feed} scrollRef={scrollRef} />}
      {/* Only when there's more than the rows show at some width. */}
      {!feed.loading && rows && (feed.hasMore || fourRows(feed.items.length - 1, lead) !== '') && seeAll}
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
