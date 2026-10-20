'use client';
// The app shell shared by every page: the live world, the Orb (chat · explore · you), the world
// bar, the building pill and the sheets layered over the world. Pages only choose how to start
// (start canvas, a world, or Explore); navigation afterwards happens in place without remounts.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AccountCard } from '@/components/orb/AccountCard';
import { BuildingPill } from '@/components/orb/BuildingPill';
import { ChatView } from '@/components/orb/ChatView';
import { ExploreSheet } from '@/components/orb/ExploreSheet';
import { HomeIntro } from '@/components/orb/Hero';
import { dockedOrbStyle, Orb, ORB_MARGIN, ORB_SIZE, OrbSphere } from '@/components/orb/Orb';
import { OrbPanel } from '@/components/orb/OrbPanel';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Toaster } from '@/components/ui/Toaster';
import { WorldBar, type WorldBarActions } from '@/components/world/WorldBar';
import { WorldStage } from '@/components/world/WorldStage';
import { useBuild, type BackgroundBuild, type BuildHost } from '@/lib/engine/useBuild';
import { track } from '@/lib/analytics';
import { api, worldHref } from '@/lib/api';
import { setChatSync } from '@/lib/chatsync';
import { readJSON, writeJSON } from '@/lib/local';
import { trackVisualViewport } from '@/lib/viewport';
import { TEMPLATE_BY_ID } from '@/lib/templates';
import type { WorldFull } from '@/lib/types';
import { useFriendsSync, useFriendUnread } from '@/state/friends';
import { useInviteWelcome } from '@/state/invites';
import { useGitHubLinks } from '@/state/links';
import { useClip } from '@/state/clips';
import { useShop } from '@/state/shop';
import { toast, useToasts } from '@/state/toast';
import { trackBackgroundBuild, trackPrompt, trackWorldError, useTracking } from '@/state/tracking';
import { useIsMobile, usePhone, useUi } from '@/state/ui';
import { bindCurrentThread, buildModeFor, getFrameHandle, useWorld } from '@/state/world';
import { Spinner } from '@/components/ui/Spinner';
import { useSession } from '@/components/orb/AccountCard';
import { useBilling } from '@/state/billing';

// Sheets and tabs that are closed when a page opens load on first use, so the first screen
// doesn't wait for their code.
const YouView = dynamic(() => import('@/components/orb/YouView').then((m) => m.YouView), { ssr: false });
const HistorySheet = dynamic(() => import('@/components/world/HistorySheet').then((m) => m.HistorySheet), { ssr: false });
const ShareSheet = dynamic(() => import('@/components/world/ShareSheet').then((m) => m.ShareSheet), { ssr: false });
const ProfileSheet = dynamic(() => import('@/components/orb/ProfileSheet').then((m) => m.ProfileSheet), { ssr: false });
const PlansSheet = dynamic(() => import('@/components/orb/PlansSheet').then((m) => m.PlansSheet), { ssr: false });
const ClipSheet = dynamic(() => import('@/components/world/ClipSheet').then((m) => m.ClipSheet), { ssr: false });
const PurchaseSheet = dynamic(() => import('@/components/world/PurchaseSheet').then((m) => m.PurchaseSheet), { ssr: false });

/** Fetch the lazy sheets once the page is loaded and idle, so the first open is instant. */
function warmLazySheets(): void {
  const warm = () => {
    void import('@/components/orb/YouView');
    void import('@/components/world/HistorySheet');
    void import('@/components/world/ShareSheet');
    void import('@/components/orb/ProfileSheet');
    void import('@/components/orb/PlansSheet');
    void import('@/components/world/PurchaseSheet');
  };
  const idle = () => (typeof requestIdleCallback === 'function' ? requestIdleCallback(warm, { timeout: 4000 }) : setTimeout(warm, 1500));
  if (document.readyState === 'complete') idle();
  else window.addEventListener('load', idle, { once: true });
}

/** True from the first time `flag` is true (a sheet stays mounted after closing, for its exit animation). */
function useEver(flag: boolean): boolean {
  const [ever, setEver] = useState(flag);
  if (flag && !ever) setEver(true);
  return ever || flag;
}

export type ShellMode = 'start' | 'world' | 'explore' | 'plans';

const PANEL_W = 400;
const PANEL_GAP = 16;

/** Parse the current location into what the shell should show. */
function routeFromLocation():
  | { kind: 'start'; prompt?: string; template?: string }
  | { kind: 'world'; id: string }
  | { kind: 'path'; handle: string; slug: string }
  | { kind: 'profile'; handle: string }
  | { kind: 'explore' }
  | { kind: 'plans' } {
  const { pathname, search } = window.location;
  const m = pathname.match(/^\/w\/([^/]+)\/?$/);
  if (m) return { kind: 'world', id: decodeURIComponent(m[1]) };
  if (pathname.startsWith('/explore')) return { kind: 'explore' };
  if (/^\/pricing\/?$/.test(pathname)) return { kind: 'plans' };
  const p = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (p) return { kind: 'path', handle: decodeURIComponent(p[1]), slug: decodeURIComponent(p[2]) };
  const h = pathname.match(/^\/([a-z0-9][a-z0-9-]*)\/?$/i);
  if (h) return { kind: 'profile', handle: h[1].toLowerCase() };
  const sp = new URLSearchParams(search);
  return { kind: 'start', prompt: sp.get('prompt') ?? undefined, template: sp.get('template') ?? undefined };
}

export default function Shell({
  mode,
  worldId,
  worldPath,
  initialWorld,
  initialPrompt,
  initialTemplate,
  initialProfile,
}: {
  mode: ShellMode;
  worldId?: string;
  /** "<handle>/<slug>" when the server couldn't resolve the address itself. */
  worldPath?: string;
  initialWorld?: WorldFull | null;
  initialPrompt?: string;
  initialTemplate?: string;
  /** A maker's page (/<handle>): their profile opens over the start canvas. */
  initialProfile?: string;
}) {
  const ws = useWorld();
  const { world, canEdit, isExternal, chatKey, status } = ws;
  const ui = useUi();
  const shareUsed = useEver(ui.shareOpen);
  const historyUsed = useEver(ui.historyOpen);
  const profileUsed = useEver(!!ui.profile);
  const plansUsed = useEver(ui.plansOpen);
  const clipUsed = useEver(useClip((s) => s.status !== 'idle'));
  const shopUsed = useEver(useShop((s) => !!s.ask));
  const mobile = useIsMobile();
  const phone = usePhone();
  useFriendsSync();
  useInviteWelcome();
  useGitHubLinks();
  const friendUnread = useFriendUnread();

  // ---- build engine host (latest state is read lazily so the host object can stay stable) ----
  const host: BuildHost = useMemo(
    () => ({
      chatKey,
      mode: buildModeFor({ world, canEdit, isExternal }),
      // On the start canvas the world has no name yet, so the model titles it on the first build.
      worldName: world?.name ?? 'Untitled world',
      worldId: world?.id ?? null,
      getCode: () => useWorld.getState().baseCode ?? '',
      getVersion: () => useWorld.getState().world?.version ?? null,
      preview: (code) => useWorld.getState().preview(code),
      createWorld: (threadId) => useWorld.getState().createForBuild(threadId),
      isSettled: () => useWorld.getState().verified && useWorld.getState().status === 'ready',
      adoptVersion: (v) => useWorld.getState().adoptVersion(v),
      getPreview: () => useWorld.getState().previewCode,
      onBackgroundDone: ({ chatKey: key, worldName, status: st, error }) => {
        trackBackgroundBuild(key, st, error);
        const open = key !== 'new' ? { label: 'Open', onClick: () => openBuiltWorld(key) } : undefined;
        if (st === 'done') toast(`“${worldName}” is ready ✨`, 'success', open);
        else if (st === 'error') toast(`“${worldName}” hit a snag${error ? ` — ${error}` : ''}`, 'error', open);
      },
      restore: (v) => useWorld.getState().restore(v),
      getImage: async () => (await getFrameHandle()?.capture()) ?? null,
      look: (req, signal) => getFrameHandle()?.probe(req, signal) ?? Promise.resolve({ unavailable: 'The world is not on screen.' }),
      // The store moves on (another world, the start canvas) one render before this host is replaced.
      isCurrent: () => useWorld.getState().chatKey === chatKey,
    }),
    [chatKey, world, canEdit, isExternal],
  );
  const build = useBuild(host);
  useTracking(build);
  const buildRef = useRef(build);
  useEffect(() => {
    buildRef.current = build;
  });

  useEffect(() => {
    bindCurrentThread(() => buildRef.current.activeThreadId());
  }, []);

  // Set when Explore was opened by leaving a world (nothing is behind it any more).
  const leftWorld = useRef(false);
  const exploreAddress = useRef('/explore');
  const placeExplore = useCallback((address: string) => {
    exploreAddress.current = address;
  }, []);

  // ---- boot: player, orb position, GitHub OAuth hand-off, first route ------------------------------
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const w = useWorld.getState();
    const u = useUi.getState();
    void w.initPlayer();
    u.loadOrb();
    void useSession
      .getState()
      .loadMe()
      .then((me) => {
        signedInRef.current = !!me?.user;
        void setChatSync(!!me?.user);
      });
    if (/(^|[#&])gh_(token|error)=/.test(window.location.hash) || localStorage.getItem('orb:github'))
      void import('@/components/orb/GitHubConnect').then((m) => Promise.all([m.consumeGitHubTokenFromHash(), m.moveBrowserToken()]));
    warmLazySheets();
    welcomeBack();
    trackVisualViewport();

    if (mode === 'world' && !worldId && worldPath) {
      const [h, s] = worldPath.split('/');
      void api.resolvePath(h, s).then(
        ({ id }) => w.loadWorld(id),
        () => w.loadWorld(worldPath), // shows "not found"
      );
    } else if (mode === 'world' && worldId) {
      void w.loadWorld(worldId, initialWorld ?? null);
      // Owners on desktop see the chat; visitors see the world.
    } else {
      if (initialPrompt) u.setDraft(initialPrompt);
      void w.loadTemplate(initialTemplate && TEMPLATE_BY_ID[initialTemplate] ? initialTemplate : 'blank');
      if (mode === 'explore') u.requestExplore();
      if (mode === 'plans') u.setPlans(true);
      if (initialProfile) u.openProfile(initialProfile);
    }
  }, [mode, worldId, worldPath, initialWorld, initialPrompt, initialTemplate, initialProfile]);

  // Owners land with the chat open on desktop once ownership is confirmed.
  const openedForOwner = useRef<string | null>(null);
  useEffect(() => {
    if (!world || !ws.verified || !canEdit || mobile) return;
    if (openedForOwner.current === world.id) return;
    openedForOwner.current = world.id;
    if (mode === 'world' && !useUi.getState().panelOpen) useUi.getState().openPanel('chat');
  }, [world, ws.verified, canEdit, mobile, mode]);

  useEffect(() => {
    if (ui.panelOpen) writeJSON(ORB_OPENED_KEY, true);
  }, [ui.panelOpen]);

  // ---- "I'm in this world" while a public one is on screen (Explore's playing-now) ----------------
  const hereId = world && status === 'ready' && world.visibility === 'public' ? world.id : null;
  const hereSent = useRef(false);
  useEffect(() => {
    if (!hereId) {
      if (hereSent.current) void api.here(null).catch(() => {});
      hereSent.current = false;
      return;
    }
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      hereSent.current = true;
      void api.here(hereId).catch(() => {});
    };
    beat();
    const t = setInterval(beat, 45_000);
    document.addEventListener('visibilitychange', beat);
    const gone = () => navigator.sendBeacon?.('/api/here', new Blob([JSON.stringify({ worldId: null })], { type: 'application/json' }));
    window.addEventListener('pagehide', gone);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', beat);
      window.removeEventListener('pagehide', gone);
    };
  }, [hereId]);

  // ---- the browser's storage is full (big world saves): say so once instead of failing silently ----
  useEffect(() => {
    let told = false;
    const on = () => {
      if (told) return;
      told = true;
      toast('This browser’s storage is full, so some things may not be saved. Sign in to keep your chats safe in your account.', 'error');
    };
    window.addEventListener('orb:storage-full', on);
    return () => window.removeEventListener('orb:storage-full', on);
  }, []);

  // ---- browser back/forward ------------------------------------------------------------------------
  useEffect(() => {
    const onPop = () => {
      const r = routeFromLocation();
      const w = useWorld.getState();
      const u = useUi.getState();
      if (r.kind !== 'profile') u.closeProfile();
      if (r.kind !== 'plans') u.setPlans(false);
      if (r.kind === 'world') {
        u.setExplore(false);
        void w.loadWorld(r.id);
      } else if (r.kind === 'path') {
        u.setExplore(false);
        void api.resolvePath(r.handle, r.slug).then(
          ({ id }) => w.loadWorld(id),
          () => w.loadWorld(`${r.handle}/${r.slug}`), // shows "not found"
        );
      } else if (r.kind === 'explore') {
        // Explore is the home page (down at its worlds)
        u.setExplore(false);
        u.setHeroDone(false);
        u.setIntro(null);
        u.closePanel();
        void w.loadTemplate('blank');
      } else if (r.kind === 'plans') {
        u.setPlans(true);
      } else if (r.kind === 'profile') {
        u.setExplore(false);
        u.openProfile(r.handle);
        if (w.world) void w.loadTemplate('blank');
      } else {
        u.setExplore(false);
        u.setHeroDone(false);
        u.setIntro(null);
        u.closePanel();
        if (r.prompt) u.setDraft(r.prompt);
        void w.loadTemplate(r.template ?? 'blank');
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // ---- the tab's title follows what's on screen (page metadata only titles the first page) --------
  const worldName = world?.name;
  useEffect(() => {
    if (status === 'loading' || status === 'idle') return; // keep the last title until the next world is in
    if (ui.profile) return; // the profile sheet names its maker
    document.title =
      ui.plansOpen && window.location.pathname.startsWith('/pricing')
        ? 'Plans · Orb'
        : (ui.exploreOpen || !worldName) && window.location.pathname.startsWith('/explore')
        ? 'Explore worlds · Orb'
        : status === 'not-found'
          ? 'A world on Orb'
          : worldName
            ? `${worldName} · Orb`
            : 'Orb';
  }, [status, worldName, ui.exploreOpen, ui.profile, ui.plansOpen]);

  // ---- keyboard: ⌘/Ctrl+K focuses the chat -------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const u = useUi.getState();
        u.setExplore(false);
        if (!heroVisibleRef.current) u.openPanel('chat');
        u.requestFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- unread dot when a build finishes while the panel is closed ----------------------------------
  const wasBuilding = useRef(false);
  const signedInRef = useRef(false);
  const [builds, setBuilds] = useState(0);
  useEffect(() => setBuilds(countBuild(0)), []);
  useEffect(() => {
    if (wasBuilding.current && !build.isBuilding && !useUi.getState().panelOpen) useUi.getState().setUnread(true);
    // What the build used: the credits as the server counts them now.
    if (wasBuilding.current && !build.isBuilding) void useBilling.getState().load(true);
    if (wasBuilding.current && !build.isBuilding && build.messages[build.messages.length - 1]?.build?.toVersion != null) {
      setBuilds(countBuild());
    }
    wasBuilding.current = build.isBuilding;
  }, [build.isBuilding]);

  // ---- hero (start canvas) ---------------------------------------------------------------------------
  // Landing on a world's address, home waits for the start canvas (going home from there loads it).
  const heroVisible = !world && status !== 'not-found' && status !== 'error' && !ui.heroDone && (mode !== 'world' || ws.onStart);
  const exploreUsed = useEver(ui.exploreOpen || heroVisible);
  const heroVisibleRef = useRef(heroVisible);
  useEffect(() => {
    heroVisibleRef.current = heroVisible;
  }, [heroVisible]);

  const sendFromHero = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    trackPrompt('hero', t);
    const u = useUi.getState();
    u.setHeroDone(true);
    u.setDraft('');
    u.openPanel('chat', 'half');
    void buildRef.current.send(t);
  }, []);

  const pickTemplate = useCallback(async (id: string) => {
    const t = TEMPLATE_BY_ID[id];
    if (!t) return;
    track('template_pick', { template: id });
    const u = useUi.getState();
    u.setHeroDone(true);
    await useWorld.getState().loadTemplate(id);
    u.setIntro({ text: `Here's your ${t.name}. What should we change?`, suggestions: t.suggestions, chatKey: 'new' });
    u.openPanel('chat', 'half');
  }, []);

  const remixFromHome = useCallback((id?: string) => {
    const u = useUi.getState();
    if (!id) return u.requestExplore('remix');
    track('home_remix', { world: id });
    u.setHeroDone(true);
    void useWorld.getState().remix(id);
  }, []);

  // ---- actions shared by the world bar and chat ---------------------------------------------------------
  const openWorld = useCallback((id: string) => {
    const u = useUi.getState();
    u.setExplore(false);
    u.setHeroDone(true);
    leftWorld.current = false;
    void useWorld.getState().openWorld(id);
  }, []);

  // One click from any world back to Explore, as it was left (Explore keeps its scroll and filters).
  // Browser back from there returns to the world.
  const backToExplore = useCallback(() => {
    track('explore_back', { world_id: useWorld.getState().world?.id });
    useUi.getState().requestExplore();
  }, []);

  // Explore is the home page: every way to it (the back arrow, the Orb's tab, "See all") goes home,
  // to its worlds as they were left. A world is left (a build of one's own goes on in the background,
  // and the page's composer starts a new world, never a change to that one); browser back returns to it.
  const exploreRequest = useUi((s) => s.exploreRequest);
  useEffect(() => {
    if (!exploreRequest) return;
    const u = useUi.getState();
    u.setExplore(false);
    u.closePanel();
    leftWorld.current = false;
    if (useWorld.getState().world || u.heroDone) void useWorld.getState().goStart({});
  }, [exploreRequest]);

  const makeLikeThis = useCallback(() => {
    const w = useWorld.getState().world;
    const prompt = w ? `Make something like “${w.name}”${w.description ? ` — ${w.description}` : ''}` : '';
    useUi.getState().setExplore(false);
    void useWorld.getState().goStart({ prompt });
  }, []);

  // "Make my own copy" in someone else's world: remix it, then (when they had asked for a change)
  // send that request again in the copy, once it's the world on screen and the chat is its chat.
  const afterRemix = useRef<{ worldId: string; text: string } | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const remixWith = useCallback(async (request?: string) => {
    const s = useWorld.getState();
    const id = s.world?.id;
    if (!id || s.isExternal || !s.world?.forkable) return;
    track('remix_offer', { world_id: id, with_request: !!request });
    const copy = await useWorld.getState().remix(id);
    if (!copy || !request?.trim()) return;
    afterRemix.current = { worldId: copy, text: request.trim() };
    rerender(); // the copy may already be on screen: look again once it's this render's world
  }, []);
  useEffect(() => {
    const p = afterRemix.current;
    if (!p || world?.id !== p.worldId || !canEdit || chatKey !== p.worldId) return;
    afterRemix.current = null;
    void build.send(p.text);
  });

  const barActions: WorldBarActions = useMemo(
    () => ({
      onShare: () => useUi.getState().setShare(true),
      onHistory: () => useUi.getState().setHistory(true),
      onOpenWorld: openWorld,
      onMakeLikeThis: makeLikeThis,
    }),
    [openWorld, makeLikeThis],
  );

  // "Use your own key": straight to the AI section, under the You tab's Advanced.
  const openKeys = useCallback(() => {
    const u = useUi.getState();
    u.openPanel('you', 'full');
    u.setAdvanced(true);
    let tries = 0;
    const reveal = () => {
      const el = document.getElementById('orb-model-h');
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        const section = el.closest('section');
        const radio = section?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? section?.querySelector<HTMLElement>('[role="radio"]');
        radio?.focus({ preventScroll: true });
      } else if (++tries < 20) requestAnimationFrame(reveal);
    };
    requestAnimationFrame(reveal);
  }, []);

  // ---- layout offsets: keep the bar and pill centered over the visible world ------------------------------
  const panelDocked = ui.panelOpen && !mobile;
  const pillOffset = useMemo(() => {
    const reserve = panelDocked ? PANEL_W + PANEL_GAP : 0;
    const left = !panelDocked ? '50%' : ui.orb.side === 'right' ? `calc((100vw - ${reserve}px) / 2)` : `calc(${reserve}px + (100vw - ${reserve}px) / 2)`;
    const top = mobile && world ? 'calc(var(--safe-t) + 74px)' : 'calc(var(--safe-t) + 18px)';
    return { left, top };
  }, [panelDocked, ui.orb.side, mobile, world]);

  return (
    <main className="fixed inset-0 overflow-hidden">
      {/* soft sky while the first world loads (matches the blank island's palette) */}
      <div aria-hidden className="absolute inset-0" style={{ background: 'linear-gradient(180deg, #b9c6f2 0%, #e7d6ef 55%, #fde3cf 100%)' }} />

      <WorldStage
        onReady={() => buildRef.current.reportReady()}
        onError={(e) => {
          buildRef.current.reportRuntimeError(e);
          trackWorldError(e);
        }}
      />

      {(status === 'not-found' || status === 'error') && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-6">
          <div className="glass-strong animate-pop max-w-sm rounded-[var(--r-panel)] p-7 text-center">
            <OrbSphere size={44} className="mx-auto mb-4" />
            <h1 className="font-display text-[30px] leading-tight">{status === 'not-found' ? 'This world drifted away' : 'Something went wrong'}</h1>
            <p className="mt-2 text-[14px] text-ink-2">
              {status === 'not-found' ? "It doesn't exist, or its maker keeps it private." : "We couldn't load this world. Check your connection and try again."}
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <Button variant="primary" icon="sparkle" onClick={() => void useWorld.getState().goStart({ replace: true, chat: true })}>
                Make a world
              </Button>
              <Button variant="glass" icon="compass" onClick={() => useUi.getState().requestExplore()}>
                Explore
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Nothing floats over the world but the Orb: world info lives in the Orb panel, and the
          building pill only shows while the panel (which narrates the build) is closed. */}
      {!ui.panelOpen && <BuildingPill isBuilding={build.isBuilding} progress={build.progress} messages={build.messages} offset={pillOffset} />}

      <OrbHint world={world} show={status === 'ready' && !ui.panelOpen && !build.isBuilding} side={ui.orb.side} y={ui.orb.y} />

      <ExploreBack
        worldId={world?.id ?? null}
        show={!!world && (status === 'ready' || status === 'loading') && !ui.exploreOpen && !heroVisible}
        inset={panelDocked && ui.orb.side === 'left' ? PANEL_W + PANEL_GAP : 0}
        onClick={backToExplore}
      />


      <Orb
        building={build.isBuilding || build.background.length > 0}
        unread={ui.unread || friendUnread > 0}
        hidden={ui.panelOpen}
        // Phones: off a world's touch controls and Explore's tiles (the start screen's top keeps it whole)
        tucked={phone && (!heroVisible || ui.exploreScrolled)}
        // At home the page's own composer is the chat, so the Orb opens You (unless a build has news).
        onOpen={() => (!ui.unread && (friendUnread > 0 || (heroVisible && !build.isBuilding)) ? ui.openPanel('you') : ui.openPanel())}
      />

      <OrbPanel
        building={build.isBuilding}
        header={
          <>
            <BackgroundBuilds builds={build.background} />
            <WorldBar visible={!!world && status === 'ready'} actions={barActions} />
            <SaveNudge show={builds >= 2 && !signedInRef.current && !!world?.canEdit} onSaved={() => (signedInRef.current = true)} />
          </>
        }
        onExplore={() => ui.requestExplore()}
        youBadge={friendUnread}
        chat={
          <ChatView
            build={build}
            onOpenKeys={openKeys}
            onOpenWorld={(id) => openWorld(id)}
            onMakeLikeThis={makeLikeThis}
            onRemix={(request) => void remixWith(request)}
            onStartFrom={(id) => {
              useUi.getState().setHeroDone(true);
              void useWorld.getState().remix(id);
            }}
          />
        }
        you={<YouView onOpenWorld={openWorld} onNewWorld={() => void useWorld.getState().goStart({ chat: true })} />}
      />

      {/* Explore, which is also the home page (under an invitation to make a world). */}
      {exploreUsed && (
        <ExploreSheet
          open={ui.exploreOpen || heroVisible}
          intro={
            heroVisible && !ui.exploreOpen ? (
              <HomeIntro onSend={sendFromHero} onPickTemplate={(id) => void pickTemplate(id)} onRemix={remixFromHome} onExplore={() => ui.requestExplore()} onOpenWorld={openWorld} onOpenMine={() => ui.openPanel('you')} />
            ) : undefined
          }
          onClose={() => {
            ui.setExplore(false);
            // Nothing behind Explore any more (its world was left): the start screen.
            if (leftWorld.current && !useWorld.getState().world) ui.setHeroDone(false);
            leftWorld.current = false;
            if (window.location.pathname.startsWith('/explore')) window.history.replaceState(null, '', world ? worldHref(world) : '/');
          }}
          onOpenWorld={openWorld}
          onPlace={placeExplore}
          onNewWorld={() => {
            ui.setExplore(false);
            void useWorld.getState().goStart({ chat: true });
          }}
          onRemix={(card) => {
            ui.setExplore(false);
            ui.setHeroDone(true);
            void useWorld.getState().remix(card.id);
          }}
        />
      )}

      {world && (
        <>
          {shareUsed && <ShareSheet open={ui.shareOpen} onClose={() => ui.setShare(false)} world={world} onChange={(patch) => void ws.patchWorld(patch)} />}
          {historyUsed && (
            <HistorySheet
              open={ui.historyOpen}
              onClose={() => ui.setHistory(false)}
              worldId={world.id}
              currentVersion={world.version}
              onRestore={(v) =>
                buildRef.current.isBuilding
                  ? toast('Wait for the build to finish (or stop it) before going back in time.')
                  : void ws.restore(v).then(
                  () => toast(`Restored version ${v}`, 'success'),
                  () => {
                    /* the store already told the user */
                  },
                )
              }
            />
          )}
        </>
      )}

      {profileUsed && (
        <ProfileSheet
          handle={ui.profile}
          onClose={() => {
            ui.closeProfile();
            if (routeFromLocation().kind === 'profile') window.history.replaceState(null, '', world ? worldHref(world) : '/');
          }}
          onOpenWorld={(id) => {
            ui.closeProfile();
            openWorld(id);
          }}
        />
      )}

      {clipUsed && <ClipSheet />}
      {shopUsed && <PurchaseSheet />}

      {plansUsed && (
        <PlansSheet
          open={ui.plansOpen}
          onClose={() => {
            ui.setPlans(false);
            if (routeFromLocation().kind === 'plans') window.history.replaceState(null, '', world ? worldHref(world) : '/');
          }}
        />
      )}


      <Toaster />
    </main>
  );
}

/**
 * Back from Stripe (/api/billing/return adds ?billing=pro|topup|pending, payout setup
 * ?billing=payouts|payouts-pending): say how it went, once, and show the new credits.
 */
function welcomeBack(): void {
  const url = new URL(window.location.href);
  const note = url.searchParams.get('billing');
  if (!note) return;
  url.searchParams.delete('billing');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const billing = useBilling.getState();
  if (note === 'pro' || note === 'topup') {
    track('checkout_done', { item: note });
    void billing.load(true).then((info) => {
      const text = note === 'topup' ? 'Your credits are in ✨ — happy building!' : `Welcome to Pro ✨ ${info ? `${info.plans.pro.credits.toLocaleString('en-US')} credits are yours this month.` : ''}`.trim();
      useToasts.getState().push({ text, tone: 'success' }, 7000);
      useUi.getState().openPanel('you');
    });
    return;
  }
  if (note === 'payouts' || note === 'payouts-pending') {
    track('payout_setup_done', { ready: note === 'payouts' });
    void billing.load(true);
    useUi.getState().openPanel('you');
    toast(note === 'payouts' ? 'Payouts are set up ✨ You can cash out what your worlds earn.' : 'Stripe still needs a few details before it can pay you: pick up where you left off any time.', note === 'payouts' ? 'success' : 'default');
    return;
  }
  toast('Thanks! Your credits will show up in a moment.');
  // Stripe's webhook brings it shortly: look again a few times.
  for (const ms of [4000, 12_000, 30_000]) setTimeout(() => void billing.load(true), ms);
}

/** Set once the person has opened the Orb: from then on they know where everything lives. */
const ORB_OPENED_KEY = 'orb:orb-opened';

/**
 * A brief whisper next to the Orb when a world opens: its name and maker, and that chat and
 * remix live in the Orb. Only until the person first opens the Orb; fades after ~2.5 s.
 */
function OrbHint({ world, show, side, y }: { world: WorldFull | null; show: boolean; side: 'left' | 'right'; y: number }) {
  const [visibleFor, setVisibleFor] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!world || !show || seen.current.has(world.id) || readJSON<boolean>(ORB_OPENED_KEY, false)) return;
    seen.current.add(world.id);
    setVisibleFor(world.id);
  }, [world, show]);
  // Its own effect: the world object is replaced while the hint shows (e.g. the play count
  // arrives), which must not cancel the fade.
  useEffect(() => {
    if (!visibleFor) return;
    const t = setTimeout(() => setVisibleFor(null), 2600);
    return () => clearTimeout(t);
  }, [visibleFor]);
  if (!world || !show || visibleFor !== world.id) return null;
  const orb = dockedOrbStyle(side, y);
  const gap = ORB_MARGIN + ORB_SIZE + 10;
  const own = world.canEdit;
  // Phones: sit just above the Orb (narrow screens have no room beside it, and worlds keep their
  // own controls along the bottom edge).
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;
  const below = y > 0.5;
  return (
    <div
      role="status"
      className="glass animate-pop pointer-events-none fixed z-30 max-w-[min(260px,calc(100vw-96px))] rounded-[14px] px-3 py-1.5"
      style={
        narrow
          ? {
              ...(below ? { bottom: `calc(100% - ${orb.top} + 10px)` } : { top: `calc(${orb.top} + ${ORB_SIZE + 10}px)` }),
              ...(side === 'right' ? { right: `calc(var(--safe-r) + ${ORB_MARGIN}px)` } : { left: `calc(var(--safe-l) + ${ORB_MARGIN}px)` }),
            }
          : {
              top: `calc(${orb.top} + 2px)`,
              ...(side === 'right' ? { right: `calc(var(--safe-r) + ${gap}px)` } : { left: `calc(var(--safe-l) + ${gap}px)` }),
            }
      }
    >
      <div className="truncate text-[13px] leading-[18px] text-ink">
        <span className="font-semibold">{world.name}</span>
        {!own && <span className="text-ink-2"> · by {world.authorName || 'someone'}</span>}
      </div>
      <div className="text-[11.5px] leading-4 text-ink-2">{own ? 'Tap Orb to keep building' : 'Tap Orb to chat or remix'}</div>
    </div>
  );
}

/** Successful builds made in this browser (adds `by`; returns the new total). */
function countBuild(by = 1): number {
  const n = readJSON<number>('orb:builds', 0) + by;
  if (by) writeJSON('orb:builds', n);
  return n;
}

/**
 * After a couple of builds, offer — once, gently — to keep this person's worlds safe with an
 * account (a username and password). Anonymous worlds otherwise live in one browser.
 */
function SaveNudge({ show, onSaved }: { show: boolean; onSaved(): void }) {
  const [dismissed, setDismissed] = useState(() => readJSON<boolean>('orb:nudge-dismissed', false));
  const [open, setOpen] = useState(false);
  if (!show || dismissed) return null;
  const close = () => {
    writeJSON('orb:nudge-dismissed', true);
    setDismissed(true);
  };
  if (open) {
    return (
      <div className="animate-fade-up mx-3 mb-2 rounded-[18px] bg-[color-mix(in_oklab,var(--iris-1)_10%,transparent)] px-3.5 py-3">
        <AccountCard
          variant="inline"
          where="nudge"
          reason="Keep your worlds safe"
          onSignedIn={() => {
            onSaved();
            close();
          }}
          onCancel={close}
        />
      </div>
    );
  }
  return (
    <div className="animate-fade-up mx-3 mb-2 flex items-center gap-3 rounded-[18px] bg-[color-mix(in_oklab,var(--iris-1)_10%,transparent)] px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-semibold text-ink">Keep your worlds safe</div>
        <div className="text-[12px] leading-snug text-ink-2">Pick a username and a password. Then they&apos;re yours on every device.</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          Save
        </Button>
        <button type="button" onClick={close} className="text-[11.5px] text-ink-3 hover:text-ink-2">
          Not now
        </button>
      </div>
    </div>
  );
}

/** Jump to a world whose build ran in the background, with its chat open. */
function openBuiltWorld(id: string): void {
  track('world_open', { world_id: id, source: 'built' });
  const u = useUi.getState();
  u.setExplore(false);
  u.setHeroDone(true);
  void useWorld.getState().openWorld(id);
  u.openPanel('chat');
}

/** Builds still running for other worlds: they keep going while you work here. */
function BackgroundBuilds({ builds }: { builds: BackgroundBuild[] }) {
  if (!builds.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pb-2">
      {builds.map((b, i) => (
        <button
          key={`${b.chatKey}:${i}`}
          type="button"
          disabled={b.chatKey === 'new'}
          onClick={() => openBuiltWorld(b.chatKey)}
          className="flex max-w-full items-center gap-2 rounded-full bg-ink/5 px-3 py-1.5 text-[12.5px] text-ink-2 transition hover:bg-ink/10 disabled:cursor-default disabled:hover:bg-ink/5"
          title={b.chatKey === 'new' ? 'Still building — it will show up in your worlds' : 'Open this world'}
        >
          <Spinner size={12} />
          <span className="truncate">
            Still building <span className="font-medium text-ink">{b.worldName}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Top-left in every world: back to Explore in one click. It says "Explore" when a world opens, then
 * folds to an arrow so the world has the screen; hovering or focusing it unfolds it again.
 */
function ExploreBack({ worldId, show, inset, onClick }: { worldId: string | null; show: boolean; inset: number; onClick(): void }) {
  const [foldedFor, setFoldedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!worldId || !show) return;
    const t = setTimeout(() => setFoldedFor(worldId), 3500);
    return () => clearTimeout(t);
  }, [worldId, show]);
  if (!show) return null;
  const folded = foldedFor === worldId;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back to Explore"
      title="Back to Explore"
      className="glass group/back animate-pop fixed z-30 flex h-10 items-center rounded-full pr-3.5 pl-2.5 text-[14px] font-medium text-ink transition-[padding,transform,opacity] duration-300 ease-[var(--ease)] hover:pr-3.5 focus-visible:rounded-full active:scale-[.96] data-[folded=true]:pr-2.5 data-[folded=true]:opacity-80 data-[folded=true]:hover:pr-3.5 data-[folded=true]:hover:opacity-100 data-[folded=true]:focus-visible:pr-3.5"
      data-folded={folded}
      style={{ top: 'calc(var(--safe-t) + 12px)', left: `calc(var(--safe-l) + ${12 + inset}px)` }}
    >
      <Icon name="arrow-left" size={18} strokeWidth={2} />
      <span
        className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-300 ease-[var(--ease)] ${
          folded ? 'ml-0 max-w-0 opacity-0 group-hover/back:ml-1.5 group-hover/back:max-w-[80px] group-hover/back:opacity-100 group-focus-visible/back:ml-1.5 group-focus-visible/back:max-w-[80px] group-focus-visible/back:opacity-100' : 'ml-1.5 max-w-[80px] opacity-100'
        }`}
      >
        Explore
      </span>
    </button>
  );
}
