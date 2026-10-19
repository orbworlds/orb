// Moving to a new domain: the plain-data parts of the hand-off, shared by the /move page, the move
// API (src/server/move.ts) and tests. docs/operations.md "Moving to a new domain".
//
// A browser brings every `orb:*` localStorage entry from a former address: JSON, gzipped where the
// browser can, at most MAX_BUNDLE bytes (Vercel takes 4.5 MB per request). If that's too much, the
// bulkiest entries stay behind — chats' messages first, then worlds' saved games.

export type Entries = Record<string, string>;
export type Pack = 'gzip' | 'json';

export const MAX_BUNDLE = 4_000_000;
/** Set on a former address once its browser has moved: its later visits go straight over. */
export const MOVED_COOKIE = 'orb_moved';

const DEVICE = 'orb:device';
const CHATS = 'orb:chats';
const CHAT = 'orb:chat:';
const WORLD_STORAGE = 'orb:ls:';
const MAX_CHATS = 200;
/** Who you are on a device: comes with the device key when the carried one takes over. */
const WITH_DEVICE = new Set(['orb:name', 'orb:color']);
/** id → value maps: both browsers' entries are kept (this browser's win a clash). */
const MAPS = new Set(['orb:world-names', 'orb:ls-at']);

/** A path on this site to land on ("/w/abc?x=1"); anything else (other sites, junk) becomes "/". */
export function safeTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.length > 2000) return '/';
  try {
    const base = 'https://orb.invalid';
    const url = new URL(raw, base);
    const path = url.pathname + url.search;
    // Checked again as it will be used: "/..//x" normalises to "//x", which is another site.
    return url.origin === base && new URL(path, base).origin === base ? path : '/';
  } catch {
    return '/';
  }
}

interface Thread {
  id: string;
  updatedAt: number;
}

function threads(raw: string | undefined): Thread[] {
  try {
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((t): t is Thread => !!t && typeof t === 'object' && typeof t.id === 'string' && typeof t.updatedAt === 'number');
  } catch {
    return [];
  }
}

function object(raw: string | undefined): Record<string, unknown> | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What to write into this browser's storage to take in `carried` (a former address's entries).
 * Missing entries come along. Chats merge thread by thread: the newer one wins, with its
 * messages, keeping the 200 most recent. A different carried device key replaces this browser's
 * (the server moves what the replaced key owned, src/server/move.ts) and brings its name and
 * colour. id → value maps are combined. Everything else keeps this browser's own value.
 */
export function mergeEntries(local: Entries, carried: Entries): { set: Entries; remove: string[] } {
  const set: Entries = {};
  const remove: string[] = [];
  const deviceReplaced = !!local[DEVICE] && !!carried[DEVICE] && local[DEVICE] !== carried[DEVICE];

  const carriedThreads = threads(carried[CHATS]);
  if (carriedThreads.length) {
    const byId = new Map<string, { thread: Thread; carried: boolean }>();
    for (const thread of threads(local[CHATS])) byId.set(thread.id, { thread, carried: false });
    for (const thread of carriedThreads) {
      const have = byId.get(thread.id);
      if (!have || thread.updatedAt > have.thread.updatedAt) byId.set(thread.id, { thread, carried: true });
    }
    const all = [...byId.values()].sort((a, b) => b.thread.updatedAt - a.thread.updatedAt);
    set[CHATS] = JSON.stringify(all.slice(0, MAX_CHATS).map((x) => x.thread));
    for (const { thread, carried: fromCarried } of all.slice(0, MAX_CHATS)) {
      const key = CHAT + thread.id;
      // The winning side's messages, or the other side's if it has none.
      if (carried[key] !== undefined && (fromCarried || local[key] === undefined)) set[key] = carried[key];
    }
    for (const { thread } of all.slice(MAX_CHATS)) if (local[CHAT + thread.id] !== undefined) remove.push(CHAT + thread.id);
  }

  for (const [key, value] of Object.entries(carried)) {
    if (key === CHATS || key.startsWith(CHAT)) continue;
    const mine = local[key];
    if (mine === undefined) set[key] = value;
    else if (key === DEVICE || (deviceReplaced && WITH_DEVICE.has(key))) {
      if (value !== mine) set[key] = value;
    } else if (MAPS.has(key)) {
      const theirs = object(value);
      const ours = object(mine);
      if (theirs && ours) {
        const merged = JSON.stringify({ ...theirs, ...ours });
        if (merged !== mine) set[key] = merged;
      }
    }
  }
  return { set, remove };
}

/** Entries to leave behind when a bundle is too big, in order: chats' messages and worlds' saved games, largest first, then anything else but the device key and the chat list. */
export function dropOrder(entries: Entries): string[] {
  const size = (k: string) => k.length + entries[k].length;
  const tier = (k: string) => (k === DEVICE || k === CHATS ? -1 : k.startsWith(CHAT) ? 0 : k.startsWith(WORLD_STORAGE) ? 1 : 2);
  return Object.keys(entries)
    .filter((k) => tier(k) >= 0)
    .sort((a, b) => tier(a) - tier(b) || size(b) - size(a));
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function pack(entries: Entries): Promise<{ body: Uint8Array<ArrayBuffer>; pack: Pack }> {
  const json = new TextEncoder().encode(JSON.stringify(entries));
  if (typeof CompressionStream === 'undefined') return { body: json, pack: 'json' };
  return { body: await readAll(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))), pack: 'gzip' };
}

export async function unpack(body: ArrayBuffer, format: string | null): Promise<Entries> {
  const bytes = format === 'gzip' ? await readAll(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))) : new Uint8Array(body);
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const out: Entries = {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data)) if (k.startsWith('orb:') && typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Pack `entries` into at most `max` bytes, leaving the bulkiest behind (see dropOrder) if needed.
 * A chat whose messages stay behind leaves the chat list too, so an account that has the chat
 * fills it in whole at the new address.
 */
export async function packWithin(entries: Entries, max = MAX_BUNDLE): Promise<{ body: Uint8Array<ArrayBuffer>; pack: Pack; dropped: string[] }> {
  const kept = { ...entries };
  const order = dropOrder(kept);
  const dropped: string[] = [];
  for (;;) {
    const packed = await pack(kept);
    const size = packed.body.byteLength;
    if (size <= max || !order.length) return { ...packed, dropped };
    // Leave about as much behind as the excess (at this bundle's packing ratio), then pack again.
    const raw = Object.entries(kept).reduce((n, [k, v]) => n + k.length + v.length, 0);
    let excess = ((size - max) / size) * raw;
    while (order.length && excess > 0) {
      const key = order.shift()!;
      excess -= key.length + kept[key].length;
      delete kept[key];
      dropped.push(key);
    }
    const gone = new Set(dropped.filter((k) => k.startsWith(CHAT)).map((k) => k.slice(CHAT.length)));
    if (gone.size && kept[CHATS] !== undefined) kept[CHATS] = JSON.stringify(threads(entries[CHATS]).filter((t) => !gone.has(t.id)));
  }
}
