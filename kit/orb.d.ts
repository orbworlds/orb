// Types of `window.orb`, the SDK Orb gives every world (SPEC §7 of Orb). It exists only inside Orb
// (or the kit's local host): guard with `const orb = window.orb;` and `orb?.store`, so the page
// still runs on its own.

export interface OrbPlayer {
  id: string;
  name: string;
  color: string;
  /** What their blob wears on Orb (look ids). */
  wears: string[];
}

export interface OrbPeer extends OrbPlayer {
  state?: unknown;
  /** One of the viewer's friends on Orb. */
  friend?: boolean;
}

export type OrbRoomEvent =
  | { type: 'joined'; self: OrbPeer; peers: OrbPeer[]; live?: boolean }
  | { type: 'join'; peer: OrbPeer }
  | { type: 'leave'; peer: OrbPeer }
  | { type: 'state'; peer: OrbPeer }
  | { type: 'message'; peer: OrbPeer; data: unknown };

export interface OrbRoom {
  readonly peers: Map<string, OrbPeer>;
  send(data: unknown): void;
  setState(state: unknown): void;
  leave(): void;
}

export interface OrbVisitor extends OrbPeer {
  x?: number;
  y?: number;
  z?: number;
  ry?: number;
  [field: string]: unknown;
}

export interface OrbVisitors {
  readonly list: OrbVisitor[];
  readonly count: number;
  on(event: 'join' | 'leave', fn: (v: OrbVisitor) => void): () => void;
  leave(): void;
}

export interface OrbShopItem {
  id: string;
  name: string;
  price: number;
  emoji?: string;
  description?: string;
}

export type OrbBuyResult =
  | { ok: true; item: string }
  | { ok: false; item: string | null; reason: 'cancelled' | 'no_credits' | 'sign_in' | 'unknown_item' | 'busy' | 'not_saved' | 'looking' | 'not_on_orb' | string };

export interface Orb {
  readonly world: { id: string; name: string };
  readonly me: OrbPlayer;
  store: {
    get<T = unknown>(key: string): Promise<T | null>;
    /** ≤ 8 KB of JSON per key. */
    set<T = unknown>(key: string, value: T): Promise<T>;
    incr(key: string, by?: number): Promise<number>;
    push<T = unknown>(key: string, item: T, max?: number): Promise<T[]>;
    /** Atomic shallow merge; a null field removes it. */
    merge<T extends object = Record<string, unknown>>(key: string, patch: Partial<T>): Promise<T>;
    /** ≤ 200 keys starting with `prefix`. */
    list<T = unknown>(prefix: string): Promise<Record<string, T>>;
  };
  room: {
    join(onEvent: (event: OrbRoomEvent) => void, opts?: { name?: string }): OrbRoom;
    /** A link that opens the world in that room, or null. */
    invite(name: string): Promise<string | null>;
    /** The room the link this page was opened with asked for. */
    readonly invited: string | null;
  };
  visitors: {
    /** Everyone here as three.js characters with name tags. */
    show(opts: {
      THREE: unknown;
      scene: unknown;
      camera: unknown;
      player?: unknown;
      avatar?(v: OrbVisitor): unknown;
      update?(v: OrbVisitor, model: unknown, dt: number): void;
      height?: number;
      eye?: number;
      pose?(): Record<string, unknown> | null;
      room?: string;
      tags?: boolean;
    }): { leave(): void };
    join(pose: () => Record<string, unknown> | null, opts?: { room?: string; smooth?: boolean; snap?: boolean }): OrbVisitors;
  };
  shop: {
    buy(id: string): Promise<OrbBuyResult>;
    owned(): Promise<string[]>;
    items(): Promise<OrbShopItem[]>;
  };
  /** Ask Orb to take the world's thumbnail now. */
  capture(): void;
  toast(text: string): void;
}

declare global {
  interface Window {
    orb?: Orb;
  }
}
