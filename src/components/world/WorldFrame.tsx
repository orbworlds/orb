'use client';
// The world viewport: a double-buffered, sandboxed iframe running a world + the orb runtime.
//
// Native worlds (`html`): every html change mounts a fresh iframe *underneath* the visible one.
// When it reports `ready` (or load + 400 ms, or after 5 s at the latest) it becomes the visible
// frame and the old one, now on top, fades out and is removed — at every moment one fully-drawn
// world covers the viewport, so there is never a blank flash. While a frame is loading, newer html
// is queued (latest wins); a frame stuck loading for >2 s is replaced right away.
//
// External worlds (`externalUrl`): one plain cross-origin iframe, no runtime.
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { getLiveWorldStorage, isDraftWorldId, moveWorldStorage, WorldBridge, type BridgeHandlers } from '@/lib/runtime/bridge';
import { injectRuntime } from '@/lib/runtime/sdk';
import { probeDuration } from '@/lib/probe';
import type { ProbeRequest, ProbeResult, ProbeUnavailable, RuntimeContext, WorldRuntimeError } from '@/lib/types';

export interface FrameProbe extends ProbeRequest {
  /** Only a frame running this file tree (its page loads from /api/tree/<tree>/) counts. */
  tree?: string;
}

export interface WorldFrameHandle {
  /** Capture a thumbnail (webp/jpeg data URL, ~640x400) or null if not possible. */
  capture(): Promise<string | null>;
  /** Record `ms` of the world on screen as a video with `label` drawn in, or why not (see WorldBridge.recordClip). */
  recordClip(ms: number, label: string): Promise<{ blob: Blob } | { error: string }>;
  /** Re-run the current world from scratch. */
  reload(): void;
  /** Focus the world (keyboard input goes to it). */
  focus(): void;
  /** Play the world on screen with synthetic input and report what it looks like (stops on `signal`). */
  probe(req: FrameProbe, signal?: AbortSignal): Promise<ProbeResult | ProbeUnavailable>;
}

export interface WorldFrameProps {
  /** Native world HTML. Changing it swaps in a new iframe with a cross-fade. */
  html?: string | null;
  /** External world URL (embedded directly, no runtime). */
  externalUrl?: string | null;
  ctx: RuntimeContext;
  onReady?(): void;
  onError?(e: WorldRuntimeError): void;
  onToast?(text: string): void;
  /** The world's document.title (native worlds; after load and on change). */
  onTitle?(text: string): void;
  /** The world called `orb.capture()` — a fresh thumbnail data URL (throttled). */
  onCapture?(dataUrl: string): void;
  /** The world called `orb.room.invite(room)`: share a link to it; resolves with the URL (or null). */
  onInvite?(room: string): Promise<string | null> | string | null;
  /** Who else is in the world's own room right now: how many, and how many of them are friends. */
  onPeople?(people: { count: number; friends: number }): void;
  /** The world called `orb.shop.buy(item)`: ask the player in Orb's own sheet; whether they got it. */
  onPurchase?(item: string): Promise<{ ok: boolean; reason?: string }>;
  ref?: Ref<WorldFrameHandle>;
}

/** Native worlds: scripts but never allow-same-origin (opaque origin, no access to Orb). */
const WORLD_SANDBOX = 'allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';
/** External worlds are cross-origin sites; they keep their own origin. */
const EXTERNAL_SANDBOX = `${WORLD_SANDBOX} allow-same-origin`;
// No camera / microphone: browsers remember a grant for the whole site (Orb), so allowing it once
// in one world would let every other world use it too.
// `gpu` is WebGPU in a cross-origin iframe (Unity WebGPU builds, e.g. The Little Prince).
const WORLD_ALLOW = 'fullscreen; autoplay; gamepad; accelerometer; gyroscope; magnetometer; xr-spatial-tracking; clipboard-write; midi; screen-wake-lock; gpu';

const FADE_MS = 450;
const FADE_MS_REDUCED = 160;
const LOAD_GRACE_MS = 400; // after the iframe's load event, if the runtime never said ready
const READY_TIMEOUT_MS = 5000; // swap in no matter what after this
const STALE_PENDING_MS = 2000; // a newer html replaces a frame that has been loading this long
const CAPTURE_TIMEOUT_MS = 1500;
// A symmetric ease reads as a calm dissolve; the UI's ease-out curve would make it look like a cut.
const EASE = 'cubic-bezier(.4,0,.2,1)';

const FILL: CSSProperties = { position: 'absolute', inset: 0, overflow: 'hidden', background: 'transparent' };

type SlotStatus = 'loading' | 'shown' | 'leaving';
interface Slot {
  html: string;
  /** ctx.worldId the frame was started with (baked into its orb.world / storage). */
  worldId: string;
  iframe: HTMLIFrameElement;
  bridge: WorldBridge;
  status: SlotStatus;
  createdAt: number;
  shownAt: number | null;
  readyAt: number | null;
  timers: ReturnType<typeof setTimeout>[];
}

/** How long a probe waits for the frame it wants (loading, swapping in, restarting): a heavy world on a slow device takes a while. */
const PROBE_WAIT_MS = 25_000;
/** A freshly started world runs this long before it is played (first frames, start-up errors). */
const PROBE_SETTLE_MS = 700;
/** A frame shown this recently counts as fresh: it isn't restarted before a probe. */
const PROBE_FRESH_MS = 5000;
/** The screen of a look on a phone (CSS px). */
const PHONE = { w: 390, h: 844 };

/** Where a phone-sized frame sits: the middle of the stage. Null when the stage is phone-sized already. */
function phoneFrame(host: HTMLElement): Partial<CSSStyleDeclaration> | null {
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (w < PHONE.w + 160 || h < 480) return null;
  const height = Math.min(PHONE.h, h - 32);
  return {
    inset: 'auto',
    left: `${Math.round((w - PHONE.w) / 2)}px`,
    top: `${Math.round((h - height) / 2)}px`,
    width: `${PHONE.w}px`,
    height: `${height}px`,
    borderRadius: '28px',
    boxShadow: '0 0 0 1px rgba(15,15,35,.14), 0 30px 80px -24px rgba(16,16,40,.5)',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stacking: the loading frame sits under the visible one, a leaving frame fades out above both.
const Z: Record<SlotStatus, string> = { loading: '1', shown: '2', leaving: '3' };

function fadeMs(): number {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? FADE_MS_REDUCED : FADE_MS;
}

/** Imperative manager of the iframes of one native world viewport. */
class FrameStack {
  private current: Slot | null = null;
  private pending: Slot | null = null;
  private queued: string | null = null;
  private readonly leaving = new Set<Slot>();
  private destroyed = false;
  /** New frames mount phone-sized (during a look on a phone). */
  private phone = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly getCtx: () => RuntimeContext,
    private readonly handlers: () => BridgeHandlers,
  ) {}

  /** The newest frame — the only one whose ready / errors / toasts are reported. */
  private get newest(): Slot | null {
    return this.pending ?? this.current;
  }

  show(html: string | null): void {
    if (this.destroyed) return;
    if (!html) {
      this.queued = null;
      for (const s of [this.pending, this.current, ...this.leaving]) if (s) this.discard(s);
      this.pending = this.current = null;
      return;
    }
    if (this.pending) {
      if (this.pending.html === html) {
        this.queued = null;
      } else if (this.current?.html === html) {
        // Back to what is on screen (e.g. undo): drop the in-flight frame.
        this.queued = null;
        this.discard(this.pending);
        this.pending = null;
      } else if (Date.now() - this.pending.createdAt > STALE_PENDING_MS) {
        this.discard(this.pending);
        this.pending = null;
        this.mount(html);
      } else {
        this.queued = html;
      }
      return;
    }
    if (this.current?.html === html) return;
    this.mount(html);
  }

  reload(): void {
    const html = this.queued ?? this.pending?.html ?? this.current?.html;
    if (this.destroyed || !html) return;
    this.queued = null;
    if (this.pending) this.discard(this.pending);
    this.pending = null;
    this.mount(html);
  }

  /** A draft got saved under a new id: its running frames keep going as that world. */
  adopt(fromId: string, toId: string): void {
    for (const s of [this.pending, this.current, ...this.leaving]) if (s && s.worldId === fromId) s.worldId = toId;
  }

  /** The world id changed under the same html (e.g. a fork): restart so the world sees its new id. */
  syncWorld(worldId: string): void {
    const slot = this.newest;
    if (slot && slot.worldId !== worldId) this.reload();
  }

  capture(): Promise<string | null> {
    const slot = this.current ?? this.pending;
    return slot ? slot.bridge.capture(CAPTURE_TIMEOUT_MS) : Promise.resolve(null);
  }

  recordClip(ms: number, label: string): Promise<{ blob: Blob } | { error: string }> {
    return this.current ? this.current.bridge.recordClip(ms, label) : Promise.resolve({ error: 'not_ready' });
  }

  /**
   * Every probe plays a fresh world and leaves a fresh one behind, so a play-test's state (a
   * started game, a score, a paused screen) never stays with the person.
   */
  async probe(req: FrameProbe, signal?: AbortSignal): Promise<ProbeResult | ProbeUnavailable> {
    const want = req.tree ? `/api/tree/${req.tree}/` : null;
    const matches = (s: Slot | null): s is Slot => !!s && (!want || s.html.includes(want));
    const until = async (ok: () => boolean) => {
      const end = Date.now() + PROBE_WAIT_MS;
      while (!ok()) {
        if (this.destroyed || signal?.aborted || Date.now() > end) return false;
        await sleep(100);
      }
      return true;
    };
    if (!(await until(() => matches(this.current)))) return { unavailable: "The world with the latest files didn't appear on screen in time." };
    let slot = this.current!;
    const phone = req.viewport === 'phone' && !!phoneFrame(this.host);
    /** Back to a fresh, full-size world. */
    const restore = () => {
      this.phone = false;
      this.reload();
    };
    if (phone || Date.now() - (slot.shownAt ?? 0) > PROBE_FRESH_MS) {
      const old = slot;
      this.phone = phone;
      this.reload();
      if (!(await until(() => this.current !== old && matches(this.current)))) {
        if (phone) restore();
        return { unavailable: "The world didn't restart in time." };
      }
      slot = this.current!;
    }
    await until(() => slot.readyAt !== null || this.current !== slot);
    if (this.current !== slot || signal?.aborted) {
      if (phone) restore();
      return { unavailable: 'The world was replaced while it was being looked at.' };
    }
    const settle = PROBE_SETTLE_MS - (Date.now() - (slot.readyAt ?? slot.shownAt ?? Date.now()));
    if (settle > 0) await sleep(settle);
    signal?.addEventListener('abort', restore, { once: true });
    try {
      const result = await slot.bridge.probe(req, 15_000 + probeDuration(req.actions));
      return signal?.aborted ? { unavailable: 'The build was stopped.' } : result;
    } finally {
      signal?.removeEventListener('abort', restore);
      if (!signal?.aborted && (phone || this.current === slot)) restore();
    }
  }

  focus(): void {
    const slot = this.current ?? this.pending;
    if (!slot) return;
    slot.iframe.focus();
    try {
      slot.iframe.contentWindow?.focus();
    } catch {
      /* ignore */
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.queued = null;
    for (const s of [this.pending, this.current, ...this.leaving]) if (s) this.discard(s);
    this.pending = this.current = null;
  }

  private mount(html: string): void {
    const ctx = this.getCtx();
    const first = !this.current;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', WORLD_SANDBOX);
    iframe.setAttribute('allow', WORLD_ALLOW);
    iframe.title = ctx.worldName || 'World';
    Object.assign(iframe.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      border: '0',
      display: 'block',
      background: 'transparent',
      // Matching the world's default scheme keeps the iframe transparent in dark mode.
      colorScheme: 'normal',
      zIndex: Z.loading,
      // The first world fades in from nothing; later ones load fully opaque under the current one.
      opacity: first ? '0' : '1',
      pointerEvents: 'none',
      transition: `opacity ${fadeMs()}ms ${EASE}`,
    } satisfies Partial<CSSStyleDeclaration>);
    const phone = this.phone ? phoneFrame(this.host) : null;
    if (phone) Object.assign(iframe.style, phone);

    const slot: Slot = { html, worldId: ctx.worldId, iframe, bridge: null as unknown as WorldBridge, status: 'loading', createdAt: Date.now(), shownAt: null, readyAt: null, timers: [] };
    const isNewest = () => slot === this.newest;
    slot.bridge = new WorldBridge(iframe, {
      // Live ctx (player, name), but always this frame's own world id: a frame still on screen while
      // the next world loads must not write that world's storage / store or join its room.
      ctx: () => ({ ...this.getCtx(), worldId: slot.worldId }),
      onReady: () => {
        slot.readyAt ??= Date.now();
        const newest = isNewest();
        this.swapIn(slot);
        if (newest) this.handlers().onReady?.();
      },
      onError: (e) => isNewest() && this.handlers().onError?.(e),
      onToast: (t) => isNewest() && this.handlers().onToast?.(t),
      onTitle: (t) => isNewest() && this.handlers().onTitle?.(t),
      onCapture: (u) => isNewest() && this.handlers().onCapture?.(u),
      onInvite: (room) => (isNewest() ? (this.handlers().onInvite?.(room) ?? null) : null),
      onPeople: (p) => isNewest() && this.handlers().onPeople?.(p),
      onPurchase: (item) => (isNewest() && this.handlers().onPurchase ? this.handlers().onPurchase!(item) : Promise.resolve({ ok: false, reason: 'unavailable' })),
    });
    iframe.addEventListener('load', () => {
      if (slot === this.pending) slot.timers.push(setTimeout(() => this.swapIn(slot), LOAD_GRACE_MS));
    });
    slot.timers.push(setTimeout(() => this.swapIn(slot), READY_TIMEOUT_MS));

    // The runtime is seeded with the freshest storage of this world (incl. unflushed writes).
    iframe.srcdoc = injectRuntime(html, { ...ctx, storage: getLiveWorldStorage(ctx.worldId, ctx.storage) });
    this.pending = slot;
    this.host.appendChild(iframe);
  }

  /** Make a loading frame the visible one and fade the previous one out. */
  private swapIn(slot: Slot): void {
    if (slot !== this.pending || this.destroyed) return;
    for (const t of slot.timers) clearTimeout(t);
    slot.timers = [];
    this.pending = null;

    const prev = this.current;
    const hadFocus = !!prev && document.activeElement === prev.iframe;
    this.current = slot;
    slot.status = 'shown';
    slot.shownAt = Date.now();
    Object.assign(slot.iframe.style, { zIndex: Z.shown, opacity: '1', pointerEvents: 'auto' });

    if (prev) {
      prev.status = 'leaving';
      this.leaving.add(prev);
      Object.assign(prev.iframe.style, { zIndex: Z.leaving, pointerEvents: 'none' });
      void prev.iframe.offsetWidth; // commit the current opacity so the fade runs
      prev.iframe.style.opacity = '0';
      prev.timers.push(setTimeout(() => this.discard(prev), fadeMs() + 80));
    }
    if (hadFocus) slot.iframe.focus();

    if (this.queued !== null) {
      const next = this.queued;
      this.queued = null;
      if (next !== slot.html) this.mount(next);
    }
  }

  private discard(slot: Slot): void {
    for (const t of slot.timers) clearTimeout(t);
    slot.timers = [];
    this.leaving.delete(slot);
    slot.bridge.destroy();
    slot.iframe.remove();
  }
}

export default function WorldFrame({ html, externalUrl, ctx, onReady, onError, onToast, onTitle, onCapture, onInvite, onPeople, onPurchase, ref }: WorldFrameProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const externalRef = useRef<HTMLIFrameElement>(null);
  const stackRef = useRef<FrameStack | null>(null);
  const ctxRef = useRef(ctx);
  const handlersRef = useRef<BridgeHandlers>({});
  const [externalKey, setExternalKey] = useState(0);
  // Embedded with allow-same-origin, so only ever an absolute http(s) URL (never javascript:/data:).
  const external = externalUrl && /^https?:\/\//i.test(externalUrl) ? externalUrl : null;

  // Latest props for the long-lived frame stack / bridges.
  useLayoutEffect(() => {
    ctxRef.current = ctx;
    handlersRef.current = { onReady, onError, onToast, onTitle, onCapture, onInvite, onPeople, onPurchase };
  });

  useEffect(() => {
    if (external || !hostRef.current) return;
    const stack = new FrameStack(
      hostRef.current,
      () => ctxRef.current,
      () => handlersRef.current,
    );
    stackRef.current = stack;
    return () => {
      stack.destroy();
      if (stackRef.current === stack) stackRef.current = null;
    };
  }, [external]);

  // Show the html. When the world id changes too: a draft that just got saved keeps running and
  // keeps its localStorage under the new id (migrated *before* any new frame is seeded); any other
  // change (e.g. a fork with identical code) restarts the world so it sees its new id.
  const prevWorldId = useRef(ctx.worldId);
  useEffect(() => {
    const prev = prevWorldId.current;
    const worldId = ctx.worldId;
    prevWorldId.current = worldId;
    const saved = prev !== worldId && isDraftWorldId(prev) && !isDraftWorldId(worldId);
    const stack = external ? null : stackRef.current;
    if (saved) {
      moveWorldStorage(prev, worldId);
      stack?.adopt(prev, worldId);
    }
    if (!stack) return;
    stack.show(html ?? null);
    if (prev !== worldId && !saved) stack.syncWorld(worldId);
  }, [html, external, ctx.worldId]);

  useImperativeHandle(
    ref,
    () => ({
      capture: () => (external ? Promise.resolve(null) : (stackRef.current?.capture() ?? Promise.resolve(null))),
      recordClip: (ms, label) => (external ? Promise.resolve({ error: 'external' }) : (stackRef.current?.recordClip(ms, label) ?? Promise.resolve({ error: 'not_ready' }))),
      reload: () => (external ? setExternalKey((k) => k + 1) : stackRef.current?.reload()),
      focus: () => (external ? externalRef.current?.focus() : stackRef.current?.focus()),
      probe: (req, signal) =>
        external
          ? Promise.resolve({ unavailable: "This world is another website, so Orb can't look inside it." })
          : (stackRef.current?.probe(req, signal) ?? Promise.resolve({ unavailable: 'The world is not on screen.' })),
    }),
    [external],
  );

  return (
    <div style={FILL} data-orb-world="">
      {external ? (
        <iframe
          key={externalKey}
          ref={externalRef}
          src={external}
          title={ctx.worldName || 'World'}
          sandbox={EXTERNAL_SANDBOX}
          allow={WORLD_ALLOW}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent', colorScheme: 'normal' }}
          onLoad={() => handlersRef.current.onReady?.()}
        />
      ) : (
        <div ref={hostRef} style={FILL} />
      )}
    </div>
  );
}
