'use client';
// The blob's look (src/lib/looks.ts) in the You tab: Orb's things to wear, what the account owns
// and wears, and its color. Every change goes to the player in worlds (useWorld.dress) and the
// session too, so the others in a world see it.

import { create } from 'zustand';
import { track } from '@/lib/analytics';
import { api, ApiError } from '@/lib/api';
import { setPlayerColor } from '@/lib/local';
import type { LookItem, LooksView } from '@/lib/types';
import { useSession } from '@/components/orb/AccountCard';
import { useBilling } from './billing';
import { apiMessage, toast } from './toast';
import { useWorld } from './world';

interface LooksState {
  view: LooksView | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** What's being bought or changed right now. */
  busy: string | null;
  load(force?: boolean): Promise<void>;
  /** Buy and put on; a failure says why (`no_credits` with `message`, …). */
  buy(item: LookItem): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  wear(wear: string[]): Promise<void>;
  setColor(color: string): Promise<void>;
}

function adopt(view: LooksView): void {
  useLooks.setState({ view, status: 'ready' });
  if (!view.signedIn) return;
  if (view.look.color) setPlayerColor(view.look.color);
  useWorld.getState().dress({ color: view.look.color ?? undefined, wear: view.look.wear });
  const me = useSession.getState().me;
  if (me?.user) useSession.setState({ me: { ...me, user: { ...me.user, look: view.look } } });
}

let loading: Promise<void> | null = null;

export const useLooks = create<LooksState>((set, get) => ({
  view: null,
  status: 'idle',
  busy: null,
  load(force = false) {
    if (!force && (get().status === 'ready' || loading)) return loading ?? Promise.resolve();
    set({ status: get().view ? 'ready' : 'loading' });
    const p = api
      .looks()
      .then(adopt)
      .catch(() => set({ status: get().view ? 'ready' : 'error' }))
      .finally(() => {
        if (loading === p) loading = null;
      });
    loading = p;
    return p;
  },
  async buy(item) {
    if (get().busy) return { ok: false, code: 'busy', message: 'One moment…' };
    set({ busy: item.id });
    try {
      adopt(await api.buyLook(item.id, item.price));
      set({ busy: null });
      track('look_buy', { item: item.id, credits: item.price });
      toast(`${item.name} is yours ✨ Others see it in worlds.`, 'success');
      void useBilling.getState().load(true);
      return { ok: true };
    } catch (e) {
      set({ busy: null });
      const code = e instanceof ApiError ? e.code : 'failed';
      if (code === 'price_changed') void get().load(true);
      return { ok: false, code, message: apiMessage(e, 'Couldn’t get that just now. Try again in a moment.') };
    }
  },
  async wear(wear) {
    if (get().busy) return;
    set({ busy: 'wear' });
    try {
      adopt(await api.setLook({ wear }));
      track('look_wear', { wear: wear.join(' ') || 'nothing' });
    } catch (e) {
      toast(apiMessage(e, 'Couldn’t change that just now.'), 'error');
    } finally {
      set({ busy: null });
    }
  },
  async setColor(color) {
    setPlayerColor(color);
    useWorld.getState().dress({ color });
    track('blob_color', { color });
    if (!get().view?.signedIn) return;
    try {
      adopt(await api.setLook({ color }));
    } catch {
      toast('Couldn’t keep that color on your account just now.', 'error');
    }
  },
}));

// Signing in or out changes whose looks they are.
useSession.subscribe((s, prev) => {
  if ((s.me?.user?.id ?? null) === (prev.me?.user?.id ?? null) || useLooks.getState().status === 'idle') return;
  void useLooks.getState().load(true);
});
