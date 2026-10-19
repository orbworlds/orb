'use client';
// Clips: a few seconds of the world on screen as a video to post (TikTok, Reels, Shorts, X), recorded
// inside the world (the runtime's recordClip) with the world's address drawn in, so whoever sees
// it can find it. src/components/world/ClipSheet.tsx shows the recording and the finished clip.
import { create } from 'zustand';
import { track } from '@/lib/analytics';
import { worldHref } from '@/lib/api';
import type { WorldFull } from '@/lib/types';
import { toast } from './toast';
import { getFrameHandle } from './world';

export const CLIP_MS = 8000;

interface ClipState {
  status: 'idle' | 'recording' | 'ready';
  startedAt: number;
  blob: Blob | null;
  /** An object URL of `blob`, for the preview. */
  url: string | null;
  world: { id: string; name: string; path: string | null } | null;
  record(world: WorldFull): Promise<void>;
  close(): void;
}

const WHY: Record<string, string> = {
  no_canvas: 'This world isn’t drawn on a canvas, so it can’t be recorded.',
  unsupported: 'This browser can’t record clips. Try Chrome or Safari.',
  busy: 'A clip is already being recorded.',
};

export const useClip = create<ClipState>((set, get) => ({
  status: 'idle',
  startedAt: 0,
  blob: null,
  url: null,
  world: null,

  async record(world) {
    const frame = getFrameHandle();
    if (get().status === 'recording' || !frame) return;
    get().close();
    set({ status: 'recording', startedAt: Date.now(), world: { id: world.id, name: world.name, path: world.path ?? null } });
    const r = await frame.recordClip(CLIP_MS, `${window.location.host}${worldHref(world)}`);
    if (get().world?.id !== world.id || get().status !== 'recording') return;
    if ('error' in r) {
      set({ status: 'idle' });
      track('clip_record', { ok: false, error: r.error });
      toast(WHY[r.error] ?? 'Couldn’t record a clip. Try again in a moment.', 'error');
      return;
    }
    track('clip_record', { ok: true, type: r.blob.type, kb: Math.round(r.blob.size / 1024) });
    set({ status: 'ready', blob: r.blob, url: URL.createObjectURL(r.blob) });
  },

  close() {
    const { url } = get();
    if (url) URL.revokeObjectURL(url);
    set({ status: 'idle', blob: null, url: null });
  },
}));
