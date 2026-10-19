// Looks for the blob, the character Orb gives people in worlds (orb.visitors, SPEC §2): a color to
// pick (free) and things to wear bought with credits, one on the head and one on the face. They
// follow the account into every world that shows the blob. Shared by the server (what things cost)
// and the app (the You tab); worlds draw them in the world SDK (src/lib/runtime/sdk.ts).

export type LookSlot = 'head' | 'face';

export interface LookItem {
  id: string;
  name: string;
  slot: LookSlot;
  /** Credits. */
  price: number;
}

/** What the account's blob looks like: its color (null: this device's) and what it wears, by slot. */
export interface Look {
  color: string | null;
  wear: string[];
}

/**
 * Priced like Roblox's avatar shop (a credit is worth about a Robux): a month of Free credits gets
 * two or three things, as Premium's monthly Robux do there; a month of Pro gets most of them.
 */
export const LOOK_ITEMS: readonly LookItem[] = [
  { id: 'sprout', name: 'Sprout', slot: 'head', price: 75 },
  { id: 'flower', name: 'Flower', slot: 'head', price: 100 },
  { id: 'party-hat', name: 'Party hat', slot: 'head', price: 150 },
  { id: 'bunny-ears', name: 'Bunny ears', slot: 'head', price: 200 },
  { id: 'top-hat', name: 'Top hat', slot: 'head', price: 250 },
  { id: 'halo', name: 'Halo', slot: 'head', price: 400 },
  { id: 'crown', name: 'Crown', slot: 'head', price: 750 },
  { id: 'blush', name: 'Blush', slot: 'face', price: 50 },
  { id: 'round-glasses', name: 'Round glasses', slot: 'face', price: 100 },
  { id: 'shades', name: 'Shades', slot: 'face', price: 150 },
];

/** The colors new players get one of at random. */
export const PLAYER_COLORS = ['#8b7bff', '#5ec8ff', '#ffb38a', '#ff8fc8', '#7ee0b8', '#ffd36e', '#a0a8ff', '#ff9e7a'] as const;
/** The colors a blob can be. */
export const BLOB_COLORS: readonly string[] = [...PLAYER_COLORS, '#ff6b81', '#9ee35d', '#f2efe9', '#4b4763'];

const BY_ID = new Map(LOOK_ITEMS.map((i) => [i.id, i]));
const SLOTS: readonly LookSlot[] = ['head', 'face'];

export const lookItem = (id: unknown): LookItem | undefined => (typeof id === 'string' ? BY_ID.get(id) : undefined);

export const isBlobColor = (c: unknown): c is string => typeof c === 'string' && BLOB_COLORS.includes(c.toLowerCase());

/** Known things to wear, at most one per slot (a later one wins), head first. */
export function cleanWear(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const bySlot = new Map<LookSlot, string>();
  for (const id of list.slice(0, 20)) {
    const it = lookItem(id);
    if (it) bySlot.set(it.slot, it.id);
  }
  return SLOTS.flatMap((s) => {
    const id = bySlot.get(s);
    return id ? [id] : [];
  });
}

/** A stored or sent look, cleaned. */
export function cleanLook(raw: unknown): Look {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { color: isBlobColor(o.color) ? (o.color as string).toLowerCase() : null, wear: cleanWear(o.wear) };
}
