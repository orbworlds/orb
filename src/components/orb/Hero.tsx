'use client';
// The top of the home page, above Explore's worlds (the home page is Explore: worlds to get inspired
// by, right under a composer to make your own): a header row with Orb's name and the Orb, and the
// invitation to make a world.
import { useFriendUnread } from '@/state/friends';
import { useUi } from '@/state/ui';
import { useSession } from './AccountCard';
import { OrbSphere } from './Orb';
import { Composer } from './Composer';
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

const HERO_COMPOSER_ID = 'orb-hero-composer';

/**
 * The Orb, docked in the home page's header (it floats only inside worlds): it opens its panel (under
 * it) on the You tab, or on the chat when a build there has news, and closes it again. It swirls
 * while a build runs.
 */
export function OrbButton({ building, className = '' }: { building: boolean; className?: string }) {
  const news = useUi((s) => s.unread);
  const friendNews = useFriendUnread() > 0;
  const open = useUi((s) => s.panelOpen);
  return (
    <button
      type="button"
      aria-label={open ? 'Close Orb' : news || friendNews ? 'Open Orb (new message)' : 'Open Orb'}
      aria-expanded={open}
      onClick={() => (open ? useUi.getState().closePanel() : useUi.getState().openPanel(news ? 'chat' : 'you'))}
      className={`group relative h-10 w-10 shrink-0 rounded-full focus-visible:rounded-full ${className}`}
    >
      <span className="block transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-[1.06] group-active:scale-95">
        <OrbSphere size={40} building={building} glow={false} />
      </span>
      {(news || friendNews) && <span aria-hidden="true" className="animate-pop absolute top-0 right-0 h-2.5 w-2.5 rounded-full bg-[var(--iris-4)] shadow-[0_0_0_2px_var(--paper)]" />}
    </button>
  );
}

/** The home page's header row: Orb's name, and the Orb (signed out, a quiet "Sign in" before it). */
export function HomeHeader({ building }: { building: boolean }) {
  const guest = useSession((s) => s.meStatus === 'ready' && !s.me?.user);
  return (
    <div className="flex items-center gap-1 px-3 pt-[max(12px,env(safe-area-inset-top))] sm:px-5 lg:px-6">
      <p className="font-display mr-auto flex items-center gap-2 pl-1 text-[24px] leading-none text-ink">
        <OrbSphere size={22} glow={false} /> Orb
      </p>
      {guest && (
        <button type="button" onClick={() => useUi.getState().openPanel('you')} className="h-10 rounded-full px-3 text-[14px] font-medium text-ink-2 transition-colors hover:text-ink">
          Sign in
        </button>
      )}
      <OrbButton building={building} />
    </div>
  );
}

/**
 * The invitation to make a world: a serif headline, the big frosted composer (typing out ideas) and,
 * for people who have some, their own and their friends' worlds. Scrolls away into the worlds below.
 */
export function HomeIntro({
  onSend,
  onOpenWorld,
  onOpenMine,
}: {
  onSend(text: string): void;
  onOpenWorld(id: string): void;
  /** All of this person's worlds (the You tab). */
  onOpenMine(): void;
}) {
  const { draft, setDraft } = useUi();
  return (
    <section aria-label="Make a world" className="relative px-4 pt-7 pb-9 sm:px-6 sm:pt-[7vh] sm:pb-14">
      <div className="mx-auto w-full max-w-[760px]">
        <h1 className="font-display animate-rise text-center text-[40px] leading-[1.02] tracking-[-0.015em] text-ink sm:text-[64px]">
          Step into a <em className="italic">world</em>
        </h1>
        <p className="animate-rise mx-auto mt-2 max-w-[460px] text-center text-balance text-[15px] leading-snug text-ink-2 [animation-delay:60ms] sm:mt-3 sm:max-w-[600px] sm:text-[17px]">
          Describe a world, and Orb’s AI builds it.
        </p>
        <div className="mx-auto mt-6 w-full max-w-[680px] sm:mt-8">
          <div className="animate-rise [animation-delay:120ms]">
            <Composer variant="hero" id={HERO_COMPOSER_ID} value={draft} onChange={setDraft} onSend={onSend} placeholder="Describe a world to make…" ideas={IDEAS} autoFocus />
          </div>
        </div>
        <WorldStrip className="animate-rise mt-9 [animation-delay:160ms]" onOpenWorld={onOpenWorld} onOpenMine={onOpenMine} />
      </div>
    </section>
  );
}
