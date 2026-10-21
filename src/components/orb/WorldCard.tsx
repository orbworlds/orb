'use client';
// World cards for Explore / lists, plus the small presentational kit shared by the Orb's panels
// and sheets (thumbnails, skeletons, section headers, field styling, number/time formatting). Kept
// in this module so the panels stay dependency-free of each other.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';
import { worldHref } from '@/lib/api';
import { previewVideo, type PreviewVideo } from '@/lib/previews';
import type { WorldCard as WorldCardData } from '@/lib/types';
import { Icon, type IconName } from '@/components/ui/Icon';

// ---------------------------------------------------------------------------------------------
// Formatting

/** 950 → "950", 1234 → "1.2k", 48_200 → "48k", 2_400_000 → "2.4M". Rounds down so 999_999 ≠ "1000k". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.floor(n));
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [v, s] of units) {
    if (n >= v) {
      const x = n / v;
      const r = x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x);
      return `${r}${s}`;
    }
  }
  return String(n);
}

/** "1 play", "950 plays", "1.2k plays". */
export const playsLabel = (n: number) => `${formatCount(n)} ${n === 1 ? 'play' : 'plays'}`;

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday", "3 days ago", then "Mar 4" / "Mar 4, 2024". */
export function timeAgo(iso: string | number | Date): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return rtf.format(-m, 'minute');
  const h = Math.round(m / 60);
  if (h < 24) return rtf.format(-h, 'hour');
  const d = Math.round(h / 24);
  if (d < 7) return rtf.format(-d, 'day');
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

// ---------------------------------------------------------------------------------------------
// Hydration-safe client values

const noopSubscribe = () => () => {};
/** False during SSR and hydration, true afterwards — gate reads of localStorage / window on it. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * A link's click handler: a plain click opens it here, in place (`open`); with a modifier key or
 * another button the browser does what it does with links (a new tab, a new window…).
 */
export function onPlainClick(open: () => void) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open();
  };
}

// ---------------------------------------------------------------------------------------------
// Shared styling

/** Text field styling shared by the panels (pairs with globals.css tokens). */
export const fieldClass =
  'h-10 w-full min-w-0 rounded-[var(--r-field)] bg-[var(--field-bg)] px-3.5 text-[14px] text-ink placeholder:text-ink-3 outline-none transition-[background,box-shadow] duration-200 ease-[var(--ease)] focus:bg-[var(--field-bg-focus)] focus:shadow-[0_0_0_1px_var(--ink-4),0_0_0_4px_color-mix(in_oklab,var(--iris-1)_22%,transparent)] focus-visible:outline-none disabled:opacity-50';

/** Quiet grouped surface used for settings rows and list groups inside glass panels. */
export const groupClass = 'rounded-[18px] bg-[color-mix(in_oklab,var(--ink)_4%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_6%,transparent)]';

export function SectionHeader({ title, hint, accessory, id }: { title: ReactNode; hint?: ReactNode; accessory?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3 px-1">
      <div className="min-w-0">
        <h3 id={id} className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
          {title}
        </h3>
        {hint && <p className="mt-0.5 text-[13px] leading-snug text-ink-2">{hint}</p>}
      </div>
      {accessory}
    </div>
  );
}

/** A quiet note where a list has nothing in it yet. */
export function EmptyNote({ icon, title, text, children }: { icon: IconName; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="rounded-[18px] px-5 py-6 text-center shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_10%,transparent)] [background:color-mix(in_oklab,var(--ink)_2%,transparent)]">
      <span className="mx-auto mb-2.5 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--field-bg)] text-ink-2">
        <Icon name={icon} size={18} />
      </span>
      <p className="text-[14px] font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-[280px] text-[13px] leading-snug text-ink-2">{text}</p>
      {children}
    </div>
  );
}

/** Shimmering placeholder block. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-[orb-shimmer_1.8s_linear_infinite] bg-[length:200%_100%] bg-[linear-gradient(100deg,color-mix(in_oklab,var(--ink)_6%,transparent)_20%,color-mix(in_oklab,var(--ink)_11%,transparent)_40%,color-mix(in_oklab,var(--ink)_6%,transparent)_60%)] ${className}`}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Thumbnails

// Soft, slightly desaturated palettes for worlds without a picture.
const PLACEHOLDER_PALETTES: [string, string, string][] = [
  ['#b7a8ff', '#7fd3ff', '#ffd2b8'],
  ['#ffb7d5', '#ffd9a8', '#b9b0ff'],
  ['#9fe6cc', '#8ec9ff', '#e8f3ff'],
  ['#ffc9a6', '#ff9fc4', '#fff0d9'],
  ['#a7b5ff', '#c9a7ff', '#ffd0e6'],
  ['#8fd8ff', '#b5f0d9', '#fff4c9'],
];

/** FNV-1a: the same number for the same string, everywhere (colors and gradients by id). */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic gradient for a world id (same world → same colors everywhere). */
function placeholderBackground(seed: string): string {
  const h = hash(seed || 'orb');
  const [a, b, c] = PLACEHOLDER_PALETTES[h % PLACEHOLDER_PALETTES.length];
  const x = 15 + (h % 50);
  const y = 10 + ((h >> 8) % 40);
  return `radial-gradient(120% 90% at ${x}% ${y}%, ${a} 0%, transparent 60%), radial-gradient(90% 90% at ${100 - x}% 100%, ${b} 0%, transparent 65%), linear-gradient(160deg, ${c}, ${b})`;
}

function ThumbImage({ src, priority, onError }: { src: string; priority: boolean; onError(): void }) {
  const [loaded, setLoaded] = useState(false);
  // Images served from cache can finish before React attaches onLoad; check on attach.
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, []);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- thumbnails are API routes / external URLs with immutable caching
    <img
      ref={ref}
      src={src}
      alt=""
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : undefined}
      decoding="async"
      draggable={false}
      onLoad={() => setLoaded(true)}
      onError={onError}
      className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ease-[var(--ease)] ${loaded ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}

/** Whether looping previews may play: not when the person asked for less motion or to save data. */
function previewsAllowed(): boolean {
  return !matchMedia('(prefers-reduced-motion: reduce)').matches && !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
}

/**
 * A world's looping preview over its thumbnail: muted, loaded only once the card scrolls into view,
 * playing while it's on screen and paused when it isn't. It fades in once frames are coming, so the
 * still image shows until then (and stays, if the video can't play).
 */
function ThumbVideo({ video }: { video: PreviewVideo }) {
  const ref = useRef<HTMLVideoElement>(null);
  const shown = useRef(false);
  const [near, setNear] = useState(false);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !previewsAllowed()) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) setNear(true);
        shown.current = e.intersectionRatio >= 0.4;
        if (shown.current) el.play().catch(() => {});
        else el.pause();
      },
      { threshold: [0, 0.4] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // the sources are only added once the card comes near, so load them then
  useEffect(() => {
    const el = ref.current;
    if (!near || !el) return;
    el.load();
    if (shown.current) el.play().catch(() => {});
  }, [near]);
  return (
    <video
      ref={ref}
      muted
      loop
      playsInline
      disablePictureInPicture
      preload="none"
      aria-hidden="true"
      tabIndex={-1}
      onPlaying={() => setPlaying(true)}
      className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ease-[var(--ease)] ${playing ? 'opacity-100' : 'opacity-0'}`}
    >
      {near && <source src={video.webm} type="video/webm" />}
      {near && <source src={video.mp4} type="video/mp4" />}
    </video>
  );
}

/**
 * World thumbnail: a lazy image fading in over a quiet tint, plus a subtle inner border. A world
 * without a picture (or whose picture fails) shows a gradient of its own with its initial instead.
 * Size it with `className` (e.g. aspect-[16/10]). `video`: a looping preview played over the image
 * while the thumbnail is on screen. `priority`: on the first screen, so it loads first.
 */
export function Thumb({
  src,
  seed,
  name,
  className,
  initialSize,
  video = null,
  priority = false,
}: {
  src: string | null;
  seed: string;
  name: string;
  className: string;
  initialSize: number;
  video?: PreviewVideo | null;
  priority?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = !!src && failed !== src;
  return (
    <div
      className={`relative isolate overflow-hidden ${showImage ? 'bg-[color-mix(in_oklab,var(--ink)_6%,transparent)]' : ''} ${className}`}
      style={showImage ? undefined : { background: placeholderBackground(seed) }}
    >
      {showImage ? (
        <ThumbImage key={src} src={src} priority={priority} onError={() => setFailed(src)} />
      ) : (
        <span aria-hidden="true" className="font-display absolute inset-0 flex items-center justify-center text-white/70 select-none" style={{ fontSize: initialSize }}>
          {(name.trim()[0] || '◦').toUpperCase()}
        </span>
      )}
      {video && <ThumbVideo key={video.webm} video={video} />}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_rgba(255,255,255,.16),inset_0_0_0_1px_rgba(12,12,20,.07)]" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// World card

/**
 * The card for profile and remix lists: 16:10 thumbnail, name, author and plays/likes — the same
 * for every world, wherever its code lives. The whole card is a link to the world.
 */
export function WorldCard({ world, onOpen }: { world: WorldCardData; onOpen(id: string): void }) {
  return (
    <article className="group relative min-w-0">
      <div className="relative transition-transform duration-300 ease-[var(--ease)] group-hover:-translate-y-1 group-has-[:focus-visible]:-translate-y-1">
        <Thumb
          src={world.thumbUrl}
          seed={world.id}
          name={world.name}
          initialSize={48}
          video={previewVideo(world.id)}
          className="aspect-[16/10] rounded-[var(--r-card)] shadow-[0_1px_2px_rgba(16,16,40,.06),0_8px_24px_-12px_rgba(16,16,40,.28)] transition-shadow duration-300 ease-[var(--ease)] group-hover:shadow-[var(--shadow-lift)]"
        />
        {/* hover play glyph */}
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          <span className="glass flex h-12 w-12 scale-90 items-center justify-center rounded-full text-ink transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-100">
            <Icon name="play" size={18} className="translate-x-[1px]" fill="currentColor" />
          </span>
        </span>
      </div>

      <div className="mt-3 px-0.5">
        <h3 className="truncate text-[15px] font-medium tracking-[-0.01em] text-ink">{world.name}</h3>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-ink-2">
          <span className="truncate">{world.authorName || 'Someone'}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2 text-[12.5px] text-ink-3 tabular-nums">
            <span>{playsLabel(world.plays)}</span>
            <span className="flex items-center gap-1" aria-label={`${world.likes} likes`}>
              <Icon name="heart" size={12} strokeWidth={2} />
              {formatCount(world.likes)}
            </span>
          </span>
        </div>
      </div>

      {/* Stretched over the card: the whole card opens the world. */}
      <a
        href={worldHref(world)}
        onClick={onPlainClick(() => onOpen(world.id))}
        aria-label={`Open ${world.name}`}
        className="absolute -inset-1.5 z-[1] rounded-[20px] focus-visible:rounded-[20px] focus-visible:outline-offset-0"
      />
    </article>
  );
}

export function WorldCardSkeleton() {
  return (
    <div aria-hidden="true" className="min-w-0">
      <Skeleton className="aspect-[16/10] rounded-[var(--r-card)]" />
      <Skeleton className="mt-3.5 h-3.5 w-3/5 rounded-full" />
      <Skeleton className="mt-2 h-3 w-2/5 rounded-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Explore tile

const PLATFORM: Record<string, string> = { x: 'X', hn: 'Hacker News', reddit: 'Reddit', youtube: 'YouTube', github: 'GitHub', blog: 'their site' };

/** "on X", "on Hacker News"… for a curated world's post. */
export function platformName(platform: string | null | undefined): string | null {
  if (!platform) return null;
  return PLATFORM[platform] ?? platform;
}

/**
 * Explore's tile: the world edge to edge, playing its preview when it has one, its name and maker
 * on it. Hovered (or focused), it also says what the world is and how many played it. The tile is a
 * link to the world. `big`: the feed's lead tile, two columns wide (and two rows tall from md).
 */
export function ExploreTile({
  world,
  onOpen,
  onRemix,
  big = false,
  priority = false,
  className = '',
}: {
  world: WorldCardData;
  onOpen(id: string): void;
  onRemix?(world: WorldCardData): void;
  big?: boolean;
  /** On the first screen: its picture loads first. */
  priority?: boolean;
  className?: string;
}) {
  const canRemix = !!onRemix && world.kind === 'native' && world.forkable;
  const author = world.authorName || 'Someone';
  const about = [world.plays > 0 && playsLabel(world.plays), world.description].filter(Boolean).join(' · ');
  return (
    <article
      className={`group/tile relative isolate aspect-[16/10] min-w-0 overflow-hidden rounded-[18px] bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] shadow-[0_1px_2px_rgba(16,16,40,.08),0_10px_30px_-14px_rgba(16,16,40,.35)] transition-[transform,box-shadow] duration-300 ease-[var(--ease)] hover:shadow-[var(--shadow-lift)] has-[a:focus-visible]:shadow-[var(--shadow-lift)] has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-[var(--ink)] ${big ? 'col-span-2 md:row-span-2 md:aspect-auto' : ''} ${className}`}
    >
      <div className="absolute inset-0 transition-transform duration-[900ms] ease-[var(--ease)] group-hover/tile:scale-[1.035]">
        <Thumb src={world.thumbUrl} seed={world.id} name={world.name} initialSize={big ? 96 : 56} video={previewVideo(world.id)} priority={priority} className="h-full w-full" />
      </div>

      {/* Its name and maker, always; hovered, what it is. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-[60%] bg-[linear-gradient(to_top,rgba(8,8,16,.72),rgba(8,8,16,.3)_50%,transparent)]" />
      <div className={`pointer-events-none absolute inset-x-0 bottom-0 text-white [text-shadow:0_1px_10px_rgba(0,0,0,.3)] ${big ? 'p-3.5 sm:p-4 md:p-6' : 'p-3 sm:p-4'}`}>
        <h3 className={`truncate leading-tight font-semibold tracking-[-0.01em] ${big ? 'text-[15px] md:text-[24px]' : 'text-[14px] sm:text-[15px]'}`}>
          {world.name} <span className={`font-normal text-white/75 ${big ? 'text-[12.5px] sm:text-[13px] md:text-[15px]' : 'text-[12px] sm:text-[13px]'}`}>by {author}</span>
        </h3>
        {about && (
          <div className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-300 ease-[var(--ease)] group-hover/tile:grid-rows-[1fr] group-has-[:focus-visible]/tile:grid-rows-[1fr] phone:hidden">
            <p className="min-h-0 overflow-hidden">
              <span className={`block truncate pt-1 text-white/80 ${big ? 'text-[13px] md:text-[14px]' : 'text-[12.5px]'}`}>{about}</span>
            </p>
          </div>
        )}
      </div>

      {/* People in it right now: always shown (it's an invitation), out of Remix's way on hover. */}
      {!!world.live && (
        <span className={`pointer-events-none absolute top-2.5 right-2.5 z-[2] flex h-7 items-center gap-1.5 rounded-full bg-[rgba(8,8,16,.55)] pr-2.5 pl-2 text-[12px] font-medium text-white backdrop-blur-md transition-opacity duration-200 ${canRemix ? 'group-hover/tile:opacity-0' : ''}`}>
          <span aria-hidden="true" className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4ade80] opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#4ade80]" />
          </span>
          {world.live} playing
        </span>
      )}

      {/* Just made (a person's world, its first days): a nudge to be among its first players. */}
      {!world.live && world.fresh && (
        <span className={`pointer-events-none absolute top-2.5 right-2.5 z-[2] flex h-7 items-center rounded-full bg-[rgba(8,8,16,.55)] px-2.5 text-[12px] font-medium text-white backdrop-blur-md transition-opacity duration-200 ${canRemix ? 'group-hover/tile:opacity-0' : ''}`}>
          New
        </span>
      )}

      {/* The whole tile is a link to the world (focused, the tile wears the ring: it clips the link's). */}
      <a href={worldHref(world)} onClick={onPlainClick(() => onOpen(world.id))} aria-label={`Play ${world.name}, by ${author}`} className="absolute inset-0 z-[1] rounded-[18px]" />

      {canRemix && (
        <button
          type="button"
          onClick={() => onRemix!(world)}
          aria-label={`Remix ${world.name}`}
          className="glass absolute top-2.5 right-2.5 z-[2] flex h-8 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-[12.5px] font-medium text-ink opacity-0 transition-[opacity,transform] duration-200 ease-[var(--ease)] group-hover/tile:opacity-100 hover:scale-[1.03] focus-visible:rounded-full focus-visible:opacity-100 active:scale-[.97] phone:hidden"
        >
          <Icon name="remix" size={14} />
          Remix
        </button>
      )}
    </article>
  );
}

export function ExploreTileSkeleton({ big = false }: { big?: boolean }) {
  return <Skeleton className={`aspect-[16/10] rounded-[18px] ${big ? 'col-span-2 md:row-span-2 md:aspect-auto' : ''}`} />;
}
