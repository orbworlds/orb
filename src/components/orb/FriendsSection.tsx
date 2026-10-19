'use client';
// The You tab's Friends: add someone by their username, answer requests, see where friends are and
// join them, the invites waiting for you, and your profile link to send to people.

import { useEffect, useId, useState, type ReactNode } from 'react';
import { ApiError, profileHref } from '@/lib/api';
import type { Friend, FriendNote, FriendRequest } from '@/lib/types';
import { Button, IconButton } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { joinWorld, roomOf, useFriends } from '@/state/friends';
import { toast } from '@/state/toast';
import { useUi } from '@/state/ui';
import { useWorld } from '@/state/world';
import { useMe } from './AccountCard';
import { PersonAvatar, whereIs } from './People';
import { fieldClass, groupClass, SectionHeader, Skeleton, Thumb, timeAgo, useHydrated } from './WorldCard';

/** Invites stay in the list this long (read or not). */
const INVITE_SHOWN_MS = 2 * 86_400_000;

const rowClass = 'flex w-full items-center gap-3 rounded-[13px] px-2 py-2';
const rowButton = 'transition-colors duration-200 hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)] focus-visible:rounded-[13px] focus-visible:outline-offset-0';

function failure(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.status < 500 && e.message ? e.message : fallback;
}

export function FriendsSection() {
  const hydrated = useHydrated();
  const { me, status, signedIn } = useMe();
  const data = useFriends((s) => s.data);
  const syncedAt = useFriends((s) => s.syncedAt);
  const visible = useUi((s) => s.panelOpen && s.tab === 'you');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (signedIn && !useFriends.getState().data) void useFriends.getState().sync();
  }, [signedIn]);

  // What's new here has been seen once the section is on screen for a moment.
  const unread = data?.unread ?? 0;
  useEffect(() => {
    if (!visible || !unread) return;
    const t = setTimeout(() => useFriends.getState().markRead(), 1500);
    return () => clearTimeout(t);
  }, [visible, unread]);

  const header = (accessory?: ReactNode) => <SectionHeader id="orb-friends-h" title="Friends" accessory={accessory} />;

  if (!hydrated || (!me && status !== 'error')) {
    return (
      <section aria-labelledby="orb-friends-h">
        {header()}
        <div className={`${groupClass} p-4`} aria-busy="true">
          <Skeleton className="h-3.5 w-1/2 rounded-full" />
          <Skeleton className="mt-2.5 h-3 w-2/3 rounded-full" />
        </div>
      </section>
    );
  }

  if (!signedIn) {
    return (
      <section aria-labelledby="orb-friends-h">
        {header()}
        <Empty
          title="Play with friends"
          text="With an account, add friends & play together."
          action={
            <Button variant="primary" size="sm" className="mt-3.5" onClick={() => useUi.getState().requestSignup()}>
              Create account
            </Button>
          }
        />
      </section>
    );
  }

  const friends = data?.friends ?? [];
  const incoming = data?.incoming ?? [];
  const outgoing = data?.outgoing ?? [];
  const invites = (data?.notes ?? []).filter((n) => n.kind === 'invite' && n.world && syncedAt - Date.parse(n.at) < INVITE_SHOWN_MS).slice(0, 3);
  const remixes = (data?.notes ?? []).filter((n) => n.kind === 'remix' && n.world).slice(0, 5);
  const sales = (data?.notes ?? []).filter((n) => n.kind === 'sale' && n.world && n.sale).slice(0, 5);
  const nobody = !friends.length && !incoming.length && !outgoing.length;
  const handle = me?.user?.handle ?? null;

  return (
    <section aria-labelledby="orb-friends-h">
      {header(
        !nobody && (
          <Button variant="glass" size="sm" icon={adding ? 'check' : 'user-plus'} onClick={() => setAdding(!adding)} className="mb-0.5" aria-expanded={adding}>
            {adding ? 'Done' : 'Add'}
          </Button>
        ),
      )}

      {!data ? (
        <div className={`${groupClass} p-1.5`} aria-busy="true" aria-label="Loading your friends">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-2">
              <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3.5 w-1/3 rounded-full" />
                <Skeleton className="mt-2 h-3 w-1/2 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {nobody && <Empty title="Play with friends" text="Add friends by username to see what they play & join them." />}
          {(adding || nobody) && <AddFriend autoFocus={adding} onAdded={() => setAdding(true)} />}
          {invites.length > 0 && <Invites notes={invites} />}
          {sales.length > 0 && <Sales notes={sales} />}
          {remixes.length > 0 && <Remixes notes={remixes} />}
          {incoming.length > 0 && <Incoming list={incoming} />}
          {friends.length > 0 && <FriendList friends={friends} />}
          {outgoing.length > 0 && <Outgoing list={outgoing} />}
        </div>
      )}

      {handle && <ProfileLink handle={handle} />}
    </section>
  );
}

function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="rounded-[18px] px-5 py-6 text-center shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ink)_10%,transparent)] [background:color-mix(in_oklab,var(--ink)_2%,transparent)]">
      <span className="mx-auto mb-2.5 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--field-bg)] text-ink-2">
        <Icon name="users" size={18} />
      </span>
      <p className="text-[14px] font-medium text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-[280px] text-[13px] leading-snug text-ink-2">{text}</p>
      {action}
    </div>
  );
}

/** `onAdded`: keep this form open (the first request ends the empty state that showed it). */
function AddFriend({ autoFocus, onAdded }: { autoFocus: boolean; onAdded(): void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const id = useId();
  // The request shows up in the list below; the line saying so goes before it can go stale.
  useEffect(() => {
    if (!note?.ok) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);

  const submit = async () => {
    const username = name.trim();
    if (!username || busy) return;
    setBusy(true);
    setNote(null);
    try {
      onAdded();
      const r = await useFriends.getState().add(username);
      setName('');
      setNote({
        ok: true,
        text: r.state === 'friends' ? `You and ${r.person.name} are friends now ✨` : `Asked ${r.person.name}. You’ll be friends as soon as they say yes.`,
      });
    } catch (e) {
      setNote({ ok: false, text: failure(e, 'Couldn’t send that. Please try again.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="animate-fade-up"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Your friend’s username
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          autoFocus={autoFocus}
          className={fieldClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your friend’s username"
          maxLength={40}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          disabled={busy}
        />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !name.trim()} className="h-10 shrink-0">
          {busy && <Spinner size={14} />}
          Add friend
        </Button>
      </div>
      {note && (
        <p role={note.ok ? 'status' : 'alert'} className={`mt-2 px-0.5 text-[12.5px] leading-snug ${note.ok ? 'text-ink-2' : 'text-[var(--bad)]'}`}>
          {note.text}
        </p>
      )}
    </form>
  );
}

function Group({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div>
      {label && <div className="mb-1.5 px-1 text-[12px] font-medium text-ink-3">{label}</div>}
      <ul className={`${groupClass} p-1.5`}>{children}</ul>
    </div>
  );
}

function Invites({ notes }: { notes: FriendNote[] }) {
  return (
    <Group label="Invites">
      {notes.map((n) => (
        <li key={n.id} className={rowClass}>
          <Thumb src={n.world!.thumbUrl} seed={n.world!.id} name={n.world!.name} initialSize={18} className="h-[38px] w-[60px] shrink-0 rounded-[9px]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium text-ink">{n.world!.name}</span>
            <span className="block truncate text-[12.5px] text-ink-2">
              {n.from.name} invited you · {timeAgo(n.at)}
            </span>
          </span>
          {!n.read && <span aria-label="New" className="h-2 w-2 shrink-0 rounded-full bg-[var(--iris-4)]" />}
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              useFriends.getState().markRead([n.id]);
              joinWorld(n.world!.id, 'invite');
            }}
            className="shrink-0"
          >
            Join
          </Button>
        </li>
      ))}
    </Group>
  );
}

/** Things people got in your worlds' shops, and what you earned (each world's add up until seen). */
function Sales({ notes }: { notes: FriendNote[] }) {
  return (
    <Group label="Sales in your worlds">
      {notes.map((n) => (
        <li key={n.id} className={rowClass}>
          <Thumb src={n.world!.thumbUrl} seed={n.world!.id} name={n.world!.name} initialSize={18} className="h-[38px] w-[60px] shrink-0 rounded-[9px]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium text-ink">
              {n.world!.name}
              {n.sale!.credits > 0 && <span className="font-normal text-[var(--ok)] tabular-nums"> · +{Math.round(n.sale!.credits * 10) / 10} credits</span>}
            </span>
            <span className="block truncate text-[12.5px] text-ink-2">
              {n.sale!.count > 1 ? `${n.sale!.count} sold · last: ${n.sale!.item}` : `Someone got ${n.sale!.item}`} · {timeAgo(n.at)}
            </span>
          </span>
          {!n.read && <span aria-label="New" className="h-2 w-2 shrink-0 rounded-full bg-[var(--iris-4)]" />}
        </li>
      ))}
    </Group>
  );
}

/** People made your worlds their own: each remix, with who made it. */
function Remixes({ notes }: { notes: FriendNote[] }) {
  return (
    <Group label="Remixes of your worlds">
      {notes.map((n) => (
        <li key={n.id} className={rowClass}>
          <Thumb src={n.world!.thumbUrl} seed={n.world!.id} name={n.world!.name} initialSize={18} className="h-[38px] w-[60px] shrink-0 rounded-[9px]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium text-ink">{n.world!.name}</span>
            <span className="block truncate text-[12.5px] text-ink-2">
              {n.from.name} remixed {n.world!.forkedFrom ? `“${n.world!.forkedFrom.name}”` : 'your world'} · {timeAgo(n.at)}
            </span>
          </span>
          {!n.read && <span aria-label="New" className="h-2 w-2 shrink-0 rounded-full bg-[var(--iris-4)]" />}
          <Button
            size="sm"
            variant="glass"
            onClick={() => {
              useFriends.getState().markRead([n.id]);
              joinWorld(n.world!.id, 'remix_note');
            }}
            className="shrink-0"
          >
            See
          </Button>
        </li>
      ))}
    </Group>
  );
}

function Incoming({ list }: { list: FriendRequest[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (p: FriendRequest, yes: boolean) => {
    setBusy(p.id);
    try {
      if (yes) {
        await useFriends.getState().accept(p.id);
        toast(`You and ${p.name} are friends now ✨`, 'success');
      } else await useFriends.getState().remove(p.id);
    } catch (e) {
      toast(failure(e, 'Couldn’t do that just now. Try again in a moment.'), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Group label="Want to be friends">
      {list.map((p) => (
        <li key={p.id} className={rowClass}>
          <PersonButton person={p} sub={timeAgo(p.at)} />
          <Button size="sm" variant="primary" onClick={() => void act(p, true)} disabled={!!busy} className="shrink-0">
            {busy === p.id && <Spinner size={13} />}
            Accept
          </Button>
          <IconButton icon="x" label={`Decline ${p.name}`} size={32} onClick={() => void act(p, false)} disabled={!!busy} className="-ml-1 text-ink-2" />
        </li>
      ))}
    </Group>
  );
}

function FriendList({ friends }: { friends: Friend[] }) {
  const here = useWorld((s) => (s.status === 'ready' ? (s.world?.id ?? null) : null));
  const online = friends.filter((f) => f.online).length;
  return (
    <Group label={online ? `${online} online` : undefined}>
      {friends.map((f) => (
        <li key={f.id} className={rowClass}>
          <PersonButton person={f} online={f.online} sub={whereIs(f)} highlight={!!f.world} />
          {f.world &&
            (f.world.id === here ? (
              <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--ok)_14%,transparent)] px-2.5 py-1 text-[12px] font-medium text-[var(--ok)]">Here with you</span>
            ) : (
              <Button size="sm" variant="primary" onClick={() => joinWorld(f.world!.id, 'friend', roomOf(f))} className="shrink-0">
                Join
              </Button>
            ))}
        </li>
      ))}
    </Group>
  );
}

function Outgoing({ list }: { list: FriendRequest[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const cancel = async (p: FriendRequest) => {
    setBusy(p.id);
    try {
      await useFriends.getState().remove(p.id);
    } catch (e) {
      toast(failure(e, 'Couldn’t do that just now. Try again in a moment.'), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Group label="Asked">
      {list.map((p) => (
        <li key={p.id} className={rowClass}>
          <PersonButton person={p} sub="Waiting for them to say yes" />
          <Button size="sm" variant="ghost" onClick={() => void cancel(p)} disabled={!!busy} className="shrink-0">
            {busy === p.id && <Spinner size={13} />}
            Cancel
          </Button>
        </li>
      ))}
    </Group>
  );
}

/** Avatar, name and a line under it; opens their profile when they have one. */
function PersonButton({ person, sub, online = false, highlight = false }: { person: FriendRequest | Friend; sub: string; online?: boolean; highlight?: boolean }) {
  const body = (
    <>
      <PersonAvatar person={person} online={online} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{person.name}</span>
        <span className={`block truncate text-[12.5px] ${highlight ? 'font-medium text-[var(--ok)]' : 'text-ink-2'}`}>{sub}</span>
      </span>
    </>
  );
  if (!person.handle) return <span className="flex min-w-0 flex-1 items-center gap-3">{body}</span>;
  const handle = person.handle;
  return (
    <button type="button" onClick={() => useUi.getState().openProfile(handle)} className={`-my-1 -ml-1.5 flex min-w-0 flex-1 items-center gap-3 rounded-[13px] py-1 pl-1.5 text-left ${rowButton}`}>
      {body}
    </button>
  );
}

function ProfileLink({ handle }: { handle: string }) {
  const href = profileHref(handle);
  const copy = async () => {
    const url = `${location.origin}${href}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Profile link copied. Send it to friends so they can add you', 'success');
    } catch {
      toast(url);
    }
  };
  return (
    <div className="mt-3 flex items-center gap-2 px-1 text-[12.5px] text-ink-2">
      <Icon name="link" size={13} className="shrink-0 text-ink-3" />
      <button type="button" onClick={() => useUi.getState().openProfile(handle)} className="min-w-0 truncate text-left hover:text-ink hover:underline">
        Your profile: {typeof location === 'undefined' ? '' : location.host}
        {href}
      </button>
      <button type="button" onClick={() => void copy()} className="ml-auto shrink-0 font-medium text-ink hover:underline">
        Copy link
      </button>
    </div>
  );
}
