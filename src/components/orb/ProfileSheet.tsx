'use client';
// A maker's profile, over the world: at /<handle>, from a world's "by …" and from the friends list.
// Who they are, their worlds, and becoming friends: add them (signing up first, if need be),
// answer their request, or, as friends, see where they are and join them.

import { useEffect, useState } from 'react';
import { track } from '@/lib/analytics';
import { api, ApiError, profileHref } from '@/lib/api';
import type { FriendState, Profile } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import { joinWorld, roomOf, useFriends } from '@/state/friends';
import { toast } from '@/state/toast';
import { AccountCard, useMe } from './AccountCard';
import { PersonAvatar, whereIs } from './People';
import { formatCount, Skeleton, Thumb, WorldCard, WorldCardSkeleton } from './WorldCard';

export function ProfileSheet({ handle, onClose, onOpenWorld }: { handle: string | null; onClose(): void; onOpenWorld(id: string): void }) {
  return (
    <Modal open={!!handle} onClose={onClose} width={600}>
      {handle && <ProfileBody key={handle} handle={handle} onOpenWorld={onOpenWorld} />}
    </Modal>
  );
}

type Load = { profile: Profile } | { missing: true } | { failed: true } | null;

function ProfileBody({ handle, onOpenWorld }: { handle: string; onOpenWorld(id: string): void }) {
  const { me } = useMe();
  const signedInAs = me?.user?.id ?? null;
  const [load, setLoad] = useState<Load>(null);
  const [nonce, setNonce] = useState(0);
  // Friends changing (a yes, a request) changes how the viewer stands with this person.
  const friendsVersion = useFriends((s) => s.data);

  useEffect(() => {
    let alive = true;
    api.profile(handle).then(
      (r) => alive && setLoad({ profile: r.profile }),
      (e: unknown) => alive && setLoad(e instanceof ApiError && e.status === 404 ? { missing: true } : { failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [handle, signedInAs, nonce, friendsVersion]);

  useEffect(() => {
    track('profile_open', { handle });
  }, [handle]);

  const name = load && 'profile' in load ? load.profile.name : null;
  useEffect(() => {
    if (name) document.title = `${name} · Orb`;
  }, [name]);

  if (!load) {
    return (
      <div aria-busy="true">
        <div className="flex items-center gap-4">
          <Skeleton className="h-[72px] w-[72px] shrink-0 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-6 w-1/2 rounded-full" />
            <Skeleton className="mt-2.5 h-3.5 w-1/3 rounded-full" />
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5">
          <WorldCardSkeleton />
          <WorldCardSkeleton />
        </div>
      </div>
    );
  }
  if ('missing' in load || 'failed' in load) {
    return (
      <div className="py-6 text-center">
        <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--field-bg)] text-ink-2">
          <Icon name="user" size={20} />
        </span>
        <p className="text-[15px] font-medium text-ink">{'missing' in load ? 'No one here' : 'Couldn’t load this profile'}</p>
        <p className="mx-auto mt-1 max-w-[280px] text-[13px] text-ink-2">{'missing' in load ? `There’s no maker called ${handle} on Orb.` : 'Check your connection and try again.'}</p>
        {'failed' in load && (
          <Button variant="glass" size="sm" icon="refresh" className="mt-4" onClick={() => setNonce((n) => n + 1)}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const p = load.profile;
  const plays = p.worlds.reduce((n, w) => n + w.plays, 0);
  const facts = [
    `@${p.handle}`,
    p.id ? `${p.friendCount} ${p.friendCount === 1 ? 'friend' : 'friends'}` : null,
    `${p.worlds.length}${p.worlds.length >= 24 ? '+' : ''} ${p.worlds.length === 1 ? 'world' : 'worlds'}`,
    plays > 0 ? `${formatCount(plays)} ${plays === 1 ? 'play' : 'plays'}` : null,
  ].filter(Boolean);

  return (
    <div>
      <div className="flex items-center gap-4">
        <PersonAvatar person={{ id: p.id ?? p.handle, name: p.name }} size={72} online={p.online} />
        <div className="min-w-0 flex-1">
          <h2 className="font-display truncate text-[30px] leading-tight tracking-[-0.01em] text-ink">{p.name}</h2>
          <p className="mt-0.5 truncate text-[13px] text-ink-2">{facts.join(' · ')}</p>
        </div>
      </div>

      <FriendBar profile={p} onChange={(friend) => setLoad({ profile: { ...p, friend, friendCount: p.friendCount + (friend === 'friends' ? 1 : 0) - (p.friend === 'friends' && friend !== 'friends' ? 1 : 0) } })} />

      {p.friend === 'friends' && p.online && (
        <div className="mt-4 flex items-center gap-3 rounded-[18px] bg-[color-mix(in_oklab,var(--ok)_9%,transparent)] py-2 pr-2 pl-2.5">
          {p.world ? (
            <Thumb src={p.world.thumbUrl} seed={p.world.id} name={p.world.name} initialSize={18} className="h-[38px] w-[60px] shrink-0 rounded-[10px]" />
          ) : (
            <span className="ml-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--ok)]" />
          )}
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{whereIs({ world: p.world, own: p.own, online: p.online, seenAt: null })}</span>
          {p.world && (
            <Button size="sm" variant="primary" onClick={() => joinWorld(p.world!.id, 'profile', roomOf(p))} className="shrink-0">
              Join
            </Button>
          )}
        </div>
      )}

      <h3 className="mt-6 mb-3 px-0.5 text-[15px] font-semibold tracking-[-0.01em] text-ink">{p.friend === 'you' ? 'Your public worlds' : 'Worlds'}</h3>
      {p.worlds.length ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-5">
          {p.worlds.map((w) => (
            <WorldCard
              key={w.id}
              world={w}
              onOpen={(id) => {
                track('world_open', { world_id: id, source: 'profile' });
                onOpenWorld(id);
              }}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-[18px] px-5 py-6 text-center text-[13px] text-ink-2 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_10%,transparent)]">
          {p.friend === 'you' ? 'Worlds you make public show up here.' : `${p.name} hasn’t shared a world yet.`}
        </p>
      )}
    </div>
  );
}

/** The friend button (or, on your own profile, your link to send). */
function FriendBar({ profile: p, onChange }: { profile: Profile; onChange(friend: FriendState): void }) {
  const { signedIn, status } = useMe();
  const [busy, setBusy] = useState(false);
  const [signUp, setSignUp] = useState(false);
  const link = typeof location === 'undefined' ? profileHref(p.handle) : `${location.origin}${profileHref(p.handle)}`;

  const run = async (fn: () => Promise<FriendState>) => {
    setBusy(true);
    try {
      onChange(await fn());
    } catch (e) {
      toast(e instanceof ApiError && e.status < 500 && e.message ? e.message : 'Couldn’t do that just now. Try again in a moment.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const add = () =>
    run(async () => {
      const r = await useFriends.getState().add(p.handle);
      toast(r.state === 'friends' ? `You and ${p.name} are friends now ✨` : `Asked ${p.name} to be friends`, 'success');
      return r.state;
    });
  const accept = () =>
    run(async () => {
      await useFriends.getState().accept(p.id!);
      toast(`You and ${p.name} are friends now ✨`, 'success');
      return 'friends';
    });
  const remove = () =>
    run(async () => {
      await useFriends.getState().remove(p.id!);
      return 'none';
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Profile link copied — send it to friends so they can add you', 'success');
    } catch {
      toast(link);
    }
  };

  if (p.friend === 'you') {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" icon="link" onClick={() => void copy()}>
          Copy your profile link
        </Button>
        <span className="text-[12.5px] text-ink-2">Friends can add you from here.</span>
      </div>
    );
  }
  if (!p.id) return null; // a maker without an account

  if (!signedIn && status !== 'loading') {
    return signUp ? (
      <div className="animate-fade-up mt-4 rounded-[18px] bg-[var(--glass-bg-strong)] p-4 shadow-[0_1px_2px_rgba(16,16,40,.05),0_8px_24px_-12px_rgba(16,16,40,.22),inset_0_0_0_1px_var(--glass-hairline)]">
        <AccountCard
          variant="inline"
          where="profile"
          reason={`Make an account to add ${p.name}`}
          onSignedIn={() => {
            setSignUp(false);
            void add();
          }}
          onCancel={() => setSignUp(false)}
        />
      </div>
    ) : (
      <div className="mt-4">
        <Button variant="primary" size="sm" icon="user-plus" onClick={() => setSignUp(true)}>
          Add friend
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      {p.friend === 'none' && (
        <Button variant="primary" size="sm" icon={busy ? undefined : 'user-plus'} onClick={() => void add()} disabled={busy}>
          {busy && <Spinner size={14} />}
          Add friend
        </Button>
      )}
      {p.friend === 'requested' && (
        <>
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--field-bg)] px-3 text-[13px] font-medium text-ink-2">
            <Icon name="check" size={14} />
            Asked
          </span>
          <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={busy}>
            Take back
          </Button>
          <span className="text-[12.5px] text-ink-2">You’ll be friends as soon as they say yes.</span>
        </>
      )}
      {p.friend === 'incoming' && (
        <>
          <Button variant="primary" size="sm" onClick={() => void accept()} disabled={busy}>
            {busy && <Spinner size={14} />}
            Accept
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={busy}>
            Decline
          </Button>
          <span className="text-[12.5px] text-ink-2">{p.name} wants to be friends.</span>
        </>
      )}
      {p.friend === 'friends' && (
        <Menu
          align="start"
          width={200}
          items={[{ label: `Remove ${p.name}`, icon: 'x', danger: true, onSelect: () => void remove() }]}
          renderTrigger={(t, open) => (
            <button
              type="button"
              {...t}
              disabled={busy}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[var(--ok)] transition-colors bg-[color-mix(in_oklab,var(--ok)_12%,transparent)] hover:bg-[color-mix(in_oklab,var(--ok)_18%,transparent)] ${open ? 'bg-[color-mix(in_oklab,var(--ok)_18%,transparent)]' : ''}`}
            >
              <Icon name="check" size={14} strokeWidth={2.2} />
              Friends
              <Icon name="chevron-down" size={13} />
            </button>
          )}
        />
      )}
    </div>
  );
}
