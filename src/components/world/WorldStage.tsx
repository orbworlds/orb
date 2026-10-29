'use client';
// The full-bleed world behind everything (never behind home). While nothing is drawn yet, a soft
// sky (never a spinner); a world being opened is covered by its preview and name until it has
// drawn; changes to the world on screen cross-fade in place (WorldFrame).
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { withTree } from '@/lib/tree';
import WorldFrame from '@/components/world/WorldFrame';
import { askPurchase } from '@/state/shop';
import { copyLink, shareUrl } from '@/state/share';
import { getWorldStorage } from '@/lib/local';
import { isDraftWorldId } from '@/lib/runtime/bridge';
import { setRoomIdentity } from '@/lib/runtime/realtime';
import { ROOM_NAME_RE } from '@/lib/runtime/sdk';
import type { RuntimeContext, WorldFull, WorldRuntimeError } from '@/lib/types';
import { needsKeyboard, onPhone } from '@/lib/keyboard';
import { PANEL_REACH } from '@/components/orb/OrbPanel';
import { Button } from '@/components/ui/Button';
import { addPhotos } from '@/lib/photos';
import { previewVideo } from '@/lib/previews';
import { toast } from '@/state/toast';
import { useIsMobile, useUi } from '@/state/ui';
import { setFrameHandle, useWorld } from '@/state/world';

/** The room an invite link asked for: `?room=` on this page. */
function invitedRoom(): string | null {
  if (typeof window === 'undefined') return null;
  const room = new URLSearchParams(window.location.search).get('room');
  return room && ROOM_NAME_RE.test(room) ? room : null;
}

/** orb.room.invite: a link to this world in `room` — the phone's share sheet, else copied. */
async function shareInvite(world: WorldFull | null, frameId: string, room: string): Promise<string | null> {
  if (!world || world.id !== frameId || isDraftWorldId(frameId)) {
    toast('Save this world first, then invite friends.');
    return null;
  }
  if (world.visibility === 'private') {
    toast('This world is private — make it public in Share to invite friends.');
    return null;
  }
  const url = shareUrl(world, room);
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title: world.name, text: `Come play ${world.name} with me on Orb`, url });
      return url;
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null; // cancelled
    // no share sheet after all (e.g. not allowed without a fresh tap): copy the link instead
  }
  await copyLink(url, 'Invite link copied — send it to a friend');
  return url;
}

/** A world that hasn't said it's ready by now is shown anyway. */
const COVER_GIVE_UP_MS = 20_000;
/** A world this big (its files) takes a while: say so, until a little after it's on screen (or 3 minutes). */
const BIG_WORLD_BYTES = 25_000_000;
const BIG_NOTE_AFTER_READY_MS = 40_000;
const BIG_NOTE_MS = 180_000;

const hasPainted = () => typeof performance !== 'undefined' && typeof performance.getEntriesByName === 'function' && performance.getEntriesByName('first-contentful-paint').length > 0;

/**
 * True once the page has painted. The first world waits for it: its libraries (three.js alone is
 * ~400 KB) would otherwise compete with the page's own scripts and fonts and push back the moment
 * the start screen's text appears.
 */
function useFirstPaint(): boolean {
  const [painted, setPainted] = useState(hasPainted);
  useEffect(() => {
    if (painted) return;
    const done = () => setPainted(true);
    if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('paint')) {
      const t = setTimeout(done, 0);
      return () => clearTimeout(t);
    }
    const po = new PerformanceObserver((list) => {
      if (list.getEntriesByName('first-contentful-paint').length) done();
    });
    po.observe({ type: 'paint', buffered: true });
    const t = setTimeout(done, 2500);
    return () => {
      po.disconnect();
      clearTimeout(t);
    };
  }, [painted]);
  return painted;
}

export function WorldStage({ home, onReady, onError }: { home: boolean; onReady(): void; onError(e: WorldRuntimeError): void }) {
  const { previewCode, world, status, canEdit, isExternal, frameId, me, drawn, frameReady, worldCaptured } = useWorld();
  const docked = useUi((s) => (s.panelOpen ? s.orb.side : null));
  const mobile = useIsMobile();
  const painted = useFirstPaint();
  useEffect(() => {
    if (me) setRoomIdentity(me);
  }, [me]);

  const worldName = world?.name ?? '';
  const ctx = useMemo<RuntimeContext | null>(
    () => (me ? { worldId: frameId, worldName, me, storage: getWorldStorage(frameId), room: invitedRoom() } : null),
    [frameId, worldName, me],
  );

  // Nothing plays behind home, nor while another world is on its way (or isn't there): a world
  // mounts with its own code, so the start island never shows in between.
  const live = !home && status === 'ready';

  // On a phone, a visitor's world that needs a keyboard asks first (once a session), before loading.
  const [allowed, setAllowed] = useState<string | null>(null);
  const gated = live && !!world && !canEdit && needsKeyboard(world) && onPhone() && allowed !== world.id && !playedAnyway(world.id);

  // The cover of a world being opened lifts once it has drawn (or after a while, whatever happens).
  const covered = live && !!world && !drawn;
  useEffect(() => {
    if (!covered || gated) return;
    const t = setTimeout(() => useWorld.setState({ drawn: true }), COVER_GIVE_UP_MS);
    return () => clearTimeout(t);
  }, [covered, gated, frameId]);

  // A big world (Long Wind's 130 MB of models): its own loading screen can run for a minute.
  const big = !!world && !isExternal && (world.size ?? 0) > BIG_WORLD_BYTES ? frameId : null;
  const [bigNoted, setBigNoted] = useState<string | null>(null); // the world whose note has had its time
  useEffect(() => {
    if (!big) return;
    const t = setTimeout(() => setBigNoted(big), BIG_NOTE_MS);
    return () => clearTimeout(t);
  }, [big]);

  const handleReady = useCallback(() => {
    setTimeout(() => setBigNoted(frameId), BIG_NOTE_AFTER_READY_MS);
    frameReady();
    onReady();
  }, [frameId, frameReady, onReady]);

  const externalUrl = isExternal ? world?.externalUrl ?? null : null;
  const html = isExternal ? null : withTree(previewCode ?? '', world?.tree);

  return (
    <div className="sky fixed inset-0 z-0 overflow-hidden" aria-label={worldName ? `World: ${worldName}` : 'World'}>
      {live && !gated && painted && ctx && (html || externalUrl) && (
        <WorldFrame
          ref={setFrameHandle}
          html={html}
          externalUrl={externalUrl}
          ctx={ctx}
          onReady={handleReady}
          onError={onError}
          onToast={(text) => toast(text)}
          onCapture={worldCaptured}
          onInvite={(room) => shareInvite(world, frameId, room)}
          onPeople={(p) => useWorld.setState({ people: { worldId: frameId, ...p } })}
          onPurchase={(item) => askPurchase(world, frameId, item)}
          onDrop={(files) => void dropIntoChat(files)}
        />
      )}
      {covered && world && (
        <Cover
          key={world.id}
          world={world}
          // Centred on what the panel leaves of the world.
          inset={!mobile && docked ? { [docked === 'right' ? 'paddingRight' : 'paddingLeft']: PANEL_REACH } : undefined}
          onPlay={
            gated
              ? () => {
                  playAnyway(world.id);
                  setAllowed(world.id);
                }
              : undefined
          }
        />
      )}
      {big && bigNoted !== big && (
        <p
          className="glass animate-fade-in pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 rounded-full px-4 py-2 text-[13px] whitespace-nowrap text-ink"
          style={{ bottom: 'calc(var(--safe-b) + 24px)' }}
          role="status"
        >
          A big world — it can take a minute to load
        </p>
      )}
    </div>
  );
}

const playedKey = (id: string) => `orb:kbd:${id}`;
function playedAnyway(id: string): boolean {
  try {
    return !!sessionStorage.getItem(playedKey(id));
  } catch {
    return false;
  }
}
function playAnyway(id: string): void {
  try {
    sessionStorage.setItem(playedKey(id), '1');
  } catch {
    /* this time only */
  }
}

/**
 * A world opening: its preview (or picture) at full strength under a soft scrim, and its name. On a
 * phone, a world that needs a keyboard says so here, with "Play anyway" (`onPlay`).
 */
function Cover({ world, inset, onPlay }: { world: WorldFull; inset?: CSSProperties; onPlay?(): void }) {
  const video = previewVideo(world.id);
  const poster = world.thumbUrl ?? undefined;
  return (
    <div className="animate-fade-in absolute inset-0 z-10 flex items-center justify-center px-6" style={inset} role="status">
      {video ? (
        <video className="absolute inset-0 h-full w-full object-cover" poster={poster} autoPlay muted loop playsInline aria-hidden>
          <source src={video.webm} type="video/webm" />
          <source src={video.mp4} type="video/mp4" />
        </video>
      ) : (
        poster && (
          // eslint-disable-next-line @next/next/no-img-element -- the world's own thumbnail (an API route with immutable caching)
          <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )
      )}
      {(video || poster) && <div aria-hidden className="absolute inset-0 bg-[color-mix(in_oklab,var(--paper)_18%,transparent)]" />}
      <div className="glass-strong relative flex max-w-[min(420px,100%)] flex-col items-center rounded-[var(--r-panel)] px-7 py-4 text-center">
        <p className="font-display text-[30px] leading-tight text-ink">{world.name}</p>
        {onPlay && (
          <>
            <p className="mt-1 text-[14px] text-ink-2">Best on a computer: it needs a keyboard.</p>
            <Button variant="primary" className="mt-4 h-11 px-5" onClick={onPlay}>
              Play anyway
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Pictures dropped on the world: they go with the person's next message, the chat open to show them. */
async function dropIntoChat(files: File[]): Promise<void> {
  useUi.getState().openPanel('chat');
  const { photos, problem } = await addPhotos(useUi.getState().draftPhotos, files);
  useUi.getState().setDraftPhotos(photos);
  if (problem) toast(problem);
}
