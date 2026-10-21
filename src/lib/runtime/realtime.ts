'use client';
// Multiplayer rooms for worlds (`orb.room` in the world SDK, SPEC §7), backed by Supabase Realtime:
// one channel per world room ("orb-world:<worldId>" for its own, "orb-world:<worldId>:<name>" for a
// named one), presence for who's here (+ a recent state snapshot) and broadcast for messages and
// fast state updates.
//
// Each room is one connection per page, shared by every frame that joined it, so a world
// hot-swapped by a build step keeps the same peer identity and the other players see no
// leave/join flicker. When realtime is not configured, fails, or the world is an unsaved draft,
// the room is "solo": it reports `joined` with no peers and silently drops outgoing traffic.
// Nothing in here throws.

import type { RealtimeChannel, RealtimeClient } from '@supabase/realtime-js';
import { api } from '../api';
import type { RoomEvent, RoomPeer } from '../types';

interface RealtimeConfig {
  url: string;
  key: string;
}

export interface RoomIdentity {
  id: string;
  name: string;
  color: string;
  /** What their blob wears (src/lib/looks.ts). */
  wears?: string[];
}

export interface JoinRoomOptions {
  worldId: string;
  /** A named room of the world (its own channel), or '' / omitted for the world's room. */
  room?: string;
  me: RoomIdentity;
  onEvent(event: RoomEvent): void;
  /** Never connect (e.g. drafts): behave as a room with nobody else in it. */
  solo?: boolean;
}

/** One frame's membership of a world's room. */
export interface RoomMembership {
  send(data: unknown): void;
  setState(state: unknown): void;
  leave(): void;
}

// Supabase Realtime quotas (free plan, per project): 100 messages/s — counting every message a
// client sends *and* every copy delivered — 20 presence messages/s, and 5 presence calls per
// client per 30 s. Going over gets connections dropped (players vanish), so:
// - state broadcasts are paced by room size: n players cost ~rate·n² messages/s;
// - nothing is broadcast while you're alone (a newcomer gets your state the moment they join);
// - presence carries only who you are (+ the state at join time), refreshed at most every 7 s.
const STATE_MIN_INTERVAL_MS = 200; // ≤ 5 state broadcasts/s per player
const STATE_BUDGET_PER_S = 60; // messages/s one room may use for state, all players together
const TRACK_INTERVAL_MS = 7000; // presence (re)track: ≤ 5 per 30 s
const SEND_INTERVAL_MS = 50; // room.send: ≤ 20 messages/s, queued
const SEND_QUEUE_MAX = 50;
const JOIN_TIMEOUT_MS = 6000; // report a solo `joined` if the channel isn't up by then
const CLOSE_GRACE_MS = 1500; // keep an empty room open briefly so a swapped-in frame can adopt it
const HEALTH_INTERVAL_MS = 5000; // check the channel is still joined + reconcile presence
const UNHEALTHY_REBUILD_MS = 15000; // rebuild a channel that has not been joined for this long
const HIDDEN_REBUILD_MS = 30000; // after a tab/phone was hidden this long, rejoin from scratch

// realtime-js hands back the existing channel for a topic, so a room reopened while its previous
// incarnation is still leaving must wait for that channel to be gone (or it adopts a dying channel
// that never reports SUBSCRIBED — the player sees others but is invisible to them).
const leaving = new Map<string, Promise<unknown>>();

// ---------------------------------------------------------------------------------------------
// Config + client (cached)

let configPromise: Promise<RealtimeConfig | null> | null = null;

/** Realtime settings from /api/config (cached; a failed lookup is retried after 30 s). */
function getRealtimeConfig(): Promise<RealtimeConfig | null> {
  if (!configPromise) {
    configPromise = api
      .config()
      .then((c) => (c.realtime && c.realtime.url && c.realtime.key ? c.realtime : null))
      .catch(() => {
        setTimeout(() => (configPromise = null), 30_000);
        return null;
      });
  }
  return configPromise;
}

let clientPromise: Promise<RealtimeClient | null> | null = null;

/** `https://x.supabase.co` → `wss://x.supabase.co/realtime/v1`. */
function socketUrl(url: string): string {
  const base = url.trim().replace(/\/+$/, '').replace(/^http/i, 'ws');
  return /\/realtime\/v\d+$/.test(base) ? base : `${base}/realtime/v1`;
}

/** The page's one realtime client (its config never changes once a lookup succeeded). */
function getClient(cfg: RealtimeConfig): Promise<RealtimeClient | null> {
  if (!clientPromise) {
    // Loaded on demand: most worlds never join a room.
    clientPromise = import('@supabase/realtime-js')
      // worker: heartbeats from a Web Worker keep the socket alive in background tabs, where timers
      // are throttled hard and the connection would otherwise silently go stale.
      .then(({ RealtimeClient }) => new RealtimeClient(socketUrl(cfg.url), { params: { apikey: cfg.key }, worker: typeof Worker !== 'undefined' }))
      .catch((e) => {
        console.warn('[orb] realtime unavailable', e);
        clientPromise = null;
        return null;
      });
  }
  return clientPromise;
}

// ---------------------------------------------------------------------------------------------
// Rooms

interface PresenceMeta {
  name?: string;
  color?: string;
  wears?: unknown;
  state?: unknown;
  /** Sequence number of `state` (newer wins over older broadcasts / snapshots). */
  s?: number;
}
interface StatePayload {
  id: string;
  s: number;
  state: unknown;
}
interface MessagePayload {
  from: RoomIdentity;
  data: unknown;
}
interface PeerRecord {
  peer: RoomPeer;
  seq: number;
  /** When its presence appeared here (Date.now()). */
  since: number;
  /** How many connections hold its presence key (one page: 1). */
  metas: number;
}
/** One frame's listener in a room. */
type Member = (event: RoomEvent) => void;

function randomId(n = 6): string {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}
function str(v: unknown, fallback: string, max = 80): string {
  return typeof v === 'string' && v ? v.slice(0, max) : fallback;
}
/** What a blob wears, as sent: a few short ids (the world draws the ones it knows). */
function wearOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[a-z0-9-]{1,24}$/.test(x)).slice(0, 4) : [];
}
const sameWear = (a: string[] | undefined, b: string[] | undefined) => (a ?? []).join() === (b ?? []).join();
const copy = (p: RoomPeer): RoomPeer => ({ id: p.id, name: p.name, color: p.color, wears: [...(p.wears ?? [])], state: p.state, friend: p.friend === true });

// Who here is the viewer's friend, as the friends sync vouches for it: a friend's own page told Orb's
// server its peer id in each room (src/state/friends.ts). Peer ids aren't secret, so a peer counts
// only while one connection holds its id and if the sync was asked after its presence appeared — a
// stranger reusing a friend's id after they left gets nothing from an older answer.
let friendPeers = new Set<string>();
let friendsAskedAt = 0;

/** The peer ids of the viewer's friends in the world on screen, from a friends sync asked at `askedAt`. */
export function setFriendPeers(peers: Iterable<string>, askedAt: number): void {
  friendPeers = new Set(peers);
  friendsAskedAt = askedAt;
  for (const room of rooms.values()) room.refreshFriends();
}

export type RoomsEvent = { type: 'open'; worldId: string } | { type: 'peer'; worldId: string };
const roomsListeners = new Set<(e: RoomsEvent) => void>();

/** A networked room opened (the page can now name its peer id) or someone new appeared in one. */
export function onRooms(fn: (e: RoomsEvent) => void): () => void {
  roomsListeners.add(fn);
  return () => roomsListeners.delete(fn);
}
function roomsEvent(e: RoomsEvent): void {
  for (const fn of roomsListeners) {
    try {
      fn(e);
    } catch (err) {
      console.error('[orb] rooms listener failed', err);
    }
  }
}

/** This page's peer id in each networked room of a world it's in ('' is the world's own room). */
export function roomSelves(worldId: string): Array<{ room: string; peer: string }> {
  return [...rooms.values()].filter((r) => r.worldId === worldId && r.live).map((r) => ({ room: r.name, peer: r.self.id }));
}

class WorldRoom {
  readonly self: RoomPeer;
  private readonly members = new Set<Member>();
  private readonly peers = new Map<string, PeerRecord>();
  /** State broadcasts that arrived before the sender's presence did. */
  private readonly early = new Map<string, { state: unknown; seq: number }>();
  private joined = false;
  private closed = false;
  private subscribed = false;
  private channel: RealtimeChannel | null = null;
  private client: RealtimeClient | null = null;
  private seq = 0;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private joinTimer: ReturnType<typeof setTimeout> | undefined;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private trackTimer: ReturnType<typeof setTimeout> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private unhealthySince = 0;
  private hiddenAt = 0;
  private rebuilding = false;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private lastStateAt = 0;
  private lastTrackAt = 0;
  private lastSendAt = 0;
  private stateDirty = false;
  private readonly queue: unknown[] = [];

  constructor(
    readonly worldId: string,
    readonly name: string,
    me: RoomIdentity,
    private readonly solo: boolean,
    private readonly onClosed: (room: WorldRoom) => void,
  ) {
    this.self = { id: `${str(me.id, 'guest', 40)}:${randomId()}`, name: str(me.name, 'Guest'), color: str(me.color, '#8b7bff', 32), wears: wearOf(me.wears) };
    void this.connect();
  }

  // --- membership -------------------------------------------------------------------------

  add(member: Member, me: RoomIdentity): void {
    clearTimeout(this.closeTimer);
    this.members.add(member);
    this.identify(me);
    if (this.joined) queueMicrotask(() => this.members.has(member) && member(this.joinedEvent()));
  }

  /** Who we are changed (a new name, color or what our blob wears): the others see it with the next presence. */
  identify(me: RoomIdentity): void {
    const name = str(me.name, this.self.name);
    const color = str(me.color, this.self.color, 32);
    const wears = me.wears === undefined ? this.self.wears : wearOf(me.wears);
    if (name !== this.self.name || color !== this.self.color || !sameWear(wears, this.self.wears)) {
      this.self.name = name;
      this.self.color = color;
      this.self.wears = wears;
      this.scheduleTrack();
    }
  }

  remove(member: Member): void {
    this.members.delete(member);
    if (this.members.size === 0) {
      clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => this.close(), CLOSE_GRACE_MS);
    }
  }

  private emit(event: RoomEvent): void {
    for (const m of this.members) {
      try {
        m(event);
      } catch (e) {
        console.error('[orb] room listener failed', e);
      }
    }
  }

  /** `live`: the channel is up, so others can see us (false for solo rooms, and for the 6 s fallback). */
  private joinedEvent(): RoomEvent {
    return { type: 'joined', self: copy(this.self), peers: [...this.peers.values()].map((r) => copy(r.peer)), live: this.subscribed };
  }

  /** Connected to the room (not solo, not closing): others can see this page here. */
  get live(): boolean {
    return this.subscribed && !this.closed && !this.solo;
  }

  private isFriend(rec: PeerRecord): boolean {
    return friendPeers.has(rec.peer.id) && rec.metas === 1 && rec.since < friendsAskedAt;
  }

  /** Friends known or gone since the last friends sync: say so for the peers that changed. */
  refreshFriends(): void {
    for (const rec of this.peers.values()) {
      const friend = this.isFriend(rec);
      if (friend === (rec.peer.friend === true)) continue;
      rec.peer.friend = friend;
      if (this.joined) this.emit({ type: 'state', peer: copy(rec.peer) });
    }
  }

  private markJoined(): void {
    clearTimeout(this.joinTimer);
    if (this.joined || this.closed) return;
    this.joined = true;
    this.emit(this.joinedEvent());
  }

  // --- connection ---------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.solo) return queueMicrotask(() => this.markJoined());
    this.joinTimer = setTimeout(() => this.markJoined(), JOIN_TIMEOUT_MS);
    try {
      const cfg = await getRealtimeConfig();
      const client = cfg && !this.closed ? await getClient(cfg) : null;
      if (!client || this.closed) return this.markJoined();
      this.client = client;
      await this.openChannel();
      if (this.closed) return; // left while connecting
      client.connect();
      this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_INTERVAL_MS);
      document.addEventListener('visibilitychange', this.onVisibility);
      addEventListener('online', this.onWake);
      addEventListener('pageshow', this.onWake);
    } catch (e) {
      console.warn('[orb] realtime room failed', e);
      this.markJoined();
    }
  }

  private get topic(): string {
    return this.name ? `orb-world:${this.worldId}:${this.name}` : `orb-world:${this.worldId}`;
  }

  /** Create + subscribe this room's channel (after any previous channel for the topic is gone). */
  private async openChannel(): Promise<void> {
    const client = this.client;
    if (!client || this.closed) return;
    await leaving.get(this.topic); // never rejects
    const stale = client.getChannels().find((c) => c.topic === `realtime:${this.topic}`);
    if (stale) await client.removeChannel(stale).catch(() => undefined);
    if (this.closed) return;
    const channel = client.channel(this.topic, {
      config: { broadcast: { self: false, ack: false }, presence: { key: this.self.id, enabled: true } },
    });
    this.channel = channel;
    this.unhealthySince = Date.now();
    channel
      .on('presence', { event: 'sync' }, () => this.channel === channel && this.syncPresence())
      .on('broadcast', { event: 'state' }, (m: { payload?: unknown }) => this.channel === channel && this.onState(m.payload))
      .on('broadcast', { event: 'msg' }, (m: { payload?: unknown }) => this.channel === channel && this.onMessage(m.payload))
      .subscribe((status) => {
        if (this.closed || this.channel !== channel) return;
        if (status === 'SUBSCRIBED') {
          this.subscribed = true;
          this.unhealthySince = 0;
          this.scheduleTrack();
          this.flushQueue();
          this.markJoined();
          roomsEvent({ type: 'open', worldId: this.worldId });
        } else {
          // CHANNEL_ERROR / TIMED_OUT / CLOSED: carry on solo; realtime-js keeps retrying (and
          // checkHealth rebuilds the channel if it stays down).
          this.subscribed = false;
          if (!this.unhealthySince) this.unhealthySince = Date.now();
          this.markJoined();
        }
      });
  }

  /** Throw away the channel and join again from scratch (keeps the same peer identity). */
  private async rebuild(): Promise<void> {
    const { client, channel } = this;
    if (!client || this.closed || this.rebuilding) return;
    this.rebuilding = true;
    try {
      this.subscribed = false;
      this.channel = null;
      if (channel) await client.removeChannel(channel).catch(() => undefined);
      await this.openChannel();
      client.connect();
    } finally {
      this.rebuilding = false;
    }
  }

  private checkHealth(): void {
    const channel = this.channel;
    if (this.closed || this.rebuilding || !channel) return;
    if (channel.state === 'joined' && this.subscribed) {
      this.unhealthySince = 0;
      this.syncPresence(); // reconcile, in case a presence event was missed
      return;
    }
    if (!this.unhealthySince) this.unhealthySince = Date.now();
    else if (Date.now() - this.unhealthySince > UNHEALTHY_REBUILD_MS) void this.rebuild();
  }

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
      return;
    }
    const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    if (away > HIDDEN_REBUILD_MS) void this.rebuild();
    else this.onWake();
  };

  /** Back online / restored from the back-forward cache: make sure we're in the room. */
  private readonly onWake = (): void => {
    if (this.closed) return;
    if (!this.client?.isConnected() || this.channel?.state !== 'joined') void this.rebuild();
    else this.syncPresence();
  };

  private close(): void {
    if (this.closed || this.members.size) return;
    this.closed = true;
    for (const t of [this.joinTimer, this.stateTimer, this.trackTimer, this.sendTimer]) clearTimeout(t);
    clearInterval(this.healthTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    removeEventListener('online', this.onWake);
    removeEventListener('pageshow', this.onWake);
    this.onClosed(this);
    const { channel, client } = this;
    this.channel = null;
    if (channel && client) {
      const topic = this.topic;
      const done = channel
        .untrack()
        .catch(() => undefined)
        .then(() => client.removeChannel(channel))
        .catch(() => undefined)
        .finally(() => leaving.get(topic) === done && leaving.delete(topic));
      leaving.set(topic, done);
    }
  }

  // --- incoming -----------------------------------------------------------------------------

  private syncPresence(): void {
    const channel = this.channel;
    if (!channel) return;
    let state: Record<string, Array<PresenceMeta & { presence_ref: string }>>;
    try {
      state = channel.presenceState<PresenceMeta>();
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const [id, metas] of Object.entries(state)) {
      if (id === this.self.id || !metas?.length) continue;
      seen.add(id);
      const meta = metas[metas.length - 1];
      const existing = this.peers.get(id);
      const early = this.early.get(id);
      this.early.delete(id);
      // Pick the freshest state among the presence snapshot, an early broadcast and what we have.
      let seq = typeof meta.s === 'number' ? meta.s : 0;
      let st = meta.state;
      if (early && early.seq > seq) ({ seq, state: st } = early);
      if (!existing) {
        const peer: RoomPeer = { id, name: str(meta.name, 'Guest'), color: str(meta.color, '#8b7bff', 32), wears: wearOf(meta.wears), state: st, friend: false };
        const rec: PeerRecord = { peer, seq, since: Date.now(), metas: metas.length };
        this.peers.set(id, rec);
        peer.friend = this.isFriend(rec);
        if (this.joined) this.emit({ type: 'join', peer: copy(peer) });
        roomsEvent({ type: 'peer', worldId: this.worldId });
        // Tell the newcomer where we are (presence only has our state from when we joined).
        if (this.self.state !== undefined) {
          this.stateDirty = true;
          this.scheduleState();
        }
      } else {
        const p = existing.peer;
        existing.metas = metas.length;
        const name = str(meta.name, p.name);
        const color = str(meta.color, p.color, 32);
        const wears = wearOf(meta.wears);
        const friend = this.isFriend(existing);
        const renamed = name !== p.name || color !== p.color || !sameWear(wears, p.wears) || friend !== p.friend;
        Object.assign(p, { name, color, wears, friend });
        const newer = seq > existing.seq;
        if (newer) {
          existing.seq = seq;
          p.state = st;
        }
        if ((newer || renamed) && this.joined) this.emit({ type: 'state', peer: copy(p) });
      }
    }
    for (const [id, rec] of this.peers) {
      if (seen.has(id)) continue;
      this.peers.delete(id);
      if (this.joined) this.emit({ type: 'leave', peer: copy(rec.peer) });
    }
  }

  private onState(raw: unknown): void {
    const p = raw as Partial<StatePayload> | undefined;
    if (!p || typeof p.id !== 'string' || typeof p.s !== 'number' || p.id === this.self.id) return;
    const rec = this.peers.get(p.id);
    if (!rec) {
      // Presence for this peer hasn't synced yet: remember the state for when it does.
      const prev = this.early.get(p.id);
      if (!prev || p.s > prev.seq) this.early.set(p.id, { state: p.state, seq: p.s });
      if (this.early.size > 200) this.early.delete(this.early.keys().next().value as string);
      return;
    }
    if (p.s <= rec.seq) return;
    rec.seq = p.s;
    rec.peer.state = p.state;
    if (this.joined) this.emit({ type: 'state', peer: copy(rec.peer) });
  }

  private onMessage(raw: unknown): void {
    const p = raw as Partial<MessagePayload> | undefined;
    if (!p || !p.from || typeof p.from.id !== 'string' || p.from.id === this.self.id) return;
    const known = this.peers.get(p.from.id)?.peer;
    const peer: RoomPeer = known ? copy(known) : { id: p.from.id, name: str(p.from.name, 'Guest'), color: str(p.from.color, '#8b7bff', 32), friend: false };
    if (this.joined) this.emit({ type: 'message', peer, data: p.data ?? null });
  }

  // --- outgoing -----------------------------------------------------------------------------

  send(data: unknown): void {
    if (this.closed || this.solo) return;
    if (!this.channel && this.joined) return; // solo fallback: nobody to talk to
    this.queue.push(data);
    if (this.queue.length > SEND_QUEUE_MAX) this.queue.shift();
    this.flushQueue();
  }

  private flushQueue(): void {
    if (!this.subscribed || !this.channel || this.sendTimer !== undefined) return;
    const wait = this.lastSendAt + SEND_INTERVAL_MS - Date.now();
    if (wait > 0) {
      this.sendTimer = setTimeout(() => {
        this.sendTimer = undefined;
        this.flushQueue();
      }, wait);
      return;
    }
    if (!this.queue.length) return;
    const data = this.queue.shift();
    this.lastSendAt = Date.now();
    const from: RoomIdentity = { id: this.self.id, name: this.self.name, color: this.self.color };
    void this.channel.send({ type: 'broadcast', event: 'msg', payload: { from, data } satisfies MessagePayload }).catch(() => undefined);
    if (this.queue.length) this.flushQueue(); // schedules the next one SEND_INTERVAL_MS later
  }

  setState(state: unknown): void {
    if (this.closed) return;
    this.self.state = state;
    this.seq++;
    this.stateDirty = true;
    this.scheduleState();
  }

  /** Paced by room size so the whole room stays within STATE_BUDGET_PER_S. */
  private stateInterval(): number {
    const n = this.peers.size + 1;
    return Math.max(STATE_MIN_INTERVAL_MS, Math.round((1000 * n * n) / STATE_BUDGET_PER_S));
  }

  /** Broadcast the latest state, at most every stateInterval() (leading + trailing). */
  private scheduleState(): void {
    if (this.stateTimer !== undefined) return;
    const wait = this.lastStateAt + this.stateInterval() - Date.now();
    const fire = () => {
      this.stateTimer = undefined;
      if (!this.stateDirty) return;
      if (this.peers.size === 0) return; // nobody to tell: stays dirty until someone joins
      this.stateDirty = false;
      this.lastStateAt = Date.now();
      if (!this.subscribed || !this.channel) return;
      const payload: StatePayload = { id: this.self.id, s: this.seq, state: this.self.state };
      void this.channel.send({ type: 'broadcast', event: 'state', payload }).catch(() => undefined);
    };
    if (wait <= 0) fire();
    else this.stateTimer = setTimeout(fire, wait);
  }

  /** (Re)track presence (name, color, current state) at most every TRACK_INTERVAL_MS. */
  private scheduleTrack(): void {
    if (this.trackTimer !== undefined) return;
    const wait = Math.max(0, this.lastTrackAt + TRACK_INTERVAL_MS - Date.now());
    this.trackTimer = setTimeout(() => {
      this.trackTimer = undefined;
      this.track();
    }, wait);
  }

  private track(): void {
    if (!this.subscribed || !this.channel || this.closed) return;
    this.lastTrackAt = Date.now();
    const meta: PresenceMeta = { name: this.self.name, color: this.self.color, wears: this.self.wears, state: this.self.state, s: this.seq };
    void this.channel.track(meta).catch(() => undefined);
  }
}

const rooms = new Map<string, WorldRoom>();
const MAX_NET_ROOMS = 8;

/** The player's name, color or what their blob wears changed: every room they're in shows the others. */
export function setRoomIdentity(me: RoomIdentity): void {
  for (const room of rooms.values()) room.identify(me);
}

/**
 * Join the room of a world. The first `joined` event arrives asynchronously (immediately for solo
 * rooms, after the channel is subscribed — or JOIN_TIMEOUT_MS at the latest — otherwise).
 */
export function joinRoom(opts: JoinRoomOptions): RoomMembership {
  const name = opts.room ?? '';
  // Every networked room is a channel on the page's one socket (closing ones linger briefly): keep it to a handful.
  const netKey = `net:${opts.worldId}:${name}`;
  const solo = !!opts.solo || (!rooms.has(netKey) && [...rooms.keys()].filter((k) => k.startsWith('net:')).length >= MAX_NET_ROOMS);
  const key = solo ? `solo:${opts.worldId}:${name}` : netKey;
  const room = rooms.get(key) ?? new WorldRoom(opts.worldId, name, opts.me, solo, (r) => rooms.get(key) === r && rooms.delete(key));
  rooms.set(key, room);
  // A fresh function per join: each frame's membership is its own, even with the same onEvent.
  const member: Member = (e) => opts.onEvent(e);
  room.add(member, opts.me);
  let active = true;
  return {
    send: (data) => active && room.send(data),
    setState: (state) => active && room.setState(state),
    leave: () => {
      if (!active) return;
      active = false;
      room.remove(member);
    },
  };
}
