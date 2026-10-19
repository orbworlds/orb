'use client';
// World cards for Explore / lists, plus the small presentational kit shared by the
// Explore, You, Share, History and Code panels (thumbnails, skeletons, section headers,
// field styling, number/time formatting). Kept in this module so the panels stay
// dependency-free of each other.

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { needsKeyboard } from '@/lib/keyboard';
import { previewVideo, type PreviewVideo } from '@/lib/previews';
import type { WorldCard as WorldCardData } from '@/lib/types';
import { Icon } from '@/components/ui/Icon';

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

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null;

/** "just now", "5 minutes ago", "yesterday", "3 days ago", then "Mar 4" / "Mar 4, 2024". */
export function timeAgo(iso: string | number | Date, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return rtf ? rtf.format(-m, 'minute') : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return rtf ? rtf.format(-h, 'hour') : `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return rtf ? rtf.format(-d, 'day') : `${d} d ago`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
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

/** Shimmering placeholder block. */
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-[orb-shimmer_1.8s_linear_infinite] bg-[length:200%_100%] bg-[linear-gradient(100deg,color-mix(in_oklab,var(--ink)_6%,transparent)_20%,color-mix(in_oklab,var(--ink)_11%,transparent)_40%,color-mix(in_oklab,var(--ink)_6%,transparent)_60%)] ${className}`}
      style={style}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Thumbnails

// Soft, slightly desaturated palettes for worlds without a thumbnail yet.
const PLACEHOLDER_PALETTES: [string, string, string][] = [
  ['#b7a8ff', '#7fd3ff', '#ffd2b8'],
  ['#ffb7d5', '#ffd9a8', '#b9b0ff'],
  ['#9fe6cc', '#8ec9ff', '#e8f3ff'],
  ['#ffc9a6', '#ff9fc4', '#fff0d9'],
  ['#a7b5ff', '#c9a7ff', '#ffd0e6'],
  ['#8fd8ff', '#b5f0d9', '#fff4c9'],
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic gradient for a world id (same world → same colors everywhere). */
export function placeholderBackground(seed: string): string {
  const h = hash(seed || 'orb');
  const [a, b, c] = PLACEHOLDER_PALETTES[h % PLACEHOLDER_PALETTES.length];
  const x = 15 + (h % 50);
  const y = 10 + ((h >> 8) % 40);
  return `radial-gradient(120% 90% at ${x}% ${y}%, ${a} 0%, transparent 60%), radial-gradient(90% 90% at ${100 - x}% 100%, ${b} 0%, transparent 65%), linear-gradient(160deg, ${c}, ${b})`;
}

function ThumbImage({ src, onError }: { src: string; onError(): void }) {
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
      loading="lazy"
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
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  return !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
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
    if (!el || !previewsAllowed() || typeof IntersectionObserver === 'undefined') return;
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
 * World thumbnail: lazy image fading in over a deterministic gradient placeholder (with the
 * world's initial), plus a subtle inner border. Size it with `className` (e.g. aspect-[16/10]).
 * `video`: a looping preview played over the image while the thumbnail is on screen.
 */
export function Thumb({ src, seed, name, className = '', initialSize = 44, video = null }: { src: string | null; seed: string; name: string; className?: string; initialSize?: number; video?: PreviewVideo | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = !!src && failed !== src;
  const initial = (name.trim()[0] || '◦').toUpperCase();
  return (
    <div className={`relative isolate overflow-hidden ${className}`} style={{ background: placeholderBackground(seed) }}>
      <span aria-hidden="true" className="font-display absolute inset-0 flex items-center justify-center text-white/70 select-none" style={{ fontSize: initialSize }}>
        {initial}
      </span>
      {showImage && <ThumbImage key={src} src={src} onError={() => setFailed(src)} />}
      {video && <ThumbVideo key={video.webm} video={video} />}
      <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_rgba(255,255,255,.16),inset_0_0_0_1px_rgba(12,12,20,.07)]" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// World card

/**
 * Explore card: 16:10 thumbnail, name, author and plays/likes — the same for every world, wherever
 * its code lives.
 * The whole card is one button (stretched over the card); "Remix" is a separate quick action.
 */
export function WorldCard({
  world,
  onOpen,
  onRemix,
  size = 'md',
}: {
  world: WorldCardData;
  onOpen(id: string): void;
  onRemix?(world: WorldCardData): void;
  /** 'lg' = featured row card (bigger title, shows the description). */
  size?: 'md' | 'lg';
}) {
  const canRemix = !!onRemix && world.kind === 'native' && world.forkable;
  const lg = size === 'lg';
  const keyboard = needsKeyboard(world);
  const keyboardId = useId();
  return (
    <article className="group relative min-w-0">
      <div className="relative transition-transform duration-300 ease-[var(--ease)] group-hover:-translate-y-1 group-has-[:focus-visible]:-translate-y-1">
        <Thumb
          src={world.thumbUrl}
          seed={world.id}
          name={world.name}
          initialSize={lg ? 64 : 48}
          video={previewVideo(world.id)}
          className="aspect-[16/10] rounded-[var(--r-card)] shadow-[0_1px_2px_rgba(16,16,40,.06),0_8px_24px_-12px_rgba(16,16,40,.28)] transition-shadow duration-300 ease-[var(--ease)] group-hover:shadow-[var(--shadow-lift)]"
        />
        {/* hover play glyph */}
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          <span className="glass flex h-12 w-12 scale-90 items-center justify-center rounded-full text-ink transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-100">
            <Icon name="play" size={18} className="translate-x-[1px]" fill="currentColor" />
          </span>
        </span>
        {keyboard && (
          <span id={keyboardId} className="glass pointer-events-none absolute bottom-2.5 left-2.5 hidden h-8 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-[12.5px] font-medium text-ink phone:flex">
            <Icon name="keyboard" size={15} />
            Needs a keyboard
          </span>
        )}
      </div>

      <div className={`px-0.5 ${lg ? 'mt-3.5' : 'mt-3'}`}>
        <h3 className={`truncate font-medium tracking-[-0.01em] text-ink ${lg ? 'text-[16px]' : 'text-[15px]'}`}>{world.name}</h3>
        {lg && world.description && <p className="mt-0.5 truncate text-[13.5px] text-ink-2">{world.description}</p>}
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-ink-2">
          <span className="truncate">{world.authorName || 'Someone'}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2 text-[12.5px] text-ink-3 tabular-nums">
            <span>
              {formatCount(world.plays)} {world.plays === 1 ? 'play' : 'plays'}
            </span>
            <span className="flex items-center gap-1" aria-label={`${world.likes} likes`}>
              <Icon name="heart" size={12} strokeWidth={2} />
              {formatCount(world.likes)}
            </span>
          </span>
        </div>
      </div>

      {/* Stretched primary action: the whole card opens the world. */}
      <button
        type="button"
        onClick={() => onOpen(world.id)}
        aria-label={`Open ${world.name}`}
        aria-describedby={keyboard ? keyboardId : undefined}
        className="absolute -inset-1.5 z-[1] cursor-pointer rounded-[20px] focus-visible:rounded-[20px] focus-visible:outline-offset-0"
      />

      {canRemix && (
        <button
          type="button"
          onClick={() => onRemix!(world)}
          aria-label={`Remix ${world.name}`}
          className="glass absolute top-2.5 right-2.5 z-[2] flex h-8 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-[12.5px] font-medium text-ink opacity-0 transition-[opacity,transform] duration-200 ease-[var(--ease)] group-hover:opacity-100 hover:scale-[1.03] focus-visible:rounded-full focus-visible:opacity-100 active:scale-[.97] [@media(hover:none)]:opacity-100"
        >
          <Icon name="remix" size={14} />
          Remix
        </button>
      )}
    </article>
  );
}

export function WorldCardSkeleton({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <div aria-hidden="true" className="min-w-0">
      <Skeleton className="aspect-[16/10] rounded-[var(--r-card)]" />
      <Skeleton className={`mt-3.5 h-3.5 rounded-full ${size === 'lg' ? 'w-1/2' : 'w-3/5'}`} />
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
 * Explore's tile: the world edge to edge, playing its preview when it has one. Its name, maker and
 * numbers (plays, likes, and the views of its maker's post) show on hover or keyboard focus; on
 * touch screens, which can't hover, the name and maker stay on the picture. `big` is the feed's lead
 * tile (two columns by two rows on wide screens), which also quotes the prompt it was made with.
 */
export function ExploreTile({
  world,
  onOpen,
  onRemix,
  big = false,
  className = '',
}: {
  world: WorldCardData;
  onOpen(id: string): void;
  onRemix?(world: WorldCardData): void;
  big?: boolean;
  className?: string;
}) {
  const canRemix = !!onRemix && world.kind === 'native' && world.forkable;
  const keyboard = needsKeyboard(world);
  const keyboardId = useId();
  const origin = world.origin ?? null;
  const views = origin?.views ?? null;
  const prompt = origin?.prompt ?? null;
  const author = world.authorName || 'Someone';
  return (
    <article
      className={`group/tile relative isolate min-w-0 overflow-hidden rounded-[18px] bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] shadow-[0_1px_2px_rgba(16,16,40,.08),0_10px_30px_-14px_rgba(16,16,40,.35)] transition-[transform,box-shadow] duration-300 ease-[var(--ease)] hover:shadow-[var(--shadow-lift)] has-[:focus-visible]:shadow-[var(--shadow-lift)] ${big ? 'aspect-[16/10] xl:aspect-auto' : 'aspect-[16/10]'} ${className}`}
    >
      <div className="absolute inset-0 transition-transform duration-[900ms] ease-[var(--ease)] group-hover/tile:scale-[1.035]">
        <Thumb src={world.thumbUrl} seed={world.id} name={world.name} initialSize={big ? 96 : 56} video={previewVideo(world.id)} className="h-full w-full" />
      </div>

      {/* Hover: the world's card. Touch: its name and maker only. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[75%] bg-[linear-gradient(to_top,rgba(8,8,16,.82),rgba(8,8,16,.38)_45%,transparent)] opacity-0 transition-opacity duration-300 ease-[var(--ease)] group-hover/tile:opacity-100 group-has-[:focus-visible]/tile:opacity-100 phone:h-[50%] phone:opacity-100 phone:bg-[linear-gradient(to_top,rgba(8,8,16,.66),transparent)]"
      />
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 text-white transition-[opacity,transform] duration-300 ease-[var(--ease)] ${big ? 'p-5 sm:p-7' : 'p-4'} translate-y-2 opacity-0 group-hover/tile:translate-y-0 group-hover/tile:opacity-100 group-has-[:focus-visible]/tile:translate-y-0 group-has-[:focus-visible]/tile:opacity-100 phone:translate-y-0 phone:opacity-100`}
      >
        <h3 className={`truncate font-semibold tracking-[-0.015em] [text-shadow:0_1px_12px_rgba(0,0,0,.35)] ${big ? 'font-display text-[34px] leading-[1.05] font-normal sm:text-[46px]' : 'text-[16px] leading-tight'}`}>{world.name}</h3>
        <p className={`mt-1 truncate text-white/80 ${big ? 'text-[15px]' : 'text-[13px]'}`}>
          by <span className="text-white">{author}</span>
          {origin?.handle && origin.handle.replace(/^@/, '').toLowerCase() !== author.toLowerCase() && <span className="text-white/60"> · {origin.handle}</span>}
        </p>
        {big && prompt && <p className="mt-3 line-clamp-2 max-w-[60ch] text-[14px] leading-snug text-white/85 italic phone:hidden">“{prompt}”</p>}
        {big && !prompt && world.description && <p className="mt-3 line-clamp-2 max-w-[60ch] text-[14px] leading-snug text-white/85 phone:hidden">{world.description}</p>}
        {!big && <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-white/75 phone:hidden">{prompt ? <span className="italic">“{prompt}”</span> : world.description}</p>}
        <div className={`mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-white/85 tabular-nums phone:hidden ${big ? 'text-[13.5px]' : 'text-[12.5px]'}`}>
          {world.plays > 0 && (
            <span className="flex items-center gap-1" title="Plays on Orb">
              <Icon name="play" size={11} fill="currentColor" strokeWidth={0} />
              {formatCount(world.plays)} {world.plays === 1 ? 'play' : 'plays'}
            </span>
          )}
          {world.likes > 0 && (
            <span className="flex items-center gap-1" title="Likes on Orb">
              <Icon name="heart" size={12} strokeWidth={2.2} />
              {formatCount(world.likes)}
            </span>
          )}
          {views != null && views > 0 && (
            <span className="flex items-center gap-1" title={`Views of the maker’s post${platformName(origin?.platform) ? ` on ${platformName(origin?.platform)}` : ''}`}>
              <Icon name="eye" size={13} strokeWidth={2} />
              {formatCount(views)} views
              {origin?.platform && <span className="text-white/60">on {platformName(origin.platform)}</span>}
            </span>
          )}
          {world.forks > 0 && (
            <span className="flex items-center gap-1" title="Remixes">
              <Icon name="remix" size={12} strokeWidth={2} />
              {formatCount(world.forks)}
            </span>
          )}
        </div>
      </div>

      {keyboard && (
        <span id={keyboardId} className="glass pointer-events-none absolute top-2.5 left-2.5 hidden h-8 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-[12.5px] font-medium text-ink phone:flex">
          <Icon name="keyboard" size={15} />
          Needs a keyboard
        </span>
      )}

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

      {/* The whole tile opens the world. */}
      <button
        type="button"
        onClick={() => onOpen(world.id)}
        aria-label={`Play ${world.name}, by ${author}`}
        aria-describedby={keyboard ? keyboardId : undefined}
        className="absolute inset-0 z-[1] cursor-pointer rounded-[18px] focus-visible:rounded-[18px] focus-visible:outline-offset-[-3px]"
      />

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
  return <Skeleton className={`rounded-[18px] ${big ? 'aspect-[16/10] xl:col-span-2 xl:row-span-2 xl:aspect-auto' : 'aspect-[16/10]'}`} />;
}
