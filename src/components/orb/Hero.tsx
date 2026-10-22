'use client';
// The top of the home page, above Explore's worlds (the home page is Explore: worlds to get inspired
// by, right under a composer to make your own): a header row with Orb's name and the Orb, and the
// invitation to make a world.
import { useFriendUnread } from '@/state/friends';
import { useUi } from '@/state/ui';
import { requestSignIn, useSession } from './AccountCard';
import { OrbSphere } from './Orb';
import { Composer } from './Composer';
import { Thumb } from './WorldCard';
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

/** Three of Orb's own worlds to start from, each a different kind: a game to build in, a toy, a tiny game. */
const REMIXES = [
  { id: 'orb-craft', name: 'Orbcraft', thumb: '/templates/craft.webp' },
  { id: 'orb-paint', name: 'Glow Paint', thumb: '/templates/paint.webp' },
  { id: 'orb-runner', name: 'Star Runner', thumb: '/templates/runner.webp' },
];

/**
 * The Orb, docked in the home page's header (it floats only inside worlds): it opens its panel (under
 * it) on the chat ("What should we make?"), or on You when the news is only a friend's (as the
 * floating Orb does), and closes it again. It swirls while a build runs.
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
      onClick={() => (open ? useUi.getState().closePanel() : useUi.getState().openPanel(!news && friendNews ? 'you' : 'chat'))}
      className={`group relative h-10 w-10 shrink-0 rounded-full focus-visible:rounded-full ${className}`}
    >
      <span className="block transition-transform duration-300 ease-[var(--ease-spring)] group-hover:scale-[1.06] group-active:scale-95">
        <OrbSphere size={40} building={building} glow={false} />
      </span>
      {(news || friendNews) && <span aria-hidden="true" className="animate-pop absolute top-0 right-0 h-2.5 w-2.5 rounded-full bg-[var(--iris-4)] shadow-[0_0_0_2px_var(--paper)]" />}
    </button>
  );
}

/** The home page's header row: Orb's name, and the Orb (signed out, a quiet "Sign in" to the sign-in form before it). */
export function HomeHeader({ building }: { building: boolean }) {
  const guest = useSession((s) => s.meStatus === 'ready' && !s.me?.user);
  return (
    <div className="flex items-center gap-1 px-3 pt-[max(12px,env(safe-area-inset-top))] sm:px-5 lg:px-6">
      <p className="font-display mr-auto flex items-center gap-2 pl-1 text-[24px] leading-none text-ink">
        <OrbSphere size={22} glow={false} /> Orb
      </p>
      {guest && (
        <button type="button" onClick={requestSignIn} className="h-10 rounded-full px-3 text-[14px] font-medium text-ink-2 transition-colors hover:text-ink">
          Sign in
        </button>
      )}
      <OrbButton building={building} />
    </div>
  );
}

/**
 * The invitation to make a world: a serif headline, the big frosted composer (typing out ideas), a
 * few of Orb's worlds to remix instead and, for people who have some, their own and their friends'
 * worlds. Scrolls away into the worlds below.
 */
export function HomeIntro({
  onSend,
  onRemix,
  onOpenWorld,
  onOpenMine,
}: {
  onSend(text: string): void;
  /** Remix this world (as a tile's Remix does): the copy opens with its chat. */
  onRemix(id: string): void;
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
          {/* One line from 360px: the label above the chips on phones, before them from sm. */}
          <div role="group" aria-label="Or remix" className="animate-rise mt-3 flex flex-wrap items-center justify-center gap-1 [animation-delay:140ms] sm:mt-3.5 sm:gap-2">
            <span aria-hidden="true" className="basis-full pb-1 text-center text-[13px] text-ink-2 sm:basis-auto sm:pr-1 sm:pb-0">
              Or remix
            </span>
            {REMIXES.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => onRemix(w.id)}
                className="glass-soft flex h-9 items-center gap-1.5 rounded-full pr-2.5 pl-1 text-[12.5px] font-medium text-ink transition-[transform,background] duration-200 ease-[var(--ease)] hover:-translate-y-0.5 hover:bg-[var(--glass-bg)] focus-visible:rounded-full active:scale-[.97] sm:gap-2 sm:pr-3.5 sm:text-[13px]"
              >
                <Thumb src={w.thumb} seed={w.id} name={w.name} initialSize={12} className="h-6 w-6 shrink-0 rounded-full sm:h-7 sm:w-7" />
                {w.name}
              </button>
            ))}
          </div>
        </div>
        <WorldStrip className="animate-rise mt-9 [animation-delay:160ms]" onOpenWorld={onOpenWorld} onOpenMine={onOpenMine} />
      </div>
    </section>
  );
}
