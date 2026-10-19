'use client';
// Starter worlds as small chips under the hero composer: a round thumbnail (graceful gradient
// fallback) and the name. One scrolling row on phones, wrapped and centered on larger screens.
import { useState } from 'react';
import { templateCard, TEMPLATES } from '@/lib/templates';

/** Hand-tuned fallbacks that hint at each world when its thumbnail is missing. */
const FALLBACK: Record<string, string> = {
  island: 'linear-gradient(160deg, #8fd8ff 0%, #bfeaff 45%, #ffe7b8 62%, #8fd49a 100%)',
  blocks: 'linear-gradient(160deg, #a9c8ff 0%, #d7e6ff 48%, #9edc8c 52%, #6fbf73 100%)',
  runner: 'linear-gradient(160deg, #3b2a73 0%, #8b5fd6 50%, #ff9ec7 100%)',
  paint: 'radial-gradient(circle at 30% 30%, #ff8fc8 0%, transparent 40%), radial-gradient(circle at 70% 65%, #5ec8ff 0%, transparent 45%), #1a1838',
  room: 'linear-gradient(160deg, #ffd6b8 0%, #ffc2a8 45%, #e8a7c8 100%)',
};

export function TemplatePicker({ onPick, className = '' }: { onPick(id: string): void; className?: string }) {
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  const items = TEMPLATES.filter((t) => t.id !== 'blank');
  return (
    <div className={`scroll-none -mx-4 flex items-center gap-2 overflow-x-auto px-4 pt-1 pb-1.5 sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0 ${className}`} role="group" aria-label="Start from a template">
      <span aria-hidden="true" className="text-halo shrink-0 pr-0.5 text-[13px] text-ink-2">
        Or start from
      </span>
      {items.map((t, i) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t.id)}
          title={t.blurb}
          className="group glass-soft animate-fade-up flex h-9 shrink-0 items-center gap-2 rounded-full py-1 pr-3.5 pl-1 text-[13px] font-medium text-ink transition-[transform,background,box-shadow] duration-300 ease-[var(--ease)] hover:-translate-y-0.5 hover:bg-[var(--glass-bg)] hover:shadow-[inset_0_0_0_1px_var(--glass-hairline),0_0_0_1px_var(--glass-edge),var(--shadow-lift)] focus-visible:rounded-full active:scale-[.97]"
          style={{ animationDelay: `${260 + i * 35}ms` }}
        >
          <span className="relative block h-7 w-7 shrink-0 overflow-hidden rounded-full" style={{ background: FALLBACK[t.id] ?? 'var(--iris)' }}>
            {!broken[t.id] && (
              // eslint-disable-next-line @next/next/no-img-element -- static template thumbnails; a missing file falls back to the gradient
              <img src={templateCard(t)} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken((b) => ({ ...b, [t.id]: true }))} className="absolute inset-0 h-full w-full object-cover" />
            )}
            <span className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,.22)]" />
          </span>
          {t.name}
        </button>
      ))}
    </div>
  );
}
