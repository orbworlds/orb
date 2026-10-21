// Looks for the blob (src/lib/looks.ts, SPEC §2): Orb's own things to wear, bought with credits
// like things in worlds' shops (Orb keeps these sales), and the account's color and what it wears
// (orb_users.look), which follow it into worlds.

import { cleanLook, cleanWear, isBlobColor, LOOK_ITEMS, lookItem, type Look } from '@/lib/looks';
import type { LooksView } from '@/lib/types';
import type { Viewer } from './auth';
import type { Db } from './db';
import { fail } from './http';
import { ensureWallet, plansConfig, type PlansConfig } from './credits';
import { charge, ownedIn } from './shop';
import { sessionUser } from './worlds';

/** orb_purchases.world_id of Orb's looks (never a world's id). */
export const LOOKS_SHOP = 'orb:looks';

async function lookOf(db: Db, user: string): Promise<Look> {
  return cleanLook((await db.query<{ look: unknown }>(`select look from orb_users where id = $1`, [user]))[0]?.look);
}

async function saveLook(db: Db, user: string, look: Look): Promise<void> {
  await db.query(`update orb_users set look = $2::jsonb where id = $1`, [user, JSON.stringify(look)]);
}

export async function looksView(db: Db, viewer: Viewer, cfg: PlansConfig = plansConfig()): Promise<LooksView> {
  const user = await sessionUser(db, viewer);
  if (!user) return { items: LOOK_ITEMS, owned: [], look: { color: null, wear: [] }, credits: null, signedIn: false };
  const [owned, look, wallet] = await Promise.all([ownedIn(db, LOOKS_SHOP, user), lookOf(db, user), ensureWallet(db, `u:${user}`, cfg)]);
  return { items: LOOK_ITEMS, owned, look: { ...look, wear: look.wear.filter((id) => owned.includes(id)) }, credits: wallet.left, signedIn: true };
}

/** Buy a look for `price` credits (what the player was shown) and put it on. */
export async function buyLook(db: Db, viewer: Viewer, itemId: unknown, price: unknown, cfg: PlansConfig = plansConfig(), env: Record<string, string | undefined> = process.env): Promise<LooksView> {
  const user = await sessionUser(db, viewer);
  if (!user) fail(401, 'account_required', 'Sign in to get looks for your blob.');
  const item = lookItem(itemId);
  if (!item) fail(404, 'unknown_item', 'Orb doesn’t have that look.');
  if (price !== undefined && price !== null && Number(price) !== item.price) fail(409, 'price_changed', `${item.name} costs ${item.price} credits now.`, { price: item.price });
  await charge(db, { user, shop: LOOKS_SHOP, item, seller: null }, cfg, env);
  const look = await lookOf(db, user);
  await saveLook(db, user, { ...look, wear: cleanWear([...look.wear, item.id]) });
  return looksView(db, viewer, cfg);
}

/** Change the blob's color (null: this device's own) and what it wears (things the account has). */
export async function setLook(db: Db, viewer: Viewer, body: unknown, cfg: PlansConfig = plansConfig()): Promise<LooksView> {
  const user = await sessionUser(db, viewer);
  if (!user) fail(401, 'account_required', 'Sign in to keep your blob’s look.');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const look = await lookOf(db, user);
  if ('color' in b) {
    if (b.color !== null && !isBlobColor(b.color)) fail(400, 'invalid_color', 'Pick one of the colors.');
    look.color = b.color === null ? null : (b.color as string).toLowerCase();
  }
  if ('wear' in b) {
    const wear = cleanWear(b.wear);
    const owned = await ownedIn(db, LOOKS_SHOP, user);
    if (wear.some((id) => !owned.includes(id))) fail(403, 'not_owned', 'Get that look first.');
    look.wear = wear;
  }
  await saveLook(db, user, look);
  return looksView(db, viewer, cfg);
}
