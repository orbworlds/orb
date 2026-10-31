'use client';
// Making a world together (SPEC §2): an owner's invite in the address, taken out of it at once and
// acted on by JoinTogether; and, while a world others may change too is on screen, what they do —
// their new versions come in, and who is changing it right now holds this page's builds.
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { api, ApiError } from '@/lib/api';
import { takeParams } from './share';
import { toast } from './toast';
import { useWorld } from './world';

interface TogetherState {
  /** An owner's invite to come in with (the world it's for, when the address names it). */
  invite: { worldId: string | null; token: string } | null;
  /** Someone else changing the world on screen right now (their name). */
  building: string | null;
}

export const useTogether = create<TogetherState>(() => ({ invite: null, building: null }));

/** How often a world made together is looked at again while it's on screen. */
const EVERY_MS = 15_000;

/** The invite in the address (?edit=…), taken out of it so the address can be passed on safely. */
export function takeInvite(worldId: string | null): void {
  const [token] = takeParams('edit');
  if (token && /^[A-Za-z0-9]{8,64}$/.test(token)) useTogether.setState({ invite: { worldId, token } });
}

/** While a world made together is on screen (and this page isn't building it): follow what the others do. */
export function useFollowTogether(building: boolean): void {
  const id = useWorld((s) => (s.world && s.canEdit && (s.world.invited || s.world.invite || s.world.editors?.length) ? s.world.id : null));
  const busy = useRef(building);
  useEffect(() => {
    busy.current = building;
  }, [building]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    /** Who was changing it when last looked. */
    let by: string | null = null;
    const look = async () => {
      if (document.visibilityState !== 'visible' || busy.current) return;
      try {
        const now = await api.together(id);
        const w = useWorld.getState().world;
        if (!alive || w?.id !== id) return;
        useTogether.setState({ building: now.building });
        if (JSON.stringify(now.editors) !== JSON.stringify(w.editors ?? [])) useWorld.setState({ world: { ...w, editors: now.editors } });
        if (now.version > w.version) {
          const { world } = await api.getWorld(id);
          if (!alive || !world.tree || useWorld.getState().world?.id !== id) return;
          useWorld.getState().adoptVersion({ worldId: id, version: world.version, tree: world.tree, code: world.code ?? '', name: world.name });
          toast(by ? `${by} changed the world` : 'The world was changed');
        }
        by = now.building;
      } catch (e) {
        // Taken off it (or it's gone): show the world as it is for them now.
        if (alive && e instanceof ApiError && (e.status === 403 || e.status === 404)) void useWorld.getState().loadWorld(id);
      }
    };
    void look();
    const timer = setInterval(look, EVERY_MS);
    document.addEventListener('visibilitychange', look);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', look);
      useTogether.setState({ building: null });
    };
  }, [id]);
}
