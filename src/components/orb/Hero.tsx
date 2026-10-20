'use client';
// The home page's invitation to make a world, at the top of Explore (the home page is Explore:
// worlds to get inspired by, right under a composer to make your own).
import { useUi } from '@/state/ui';
import { OrbSphere } from './Orb';
import { Composer } from './Composer';
import { TemplatePicker } from './TemplatePicker';
import { WorldStrip } from './WorldStrip';

// Short enough to fit a phone's composer.
const IDEAS = [
  'a castle on a cloud with dragons',
  'a race on rainbow roads',
  'an underwater city of jellyfish',
  'a cozy cabin on a snowy night',
  'a garden where flowers sing',
  'a tiny planet to walk around',
];

export const HERO_COMPOSER_ID = 'orb-hero-composer';

/**
 * The top of the home page, above Explore's worlds: a serif headline, the big frosted composer
 * (typing out ideas) with starter templates, and (for people who have some) their own and their
 * friends' worlds. Scrolls away into the worlds below.
 */
export function HomeIntro({
  onSend,
  onPickTemplate,
  onRemix,
  onExplore,
  onOpenWorld,
  onOpenMine,
}: {
  onSend(text: string): void;
  onPickTemplate(id: string): void;
  /** Remix a world, or (no id) see all there is to remix. */
  onRemix(id?: string): void;
  onExplore(): void;
  onOpenWorld(id: string): void;
  /** All of this person's worlds (the You tab). */
  onOpenMine(): void;
}) {
  const { draft, setDraft } = useUi();
  return (
    <section aria-label="Make a world" className="relative px-4 pt-[max(40px,calc(env(safe-area-inset-top)+28px))] pb-8 sm:px-6 sm:pt-[9vh] sm:pb-12">
      <div className="mx-auto w-full max-w-[760px]">
        <p className="animate-rise font-display mb-3 flex items-center justify-center gap-2 text-[22px] leading-none text-ink sm:mb-4 sm:text-[26px]">
          <OrbSphere size={26} glow={false} /> Orb
        </p>
        <h1 className="font-display animate-rise text-center text-[40px] leading-[1.02] tracking-[-0.015em] text-ink sm:text-[64px]">
          Step into a <em className="italic">world</em>
        </h1>
        <p className="animate-rise mx-auto mt-2 max-w-[460px] text-center text-balance text-[15px] leading-snug text-ink-2 [animation-delay:60ms] sm:mt-3 sm:max-w-[600px] sm:text-[17px]">
          Describe a game or a world and Orb’s AI builds it in moments. Or play and remix one below.
        </p>
        <div className="mx-auto mt-6 w-full max-w-[680px] sm:mt-8">
          <div className="animate-rise [animation-delay:120ms]">
            <Composer variant="hero" id={HERO_COMPOSER_ID} value={draft} onChange={setDraft} onSend={onSend} placeholder="Describe a world to make…" ideas={IDEAS} autoFocus />
          </div>
        </div>
        {/* A little wider than the headline column, so the row fits one line on a laptop. */}
        <div className="mt-2.5 sm:-mx-16 sm:mt-3.5">
          <TemplatePicker onPick={onPickTemplate} onRemix={onRemix} onMore={() => onRemix()} />
        </div>
        <WorldStrip personal className="animate-rise mt-8 [animation-delay:160ms]" onOpenWorld={onOpenWorld} onExplore={onExplore} onOpenMine={onOpenMine} />
      </div>
    </section>
  );
}
