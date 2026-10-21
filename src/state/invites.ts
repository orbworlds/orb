'use client';
// Opening someone's share link (?with=<their handle>, src/state/share.ts): Orb says who brought you
// here and offers to add them as a friend in one tap. Signed out, it opens their profile, where
// adding them makes an account first. The handle comes out of the address right away, so it isn't
// passed on when you share the page yourself, nor said twice after a reload.
import { useEffect } from 'react';
import { track } from '@/lib/analytics';
import { api } from '@/lib/api';
import type { Profile } from '@/lib/types';
import { useSession } from '@/components/orb/AccountCard';
import { useFriends } from './friends';
import { takeParams } from './share';
import { apiMessage, toast, useToasts } from './toast';
import { useUi } from './ui';
import { useWorld } from './world';

const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
let handled = false;

/** The inviter's handle in this page's address, taken out of it. */
function takeInviter(): string | null {
  const [raw] = takeParams('with');
  const handle = raw?.trim().toLowerCase() ?? '';
  return HANDLE_RE.test(handle) ? handle : null;
}

async function befriend(p: Profile, signedIn: boolean): Promise<void> {
  if (!signedIn || p.friend === 'requested') {
    useUi.getState().openProfile(p.handle);
    return;
  }
  try {
    const r = await useFriends.getState().add(p.handle, 'invite');
    toast(r.state === 'friends' ? `You and ${p.name} are friends now ✨` : `Asked ${p.name} to be friends`, 'success');
  } catch (e) {
    toast(apiMessage(e, 'Couldn’t send that. Please try again.'), 'error');
  }
}

async function welcome(handle: string): Promise<void> {
  const me = useSession.getState().me;
  if (me?.user?.handle === handle) return; // your own link
  let p: Profile;
  try {
    p = (await api.profile(handle)).profile;
  } catch {
    return;
  }
  const signedIn = !!me?.user;
  track('invite_open', { by: handle, signed_in: signedIn, friend: p.friend });
  if (p.friend === 'friends' || p.friend === 'you') return;
  if (!p.id) {
    toast(`${p.name} invited you to play`);
    return;
  }
  const incoming = p.friend === 'incoming';
  useToasts.getState().push(
    {
      text: incoming ? `${p.name} invited you here and wants to be friends` : `${p.name} invited you to play`,
      action: { label: incoming ? 'Accept' : p.friend === 'requested' ? 'See' : 'Add friend', onClick: () => void befriend(p, signedIn) },
    },
    12_000,
  );
}

/** Say who brought this page's visitor here (mount once). */
export function useInviteWelcome(): void {
  const ready = useWorld((s) => s.status === 'ready' && !!s.world);
  const known = useSession((s) => s.meStatus === 'ready' || s.meStatus === 'error');
  useEffect(() => {
    if (handled || !ready || !known) return;
    handled = true;
    const handle = takeInviter();
    if (handle) void welcome(handle);
  }, [ready, known]);
}
