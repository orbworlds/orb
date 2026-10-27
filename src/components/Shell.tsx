'use client';
// The app shell shared by every page: the live world, the Orb (chat · you), the world bar, the
// building pill and the sheets layered over the world. Pages only choose how to start
// (start canvas, a world, or Explore); navigation afterwards happens in place without remounts.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useSession } from '@/components/orb/AccountCard';
import { BuildingPill } from '@/components/orb/BuildingPill';
import { ChatView } from '@/components/orb/ChatView';
import { ExploreSheet } from '@/components/orb/ExploreSheet';
import { HomeIntro } from '@/components/orb/Hero';
import { Orb, ORB_MARGIN, ORB_SIZE, OrbSphere } from '@/components/orb/Orb';
import { OrbPanel, PANEL_REACH } from '@/components/orb/OrbPanel';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Toaster } from '@/components/ui/Toaster';
import { WorldBar, type WorldBarActions } from '@/components/world/WorldBar';
import { WorldStage } from '@/components/world/WorldStage';
import { useBuild, type BackgroundBuild, type BuildHost } from '@/lib/engine/useBuild';
import { track } from '@/lib/analytics';
import { api, worldHref } from '@/lib/api';
import { setChatSync } from '@/lib/chatsync';
import { trackVisualViewport } from '@/lib/viewport';
import { TEMPLATE_BY_ID } from '@/lib/templates';
import type { WorldFull } from '@/lib/types';
import { useFriendsSync, useFriendUnread } from '@/state/friends';
import { useInviteWelcome } from '@/state/invites';
import { useGitHubLinks } from '@/state/links';
import { useClip } from '@/state/clips';
import { takeParams } from '@/state/share';
import { useShop } from '@/state/shop';
import { toast, useToasts } from '@/state/toast';
import { trackBackgroundBuild, trackPrompt, trackWorldError, useTracking } from '@/state/tracking';
import { popLayer, useBackCloses, useIsMobile, usePhone, useUi, whenShown } from '@/state/ui';
import { buildModeFor, getFrameHandle, useWorld } from '@/state/world';
import { Spinner } from '@/components/ui/Spinner';
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

type ShellMode = 'start' | 'world' | 'explore' | 'plans';

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

/** A world's readable address (/<handle>/<slug>): open the world it names, or say it isn't there. */
function loadPath(handle: string, slug: string): void {
  const w = useWorld.getState();
  void api.resolvePath(handle, slug).then(
    ({ id }) => w.loadWorld(id),
    () => w.loadWorld(`${handle}/${slug}`), // shows "not found"
  );
}

/** Browser back/forward: show what the address says. */
function onPop(): void {
  if (popLayer()) return; // Back closed the sheet or a profile
  const r = routeFromLocation();
  const w = useWorld.getState();
  const u = useUi.getState();
  if (r.kind !== 'profile') u.closeProfile();
  if (r.kind !== 'plans') u.setPlans(false);
  if (r.kind === 'world') void w.loadWorld(r.id);
  else if (r.kind === 'path') loadPath(r.handle, r.slug);
  else if (r.kind === 'plans') u.setPlans(true);
  else if (r.kind === 'profile') {
    u.openProfile(r.handle);
    if (w.world) void w.loadTemplate('blank');
  } else {
    // The start screen, or Explore: the home page (down at its worlds)
    u.setHeroDone(false);
    u.setIntro(null);
    u.closePanel();
    if (r.kind === 'start' && r.prompt) u.setDraft(r.prompt);
    void w.loadTemplate(r.kind === 'start' ? (r.template ?? 'blank') : 'blank');
  }
}

// ---- actions shared by home, the world bar and the chat (they read the stores, nothing of a render) ----

/** Open a world (with its chat on the Orb's next open: a world opened from the You tab shows it). */
function openWorld(id: string): void {
  useUi.getState().setHeroDone(true);
  useUi.getState().setTab('chat');
  void useWorld.getState().openWorld(id);
}

/** Close the maker's profile; the address leaves their page (/<handle>) when it was that. */
function closeProfileSheet(): void {
  useUi.getState().closeProfile();
  if (routeFromLocation().kind === 'profile') {
    const w = useWorld.getState().world;
    window.history.replaceState(null, '', w ? worldHref(w) : '/');
  }
}

/** Jump to a world whose build ran in the background, with its chat open. */
function openBuiltWorld(id: string): void {
  track('world_open', { world_id: id, source: 'built' });
  openWorld(id);
  useUi.getState().openPanel('chat');
}

/** A world of one's own, copied from this one (home stays until the copy is on its way). */
function remixWorld(id: string): void {
  void useWorld.getState().remix(id).then((copy) => copy && useUi.getState().setHeroDone(true));
}

// One click from any world back to Explore, as it was left (Explore keeps its scroll and filters).
// Browser back from there returns to the world.
function backToExplore(): void {
  track('explore_back', { world_id: useWorld.getState().world?.id });
  useUi.getState().requestExplore();
}

/** "Use your own key": straight to the AI section, under the You tab's Advanced. */
function openKeys(): void {
  const u = useUi.getState();
  u.openPanel('you', 'full');
  u.setAdvanced(true);
  whenShown('orb-model-h', (el) => {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const section = el.closest('section');
    const radio = section?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? section?.querySelector<HTMLElement>('[role="radio"]');
    radio?.focus({ preventScroll: true });
  });
}

const barActions: WorldBarActions = {
  onExplore: backToExplore,
  onShare: () => useUi.getState().setShare(true),
  onHistory: () => useUi.getState().setHistory(true),
  onOpenWorld: openWorld,
};

export default function Shell({
  mode,
  worldId,
  worldPath,
  initialWorld,
  initialProfile,
  explore,
}: {
  mode: ShellMode;
  worldId?: string;
  /** "<handle>/<slug>" when the server couldn't resolve the address itself. */
  worldPath?: string;
  initialWorld?: WorldFull | null;
  /** A maker's page (/<handle>): their profile opens over the start canvas. */
  initialProfile?: string;
  /** /explore's address (?filter=…&sort=…&q=…): what Explore starts on. */
  explore?: { filter?: string; sort?: string; q?: string };
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
  // Phones: the system Back closes the sheet, then a profile over it (not a maker's page itself).
  useBackCloses(mobile && ui.panelOpen, () => useUi.getState().closePanel());
  const profileIsPage = useMemo(() => !!ui.profile && routeFromLocation().kind === 'profile', [ui.profile]);
  useBackCloses(mobile && !!ui.profile && !profileIsPage, closeProfileSheet);
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
        else if (st === 'error') toast(`Couldn’t build “${worldName}” right now`, 'error', open);
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
      .then((me) => void setChatSync(!!me?.user));
    if (/(^|[#&])gh_(token|error)=/.test(window.location.hash) || localStorage.getItem('orb:github'))
      void import('@/components/orb/GitHubConnect').then((m) => Promise.all([m.consumeGitHubTokenFromHash(), m.moveBrowserToken()]));
    warmLazySheets();
    welcomeBack();
    trackVisualViewport();

    if (mode === 'world' && !worldId && worldPath) {
      const [h, s] = worldPath.split('/');
      loadPath(h, s);
    } else if (mode === 'world' && worldId) {
      void w.loadWorld(worldId, initialWorld ?? null);
    } else {
      const sp = new URLSearchParams(window.location.search);
      const prompt = sp.get('prompt')?.slice(0, 2000);
      const template = sp.get('template');
      if (prompt) u.setDraft(prompt);
      void w.loadTemplate(template && TEMPLATE_BY_ID[template] ? template : 'blank');
      if (mode === 'explore') u.requestExplore();
      if (mode === 'plans') u.setPlans(true);
      if (initialProfile) u.openProfile(initialProfile);
    }
  }, [mode, worldId, worldPath, initialWorld, initialProfile]);

  // Owners land with the chat open on desktop once ownership is confirmed.
  const openedForOwner = useRef<string | null>(null);
  useEffect(() => {
    if (!world || !ws.verified || !canEdit || mobile) return;
    if (openedForOwner.current === world.id) return;
    openedForOwner.current = world.id;
    if (mode === 'world' && !useUi.getState().panelOpen) useUi.getState().openPanel('chat');
  }, [world, ws.verified, canEdit, mobile, mode]);

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
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // ---- the tab's title follows what's on screen (page metadata only titles the first page) --------
  // Your own world goes by its name alone (a remix's copied maker would say someone else made it).
  const worldName = world?.name;
  const maker = canEdit ? null : world?.authorName;
  useEffect(() => {
    if (status === 'loading' || status === 'idle') return; // keep the last title until the next world is in
    if (ui.profile) return; // the profile sheet names its maker
    document.title =
      ui.plansOpen && window.location.pathname.startsWith('/pricing')
        ? 'Plans · Orb'
        : !worldName && window.location.pathname.startsWith('/explore')
        ? 'Explore worlds · Orb'
        : status === 'not-found'
          ? 'A world on Orb'
          : worldName
            ? `${worldName}${maker ? ` by ${maker}` : ''} · Orb`
            : 'Orb — make and play worlds';
  }, [status, worldName, maker, ui.profile, ui.plansOpen]);

  // ---- unread dot when a build finishes while the panel is closed ----------------------------------
  const wasBuilding = useRef(false);
  useEffect(() => {
    if (wasBuilding.current && !build.isBuilding) {
      useUi.getState().setUnread(true); // (only while the panel is closed)
      // What the build used: the credits as the server counts them now.
      void useBilling.getState().load(true);
    }
    wasBuilding.current = build.isBuilding;
  }, [build.isBuilding]);

  // ---- hero (start canvas) ---------------------------------------------------------------------------
  // Landing on a world's address, home waits for the start canvas (going home from there loads it).
  const heroVisible = !world && status !== 'not-found' && status !== 'error' && !ui.heroDone && (mode !== 'world' || ws.onStart);
  const exploreUsed = useEver(heroVisible);

  // ---- keyboard: ⌘/Ctrl+K focuses the chat -------------------------------------------------------
  const onCmdK = useEffectEvent((e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return;
    e.preventDefault();
    const u = useUi.getState();
    if (!heroVisible) u.openPanel('chat');
    u.requestFocus();
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onCmdK(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // Explore is the home page: every way to it (the Explore pill, the world bar's, "See all") goes home,
  // to its worlds as they were left. A world is left (a build of one's own goes on in the background,
  // and the page's composer starts a new world, never a change to that one); browser back returns to it.
  const exploreRequest = useUi((s) => s.exploreRequest);
  useEffect(() => {
    if (!exploreRequest) return;
    useUi.getState().closePanel();
    if (useWorld.getState().world || useUi.getState().heroDone) void useWorld.getState().goStart({});
  }, [exploreRequest]);

  // In a world that runs on its maker's site (embedded), Orb can't see inside it: what the chat's
  // composer says starts a world of one's own, built from it on the start canvas.
  const newWorldFrom = useRef<string | null>(null);
  const makeOwn = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    trackPrompt('chat', t);
    newWorldFrom.current = t;
    void useWorld.getState().goStart({ chat: true });
  }, []);
  useEffect(() => {
    const t = newWorldFrom.current;
    if (!t || world || chatKey !== 'new' || status !== 'ready') return;
    newWorldFrom.current = null;
    void build.send(t);
  });

  // Remix offered under an answer in someone else's world: remix it, then (when they had asked for a
  // change) send that request again in the copy, once it's the world on screen and the chat is its chat.
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

  const panelDocked = ui.panelOpen && !mobile;

  return (
    <main className="fixed inset-0 overflow-hidden">
      <WorldStage
        home={heroVisible}
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
                New world
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
      {!ui.panelOpen && <BuildingPill isBuilding={build.isBuilding} progress={build.progress} messages={build.messages} top={mobile && world ? 'calc(var(--safe-t) + 74px)' : 'calc(var(--safe-t) + 18px)'} />}

      {!heroVisible && status !== 'not-found' && status !== 'error' && (
        <ExploreBack ready={ws.drawn} touch={mobile} inset={panelDocked && ui.orb.side === 'left' ? PANEL_REACH : 0} onClick={backToExplore} />
      )}

      {/* Home has the Orb in its header (it opens the You tab: the page's own composer is the chat). */}
      <Orb
        building={build.isBuilding || build.background.length > 0}
        unread={ui.unread || friendUnread > 0}
        hidden={heroVisible || (mobile && ui.panelOpen)}
        // Phones: half behind its edge, off a world's touch controls
        tucked={phone}
        onToggle={() => (ui.panelOpen ? ui.closePanel() : !ui.unread && friendUnread > 0 ? ui.openPanel('you') : ui.openPanel())}
      />

      <OrbPanel
        home={heroVisible}
        header={
          <>
            <BackgroundBuilds builds={build.background} />
            <WorldBar visible={!!world && status === 'ready'} actions={{ ...barActions, onNewChat: build.messages.length && !build.isBuilding ? build.newThread : undefined }} />
          </>
        }
        youBadge={friendUnread}
        chat={
          <ChatView
            build={build}
            onOpenKeys={openKeys}
            onOpenWorld={openWorld}
            onMakeOwn={makeOwn}
            onRemix={(request) => void remixWith(request)}
            onStartFrom={remixWorld}
          />
        }
        you={<YouView onOpenWorld={openWorld} onNewWorld={() => void useWorld.getState().goStart({ chat: true })} />}
      />

      {/* Explore, which is also the home page (under an invitation to make a world). */}
      {exploreUsed && (
        <ExploreSheet
          open={heroVisible}
          intro={<HomeIntro onSend={sendFromHero} onRemix={remixWorld} onOpenWorld={openWorld} onOpenMine={() => ui.openPanel('you')} />}
          building={build.isBuilding || build.background.length > 0}
          start={explore}
          onOpenWorld={openWorld}
          onRemix={(card) => remixWorld(card.id)}
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
          onClose={closeProfileSheet}
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

      {/* Toasts: just above the phone's open sheet; beside the docked panel, or the Orb in a world; else at the bottom. */}
      <Toaster
        anchor={
          mobile && ui.panelOpen
            ? 'sheet'
            : heroVisible && !panelDocked
              ? null
              : { side: ui.orb.side, y: ui.orb.y, narrow: mobile, clear: panelDocked ? PANEL_REACH : ORB_MARGIN + ORB_SIZE }
        }
      />
    </main>
  );
}

/**
 * Back from Stripe (/api/billing/return adds ?billing=pro|topup|pending, payout setup
 * ?billing=payouts|payouts-pending): say how it went, once, and show the new credits.
 */
function welcomeBack(): void {
  const [note] = takeParams('billing');
  if (!note) return;
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
 * Where the top-left corner brings the way back again (a pointer reaching it, a tap near it): the
 * corner itself and where the pill sits, so reaching for it where it was brings it back.
 */
const CORNER = { width: 'calc(var(--safe-l) + 128px)', height: 'calc(var(--safe-t) + 60px)' };

/**
 * Top-left while a world opens: "Explore", back to it in one click. A few seconds after the world is
 * ready it fades away and leaves the world the whole screen (its own controls often live there);
 * the pointer reaching the top-left corner brings it back. Phones have no pointer to reach with,
 * so there it shrinks to a small round arrow that stays.
 */
function ExploreBack({ ready, touch, inset, onClick }: { ready: boolean; touch: boolean; inset: number; onClick(): void }) {
  // `wake` counts the times it's asked to show (a world opening, the corner); gone once that one has had its time.
  const [wake, setWake] = useState(0);
  const [goneAt, setGoneAt] = useState(-1);
  const [wasReady, setWasReady] = useState(ready);
  if (ready !== wasReady) {
    setWasReady(ready);
    if (!ready) setWake(wake + 1);
  }
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setGoneAt(wake), 4000);
    return () => clearTimeout(t);
  }, [ready, wake]);
  const settled = goneAt === wake;
  const gone = settled && !touch;
  const small = settled && touch;
  // A tap that brings it back ends in a click where it now is: that one isn't a click on it.
  const tapped = useRef(-1e9);
  const again = (e?: ReactPointerEvent) => {
    if (e?.type === 'pointerdown' && e.pointerType !== 'mouse') tapped.current = performance.now();
    setWake((n) => n + 1);
  };
  // Moves, not enters: a pointer that went on into the world's frame may still be here for the page,
  // whose own changes (the pill fading) then "enter" the corner without anyone reaching for it.
  return (
    <>
      {gone && <div aria-hidden="true" className="fixed top-0 z-30" style={{ ...CORNER, left: inset }} onPointerMove={again} onPointerDown={again} />}
      <div
        className={`fixed z-30 transition-[opacity,transform] duration-500 ease-[var(--ease)] ${gone ? 'pointer-events-none -translate-y-1 opacity-0' : ''}`}
        style={{ top: 'calc(var(--safe-t) + 12px)', left: `calc(var(--safe-l) + ${12 + inset}px)` }}
        aria-hidden={gone}
        // The pointer moving on it keeps it (its leave into the world's frame may never reach the page).
        onPointerMove={() => again()}
      >
        <button
          type="button"
          onClick={() => performance.now() - tapped.current > 700 && onClick()}
          aria-label="Back to Explore"
          title="Back to Explore"
          tabIndex={gone ? -1 : 0}
          className={`glass animate-pop flex h-10 items-center gap-1.5 rounded-full text-[14px] font-medium text-ink active:scale-[.96] ${small ? 'w-10 justify-center' : 'pr-3.5 pl-2.5'}`}
        >
          <Icon name="arrow-left" size={18} strokeWidth={2} />
          {!small && 'Explore'}
        </button>
      </div>
    </>
  );
}
