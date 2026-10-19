'use client';
// A world asked to sell the player something (orb.shop.buy): the request Orb's own sheet answers
// (src/components/world/PurchaseSheet.tsx). The world only hears whether they got it.
import { create } from 'zustand';
import type { WorldFull } from '@/lib/types';

export interface PurchaseAsk {
  worldId: string;
  worldName: string;
  maker: string;
  item: string;
  resolve(r: { ok: boolean; reason?: string }): void;
}

export const useShop = create<{ ask: PurchaseAsk | null }>(() => ({ ask: null }));

/** Ask the player whether to buy `item` in the world on screen (a newer ask ends an older one). */
export function askPurchase(world: WorldFull | null, frameId: string, item: string): Promise<{ ok: boolean; reason?: string }> {
  if (!world || world.id !== frameId) return Promise.resolve({ ok: false, reason: 'not_saved' });
  return new Promise((resolve) => {
    useShop.getState().ask?.resolve({ ok: false, reason: 'cancelled' });
    useShop.setState({ ask: { worldId: world.id, worldName: world.name, maker: world.authorName || 'someone', item, resolve } });
  });
}

/** The sheet's answer: the world hears it, the sheet closes. */
export function answerPurchase(r: { ok: boolean; reason?: string }): void {
  const ask = useShop.getState().ask;
  if (!ask) return;
  useShop.setState({ ask: null });
  ask.resolve(r);
}
