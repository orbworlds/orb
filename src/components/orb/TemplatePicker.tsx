'use client';
// Worlds to start from, as small chips under the hero composer: the most played worlds one can
// remix, then two starter templates, then all there is to remix (Explore's Remix filter). A round
// thumbnail (graceful gradient fallback) and the name. One scrolling row on phones, wrapped and
// centered on larger screens.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { readJSON, writeJSON } from '@/lib/local';
import { templateCard, TEMPLATES } from '@/lib/templates';
import { Icon } from '@/components/ui/Icon';

/** Hand-tuned fallbacks that hint at each world when its thumbnail is missing. */
const FALLBACK: Record<string, string> = {
  island: 'linear-gradient(160deg, #8fd8ff 0%, #bfeaff 45%, #ffe7b8 62%, #8fd49a 100%)',
  blocks: 'linear-gradient(160deg, #a9c8ff 0%, #d7e6ff 48%, #9edc8c 52%, #6fbf73 100%)',
  runner: 'linear-gradient(160deg, #3b2a73 0%, #8b5fd6 50%, #ff9ec7 100%)',
  paint: 'radial-gradient(circle at 30% 30%, #ff8fc8 0%, transparent 40%), radial-gradient(circle at 70% 65%, #5ec8ff 0%, transparent 45%), #1a1838',
  room: 'linear-gradient(160deg, #ffd6b8 0%, #ffc2a8 45%, #e8a7c8 100%)',
};

const CHIP =
  'group glass-soft animate-fade-up flex h-9 shrink-0 items-center gap-2 rounded-full py-1 pr-3.5 pl-1 text-[13px] font-medium text-ink transition-[transform,background,box-shadow] duration-300 ease-[var(--ease)] hover:-translate-y-0.5 hover:bg-[var(--glass-bg)] hover:shadow-[inset_0_0_0_1px_var(--glass-hairline),0_0_0_1px_var(--glass-edge),var(--shadow-lift)] focus-visible:rounded-full active:scale-[.97]';

/** How many of the most played remixable worlds lead the row, and how many templates follow (one line on a laptop). */
const REMIXES = 4;
const STARTERS = ['runner', 'paint'];
const REMIX_KEY = 'orb:home-remixes';

interface RemixChip {
  id: string;
  name: string;
  thumbUrl: string | null;
}

export function TemplatePicker({
  onPick,
  onRemix,
  onMore,
  className = '',
}: {
  onPick(id: string): void;
  /** Remix this world (a new world of one's own, starting as its copy). */
  onRemix(id: string): void;
  /** Everything there is to remix. */
  onMore(): void;
  className?: string;
}) {
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  // Shown from the last visit's copy right away (none on the very first), refreshed from Explore.
  const [remixes, setRemixes] = useState<RemixChip[]>([]);
  useEffect(() => {
    const cached = readJSON<RemixChip[] | null>(REMIX_KEY, null);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- local copy read after hydration
    if (Array.isArray(cached)) setRemixes(cached.slice(0, REMIXES));
    let live = true;
    api
      .listWorlds({ remixable: true, sort: 'played', limit: REMIXES })
      .then(({ worlds }) => {
        const next = worlds.slice(0, REMIXES).map((w) => ({ id: w.id, name: w.name, thumbUrl: w.thumbUrl }));
        if (!live || !next.length) return;
        setRemixes(next);
        writeJSON(REMIX_KEY, next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const items = TEMPLATES.filter((t) => STARTERS.includes(t.id));
  const thumb = (key: string, src: string | null, fallback: string) => (
    <span className="relative block h-7 w-7 shrink-0 overflow-hidden rounded-full" style={{ background: fallback }}>
      {src && !broken[key] && (
        // eslint-disable-next-line @next/next/no-img-element -- small round thumbnails; a missing one falls back to the gradient
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken((b) => ({ ...b, [key]: true }))} className="absolute inset-0 h-full w-full object-cover" />
      )}
      <span className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,.22)]" />
    </span>
  );
  return (
    <div className={`scroll-none -mx-4 flex items-center gap-2 overflow-x-auto px-4 pt-1 pb-1.5 sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0 ${className}`} role="group" aria-label="Remix a world">
      <span aria-hidden="true" className="text-halo shrink-0 pr-0.5 text-[13px] text-ink-2">
        Or remix
      </span>
      {remixes.map((w, i) => (
        <button key={w.id} type="button" onClick={() => onRemix(w.id)} title={`Make your own ${w.name}`} className={CHIP} style={{ animationDelay: `${260 + i * 35}ms` }}>
          {thumb(w.id, w.thumbUrl, 'var(--iris)')}
          {w.name}
        </button>
      ))}
      {items.map((t, i) => (
        <button key={t.id} type="button" onClick={() => onPick(t.id)} title={t.blurb} className={CHIP} style={{ animationDelay: `${260 + (remixes.length + i) * 35}ms` }}>
          {thumb(t.id, templateCard(t), FALLBACK[t.id] ?? 'var(--iris)')}
          {t.name}
        </button>
      ))}
      <button type="button" onClick={onMore} className={`${CHIP} pl-3.5`} style={{ animationDelay: `${260 + (remixes.length + items.length) * 35}ms` }}>
        <Icon name="remix" size={14} />
        More to remix
      </button>
    </div>
  );
}
