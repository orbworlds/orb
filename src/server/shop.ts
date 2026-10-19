// Shops in worlds: things people buy with their Orb credits (`orb.shop` in the world SDK, SPEC §7).
//
// A world lists what it sells in its page, as JSON:
//   <script type="application/json" id="orb-shop">{"items":[{ "id", "name", "price", "emoji"?, "description"? }]}</script>
// Prices are in credits. The saved world's list is what things cost: Orb's own sheet shows the
// player that price before they buy, so a world can't show one price and charge another.
//
// Buying takes the price from the buyer's credits, paid ones first (Pro: the period's, then top-ups;
// Free: top-ups, then the period's free credits), and pays the world's maker SHARE of the part that
// was paid for. Free credits buy things too but earn nobody anything, so making accounts for their
// free credits pays nothing. Makers can put what they earned into their own building
// (buildWithEarnings) or cash them out (./payouts.ts). Orb's own worlds (no maker account) keep their sales.
//
// One statement per change (the database is a transaction pooler): a purchase is a 'pending' row
// first (one per account, world and item), then one statement takes the credits, completes the row
// and pays the maker.

import type { ShopBought, ShopItem, ShopView } from '@/lib/types';
import { canEdit, type Viewer } from './auth';
import type { Db } from './db';
import { ensureWallet, plansConfig, toCredits, toMicros, type PlansConfig, type Wallet } from './credits';
import { fail, isWorldId, sessionUser } from './worlds';

export const SHOP_LIMITS = { items: 40, minPrice: 1, maxPrice: 1000 } as const;
const ITEM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A pending purchase older than this was cut off midway (nothing was taken): it may go. */
const PENDING_STALE_S = 60;

function numberEnv(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const raw = (env[key] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
/** What part of paid credits spent in a world its maker earns (ORB_SHOP_SHARE, default 1: all of it). */
export const shopShare = (env: Record<string, string | undefined> = process.env) => numberEnv(env, 'ORB_SHOP_SHARE', 1, 0, 1);
/** Credits an account may spend in worlds in a day (ORB_SHOP_DAILY, default 2,000). */
/**
 * 402 for a purchase the wallet can't cover. A build can leave it a little below zero, which Orb
 * shows as 0, so the message says where the extra credits it asks for come from.
 */
function short(price: number, left: number): never {
  const need = Math.ceil(price - left);
  const below = Math.ceil(-left);
  fail(402, 'no_credits', below > 0 ? `You need ${need} more credits: your last build went ${below} below zero.` : `You need ${need} more credits.`, { need, credits: left });
}

export const shopDaily = (env: Record<string, string | undefined> = process.env) => numberEnv(env, 'ORB_SHOP_DAILY', 2000, 0, 1_000_000);

const clean = (s: string, max: number) =>
  s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const SHOP_TAG = /<script\b[^>]*\bid\s*=\s*["']orb-shop["'][^>]*>([\s\S]*?)<\/script\s*>/i;

/** What a world's page says it sells (entries that don't fit are left out). */
export function parseShop(code: string | null | undefined): ShopItem[] {
  const m = SHOP_TAG.exec(code ?? '');
  if (!m) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { items?: unknown }).items : null;
  if (!Array.isArray(list)) return [];
  const out: ShopItem[] = [];
  for (const it of list) {
    if (out.length >= SHOP_LIMITS.items) break;
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim().toLowerCase() : '';
    const name = typeof o.name === 'string' ? clean(o.name, 40) : '';
    const price = typeof o.price === 'number' && Number.isFinite(o.price) ? Math.round(o.price) : NaN;
    if (!ITEM_RE.test(id) || !name || !(price >= SHOP_LIMITS.minPrice && price <= SHOP_LIMITS.maxPrice) || out.some((x) => x.id === id)) continue;
    const emoji = typeof o.emoji === 'string' ? [...clean(o.emoji, 16)].slice(0, 4).join('') : '';
    const description = typeof o.description === 'string' ? clean(o.description, 140) : '';
    out.push({ id, name, price, emoji: emoji || null, description: description || null });
  }
  return out;
}

interface ShopWorldRow {
  id: string;
  name: string;
  kind: string;
  code: string | null;
  visibility: string;
  owner_user: string | null;
  owner_device: string | null;
}

/** The world (public, or the viewer's), and whether it's the viewer's. */
async function shopWorld(db: Db, viewer: Viewer, id: string): Promise<{ world: ShopWorldRow; mine: boolean }> {
  const world = isWorldId(id)
    ? (await db.query<ShopWorldRow>(`select id, name, kind, code, visibility, owner_user, owner_device from orb_worlds where id = $1`, [id]))[0]
    : undefined;
  if (!world) fail(404, 'not_found', 'This world does not exist.');
  const mine = await canEdit(db, viewer, world);
  if (world.visibility !== 'public' && !mine) fail(404, 'not_found', 'This world does not exist.');
  return { world, mine };
}

export async function ownedIn(db: Db, worldId: string, userId: string): Promise<string[]> {
  const rows = await db.query<{ item_id: string }>(`select item_id from orb_purchases where world_id = $1 and buyer_user = $2 and status = 'done' order by id`, [worldId, userId]);
  return rows.map((r) => r.item_id);
}

export async function shopView(db: Db, viewer: Viewer, worldId: string, cfg: PlansConfig = plansConfig()): Promise<ShopView> {
  const { world, mine } = await shopWorld(db, viewer, worldId);
  const items = world.kind === 'native' ? parseShop(world.code) : [];
  const user = await sessionUser(db, viewer);
  if (!user) return { items, owned: [], credits: null, paid: null, mine, signedIn: false };
  const [owned, wallet] = await Promise.all([ownedIn(db, world.id, user), ensureWallet(db, `u:${user}`, cfg)]);
  return { items, owned, credits: wallet.left, paid: paidLeft(wallet), mine, signedIn: true };
}

/** What of the wallet was paid for (and so pays makers): all of Pro's, a Free account's top-ups. */
const paidLeft = (w: Wallet) => Math.max(0, w.plan === 'pro' ? w.left - w.bonus : w.topup);

/** Buy `itemId` in a world for `price` credits (what the player was shown; it must still be the price). */
export async function buyItem(db: Db, viewer: Viewer, worldId: string, itemId: unknown, price: unknown, cfg: PlansConfig = plansConfig(), env: Record<string, string | undefined> = process.env): Promise<ShopBought> {
  const user = await sessionUser(db, viewer);
  if (!user) fail(401, 'account_required', 'Sign in to buy things in worlds.');
  const { world, mine } = await shopWorld(db, viewer, worldId);
  const item = world.kind === 'native' && typeof itemId === 'string' ? parseShop(world.code).find((x) => x.id === itemId) : undefined;
  if (!item) fail(404, 'unknown_item', 'This world doesn’t sell that.');
  if (price !== undefined && price !== null && Number(price) !== item.price) fail(409, 'price_changed', `${item.name} costs ${item.price} credits now.`, { price: item.price });
  const seller = world.owner_user && world.owner_user !== user ? world.owner_user : null;
  const { charged, already } = await charge(db, { user, shop: world.id, item, seller, free: mine }, cfg, env);
  const [owned, wallet] = await Promise.all([ownedIn(db, world.id, user), ensureWallet(db, `u:${user}`, cfg)]);
  return { item, owned, charged, credits: wallet.left, already };
}

/** One thing an account buys: in a world's shop (`shop`: its id) or Orb's own (looks). */
export interface Sale {
  user: string;
  shop: string;
  item: { id: string; name: string; price: number };
  /** Who earns their share of the paid part; null: Orb keeps it. */
  seller: string | null;
  /** The maker trying their own shop: it's theirs, for nothing. */
  free?: boolean;
}

/** Take a thing's price from the buyer's credits, once (`already`: it was theirs), and pay the seller. */
export async function charge(db: Db, sale: Sale, cfg: PlansConfig = plansConfig(), env: Record<string, string | undefined> = process.env): Promise<{ charged: number; already: boolean }> {
  const { user, shop, item, seller } = sale;
  const payer = `u:${user}`;
  const prior = (await db.query<{ id: string; status: string; age: number }>(`select id, status, extract(epoch from now() - created_at)::int as age from orb_purchases where world_id = $1 and item_id = $2 and buyer_user = $3`, [shop, item.id, user]))[0];
  if (prior?.status === 'done') return { charged: 0, already: true };
  if (prior) {
    if (prior.age < PENDING_STALE_S) fail(409, 'busy', 'Still getting that for you — one moment.');
    await db.query(`delete from orb_purchases where id = $1 and status = 'pending'`, [prior.id]);
  }

  if (sale.free) {
    await db.query(
      `insert into orb_purchases (world_id, item_id, item_name, buyer_user, seller_user, price_micros, status, test) values ($1, $2, $3, $4, null, 0, 'done', true) on conflict do nothing`,
      [shop, item.id, item.name, user],
    );
    return { charged: 0, already: false };
  }

  const cost = toMicros(item.price);
  const daily = toMicros(shopDaily(env));
  const spent = Number((await db.query<{ s: string | null }>(`select sum(price_micros) as s from orb_purchases where buyer_user = $1 and not test and created_at > now() - interval '1 day'`, [user]))[0]?.s ?? 0);
  if (spent + cost > daily) fail(429, 'daily_limit', `You can spend up to ${Math.round(toCredits(daily)).toLocaleString('en-US')} credits a day in worlds. Try again tomorrow.`);

  const wallet = await ensureWallet(db, payer, cfg);
  if (wallet.left < item.price) short(item.price, wallet.left);
  if (seller) await ensureWallet(db, `u:${seller}`, cfg);

  const pending = await db.query<{ id: string }>(
    `insert into orb_purchases (world_id, item_id, item_name, buyer_user, seller_user, price_micros) values ($1, $2, $3, $4, $5, $6::bigint)
     on conflict (world_id, item_id, buyer_user) do nothing returning id`,
    [shop, item.id, item.name, user, seller, cost],
  );
  if (!pending[0]) fail(409, 'busy', 'Still getting that for you — one moment.');
  const id = pending[0].id;

  // Take the credits (the wallet row locked, so two purchases at once can't both spend the same
  // credits), complete the purchase and pay the maker their share of the paid part — at once.
  const paid = await db.query<{ paid: string | null; earned: string | null }>(
    `with w as (
       select payer, plan, greatest(0, allowance_micros - used_micros) as m, topup_micros as t, greatest(0, bonus_micros) as b from orb_wallets where payer = $1 for update
     ), first as (
       -- Paid credits first: Pro's period credits then top-ups; Free: top-ups, then the month's free credits.
       select payer, plan, m, t, b,
         case when plan = 'pro' then least($2::bigint, m) else least($2::bigint - least($2::bigint, greatest(0, t)), m) end as from_plan,
         case when plan = 'pro' then least($2::bigint - least($2::bigint, m), greatest(0, t)) else least($2::bigint, greatest(0, t)) end as from_topup
       from w
     ), part as (
       -- …then bonus credits, which nobody bought.
       select payer, plan, m, t, b, from_plan, from_topup, $2::bigint - from_plan - from_topup as from_bonus from first
     ), d as (
       update orb_wallets o set
         used_micros = o.used_micros + part.from_plan,
         topup_micros = o.topup_micros - part.from_topup,
         bonus_micros = greatest(0, o.bonus_micros) - part.from_bonus,
         updated_at = now()
       from part where o.payer = part.payer and part.from_bonus <= part.b
       returning part.plan, part.from_topup, part.from_plan
     ), amt as (
       select case when d.plan = 'pro' then d.from_plan + d.from_topup else d.from_topup end as paid from d
     ), p as (
       update orb_purchases set status = 'done', paid_micros = amt.paid,
         earned_micros = case when seller_user is null then 0 else floor(amt.paid * $4::numeric)::bigint end
       from amt where id = $3 and status = 'pending'
       returning seller_user, paid_micros, earned_micros
     ), s as (
       update orb_wallets set earned_micros = orb_wallets.earned_micros + p.earned_micros,
         earned_total_micros = orb_wallets.earned_total_micros + p.earned_micros, updated_at = now()
       from p where orb_wallets.payer = 'u:' || p.seller_user and p.earned_micros > 0
       returning 1
     )
     select (select paid_micros from p) as paid, (select earned_micros from p) as earned`,
    [payer, cost, id, shopShare(env)],
  );
  if (paid[0]?.paid == null) {
    await db.query(`delete from orb_purchases where id = $1 and status = 'pending'`, [id]);
    const now = await ensureWallet(db, payer, cfg);
    short(item.price, now.left);
  }
  if (seller) await noteSale(db, seller, shop, item.name, toCredits(Number(paid[0].earned ?? 0)));
  return { charged: item.price, already: false };
}

/** Tell the maker: one note per world that adds up until they've seen it (a new id each time, so it's announced). */
async function noteSale(db: Db, seller: string, worldId: string, itemName: string, earned: number): Promise<void> {
  await db
    .query(
      `with old as (
         delete from orb_notifications where user_id = $1 and kind = 'sale' and world_id = $2 and read_at is null and created_at > now() - interval '1 day'
         returning detail
       )
       insert into orb_notifications (user_id, kind, actor_id, world_id, detail)
       select $1, 'sale', null, $2, jsonb_build_object(
         'count', 1 + coalesce((select sum((detail->>'count')::int) from old), 0),
         'credits', $3::numeric + coalesce((select sum((detail->>'credits')::numeric) from old), 0),
         'item', $4::text)`,
      [seller, worldId, Math.round(earned * 100) / 100, itemName],
    )
    .catch((e) => console.error('[orb] noting a sale failed', e instanceof Error ? e.message : e));
}

/** Put everything the account earned in its worlds' shops into its own building (bonus credits: spent in worlds, they earn nobody anything). */
export async function buildWithEarnings(db: Db, viewer: Viewer, cfg: PlansConfig = plansConfig()): Promise<Wallet> {
  const user = await sessionUser(db, viewer);
  if (!user) fail(401, 'account_required', 'Sign in first.');
  const payer = `u:${user}`;
  await ensureWallet(db, payer, cfg);
  await db.query(
    `with w as (
       select payer, earned_micros as e from orb_wallets where payer = $1 and earned_micros > 0 for update
     ), u as (
       update orb_wallets o set bonus_micros = greatest(0, o.bonus_micros) + w.e, earned_micros = 0, updated_at = now()
       from w where o.payer = w.payer
       returning w.e
     )
     insert into orb_credit_log (payer, kind, micros) select $1, 'earnings', e from u`,
    [payer],
  );
  return ensureWallet(db, payer, cfg);
}
