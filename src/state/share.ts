'use client';
// Links people share: a world's address, with ?with=<your handle> when you're signed in, so the
// person opening it is told who brought them and can add them as a friend in one tap
// (src/state/invites.ts), and ?room= for a room of it.
import { worldHref } from '@/lib/api';
import { useSession } from '@/components/orb/AccountCard';

export function shareUrl(world: { id: string; path?: string | null }, room?: string | null): string {
  const url = new URL(worldHref(world), window.location.origin);
  const handle = useSession.getState().me?.user?.handle;
  if (handle) url.searchParams.set('with', handle);
  if (room) url.searchParams.set('room', room);
  return url.toString();
}
