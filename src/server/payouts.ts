// Cash payouts of what makers earned in their worlds' shops (./shop.ts), through Stripe Connect,
// on the lines of Roblox's Developer Exchange: only credits earned from other players can be cashed
// out, never ones you were given or bought; there's a high minimum, a wait, a check of every request,
// and what a refunded or disputed payment paid for is taken back. Each maker gets a Stripe Express
// account (Stripe checks who they are and where their bank is), Orb transfers from its own Stripe
// balance, and Stripe pays it out to their bank.
//
// Cashable earnings come from sales that
//   - cleared: older than ORB_PAYOUT_HOLD_DAYS (default 30), so a stolen card's chargeback comes first;
//   - were made by someone else: a buyer who shares a device with the maker (Orb's device keys, from the
//     analytics of the last 180 days and the devices table) or a card (Stripe's card fingerprints of
//     their payments) is the maker's own account, whose purchases earn credits to build with only;
//   - stand: not reversed (./billing.ts reverses a buyer's purchases when a payment of theirs is
//     refunded or disputed, and flags the buyer: nothing they buy is cashable from then on).
// Earnings used (building, earlier payouts) are taken from the ones that can't be cashed out first,
// then the oldest. A cash-out needs at least ORB_PAYOUT_MIN credits (10,000: US$100; Roblox's is
// 30,000 Robux, about US$114) earned from at least ORB_PAYOUT_BUYERS players (10), and sends all
// that's payable. With ORB_PAYOUT_REVIEW on (the default), it is a request Orb approves
// (POST /api/admin/payouts/:id, the lab's Pulse) before the transfer; rejected, the earnings go back.
//
// A credit is a US cent. A Stripe balance in another currency (Orb's account is in euros) is paid in
// it, at the European Central Bank's rate of the day (ORB_USD_PER_EUR fixes one). Whether an account
// can be paid is Stripe's word, read back before every transfer. Payouts open by themselves once the
// Stripe account has Connect (POST /v1/accounts answers about the request, not about Connect being
// off); ORB_PAYOUTS=0 keeps them closed.
//
// One statement per change (a transaction pooler): a payout is a 'requested' (or straight 'pending')
// row made in the statement that takes the earnings, one open per maker; then 'pending' once
// approved, 'paid' with its transfer, or 'failed'/'rejected' with the earnings given back. A pending
// one whose answer was lost is settled later: Stripe is asked whether the transfer exists (its
// metadata names the payout) before it is tried again.

import crypto from 'node:crypto';
import { SITE } from '@/lib/site';
import type { BillingInfo } from '@/lib/types';
import type { Db } from './db';
import { fail } from './http';
import { MICROS_PER_CREDIT, numberEnv, toCredits, userOfPayer } from './credits';
import { keyTag, paymentsOn, stripe, StripeError } from './stripe';

const env = (k: string) => (process.env[k] ?? '').trim();

export const payoutConfig = () => ({
  holdDays: numberEnv(process.env, 'ORB_PAYOUT_HOLD_DAYS', 30, 0, 180),
  minimum: numberEnv(process.env, 'ORB_PAYOUT_MIN', 10_000, 1, 1_000_000),
  buyers: numberEnv(process.env, 'ORB_PAYOUT_BUYERS', 10, 1, 10_000),
  review: env('ORB_PAYOUT_REVIEW') !== '0',
});

/**
 * What of a maker's earnings can be cashed out (micros). `cleared`: cashable earnings old enough;
 * `excluded`: earnings that can never be cashed (from their own accounts, or flagged buyers);
 * `paidOut`: payouts so far (requested, on their way or paid). Payouts only ever come out of
 * cashable earnings, so all of them together never exceed what other players' cleared purchases
 * earned; building comes out of the excluded earnings first. At most what's left.
 */
export function payableMicros(w: { earned: number; earnedTotal: number; cleared: number; excluded: number; paidOut: number }): number {
  const built = Math.max(0, w.earnedTotal - w.earned - w.paidOut);
  return Math.max(0, Math.min(w.earned, w.cleared - w.paidOut - Math.max(0, built - w.excluded)));
}

// -- Stripe: Connect, the account's currency, the rate ------------------------------------------------

let connect: { key: string; ok: boolean; at: number } | null = null;

/**
 * Whether the Stripe account can make connected accounts. Asked with a request Stripe refuses
 * either way (an unknown country): about the country when Connect is on, about Connect when not.
 */
export async function connectReady(): Promise<boolean> {
  if (!paymentsOn() || env('ORB_PAYOUTS') === '0') return false;
  const key = keyTag();
  if (connect?.key === key && Date.now() - connect.at < (connect.ok ? 3600_000 : 600_000)) return connect.ok;
  let ok = false;
  try {
    await stripe('POST', '/v1/accounts', { type: 'express', country: 'XX' });
    ok = true;
  } catch (e) {
    ok = e instanceof StripeError && e.status === 400 && (e.param === 'country' || (/country/i.test(e.message) && !/connect|platform/i.test(e.message)));
    if (!ok) console.error('[orb] payouts are closed: Stripe Connect isn’t ready', e instanceof Error ? e.message : e);
  }
  connect = { key, ok, at: Date.now() };
  return ok;
}

let platform: { key: string; country: string; currency: string } | null = null;
async function platformAccount(): Promise<{ country: string; currency: string }> {
  const key = keyTag();
  if (platform?.key === key) return platform;
  const a = await stripe<{ country?: string; default_currency?: string }>('GET', '/v1/account');
  platform = { key, country: (a.country ?? 'US').toUpperCase(), currency: (a.default_currency ?? 'usd').toLowerCase() };
  return platform;
}

let ecb: { rate: number; at: number } | null = null;
/** US$ per euro: ORB_USD_PER_EUR, else the ECB's reference rate (kept 6 hours). */
async function usdPerEur(): Promise<number> {
  const fixed = Number(env('ORB_USD_PER_EUR'));
  if (fixed > 0) return fixed;
  if (ecb && Date.now() - ecb.at < 6 * 3600_000) return ecb.rate;
  const xml = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml', { signal: AbortSignal.timeout(8000) }).then((r) => r.text());
  const rate = Number(/currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(xml)?.[1]);
  if (!(rate > 0.2 && rate < 5)) throw new Error('no USD rate from the ECB');
  ecb = { rate, at: Date.now() };
  return rate;
}

/** The currency payouts are sent in (the Stripe balance's), and how many US$ one unit of it is. */
async function payoutCurrency(): Promise<{ currency: string; usdPer: number }> {
  const { currency } = await platformAccount();
  if (currency === 'usd') return { currency, usdPer: 1 };
  if (currency === 'eur') return { currency, usdPer: await usdPerEur() };
  throw new StripeError(503, `Payouts in ${currency.toUpperCase()} aren’t supported yet.`);
}

// -- accounts -----------------------------------------------------------------------------------------

interface AccountRow {
  stripe_account: string;
  country: string;
  ready: boolean;
}
interface ConnectedAccount {
  id: string;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  capabilities?: { transfers?: string };
  requirements?: { disabled_reason?: string | null };
}

async function accountOf(db: Db, userId: string): Promise<AccountRow | null> {
  return (await db.query<AccountRow>(`select stripe_account, country, ready from orb_payout_accounts where user_id = $1`, [userId]))[0] ?? null;
}

/** The account as Stripe has it now: ready when transfers are active and its bank can be paid. */
async function syncAccount(db: Db, userId: string, row: AccountRow): Promise<boolean> {
  const a = await stripe<ConnectedAccount>('GET', `/v1/accounts/${encodeURIComponent(row.stripe_account)}`);
  const ready = a.capabilities?.transfers === 'active' && a.payouts_enabled === true;
  await db.query(`update orb_payout_accounts set ready = $2, synced_at = now() where user_id = $1`, [userId, ready]);
  return ready;
}

export const COUNTRY_RE = /^[A-Z]{2}$/;

/** Stripe's onboarding page for the maker's payout account (made the first time, in `country`). */
export async function setupLink(db: Db, userId: string, country: string | null, urls: { refresh: string; back: string }): Promise<string> {
  if (!(await connectReady())) fail(503, 'payouts_off', 'Payouts aren’t open yet.');
  let row = await accountOf(db, userId);
  if (!row) {
    if (!country || !COUNTRY_RE.test(country)) fail(400, 'bad_country', 'Pick the country your bank account is in.');
    const handle = (await db.query<{ handle: string }>(`select handle from orb_handles where owner_user = $1`, [userId]))[0]?.handle;
    const { country: home } = await platformAccount();
    let made: { id: string };
    try {
      made = await stripe<{ id: string }>(
        'POST',
        '/v1/accounts',
        {
          type: 'express',
          country,
          business_type: 'individual',
          capabilities: { transfers: { requested: true } },
          // Paid from another country, an account only receives transfers.
          ...(country !== home ? { tos_acceptance: { service_agreement: 'recipient' } } : {}),
          business_profile: { product_description: 'Games and worlds made on Orb, with things to buy in them', ...(handle ? { url: `${SITE}/${handle}` } : {}) },
          metadata: { orb_user: userId },
        },
        { idempotencyKey: `orb-connect-${userId}-${country}` },
      );
    } catch (e) {
      if (e instanceof StripeError && e.status === 400) fail(400, 'country_unsupported', `Stripe can’t pay out to ${country} from here yet: pick another country your bank account is in, or check back later.`);
      throw e;
    }
    await db.query(`insert into orb_payout_accounts (user_id, stripe_account, country) values ($1, $2, $3) on conflict (user_id) do nothing`, [userId, made.id, country]);
    row = (await accountOf(db, userId))!;
  }
  const link = await stripe<{ url?: string }>('POST', '/v1/account_links', { account: row.stripe_account, type: 'account_onboarding', refresh_url: urls.refresh, return_url: urls.back });
  if (!link.url) throw new StripeError(502, 'Stripe returned no onboarding page.');
  return link.url;
}

/** Coming back from Stripe's onboarding: whether the account can be paid now. */
export async function returnFromSetup(db: Db, userId: string): Promise<boolean> {
  const row = await accountOf(db, userId);
  return row ? syncAccount(db, userId, row) : false;
}

/** Stripe's dashboard for a payout account (bank, payouts, tax forms); onboarding until it's set up. */
export async function dashboardLink(db: Db, userId: string, urls: { refresh: string; back: string }): Promise<string> {
  const row = await accountOf(db, userId);
  if (!row) fail(404, 'not_found', 'There are no payouts to manage yet.');
  const a = await stripe<ConnectedAccount>('GET', `/v1/accounts/${encodeURIComponent(row.stripe_account)}`);
  if (!a.details_submitted) return setupLink(db, userId, null, urls);
  const link = await stripe<{ url?: string }>('POST', `/v1/accounts/${encodeURIComponent(row.stripe_account)}/login_links`);
  if (!link.url) throw new StripeError(502, 'Stripe returned no dashboard.');
  return link.url;
}

// -- what's cashable ----------------------------------------------------------------------------------

/**
 * The maker's purchases, each marked cashable or not, and `cleared` once older than the hold. $1:
 * the maker's user id, $2: the hold in seconds (ORB_PAYOUT_HOLD_DAYS × 86400). A buyer is the
 * maker's own when they share a device (analytics of the last 180 days, or the devices table) or a
 * card; a flagged buyer (a refunded or disputed payment) never earns cashable credits again.
 */
const SALES = `
  with mine_devices as (
    select e.device from orb_events e where e.user_id = $1 and e.device is not null
    union select d.hash from orb_devices d where d.user_id = $1
  ), mine_cards as (
    select c.fingerprint from orb_cards c where c.payer = 'u:' || $1
  ), sales as (
    select p.buyer_user, p.earned_micros, p.created_at, p.created_at < now() - make_interval(secs => $2::double precision) as cleared,
      (not exists (select 1 from orb_wallets bw where bw.payer = 'u:' || p.buyer_user and bw.flagged_at is not null)
       and not exists (select 1 from orb_events e where e.user_id = p.buyer_user and e.device in (select device from mine_devices))
       and not exists (select 1 from orb_devices d where d.user_id = p.buyer_user and d.hash in (select device from mine_devices))
       and not exists (select 1 from orb_cards c where c.payer = 'u:' || p.buyer_user and c.fingerprint in (select fingerprint from mine_cards))
      ) as cashable
    from orb_purchases p
    where p.seller_user = $1 and p.status = 'done' and not p.reversed and p.earned_micros > 0
  )`;

interface Standing {
  earned: number;
  earnedTotal: number;
  cleared: number;
  excluded: number;
  /** Different players whose cleared purchases are cashable. */
  buyers: number;
  paidOut: number;
}

async function standing(db: Db, userId: string, holdDays: number): Promise<Standing> {
  const rows = await db.query<{ earned: string | null; total: string | null; cleared: string | null; excluded: string | null; buyers: string | null; paid: string | null }>(
    `${SALES}
     select w.earned_micros as earned, w.earned_total_micros as total,
       (select coalesce(sum(earned_micros), 0) from sales where cashable and cleared) as cleared,
       (select coalesce(sum(earned_micros), 0) from sales where not cashable) as excluded,
       (select count(distinct buyer_user) from sales where cashable and cleared) as buyers,
       (select coalesce(sum(micros), 0) from orb_payouts where user_id = $1 and status in ('requested', 'pending', 'paid')) as paid
     from orb_wallets w where w.payer = 'u:' || $1`,
    [userId, holdDays * 86400],
  );
  const r = rows[0];
  return { earned: Number(r?.earned ?? 0), earnedTotal: Number(r?.total ?? 0), cleared: Number(r?.cleared ?? 0), excluded: Number(r?.excluded ?? 0), buyers: Number(r?.buyers ?? 0), paidOut: Number(r?.paid ?? 0) };
}

/** Payouts in the plan card (BillingInfo.earnings.payouts), or null while they're closed. */
export async function payoutsView(db: Db, userId: string): Promise<NonNullable<BillingInfo['earnings']>['payouts']> {
  if (!(await connectReady())) return null;
  const cfg = payoutConfig();
  await settlePending(db, userId).catch((e) => console.error('[orb] settling a payout failed', e instanceof Error ? e.message : e));
  const [row, s, sums] = await Promise.all([
    accountOf(db, userId),
    standing(db, userId, cfg.holdDays),
    db.query<{ paid: string | null; requested: string | null }>(
      `select coalesce(sum(micros) filter (where status in ('paid', 'pending')), 0) as paid, coalesce(sum(micros) filter (where status = 'requested'), 0) as requested from orb_payouts where user_id = $1`,
      [userId],
    ),
  ]);
  const rate = await payoutCurrency().catch(() => null);
  const credits = (micros: number) => Math.floor(toCredits(micros) * 100) / 100;
  return {
    account: !row ? 'none' : row.ready ? 'ready' : 'pending',
    payable: credits(payableMicros(s)),
    minimum: cfg.minimum,
    holdDays: cfg.holdDays,
    buyers: s.buyers,
    minBuyers: cfg.buyers,
    requested: credits(Number(sums[0]?.requested ?? 0)),
    paid: credits(Number(sums[0]?.paid ?? 0)),
    currency: rate?.currency ?? null,
    usdPer: rate?.usdPer ?? null,
  };
}

// -- paying -------------------------------------------------------------------------------------------

export interface PayoutResult {
  credits: number;
  amount: number;
  currency: string;
  /** Waiting for Orb's check before it's sent. */
  requested: boolean;
  /** Stripe's answer didn't come back: it's settled on the next look. */
  pending: boolean;
}

interface PayoutRow {
  id: string;
  user_id: string;
  stripe_account: string;
  micros: string;
  amount: string;
  currency: string;
}
const PAYOUT_COLS = 'id, user_id, stripe_account, micros, amount, currency';

const transferParams = (p: PayoutRow) => ({
  amount: Number(p.amount),
  currency: p.currency,
  destination: p.stripe_account,
  description: 'Orb: what your worlds earned',
  metadata: { orb_user: p.user_id, orb_payout: p.id, credits: String(toCredits(Number(p.micros))) },
});

async function markPaid(db: Db, p: PayoutRow, transfer: string): Promise<void> {
  await db.query(
    `with u as (update orb_payouts set status = 'paid', transfer = $2, error = null where id = $1 and status = 'pending' returning user_id, micros)
     insert into orb_credit_log (payer, kind, micros, ref) select 'u:' || user_id, 'payout', -micros, $1 from u on conflict do nothing`,
    [p.id, transfer],
  );
}

/** The payout won't be sent (Stripe said no, or Orb's check did): the earnings are the maker's again. */
async function giveBack(db: Db, id: string, from: 'pending' | 'requested', status: 'failed' | 'rejected', note: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `with u as (update orb_payouts set status = $3, error = $4, reviewed_at = case when $3 = 'rejected' then now() else reviewed_at end
               where id = $1 and status = $2 returning user_id, micros, id)
     , w as (update orb_wallets w set earned_micros = w.earned_micros + u.micros, updated_at = now() from u where w.payer = 'u:' || u.user_id)
     select id from u`,
    [id, from, status, note.slice(0, 500)],
  );
  return rows.length > 0;
}

async function send(db: Db, p: PayoutRow): Promise<boolean> {
  try {
    const t = await stripe<{ id: string }>('POST', '/v1/transfers', transferParams(p), { idempotencyKey: `orb-payout-${p.id}` });
    await markPaid(db, p, t.id);
    return true;
  } catch (e) {
    if (e instanceof StripeError && e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429) {
      await giveBack(db, p.id, 'pending', 'failed', e.message);
      console.error('[orb] a payout failed', p.id, e.message);
      throw e;
    }
    return false; // no answer: settled later
  }
}

/** Pending payouts whose answer was lost: found in Stripe (by their metadata), or sent again. */
async function settlePending(db: Db, userId: string): Promise<void> {
  const rows = await db.query<PayoutRow>(
    `select ${PAYOUT_COLS} from orb_payouts where user_id = $1 and status = 'pending' and coalesce(reviewed_at, created_at) < now() - make_interval(secs => $2::double precision) order by created_at limit 5`,
    [userId, numberEnv(process.env, 'ORB_PAYOUT_SETTLE_S', 30, 0, 3600)],
  );
  for (const p of rows) {
    const listed = await stripe<{ data?: Array<{ id: string; metadata?: Record<string, string> }> }>('GET', '/v1/transfers', { destination: p.stripe_account, limit: 100 });
    const made = listed.data?.find((t) => t.metadata?.orb_payout === p.id);
    if (made) await markPaid(db, p, made.id);
    else await send(db, p).catch(() => undefined);
  }
}

/** Send a payout that's pending (just made, or just approved); what to tell the maker. */
async function sendNow(db: Db, p: PayoutRow): Promise<boolean> {
  try {
    return await send(db, p);
  } catch (e) {
    const balance = e instanceof StripeError && e.code === 'balance_insufficient';
    fail(502, 'payout_failed', balance ? 'Payouts are paused for a moment. Your earnings are safe: try again later.' : 'Stripe couldn’t send it. Your earnings are safe: try again later.');
  }
}

/** Cash out everything payable: a request for Orb to check (or, without review, sent at once). */
export async function cashOut(db: Db, userId: string): Promise<PayoutResult> {
  if (!(await connectReady())) fail(503, 'payouts_off', 'Payouts aren’t open yet.');
  await settlePending(db, userId);
  const row = await accountOf(db, userId);
  if (!row) fail(409, 'payout_setup', 'Set up payouts with Stripe first.');
  if (!(await syncAccount(db, userId, row))) fail(409, 'payout_setup', 'Finish setting up payouts with Stripe first.');
  const cfg = payoutConfig();
  const s = await standing(db, userId, cfg.holdDays);
  const micros = payableMicros(s);
  const minimum = cfg.minimum * MICROS_PER_CREDIT;
  if (micros < minimum || s.buyers < cfg.buyers) {
    const days = `sales clear after ${cfg.holdDays} days`;
    fail(
      409,
      'below_minimum',
      micros < minimum
        ? `You can cash out from ${cfg.minimum.toLocaleString('en-US')} credits earned from other players; ${Math.floor(toCredits(micros)).toLocaleString('en-US')} are ready (${days}).`
        : `You can cash out once at least ${cfg.buyers} different players have bought things in your worlds; ${s.buyers} so far (${days}).`,
    );
  }
  const { currency, usdPer } = await payoutCurrency();
  const id = `po_${crypto.randomBytes(9).toString('base64url')}`;
  // Credits are US cents: micros / 10,000 is US cents, divided by US$ per unit is the currency's cents.
  let rows: PayoutRow[];
  try {
    rows = await db.query<PayoutRow>(
      `with take as (
         update orb_wallets set earned_micros = earned_micros - $4::bigint, updated_at = now()
         where payer = 'u:' || $2 and earned_micros >= $4::bigint
         returning payer
       )
       insert into orb_payouts (id, user_id, stripe_account, micros, amount, currency, usd_per, status)
       select $1, $2, $3, $4::bigint, floor($4::numeric / ${MICROS_PER_CREDIT} / $5::numeric)::bigint, $6, $5::numeric, $7 from take
       returning ${PAYOUT_COLS}`,
      [id, userId, row.stripe_account, micros, usdPer, currency, cfg.review ? 'requested' : 'pending'],
    );
  } catch (e) {
    // orb_payouts_open: one open payout per maker
    if (/orb_payouts_open|duplicate key/i.test(e instanceof Error ? e.message : '')) fail(409, 'payout_open', 'Your last cash-out is still on its way.');
    throw e;
  }
  const p = rows[0];
  if (!p) fail(409, 'below_minimum', 'Your earnings changed just now: look again.');
  const result = { credits: toCredits(Number(p.micros)), amount: Number(p.amount) / 100, currency: p.currency };
  if (cfg.review) return { ...result, requested: true, pending: false };
  return { ...result, requested: false, pending: !(await sendNow(db, p)) };
}

// -- Orb's check of each request (the admin API, the lab's Pulse) -------------------------------------

export interface PayoutRequest {
  id: string;
  createdAt: string;
  user: { id: string; handle: string | null; name: string; createdAt: string };
  credits: number;
  amount: number;
  currency: string;
  country: string;
  /** What's behind it: cashable sales, from how many players, the biggest buyer's part of them, and their worlds. */
  sales: { count: number; buyers: number; topBuyerShare: number; worlds: Array<{ id: string; name: string; credits: number }> };
  /** Earnings Orb won't pay out (their own accounts, flagged buyers), and reversed sales. */
  excluded: number;
  reversed: number;
}

/** Payout requests waiting for Orb's check, oldest first, with what Orb should look at. */
export async function payoutRequests(db: Db): Promise<PayoutRequest[]> {
  const cfg = payoutConfig();
  const rows = await db.query<{ id: string; created_at: string | Date; user_id: string; micros: string; amount: string; currency: string; country: string | null; handle: string | null; name: string | null; user_created: string | Date }>(
    `select p.id, p.created_at, p.user_id, p.micros, p.amount, p.currency, a.country, h.handle, u.name, u.created_at as user_created
     from orb_payouts p left join orb_payout_accounts a on a.user_id = p.user_id left join orb_handles h on h.owner_user = p.user_id left join orb_users u on u.id = p.user_id
     where p.status = 'requested' order by p.created_at limit 100`,
  );
  const out: PayoutRequest[] = [];
  for (const r of rows) {
    const [detail] = await db.query<{ count: string; buyers: string; top: string | null; total: string | null; excluded: string | null; reversed: string | null; worlds: Array<{ id: string; name: string; micros: number }> | null }>(
      `${SALES}, ok as (select * from sales where cashable and cleared)
       select (select count(*) from ok) as count, (select count(distinct buyer_user) from ok) as buyers,
         (select max(s) from (select sum(earned_micros) as s from ok group by buyer_user) t) as top,
         (select sum(earned_micros) from ok) as total,
         (select coalesce(sum(earned_micros), 0) from sales where not cashable) as excluded,
         (select coalesce(sum(earned_micros), 0) from orb_purchases where seller_user = $1 and reversed) as reversed,
         (select json_agg(w) from (select p.world_id as id, coalesce(ww.name, p.world_id) as name, sum(p.earned_micros) as micros
            from orb_purchases p left join orb_worlds ww on ww.id = p.world_id
            where p.seller_user = $1 and p.status = 'done' and not p.reversed group by p.world_id, ww.name order by micros desc limit 5) w) as worlds`,
      [r.user_id, cfg.holdDays * 86400],
    );
    const total = Number(detail?.total ?? 0);
    out.push({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      user: { id: r.user_id, handle: r.handle, name: r.name ?? '', createdAt: new Date(r.user_created).toISOString() },
      credits: toCredits(Number(r.micros)),
      amount: Number(r.amount) / 100,
      currency: r.currency,
      country: r.country ?? '',
      sales: {
        count: Number(detail?.count ?? 0),
        buyers: Number(detail?.buyers ?? 0),
        topBuyerShare: total > 0 ? Math.round((Number(detail?.top ?? 0) / total) * 100) / 100 : 0,
        worlds: (detail?.worlds ?? []).map((w) => ({ id: w.id, name: w.name, credits: toCredits(Number(w.micros)) })),
      },
      excluded: toCredits(Number(detail?.excluded ?? 0)),
      reversed: toCredits(Number(detail?.reversed ?? 0)),
    });
  }
  return out;
}

/** Orb's answer to a payout request: approved, it's sent now; rejected, the earnings are the maker's again. */
export async function reviewPayout(db: Db, id: string, approve: boolean, note: string): Promise<{ status: string }> {
  if (!approve) {
    if (!(await giveBack(db, id, 'requested', 'rejected', note || 'rejected'))) fail(404, 'not_found', 'There’s no such payout request.');
    return { status: 'rejected' };
  }
  const rows = await db.query<PayoutRow>(
    `update orb_payouts set status = 'pending', reviewed_at = now(), error = null where id = $1 and status = 'requested' returning ${PAYOUT_COLS}`,
    [id],
  );
  const p = rows[0];
  if (!p) fail(404, 'not_found', 'There’s no such payout request.');
  const account = await accountOf(db, p.user_id);
  if (!account || !(await syncAccount(db, p.user_id, account))) {
    await giveBack(db, id, 'pending', 'failed', 'the payout account can’t be paid (Stripe)');
    fail(409, 'payout_setup', 'Stripe can’t pay this account right now; the earnings went back to the maker.');
  }
  return { status: (await sendNow(db, p)) ? 'paid' : 'pending' };
}

// -- reversals ----------------------------------------------------------------------------------------

/**
 * A payment of the buyer's was refunded or disputed: flag them (nothing they buy is cashable from
 * now on) and take back what their purchases of the last 120 days earned makers, also when it was
 * already used or paid out (the maker's earnings can go below zero; later sales cover it).
 */
export async function reverseBuyer(db: Db, buyerUser: string, why: string): Promise<number> {
  const rows = await db.query<{ micros: string | null }>(
    `with flag as (
       update orb_wallets set flagged_at = coalesce(flagged_at, now()), flag_reason = coalesce(flag_reason, $2), updated_at = now() where payer = 'u:' || $1
     ), r as (
       update orb_purchases set reversed = true
       where buyer_user = $1 and not reversed and status = 'done' and earned_micros > 0 and seller_user is not null and created_at > now() - interval '120 days'
       returning seller_user, earned_micros
     ), per as (
       select seller_user, sum(earned_micros) as m from r group by seller_user
     ), w as (
       update orb_wallets o set earned_micros = o.earned_micros - per.m, earned_total_micros = o.earned_total_micros - per.m, updated_at = now()
       from per where o.payer = 'u:' || per.seller_user
     )
     select coalesce(sum(earned_micros), 0) as micros from r`,
    [buyerUser, why.slice(0, 200)],
  );
  return toCredits(Number(rows[0]?.micros ?? 0));
}

/** Remember a card the payer paid with (Stripe's fingerprint), to tell a maker's own accounts apart. */
export async function rememberCard(db: Db, payer: string, fingerprint: string | null | undefined): Promise<void> {
  if (!fingerprint || !/^[\w-]{4,64}$/.test(fingerprint)) return;
  await db.query(`insert into orb_cards (payer, fingerprint) values ($1, $2) on conflict do nothing`, [payer, fingerprint]);
}

/** The billing answer with the maker's payouts in it (GET /api/billing and the earnings routes). */
export async function withPayouts(db: Db, info: BillingInfo, payer: string, req: Request): Promise<BillingInfo> {
  const userId = userOfPayer(payer);
  if (!info.earnings || !userId) return info;
  try {
    const view = await payoutsView(db, userId);
    const country = (req.headers.get('x-vercel-ip-country') ?? '').toUpperCase();
    info.earnings.payouts = view && { ...view, country: COUNTRY_RE.test(country) ? country : null };
  } catch (e) {
    console.error('[orb] reading payouts failed', e instanceof Error ? e.message : e);
    info.earnings.payouts = null;
  }
  return info;
}
