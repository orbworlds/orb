'use client';
// What the app shell reports to Orb's analytics (src/lib/analytics.ts) from its stores and the
// build engine; components track their own clicks (world_open from Explore, a chat, your worlds…):
// - world_open for a world that came by its address: a link, a reload, the browser's back button;
// - world_leave with the seconds a world was in view, whenever it stops being seen (another world,
//   the start canvas, the tab hidden or closed);
// - explore_open and share_open;
// - build_done when a build on screen finishes (trackBackgroundBuild: one that ran in the background);
// - prompt_send from the composers (trackPrompt);
// - world_error when the world on screen throws (trackWorldError).
// Module state, so the shell's effects running twice (React in development) count nothing twice.

import { useEffect } from 'react';
import { onLeave, setWorldContext, track, trackPageView } from '@/lib/analytics';
import type { UseBuild } from '@/lib/engine/useBuild';
import { getModelSettings } from '@/lib/local';
import type { BuildInfo, ChatMessage, WorldRuntimeError } from '@/lib/types';
import { useUi } from './ui';
import { buildModeFor, useWorld } from './world';

type WorldState = ReturnType<typeof useWorld.getState>;
type UiState = ReturnType<typeof useUi.getState>;
interface Arrival {
  source: 'link' | 'reload' | 'back';
  /** The world on screen when it started: the arrival is the next load. */
  from: string | null;
  until: number;
}

/** A world's address (/w/<id> or /<handle>/<slug>), as the shell reads it. */
const WORLD_PATH = /^\/(?!explore(\/|$))[^/]+\/[^/]+\/?$/;

let landing: Arrival | null | undefined;
let arriving: Arrival | null = null;
let seen: { id: string; since: number | null } | null = null;
let sheets = { explore: false, share: false };
let watched: { threadId: string; status: Map<string, BuildInfo['status']> } | null = null;
/** When the latest build of each chat started, for builds that finish in the background. */
const buildStarts = new Map<string, number>();

export function useTracking(build: UseBuild): void {
  useEffect(() => start(), []);
  useEffect(() => watchBuilds(build.threadId, build.messages), [build.threadId, build.messages]);
}

const worldErrors = new Set<string>();
/** The world on screen threw (its own bug, or the browser's, like a lost GPU context): the first five per page load. */
export function trackWorldError(e: WorldRuntimeError): void {
  const message = typeof e?.message === 'string' ? e.message.slice(0, 200) : '';
  if (!message || worldErrors.size >= 5 || worldErrors.has(message)) return;
  worldErrors.add(message);
  track('world_error', { message, line: typeof e.line === 'number' ? e.line : undefined });
}

export function trackPrompt(where: 'hero' | 'chat' | 'suggestion', text: string): void {
  const s = useWorld.getState();
  const ai = getModelSettings();
  track('prompt_send', { where, text: text.slice(0, 200), length: text.length, provider: ai.provider ?? 'free', model: ai.model, is_new_world: !s.world, mode: buildModeFor(s) });
}

export function trackBackgroundBuild(chatKey: string, status: BuildInfo['status'], error?: string): void {
  const since = buildStarts.get(chatKey);
  track('build_done', {
    world_id: chatKey === 'new' ? null : chatKey,
    status,
    seconds: since ? Math.round((Date.now() - since) / 1000) : undefined,
    error: error?.slice(0, 120),
    background: true,
  });
}

function start(): () => void {
  setWorldContext(() => useWorld.getState().world?.id ?? null);
  trackPageView();
  if (landing === undefined) {
    landing = WORLD_PATH.test(location.pathname) ? { source: arrival(), from: null, until: Infinity } : null;
    arriving = landing;
  }
  const s = useWorld.getState();
  onWorld(s, s);
  onSheets(useUi.getState());
  const offWorld = useWorld.subscribe(onWorld);
  const offUi = useUi.subscribe(onSheets);
  const offLeave = onLeave(() => pause('hidden'));
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('pageshow', resume);
  window.addEventListener('popstate', onPop);
  return () => {
    offWorld();
    offUi();
    offLeave();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('pageshow', resume);
    window.removeEventListener('popstate', onPop);
  };
}

function arrival(): Arrival['source'] {
  const nav = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
  return nav?.type === 'reload' ? 'reload' : nav?.type === 'back_forward' ? 'back' : 'link';
}

function onWorld(s: WorldState, prev: WorldState): void {
  const id = s.world?.id ?? null;
  if (id !== (seen?.id ?? null)) {
    pause('left');
    seen = id ? { id, since: document.visibilityState === 'visible' ? Date.now() : null } : null;
  }
  const a = arriving;
  // The arrival is the load that follows it: a new world, or the end of a load (even of the same one).
  if (!a || s.status === 'loading' || s.status === 'idle' || (id === a.from && prev.status !== 'loading')) return;
  arriving = null;
  if (id && Date.now() < a.until) {
    trackPageView();
    track('world_open', { world_id: id, source: a.source });
  }
}

function onPop(): void {
  arriving = WORLD_PATH.test(location.pathname) ? { source: 'back', from: useWorld.getState().world?.id ?? null, until: Date.now() + 10_000 } : null;
}

function pause(why: 'left' | 'hidden'): void {
  if (!seen || seen.since === null) return;
  const seconds = Math.round((Date.now() - seen.since) / 1000);
  seen.since = null;
  if (seconds > 0) track('world_leave', { world_id: seen.id, seconds, why });
}

function resume(): void {
  if (document.visibilityState === 'visible' && seen && seen.since === null) seen.since = Date.now();
}

function onSheets(u: UiState): void {
  if (u.exploreOpen && !sheets.explore) track('explore_open');
  if (u.shareOpen && !sheets.share) track('share_open');
  sheets = { explore: u.exploreOpen, share: u.shareOpen };
}

/** A build that was streaming in the chat on screen has finished. */
function watchBuilds(threadId: string, messages: ChatMessage[]): void {
  if (watched?.threadId !== threadId) watched = { threadId, status: new Map() };
  const chatKey = useWorld.getState().chatKey;
  for (const m of messages) {
    const b = m.build;
    if (!b) continue;
    const before = watched.status.get(m.id);
    watched.status.set(m.id, b.status);
    if (b.status === 'streaming') buildStarts.set(chatKey, m.createdAt);
    else if (before === 'streaming') {
      track('build_done', {
        status: b.status,
        seconds: Math.round((Date.now() - m.createdAt) / 1000),
        steps: b.steps.length,
        saved: b.toVersion != null,
        repair: b.repair || undefined,
        error: b.error?.slice(0, 120),
        repair_failed: b.repairFailed?.slice(0, 200),
      });
    }
  }
}
