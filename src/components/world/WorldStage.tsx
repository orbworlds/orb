'use client';
// The full-bleed world behind everything. While nothing is drawn yet, a soft sky gradient (never
// a spinner); then the WorldFrame cross-fades in, and between worlds it cross-fades again.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { withTree } from '@/lib/tree';
import WorldFrame, { type WorldFrameHandle } from '@/components/world/WorldFrame';
import { askPurchase } from '@/state/shop';
import { shareUrl } from '@/state/share';
import { getWorldStorage } from '@/lib/local';
import { isDraftWorldId } from '@/lib/runtime/bridge';
import { setRoomIdentity } from '@/lib/runtime/realtime';
import { ROOM_NAME_RE } from '@/lib/runtime/sdk';
import type { RuntimeContext, WorldFull, WorldRuntimeError } from '@/lib/types';
import { toast } from '@/state/toast';
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
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied — send it to a friend', 'success');
  } catch {
    toast(url);
  }
  return url;
}

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

export function WorldStage({ onReady, onError }: { onReady(): void; onError(e: WorldRuntimeError): void }) {
  const { previewCode, world, isExternal, frameId, me, frameReady, worldCaptured } = useWorld();
  const painted = useFirstPaint();
  const frame = useRef<WorldFrameHandle | null>(null);

  const setRef = useCallback((h: WorldFrameHandle | null) => {
    frame.current = h;
    setFrameHandle(h);
  }, []);
  useEffect(() => () => setFrameHandle(null), []);
  useEffect(() => {
    if (me) setRoomIdentity(me);
  }, [me]);

  const worldName = world?.name ?? '';
  const ctx = useMemo<RuntimeContext | null>(
    () => (me ? { worldId: frameId, worldName, me, storage: getWorldStorage(frameId), room: invitedRoom() } : null),
    [frameId, worldName, me],
  );

  const handleReady = useCallback(() => {
    frameReady();
    onReady();
  }, [frameReady, onReady]);

  const externalUrl = isExternal ? world?.externalUrl ?? null : null;
  const html = isExternal ? null : withTree(previewCode ?? '', world?.tree);

  return (
    <div className="sky fixed inset-0 z-0 overflow-hidden" aria-label={worldName ? `World: ${worldName}` : 'World'}>
      {painted && ctx && (html || externalUrl) && (
        <WorldFrame
          ref={setRef}
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
        />
      )}
    </div>
  );
}
