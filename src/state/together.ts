'use client';
// Making a world together (SPEC §2): an owner's invite in the address, taken out of it at once and
// acted on by JoinTogether; and, while a world others may change too is on screen, what they do —
// who is at it right now (as their blobs, src/components/world/Makers.tsx), what they are building,
// and their new versions, which come in. Nobody waits for anybody: builds at the same time all save,
// each putting its changes onto the others' (src/server/merge.ts).
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { api, ApiError } from '@/lib/api';
import type { WorldMaker } from '@/lib/types';
import { takeParams } from './share';
import { toast } from './toast';
import { useWorld } from './world';

interface TogetherState {
  /** An owner's invite to come in with (the world it's for, when the address names it). */
  invite: { worldId: string | null; token: string } | null;
  /** The others making the world on screen right now, those building first. */
  makers: WorldMaker[];
}

export const useTogether = create<TogetherState>(() => ({ invite: null, makers: [] }));

/** How often a world made together is looked at again while it's on screen. */
const EVERY_MS = 10_000;

/** The invite in the address (?edit=…), taken out of it so the address can be passed on safely. */
export function takeInvite(worldId: string | null): void {
  const [token] = takeParams('edit');
  if (token && /^[A-Za-z0-9]{8,64}$/.test(token)) useTogether.setState({ invite: { worldId, token } });
}

/** "Ana changed the world", "Ana and Ben changed the world". */
function changedBy(names: string[]): string {
  if (!names.length) return 'The world was changed';
  return `${names.length <= 2 ? names.join(' and ') : `${names[0]} and ${names.length - 1} others`} changed the world`;
}

/**
 * While a world made together is on screen: follow what the others do. Their new versions come in
 * unless this page is building (its own build shows them as it goes, src/server/agent/runner.ts).
 */
export function useFollowTogether(building: boolean): void {
  const id = useWorld((s) => (s.world && s.canEdit && (s.world.invited || s.world.invite || s.world.editors?.length) ? s.world.id : null));
  const busy = useRef(building);
  useEffect(() => {
    busy.current = building;
  }, [building]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    /** Who was building when last looked: when a new version comes, it's theirs. */
    let builders: string[] = [];
    const look = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const now = await api.together(id);
        const w = useWorld.getState().world;
        if (!alive || w?.id !== id) return;
        useTogether.setState({ makers: now.makers });
        if (JSON.stringify(now.editors) !== JSON.stringify(w.editors ?? [])) useWorld.setState({ world: { ...w, editors: now.editors } });
        const by = builders;
        builders = now.makers.filter((m) => m.building).map((m) => m.name);
        if (now.version > w.version && !busy.current) {
          const { world } = await api.getWorld(id);
          if (!alive || !world.tree || useWorld.getState().world?.id !== id || busy.current) return;
          useWorld.getState().adoptVersion({ worldId: id, version: world.version, tree: world.tree, code: world.code ?? '', name: world.name });
          toast(changedBy(by.filter((name) => !builders.includes(name))));
        }
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
      useTogether.setState({ makers: [] });
    };
  }, [id]);
}
