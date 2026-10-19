'use client';
// Friends as this page knows them: the list with where each friend is, requests both ways and
// notifications. While someone is signed in and the page is visible, `useFriendsSync` (mounted
// once, by the Shell) syncs every half minute, which also tells friends which world is on
// screen, and announces what's new: requests, yeses, invites, and friends arriving in the world
// on screen.
import { useEffect } from 'react';
import { create } from 'zustand';
import { track } from '@/lib/analytics';
import { api, ApiError, leaveFriends } from '@/lib/api';
import { readJSON, writeJSON } from '@/lib/local';
import { onRooms, roomSelves, setFriendPeers } from '@/lib/runtime/realtime';
import type { FriendNote, FriendRoom, FriendsData, FriendState, Person } from '@/lib/types';
import { useSession } from '@/components/orb/AccountCard';
import { useToasts } from './toast';
import { useUi } from './ui';
import { useWorld } from './world';

const SYNC_MS = 30_000;
/** Extra syncs (a room opened, someone came in) at most this often. */
const SOON_EVERY_MS = 8_000;
/** Invites older than this aren't announced when the page opens (they wait in the You tab). */
const INVITE_FRESH_MS = 30 * 60_000;

interface FriendsState {
  data: FriendsData | null;
  /** The account `data` belongs to. */
  userId: string | null;
  /** When `data` arrived (epoch ms). */
  syncedAt: number;
  sync(): Promise<void>;
  /** `how`: typed in (`username`) or from someone's share link (`invite`), for analytics. */
  add(username: string, how?: 'username' | 'invite'): Promise<{ state: FriendState; person: Person }>;
  accept(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  invite(worldId: string, to: string[]): Promise<number>;
  /** These notifications, or all of them, have been seen. */
  markRead(ids?: number[]): void;
}

/** The world friends should see you in: a saved world on screen. */
function worldOnScreen(): string | null {
  const s = useWorld.getState();
  return s.status === 'ready' && s.world ? s.world.id : null;
}

const toastedKey = (userId: string) => `orb:friends-toasted:${userId}`;

/** Tell the world's rooms which peers are friends, as this answer (asked at `askedAt`) vouches for. */
function vouch(data: FriendsData, worldId: string | null, askedAt: number): void {
  setFriendPeers(worldId ? data.friends.filter((f) => f.world?.id === worldId).flatMap((f) => f.rooms.map((r) => r.peer)) : [], askedAt);
}

let inflight: Promise<void> | null = null;
/** The world the last heartbeat named. */
let sentWorld: string | null | undefined;
/** Friends already greeted in a world, as "<friend>:<world>". */
const greeted = new Set<string>();

export const useFriends = create<FriendsState>((set, get) => {
  function apply(data: FriendsData, userId: string): void {
    const prev = get().userId === userId ? get().data : null;
    set({ data, userId, syncedAt: Date.now() });
    announce(prev, data, userId);
  }

  function signedInId(): string | null {
    return useSession.getState().me?.user?.id ?? null;
  }

  return {
    data: null,
    userId: null,
    syncedAt: 0,

    sync() {
      if (inflight) return inflight;
      const userId = signedInId();
      if (!userId) return Promise.resolve();
      const worldId = worldOnScreen();
      const askedAt = Date.now();
      inflight = api
        .syncFriends(worldId, worldId ? roomSelves(worldId) : [])
        .then((data) => {
          sentWorld = worldId;
          if (signedInId() !== userId) return;
          apply(data, userId);
          vouch(data, worldId, askedAt);
        })
        .catch((e: unknown) => {
          // Signed out elsewhere (or the account is gone): the session store finds out.
          if (e instanceof ApiError && e.status === 401) void useSession.getState().loadMe(true);
        })
        .finally(() => {
          inflight = null;
          // The world on screen changed while this beat was on its way: tell friends now.
          if (sentWorld === worldId && worldOnScreen() !== worldId && signedInId() === userId) setTimeout(() => void get().sync(), 500);
        });
      return inflight;
    },

    async add(username, how = 'username') {
      const askedAt = Date.now();
      const r = await api.addFriend(username);
      const userId = signedInId();
      if (userId) {
        apply(r.friends, userId);
        vouch(r.friends, worldOnScreen(), askedAt);
      }
      track(r.state === 'friends' ? 'friend_accept' : 'friend_add', { how });
      return { state: r.state, person: r.person };
    },

    async accept(id) {
      const askedAt = Date.now();
      const r = await api.acceptFriend(id);
      const userId = signedInId();
      if (userId) {
        apply(r.friends, userId);
        vouch(r.friends, worldOnScreen(), askedAt);
      }
      track('friend_accept', { how: 'request' });
    },

    async remove(id) {
      const askedAt = Date.now();
      const r = await api.removeFriend(id);
      const userId = signedInId();
      if (userId) {
        apply(r.friends, userId);
        vouch(r.friends, worldOnScreen(), askedAt);
      }
    },

    async invite(worldId, to) {
      const r = await api.invite(worldId, to);
      track('friend_invite', { world_id: worldId, friends: to.length });
      return r.invited;
    },

    markRead(ids) {
      const data = get().data;
      if (!data) return;
      const unread = data.notes.filter((n) => !n.read && (!ids || ids.includes(n.id)));
      if (!unread.length) return;
      const notes = data.notes.map((n) => (unread.includes(n) ? { ...n, read: true } : n));
      set({ data: { ...data, notes, unread: notes.filter((n) => !n.read).length } });
      void api.readNotes(ids).catch(() => {});
    },
  };
});

/** Unread notifications (0 when signed out). */
export function useFriendUnread(): number {
  return useFriends((s) => s.data?.unread ?? 0);
}

// --- going places ----------------------------------------------------------------------------------

/** The You tab, scrolled to Friends. */
export function showFriends(): void {
  const u = useUi.getState();
  u.setExplore(false);
  u.setShare(false);
  u.closeProfile();
  u.openPanel('you', 'full');
  let tries = 0;
  const reveal = () => {
    const el = document.getElementById('orb-friends-h');
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else if (++tries < 20) requestAnimationFrame(reveal);
  };
  requestAnimationFrame(reveal);
}

/** The named room of its world a friend is in (a match, a party), to join them there; null: the world's own. */
export function roomOf(f: { rooms?: FriendRoom[] }): string | null {
  return f.rooms?.find((r) => r.room)?.room ?? null;
}

/** Go to the world a friend is in (or invited you to), into their room when they're in one. */
export function joinWorld(id: string, source: 'friend' | 'invite' | 'profile' | 'remix_note', room: string | null = null): void {
  track('world_open', { world_id: id, source, ...(room ? { room: true } : {}) });
  const u = useUi.getState();
  u.setExplore(false);
  u.closeProfile();
  u.setHeroDone(true);
  // On a phone the panel covers the world you came to see.
  if (window.matchMedia('(max-width: 639px)').matches) u.closePanel();
  void useWorld.getState().openWorld(id, room ? { room } : undefined);
}

// --- announcing what's new -------------------------------------------------------------------------

/** "Someone got Crimson Cape in “VampireZ” · +35 credits" (or "3 sold in …" once they add up). */
export function saleText(s: { count: number; credits: number; item: string }, world: string): string {
  const what = s.count > 1 ? `${s.count} things sold in “${world}”` : `Someone got ${s.item || 'something'} in “${world}”`;
  return s.credits > 0 ? `${what} · +${Math.round(s.credits * 10) / 10} credits ✨` : what;
}

function say(text: string, tone: 'default' | 'success', action: { label: string; onClick(): void }, ms = 8000): void {
  useToasts.getState().push({ text, tone, action }, ms);
}

function announceNote(n: FriendNote): void {
  const read = () => useFriends.getState().markRead([n.id]);
  if (n.kind === 'friend_request') {
    say(`${n.from.name} wants to be friends`, 'default', { label: 'See', onClick: showFriends });
  } else if (n.kind === 'friend_accepted') {
    say(`You and ${n.from.name} are friends now ✨`, 'success', {
      label: 'See',
      onClick: () => {
        read();
        showFriends();
      },
    });
  } else if (n.kind === 'sale' && n.world && n.sale) {
    say(saleText(n.sale, n.world.name), 'success', {
      label: 'See',
      onClick: () => {
        read();
        showFriends();
      },
    });
  } else if (n.kind === 'remix' && n.world) {
    const world = n.world;
    say(`${n.from.name} remixed your “${world.forkedFrom?.name ?? 'world'}” ✨`, 'success', {
      label: 'See',
      onClick: () => {
        read();
        joinWorld(world.id, 'remix_note');
      },
    });
  } else if (n.kind === 'invite' && n.world) {
    const world = n.world;
    say(
      `${n.from.name} invited you to “${world.name}”`,
      'default',
      {
        label: 'Join',
        onClick: () => {
          read();
          joinWorld(world.id, 'invite');
        },
      },
      12_000,
    );
  }
}

function announce(prev: FriendsData | null, next: FriendsData, userId: string): void {
  // Notifications not announced before (in this browser), oldest first, at most two at once.
  const last = readJSON<number>(toastedKey(userId), 0);
  const fresh = next.notes.filter((n) => !n.read && n.id > last && (n.kind !== 'invite' || Date.now() - Date.parse(n.at) < INVITE_FRESH_MS));
  for (const n of fresh.slice(0, 2).reverse()) announceNote(n);
  const newest = next.notes.reduce((m, n) => Math.max(m, n.id), last);
  if (newest > last) writeJSON(toastedKey(userId), newest);

  // A friend arrives in the world on screen.
  const here = worldOnScreen();
  if (!prev || !here) return;
  for (const f of next.friends) {
    if (f.world?.id !== here || greeted.has(`${f.id}:${here}`)) continue;
    greeted.add(`${f.id}:${here}`);
    if (prev.friends.find((p) => p.id === f.id)?.world?.id === here) continue;
    useToasts.getState().push({ text: f.own ? `${f.name} is here — it’s their world` : `${f.name} is here too` }, 5000);
  }
}

// --- the sync loop -----------------------------------------------------------------------------------

/** Keep friends in sync while signed in and visible (mount once). */
export function useFriendsSync(): void {
  const userId = useSession((s) => s.me?.user?.id ?? null);
  const worldId = useWorld((s) => (s.status === 'ready' && s.world ? s.world.id : null));

  useEffect(() => {
    if (!userId) {
      sentWorld = undefined;
      greeted.clear();
      useFriends.setState({ data: null, userId: null, syncedAt: 0 });
      setFriendPeers([], 0);
      return;
    }
    const tick = () => {
      if (document.visibilityState === 'visible') void useFriends.getState().sync();
    };
    tick();
    const timer = setInterval(tick, SYNC_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('pagehide', leaveFriends);
    // A room of the world on screen opened (friends can find this page in it now), or someone new
    // came in (maybe a friend, whom only a newer sync can vouch for): sync soon, not in half a minute.
    let soon: ReturnType<typeof setTimeout> | undefined;
    let lastSoon = 0;
    const offRooms = onRooms((e) => {
      if (soon !== undefined || e.worldId !== worldOnScreen()) return;
      if (e.type === 'peer' && !useFriends.getState().data?.friends.length) return;
      const wait = Math.max(e.type === 'open' ? 1000 : 3000, lastSoon + SOON_EVERY_MS - Date.now());
      soon = setTimeout(() => {
        soon = undefined;
        lastSoon = Date.now();
        tick();
      }, wait);
    });
    return () => {
      clearInterval(timer);
      clearTimeout(soon);
      offRooms();
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('pagehide', leaveFriends);
    };
  }, [userId]);

  // Another world on screen: friends see it soon, without waiting for the next beat.
  useEffect(() => {
    if (!userId || sentWorld === undefined || worldId === sentWorld) return;
    const t = setTimeout(() => void useFriends.getState().sync(), 1500);
    return () => clearTimeout(t);
  }, [userId, worldId]);
}
