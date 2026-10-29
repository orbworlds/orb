'use client';
// Parent side of the world runtime protocol (SPEC §7). One WorldBridge per world iframe:
//   - accepts only messages whose event.source is that iframe's window,
//   - persists the world's shimmed localStorage per world per device (debounced, capped),
//   - serves orb.store (server API; an in-memory map for unsaved drafts),
//   - relays orb.room to ./realtime.ts, and counts who is in the world's own room (onPeople),
//   - serves orb.shop (Orb's copy of the list, purchases through onPurchase) and orb.room.invite,
//   - answers capture requests, records clips, and forwards ready / error / toast / title / capture,
//   - runs probes (the builder playing the world and looking at it) and cleans up their results.

import { api } from '../api';
import { getWorldStorage, localKeys, setWorldStorage } from '../local';
import { cleanProbeResult } from '../probe';
import type { ProbeRequest, ProbeResult, ProbeUnavailable, RoomEvent, RuntimeContext, StoreOp, StoreRequest, WorldRuntimeError } from '../types';
import { joinRoom, type RoomMembership } from './realtime';
import { ROOM_NAME_RE, ROOMS_PER_WORLD, SHOP_ITEM_RE, STORE_VALUE_LIMIT, WORLD_STORAGE_LIMIT } from './sdk';

export interface BridgeHandlers {
  /** The world finished loading (load + 2 animation frames). */
  onReady?(): void;
  onError?(e: WorldRuntimeError): void;
  onToast?(text: string): void;
  /** document.title of the world (after load and whenever it changes). */
  onTitle?(text: string): void;
  /** The world called orb.capture(): a fresh thumbnail data URL (throttled). */
  onCapture?(dataUrl: string): void;
  /** The world called orb.room.invite(room): share a link that opens it in that room; the URL, or null. */
  onInvite?(room: string): Promise<string | null> | string | null;
  /** Who else is in the world's own room with this frame, as they come and go: how many, and how many are friends. */
  onPeople?(people: { count: number; friends: number }): void;
  /** The world called orb.shop.buy(item): Orb asks the player in its own sheet; whether they got it. */
  onPurchase?(item: string): Promise<{ ok: boolean; reason?: string }>;
  /** Pictures dropped on the world that it didn't take itself (for the person's chat). */
  onDrop?(files: File[]): void;
}

export interface BridgeOptions extends BridgeHandlers {
  /** Runtime context, read on every message, so id / player changes apply at once. */
  ctx(): RuntimeContext;
}

type Msg = { __orb: 1; type: string } & Record<string, unknown>;
/** What orb.store and orb.shop requests are answered with. */
type Reply = { ok: true; value: unknown } | { ok: false; error: string };

const isMsg = (d: unknown): d is Msg => !!d && typeof d === 'object' && (d as { __orb?: unknown }).__orb === 1 && typeof (d as { type?: unknown }).type === 'string';

const clip = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/**
 * Worlds without a server record yet ('new' = the start canvas, or a local draft id) keep their
 * shared `orb.store` in memory and never connect to a multiplayer room.
 */
export function isDraftWorldId(worldId: string | null | undefined): boolean {
  return !worldId || worldId === 'new' || /^(draft|local|tmp|template)([:_-]|$)/i.test(worldId);
}

// ---------------------------------------------------------------------------------------------
// Per-world localStorage (shared by every frame of the same world on this page)

interface LiveStorage {
  /** Null-prototype record, so keys like "__proto__" or "toString" are plain keys. */
  data: Record<string, string>;
  /** Characters used (keys + values), kept incrementally. */
  size: number;
}

const liveStorage = new Map<string, LiveStorage>();
const dirtyWorlds = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let windowHooked = false;

function toLive(source: Record<string, unknown>): LiveStorage {
  const live: LiveStorage = { data: Object.create(null) as Record<string, string>, size: 0 };
  for (const [k, v] of Object.entries(source)) {
    if (typeof v !== 'string') continue;
    live.data[k] = v;
    live.size += k.length + v.length;
  }
  return live;
}

function hookWindow(): void {
  if (windowHooked || typeof window === 'undefined') return;
  windowHooked = true;
  window.addEventListener('pagehide', flushWorldStorage);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushWorldStorage());
  // Another tab saved storage for a world we have cached: pick it up for the next frame we start.
  const prefix = localKeys.worldStorage('');
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(prefix)) return;
    const id = e.key.slice(prefix.length);
    if (liveStorage.has(id) && !dirtyWorlds.has(id)) liveStorage.set(id, toLive(getWorldStorage(id)));
  });
}

function storageFor(worldId: string, seed?: Record<string, string>): LiveStorage {
  let live = liveStorage.get(worldId);
  if (!live) {
    hookWindow();
    const persisted = getWorldStorage(worldId);
    // Persisted data is the source of truth; the host's snapshot is only a fallback.
    live = toLive(Object.keys(persisted).length || !seed ? persisted : seed);
    liveStorage.set(worldId, live);
  }
  return live;
}

/**
 * Current localStorage snapshot of a world, including writes not yet flushed. `seed` (e.g.
 * `ctx.storage`) is used only if nothing is cached or persisted for the world yet.
 */
export function getLiveWorldStorage(worldId: string, seed?: Record<string, string>): Record<string, string> {
  return { ...storageFor(worldId, seed).data };
}

/**
 * Take over a world's storage saved elsewhere (the account's copy, src/lib/savesync.ts) for the
 * next frame of it. Not while this page has changes of its own to save (they are newer).
 */
export function adoptWorldStorage(worldId: string, data: Record<string, string>, at: number): void {
  if (dirtyWorlds.has(worldId)) return;
  setWorldStorage(worldId, data, { at, quiet: true });
  liveStorage.delete(worldId);
}

/** Write pending world storage to the parent's localStorage now. */
export function flushWorldStorage(): void {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  for (const id of dirtyWorlds) setWorldStorage(id, { ...liveStorage.get(id)?.data });
  dirtyWorlds.clear();
}

function scheduleFlush(worldId: string): void {
  dirtyWorlds.add(worldId);
  if (flushTimer === undefined) flushTimer = setTimeout(flushWorldStorage, 400);
}

/** Apply one storage op from a world; false if it would exceed the per-world cap. */
function applyStorage(worldId: string, op: unknown, key: unknown, value: unknown): boolean {
  const live = storageFor(worldId);
  const { data } = live;
  if (op === 'clear') {
    live.data = Object.create(null) as Record<string, string>;
    live.size = 0;
  } else if (op === 'remove' && typeof key === 'string') {
    if (!(key in data)) return true;
    live.size -= key.length + data[key].length;
    delete data[key];
  } else if (op === 'set' && typeof key === 'string' && typeof value === 'string') {
    if (data[key] === value) return true;
    const next = live.size - (key in data ? key.length + data[key].length : 0) + key.length + value.length;
    if (next > WORLD_STORAGE_LIMIT) return false;
    data[key] = value;
    live.size = next;
  } else {
    return true;
  }
  scheduleFlush(worldId);
  return true;
}

/**
 * Carry a draft's storage over when it gets a real world id (only if the target has none yet).
 * WorldFrame calls this when ctx.worldId changes from a draft id to a saved one.
 */
export function moveWorldStorage(fromId: string, toId: string): void {
  if (fromId === toId) return;
  const from = storageFor(fromId);
  if (from.size && !storageFor(toId).size) {
    liveStorage.set(toId, toLive(from.data));
    scheduleFlush(toId);
  }
  // The draft (e.g. the Paint canvas) starts empty next time instead of carrying this world's data.
  if (from.size) {
    from.data = Object.create(null) as Record<string, string>;
    from.size = 0;
    scheduleFlush(fromId);
  }
  memStores.delete(fromId);
}

// ---------------------------------------------------------------------------------------------
// orb.store for drafts (in memory, same semantics as the server)

const memStores = new Map<string, Map<string, unknown>>();

function memStore(worldId: string, req: StoreRequest): unknown {
  let m = memStores.get(worldId);
  if (!m) memStores.set(worldId, (m = new Map()));
  const cur = m.has(req.key) ? m.get(req.key) : null;
  switch (req.op) {
    case 'get':
      return cur;
    case 'set':
      m.set(req.key, req.value ?? null);
      return req.value ?? null;
    case 'incr': {
      const next = (typeof cur === 'number' && Number.isFinite(cur) ? cur : 0) + (req.by ?? 1);
      m.set(req.key, next);
      return next;
    }
    case 'push': {
      const list = Array.isArray(cur) ? cur.slice() : [];
      list.push(req.value ?? null);
      const max = Math.max(1, Math.min(200, req.max ?? 50));
      const next = list.slice(-max);
      m.set(req.key, next);
      return next;
    }
    case 'merge': {
      // Through a Map, so a "__proto__" key is just a key.
      const fields = new Map(cur && typeof cur === 'object' && !Array.isArray(cur) ? Object.entries(cur as Record<string, unknown>) : []);
      for (const [k, v] of Object.entries(req.value as Record<string, unknown>)) {
        if (v === null) fields.delete(k);
        else fields.set(k, v);
      }
      const next = Object.fromEntries(fields);
      if (JSON.stringify(next).length > STORE_VALUE_LIMIT) throw new Error('Stored values are limited to 8 KB.');
      m.set(req.key, next);
      return next;
    }
    case 'list': {
      const out: Record<string, unknown> = {};
      for (const k of [...m.keys()].filter((k) => k.startsWith(req.key)).sort().slice(0, STORE_LIST_KEYS)) out[k] = m.get(k);
      return out;
    }
  }
}

/** orb.store of a world: the server's, or for a draft the in-memory one. */
async function realStore(worldId: string, req: StoreRequest): Promise<unknown> {
  return isDraftWorldId(worldId) ? memStore(worldId, req) : (await api.store(worldId, req)).value;
}

/** orb.store while the builder plays the world: writes go to a trial copy, which shows over the real values. */
async function trialStore(worldId: string, req: StoreRequest): Promise<unknown> {
  const trial = `probe:${worldId}`;
  const tried = memStores.get(trial);
  if (req.op === 'get') return tried?.has(req.key) ? tried.get(req.key) : realStore(worldId, req);
  if (req.op === 'list') return { ...((await realStore(worldId, req)) as Record<string, unknown>), ...(memStore(trial, req) as Record<string, unknown>) };
  if (req.op === 'merge' && !tried?.has(req.key)) {
    // a trial merge starts from what's really stored
    const real = await realStore(worldId, { op: 'get', key: req.key });
    if (real != null) memStore(trial, { op: 'set', key: req.key, value: real });
  }
  return memStore(trial, req);
}

/** Keys one orb.store.list call returns at most (same as the server). */
const STORE_LIST_KEYS = 200;
const STORE_OPS: readonly StoreOp[] = ['get', 'set', 'incr', 'push', 'merge', 'list'];

/** Validate a store request coming from (untrusted) world code. Returns an error string if bad. */
function parseStoreRequest(d: Msg): StoreRequest | string {
  const op = d.op as StoreOp;
  if (!STORE_OPS.includes(op)) return 'Unknown store operation';
  // Same limits as the server (LIMITS.storeKey / storeListMax), so drafts behave like saved worlds.
  if (typeof d.key !== 'string' || (!d.key && op !== 'list') || d.key.length > 64) return 'Store keys must be 1-64 characters';
  const req: StoreRequest = { op, key: d.key };
  if (op === 'merge' && (!d.value || typeof d.value !== 'object' || Array.isArray(d.value))) return 'The patch must be an object';
  if (op === 'set' || op === 'push' || op === 'merge') {
    let json: string;
    try {
      json = JSON.stringify(d.value ?? null);
    } catch {
      return 'Value must be JSON';
    }
    if (json.length > STORE_VALUE_LIMIT) return 'Value is too large (max 8 KB)';
    req.value = JSON.parse(json);
  }
  if (op === 'incr') {
    const by = d.by === undefined ? 1 : d.by;
    if (typeof by !== 'number' || !Number.isFinite(by)) return '"by" must be a number';
    req.by = by;
  }
  if (op === 'push') {
    const max = d.max === undefined ? 50 : d.max;
    if (typeof max !== 'number' || !(max >= 1)) return '"max" must be a positive number';
    req.max = Math.floor(max);
  }
  return req;
}

// ---------------------------------------------------------------------------------------------
// Bridge

const STORE_BUCKET = 40; // burst of store requests per frame
const STORE_REFILL_PER_S = 4;
const CAPTURE_MIN_INTERVAL_MS = 8000; // unsolicited orb.capture() → onCapture
const TOAST_WINDOW_MS = 5000;
const TOAST_MAX_PER_WINDOW = 3;
const MAX_DATA_URL = 3_000_000;
const MAX_CLIP_BYTES = 40_000_000;
/** How long after its length a clip may take to come back (encoding, handing the bytes over). */
const CLIP_GRACE_MS = 15_000;
const ROOM_JOINS_PER_30S = 8; // new rooms per frame; beyond that a room is solo (each one is a realtime channel)
const INVITE_MIN_INTERVAL_MS = 1500;

let reqCounter = 0;

export class WorldBridge {
  private destroyed = false;
  /** Joined rooms by name ('' = the world's own room). */
  private readonly rooms = new Map<string, RoomMembership>();
  private roomJoins: number[] = [];
  private lastInviteAt = 0;
  private readonly captures = new Map<string, (dataUrl: string | null) => void>();
  private readonly clips = new Map<string, (r: { blob: Blob } | { error: string }) => void>();
  private readonly probes = new Map<string, (r: ProbeResult | ProbeUnavailable) => void>();
  /**
   * While the builder plays the world, what it does stays out of shared and saved state: orb.store
   * writes go to a trial copy, room messages aren't sent, rooms joined meanwhile are solo, localStorage
   * writes aren't persisted.
   */
  private probing = 0;
  private tokens = STORE_BUCKET;
  private tokensAt = Date.now();
  private lastCaptureAt = 0;
  private toastTimes: number[] = [];
  private lastDrop = 0;
  private storageFullReported = false;

  /** Listens at once, so create it before the iframe gets its srcdoc. */
  constructor(
    readonly iframe: HTMLIFrameElement,
    private readonly opts: BridgeOptions,
  ) {
    window.addEventListener('message', this.onMessage);
  }

  /** Stop listening, leave every room, settle pending captures, clips and probes. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('message', this.onMessage);
    for (const r of this.rooms.values()) r.leave();
    this.rooms.clear();
    for (const done of [...this.captures.values()]) done(null);
    for (const done of [...this.clips.values()]) done({ error: 'gone' });
    for (const done of [...this.probes.values()]) done({ unavailable: 'The world was replaced while it was being looked at.' });
  }

  /**
   * Play the world with synthetic input and report what it looks like (see the runtime's probe).
   * Resolves with `{ unavailable }` if the world doesn't answer within `timeoutMs`.
   */
  probe(req: ProbeRequest, timeoutMs: number): Promise<ProbeResult | ProbeUnavailable> {
    if (this.destroyed || !this.iframe.contentWindow) return Promise.resolve({ unavailable: 'The world is not running.' });
    this.probing++;
    const late = { unavailable: "The world didn't answer (it may be frozen in an endless loop)." };
    return this.request(this.probes, timeoutMs, late, { type: 'probe', actions: req.actions, opts: { size: req.size, shots: req.shots } }).finally(() => {
      this.probing--;
    });
  }

  /**
   * Record `ms` of the world's main canvas as a video (its visitors' name tags and `label` drawn in):
   * the video, or why not ('no_canvas' for a world without one, 'unsupported', 'busy', 'timeout'…).
   */
  recordClip(ms: number, label: string): Promise<{ blob: Blob } | { error: string }> {
    if (this.destroyed || !this.iframe.contentWindow) return Promise.resolve({ error: 'gone' });
    return this.request(this.clips, ms + CLIP_GRACE_MS, { error: 'timeout' }, { type: 'clip-request', ms, label });
  }

  /** Ask the world for a thumbnail (~640x400 webp/jpeg data URL); null if none within the timeout. */
  capture(timeoutMs: number): Promise<string | null> {
    if (this.destroyed || !this.iframe.contentWindow) return Promise.resolve(null);
    return this.request(this.captures, timeoutMs, null, { type: 'capture-request' });
  }

  /** Post a request the world answers with its reqId (in `pending` until then); `late` if no answer comes within `ms`. */
  private request<T>(pending: Map<string, (r: T) => void>, ms: number, late: NoInfer<T>, msg: { type: string } & Record<string, unknown>): Promise<T> {
    const reqId = `r${++reqCounter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(late), ms);
      const done = (r: T) => {
        clearTimeout(timer);
        pending.delete(reqId);
        resolve(r);
      };
      pending.set(reqId, done);
      this.post({ ...msg, reqId });
    });
  }

  private get ctx(): RuntimeContext {
    return this.opts.ctx();
  }

  private post(msg: { type: string } & Record<string, unknown>): void {
    try {
      // The world has an opaque origin, so '*' is the only possible target origin; the target
      // window itself is fixed (this iframe), and nothing secret is ever sent.
      this.iframe.contentWindow?.postMessage({ __orb: 1, ...msg }, '*');
    } catch {
      /* frame gone */
    }
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.destroyed || !event.source || event.source !== this.iframe.contentWindow) return;
    const d = event.data;
    if (!isMsg(d)) return;
    try {
      this.handle(d);
    } catch (e) {
      console.error('[orb] bridge failed to handle', d.type, e);
    }
  };

  private handle(d: Msg): void {
    const o = this.opts;
    switch (d.type) {
      case 'ready':
        o.onReady?.();
        return;
      case 'error': {
        const message = clip(d.message, 1000);
        if (message) o.onError?.({ message, stack: clip(d.stack, 4000), line: num(d.line), col: num(d.col), source: clip(d.source, 500) });
        return;
      }
      case 'storage':
        // sessionStorage lives only inside the frame; only localStorage is persisted.
        if (d.area !== 'local' || this.probing) return;
        if (!applyStorage(this.ctx.worldId, d.op, d.key, d.value) && !this.storageFullReported) {
          this.storageFullReported = true;
          o.onError?.({ message: `World storage is full (max ${Math.round(WORLD_STORAGE_LIMIT / 1048576)} MB); a localStorage write was dropped` });
        }
        return;
      case 'capture': {
        const url = typeof d.dataUrl === 'string' && d.dataUrl.startsWith('data:image/') && d.dataUrl.length < MAX_DATA_URL ? d.dataUrl : null;
        if (typeof d.reqId === 'string') {
          this.captures.get(d.reqId)?.(url);
          return;
        }
        const now = Date.now();
        if (url && now - this.lastCaptureAt >= CAPTURE_MIN_INTERVAL_MS) {
          this.lastCaptureAt = now;
          o.onCapture?.(url);
        }
        return;
      }
      case 'clip-result': {
        const done = typeof d.reqId === 'string' ? this.clips.get(d.reqId) : undefined;
        if (!done) return;
        const mime = typeof d.mime === 'string' && /^video\/(mp4|webm)$/.test(d.mime) ? d.mime : null;
        if (d.data instanceof ArrayBuffer && mime && d.data.byteLength > 0 && d.data.byteLength <= MAX_CLIP_BYTES) done({ blob: new Blob([d.data], { type: mime }) });
        else done({ error: clip(d.error, 40) ?? (d.data instanceof ArrayBuffer ? 'too_big' : 'failed') });
        return;
      }
      case 'probe-result': {
        const done = typeof d.reqId === 'string' ? this.probes.get(d.reqId) : undefined;
        if (!done) return;
        if (d.result && typeof d.result === 'object') done(cleanProbeResult(d.result));
        else done({ unavailable: d.error === 'busy' ? 'The world is already being looked at.' : `The look failed inside the world: ${clip(d.error, 200) ?? 'unknown error'}` });
        return;
      }
      case 'store':
        void this.serveStore(d);
        return;
      case 'room':
        this.serveRoom(d);
        return;
      case 'invite':
        void this.serveInvite(d);
        return;
      case 'shop':
        void this.serveShop(d);
        return;
      case 'toast': {
        const text = clip(d.text, 140)?.trim();
        if (!text) return;
        const now = Date.now();
        this.toastTimes = this.toastTimes.filter((t) => now - t < TOAST_WINDOW_MS);
        if (this.toastTimes.length >= TOAST_MAX_PER_WINDOW) return;
        this.toastTimes.push(now);
        o.onToast?.(text);
        return;
      }
      case 'title': {
        const text = clip(d.text, 120)?.trim();
        if (text) o.onTitle?.(text);
        return;
      }
      case 'drop': {
        const files = Array.isArray(d.files) ? d.files.filter((f): f is File => f instanceof File && /^image\//.test(f.type)).slice(0, 8) : [];
        const now = Date.now();
        if (!files.length || now - this.lastDrop < 800) return; // one drop at a time
        this.lastDrop = now;
        o.onDrop?.(files);
        return;
      }
    }
  }

  private takeToken(): boolean {
    const now = Date.now();
    this.tokens = Math.min(STORE_BUCKET, this.tokens + ((now - this.tokensAt) / 1000) * STORE_REFILL_PER_S);
    this.tokensAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** How to answer a request of the world (by its reqId; nothing after destroy()), or null when it has none. */
  private replyTo<R extends Record<string, unknown>>(d: Msg, type: string): ((r: R) => void) | null {
    const reqId = typeof d.reqId === 'string' ? d.reqId.slice(0, 64) : null;
    if (!reqId) return null;
    return (r) => {
      if (!this.destroyed) this.post({ type, reqId, ...r });
    };
  }

  private async serveStore(d: Msg): Promise<void> {
    const reply = this.replyTo<Reply>(d, 'store-result');
    if (!reply) return;
    const req = parseStoreRequest(d);
    if (typeof req === 'string') return reply({ ok: false, error: req });
    if (!this.takeToken()) return reply({ ok: false, error: 'Too many orb.store requests — slow down a little' });
    const { worldId } = this.ctx;
    try {
      const value = await (this.probing ? trialStore(worldId, req) : realStore(worldId, req));
      reply({ ok: true, value: value ?? null });
    } catch (e) {
      reply({ ok: false, error: e instanceof Error && e.message ? e.message : 'orb.store request failed' });
    }
  }

  private serveRoom(d: Msg): void {
    const name = d.room === undefined || d.room === '' ? '' : typeof d.room === 'string' && ROOM_NAME_RE.test(d.room) ? d.room : null;
    if (name === null) return;
    switch (d.op) {
      case 'join': {
        if (this.rooms.has(name)) return;
        const { worldId, me } = this.ctx;
        // Too many rooms, or joining and leaving in a hurry: the room still answers, on its own. So does a room joined
        // while the builder plays the world, which must never turn up as a silent ghost in someone's real game.
        const now = Date.now();
        this.roomJoins = this.roomJoins.filter((t) => now - t < 30_000);
        const busy = this.rooms.size >= ROOMS_PER_WORLD || this.roomJoins.length >= ROOM_JOINS_PER_30S;
        if (!busy) this.roomJoins.push(now);
        this.rooms.set(
          name,
          joinRoom({
            worldId,
            room: name,
            me,
            solo: isDraftWorldId(worldId) || busy || this.probing > 0,
            onEvent: (event: RoomEvent) => {
              this.post({ type: 'room-event', room: name, event });
              if (name === '') this.countPeople(event);
            },
          }),
        );
        return;
      }
      case 'send':
        if (!this.probing) this.rooms.get(name)?.send(d.data);
        return;
      case 'state':
        if (!this.probing) this.rooms.get(name)?.setState(d.data);
        return;
      case 'leave':
        this.rooms.get(name)?.leave();
        this.rooms.delete(name);
        if (name === '') this.countPeople(null);
        return;
    }
  }

  /** The world's own room: who's in it (id → friend), told to onPeople when the numbers change. */
  private readonly people = new Map<string, boolean>();
  private peopleSaid = '0:0';
  private countPeople(event: RoomEvent | null): void {
    if (!event) this.people.clear();
    else if (event.type === 'joined') {
      this.people.clear();
      for (const p of event.peers) this.people.set(p.id, p.friend === true);
    } else if (event.type === 'join' || event.type === 'state') this.people.set(event.peer.id, event.peer.friend === true);
    else if (event.type === 'leave') this.people.delete(event.peer.id);
    else return;
    let friends = 0;
    for (const f of this.people.values()) if (f) friends++;
    const said = `${this.people.size}:${friends}`;
    if (said === this.peopleSaid) return;
    this.peopleSaid = said;
    this.opts.onPeople?.({ count: this.people.size, friends });
  }

  /** orb.shop: what the world sells and what the player owns come from Orb's copy; buying goes through Orb's sheet. */
  private shopBuying = false;
  private shopSeen: { at: number; value: Promise<{ items: unknown[]; owned: string[] }> } | null = null;
  private async serveShop(d: Msg): Promise<void> {
    const reply = this.replyTo<Reply>(d, 'shop-result');
    if (!reply) return;
    const { worldId } = this.ctx;
    if (d.op === 'buy') {
      const item = typeof d.item === 'string' && SHOP_ITEM_RE.test(d.item) ? d.item : null;
      const no = (reason: string) => reply({ ok: true, value: { ok: false, item, reason } });
      if (!item) return reply({ ok: false, error: 'orb.shop.buy: unknown item' });
      // The builder playing the world never buys anything, nor does an unsaved draft.
      if (this.probing) return no('looking');
      if (isDraftWorldId(worldId)) return no('not_saved');
      if (this.shopBuying || !this.opts.onPurchase) return no(this.shopBuying ? 'busy' : 'unavailable');
      this.shopBuying = true;
      try {
        const r = await this.opts.onPurchase(item);
        this.shopSeen = null;
        reply({ ok: true, value: { ok: !!r.ok, item, ...(r.ok ? {} : { reason: r.reason ?? 'cancelled' }) } });
      } catch {
        no('failed');
      } finally {
        this.shopBuying = false;
      }
      return;
    }
    if (d.op !== 'items' && d.op !== 'owned') return reply({ ok: false, error: 'orb.shop: unknown call' });
    if (isDraftWorldId(worldId)) return reply({ ok: true, value: [] });
    // Worlds tend to ask both at load: one lookup serves them for a few seconds.
    const now = Date.now();
    if (!this.shopSeen || now - this.shopSeen.at > 5000) this.shopSeen = { at: now, value: api.shop(worldId) };
    try {
      const s = await this.shopSeen.value;
      reply({ ok: true, value: d.op === 'items' ? s.items : s.owned });
    } catch (e) {
      this.shopSeen = null;
      reply({ ok: false, error: e instanceof Error && e.message ? e.message : 'orb.shop is unavailable right now' });
    }
  }

  private async serveInvite(d: Msg): Promise<void> {
    const reply = this.replyTo<{ url: string | null }>(d, 'invite-result');
    if (!reply) return;
    const now = Date.now();
    if (typeof d.room !== 'string' || !ROOM_NAME_RE.test(d.room) || this.probing || now - this.lastInviteAt < INVITE_MIN_INTERVAL_MS) return reply({ url: null });
    this.lastInviteAt = now;
    try {
      reply({ url: (await this.opts.onInvite?.(d.room)) ?? null });
    } catch {
      reply({ url: null });
    }
  }
}
