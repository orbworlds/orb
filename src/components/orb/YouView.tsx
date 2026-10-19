'use client';
// The Orb panel's "You" tab: profile (inline-editable name), account, plan and credits, friends,
// your worlds, the ones you liked, your blob, and under Advanced your own AI and GitHub. Fills its
// container and scrolls inside it.

import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { getAiConfig, getDisplayName, getPlayerColor, setDisplayName } from '@/lib/local';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { toast } from '@/state/toast';
import { useUi } from '@/state/ui';
import { useWorld } from '@/state/world';
import { AccountCard, useMe, useSession } from './AccountCard';
import { BlobCard } from './BlobCard';
import { FriendsSection } from './FriendsSection';
import { GitHubConnect } from './GitHubConnect';
import { ModelSettings } from './ModelSettings';
import { MyWorlds } from './MyWorlds';
import { PlanCard } from './PlanCard';
import { Skeleton, useHydrated } from './WorldCard';

export function YouView({ onOpenWorld, onNewWorld }: { onOpenWorld(id: string): void; onNewWorld?(): void }) {
  return (
    <div className="scroll-soft h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain">
      <div className="flex flex-col gap-8 px-4 pt-4 pb-6 sm:px-5">
        <div className="flex flex-col gap-4">
          <ProfileHeader />
          <AccountCard />
        </div>
        <PlanCard />
        <FriendsSection />
        <MyWorlds onOpenWorld={onOpenWorld} onNewWorld={onNewWorld} />
        <MyWorlds onOpenWorld={onOpenWorld} liked />
        <BlobCard />
        <Advanced />
        <Footer />
      </div>
    </div>
  );
}

function ProfileHeader() {
  const hydrated = useHydrated();
  const { me, signedIn } = useMe();
  const setMe = useSession((s) => s.setMe);
  const playerColor = useWorld((s) => s.me?.color);
  // Name edited in this session (shown immediately, before the server answers).
  const [override, setOverride] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const committing = useRef(false);

  if (!hydrated) {
    return (
      <div className="flex items-center gap-3.5 px-1">
        <Skeleton className="h-14 w-14 shrink-0 rounded-full" />
        <div className="flex-1">
          <Skeleton className="h-5 w-1/2 rounded-full" />
          <Skeleton className="mt-2 h-3 w-1/3 rounded-full" />
        </div>
      </div>
    );
  }

  const name = override ?? (signedIn ? me!.user!.name : me?.name || getDisplayName());
  const color = playerColor ?? getPlayerColor();

  const start = () => {
    setDraft(name);
    setEditing(true);
  };

  const commit = async () => {
    if (committing.current) return;
    const next = draft.trim().replace(/\s+/g, ' ').slice(0, 40);
    setEditing(false);
    if (!next || next === name) return;
    committing.current = true;
    setOverride(next);
    setDisplayName(next);
    try {
      setMe(await api.updateMe(next));
    } catch {
      toast('Couldn’t save your name to Orb — it’s saved on this device.', 'error');
    } finally {
      committing.current = false;
    }
  };

  return (
    <div className="flex items-center gap-3.5 px-1">
      <Avatar name={name} color={color} size={56} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            aria-label="Your name"
            value={draft}
            maxLength={40}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                // Cancel the edit without closing the surrounding panel.
                e.preventDefault();
                e.stopPropagation();
                setDraft(name);
                setEditing(false);
              }
            }}
            enterKeyHint="done"
            autoComplete="nickname"
            className="font-display -mx-2 -my-0.5 w-[calc(100%+16px)] rounded-[10px] bg-[var(--field-bg)] px-2 py-0.5 text-[28px] leading-tight tracking-[-0.01em] text-ink outline-none focus:shadow-[0_0_0_4px_color-mix(in_oklab,var(--iris-1)_22%,transparent)] focus-visible:outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={start}
            title="Change your name"
            aria-label={`Your name: ${name}. Change it`}
            className="group -mx-2 -my-0.5 flex max-w-[calc(100%+16px)] items-center gap-2 rounded-[10px] px-2 py-0.5 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)]"
          >
            <span className="font-display truncate text-[28px] leading-tight tracking-[-0.01em] text-ink">{name}</span>
            <Icon name="pencil" size={15} className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100" />
          </button>
        )}
        <p className="mt-0.5 truncate text-[13px] text-ink-2">{signedIn ? 'Your worlds follow you everywhere' : 'Shown on worlds you make'}</p>
      </div>
    </div>
  );
}

/** Your own AI and GitHub. Folded away unless you use them, or a "Use your own key" link opens it. */
function Advanced() {
  const hydrated = useHydrated();
  return hydrated ? <AdvancedInner /> : <AdvancedToggle open={false} />;
}

function AdvancedInner() {
  const [inUse] = useState(() => {
    const ai = getAiConfig();
    return ai.active !== 'free' || Object.values(ai.keys).some(Boolean);
  });
  const open = useUi((s) => s.advancedOpen) ?? inUse;
  return (
    <section aria-label="Advanced">
      <AdvancedToggle open={open} onToggle={() => useUi.getState().setAdvanced(!open)} />
      {open && (
        <div className="animate-fade-up mt-6 flex flex-col gap-8">
          <ModelSettings />
          <GitHubConnect />
        </div>
      )}
    </section>
  );
}

function AdvancedToggle({ open, onToggle }: { open: boolean; onToggle?(): void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="-mx-1 flex w-[calc(100%+8px)] items-center gap-3 rounded-[14px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--hover)]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold tracking-[-0.01em] text-ink">Advanced</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-ink-2">Your own AI key and GitHub</span>
      </span>
      <Icon name="chevron-down" size={16} className={`shrink-0 text-ink-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
    </button>
  );
}

function Footer() {
  const { me } = useMe();
  return (
    <footer className="flex items-center justify-between gap-3 px-1 pt-1 text-[11.5px] text-ink-3">
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full [background:var(--iris-conic)]" />
        Orb
      </span>
      {me?.deviceId && (
        <span className="font-mono tabular-nums" title="This device’s public id (handy for support)">
          {me.deviceId.slice(0, 8)}
        </span>
      )}
    </footer>
  );
}
