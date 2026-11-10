// Plans and credits: what building with Orb's AI costs people (docs/operations.md "Plans and credits").
//
// A credit is a cent of what the AI costs Orb at the model's list price, the same cost the free
// builder's daily budget counts (./budget.ts): a typical build uses about 30 (TYPICAL_BUILD_CREDITS).
// Everyone who builds on Orb's AI has a wallet (orb_wallets), in millionths of a US dollar:
// - without an account, a device gets the guest credits each week (ORB_GUEST_CREDITS);
// - an account gets the Free plan's (ORB_FREE_CREDITS), or Pro's (ORB_PRO_CREDITS) while it pays
//   for Pro (./billing.ts keeps Pro's monthly periods in step with Stripe).
// Plan credits refresh every week, on Monday at 00:00 UTC, on every plan, like Claude's weekly
// limits; a week's don't carry over. Top-ups (packs) stay until they are used, and are spent after
// the plan's. Builds are charged as they go, so a build may end a little below zero (its last
// step), which the next week's credits make up for.
//
// Plain SQL, one statement per change (the database is a transaction pooler); unit-tested in
// src/lib/engine/__tests__/credits.test.mjs.

import type { CreditPack, Plan } from '@/lib/types';
import type { Db } from './db';

export interface PlansConfig {
  /** Credits a week per device without an account (ORB_GUEST_CREDITS). */
  guest: number;
  /** Credits a week per account on the Free plan (ORB_FREE_CREDITS). */
  free: number;
  /** Pro: credits a week (ORB_PRO_CREDITS) for US$ a month (ORB_PRO_USD). */
  pro: { credits: number; usd: number };
  /** Credit packs any account can buy (ORB_TOPUPS, "usd:credits,…"). */
  topups: CreditPack[];
}

/**
 * A week's credits are a month's over 4.35 (as many weeks as a month has): guests about 100 a
 * month, Free about 300, Pro about 2,000 for US$20, which is Orb's cost if someone uses every credit
 * (Stripe's fee aside). Packs cover Stripe's fee too and give a little less per dollar (80–84
 * credits) than Pro adds over Free (about 1,700 a month for US$20, 85 a dollar): Pro stays the
 * better deal for regular builders, but not by so much that a second account with a second
 * subscription would pay off. Pack credits never expire.
 */
export const PLAN_DEFAULTS: PlansConfig = {
  guest: 25,
  free: 70,
  pro: { credits: 460, usd: 20 },
  topups: [
    { id: 'usd10', usd: 10, credits: 800 },
    { id: 'usd25', usd: 25, credits: 2100 },
    { id: 'usd50', usd: 50, credits: 4200 },
  ],
};

/**
 * Credits a typical build uses: the median free build on Claude Sonnet 5.5 (October 2026) was 15;
 * Orb's AI is Claude Opus 5.5 now, at twice the price per token.
 */
export const TYPICAL_BUILD_CREDITS = 30;

export const MICROS_PER_CREDIT = 10_000;
export const toCredits = (micros: number) => micros / MICROS_PER_CREDIT;
export const toMicros = (credits: number) => Math.round(credits * MICROS_PER_CREDIT);

/** A number setting: env[key] when it is a number in [min, max], else the fallback. */
export function numberEnv(env: Record<string, string | undefined>, key: string, fallback: number, min = 0, max = Infinity): number {
  const raw = (env[key] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function topupsEnv(raw: string | undefined): CreditPack[] | null {
  const packs: CreditPack[] = [];
  for (const part of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+(?:\.\d{1,2})?):(\d+)$/.exec(part);
    if (!m) return null;
    const usd = Number(m[1]);
    const credits = Number(m[2]);
    if (usd < 1 || usd > 1000 || credits < 1) return null;
    packs.push({ id: `usd${String(usd).replace('.', '_')}`, usd, credits });
  }
  return packs.length ? packs.slice(0, 6) : null;
}

export function plansConfig(env: Record<string, string | undefined> = process.env): PlansConfig {
  return {
    guest: Math.min(1_000_000, numberEnv(env, 'ORB_GUEST_CREDITS', PLAN_DEFAULTS.guest)),
    free: Math.min(1_000_000, numberEnv(env, 'ORB_FREE_CREDITS', PLAN_DEFAULTS.free)),
    pro: {
      credits: Math.min(1_000_000, numberEnv(env, 'ORB_PRO_CREDITS', PLAN_DEFAULTS.pro.credits)),
      usd: Math.max(1, Math.min(10_000, numberEnv(env, 'ORB_PRO_USD', PLAN_DEFAULTS.pro.usd))),
    },
    topups: topupsEnv(env.ORB_TOPUPS) ?? PLAN_DEFAULTS.topups,
  };
}

// -- wallets ------------------------------------------------------------------------------------

/** Whose credits a build uses: the account's ('u:<id>'), or the device's without one ('d:<hash>'). */
export function payerOf(who: { userId?: string | null; deviceHash?: string | null }): string | null {
  if (who.userId) return `u:${who.userId}`;
  if (who.deviceHash) return `d:${who.deviceHash}`;
  return null;
}

export const userOfPayer = (payer: string): string | null => (payer.startsWith('u:') ? payer.slice(2) : null);

export interface Wallet {
  payer: string;
  plan: Plan;
  /** Credits left in all: this week's plan credits, bonus credits, then top-ups (a little below 0 after an overdraft). */
  left: number;
  /** This week's plan credits, and how many of them are used. */
  allowance: number;
  used: number;
  /** When the plan credits refresh: next Monday, 00:00 UTC. */
  refreshAt: string;
  /** Top-up credits left (bought). */
  topup: number;
  /** Bonus credits left: given, not bought (earnings put into building); in worlds' shops they earn nobody anything. */
  bonus: number;
  /** Credits earned in the account's worlds' shops, not used yet (./shop.ts), and all ever earned. */
  earned: number;
  earnedTotal: number;
  periodStart: string;
  /** Pro: when its paid month ends (it renews, or ends). Otherwise when the week's credits refresh. */
  periodEnd: string;
  /** Pro ends at this time instead of renewing. */
  cancelAt: string | null;
  /** The subscription's Stripe status (active, past_due…). */
  status: string | null;
  stripeCustomer: string | null;
  stripeSubscription: string | null;
  syncedAt: string | null;
}

interface WalletRow {
  payer: string;
  plan: string;
  period_start: Date | string;
  period_end: Date | string;
  allowance_micros: string | number;
  used_micros: string | number;
  topup_micros: string | number;
  bonus_micros?: string | number | null;
  earned_micros?: string | number | null;
  earned_total_micros?: string | number | null;
  stripe_customer: string | null;
  stripe_subscription: string | null;
  sub_status: string | null;
  cancel_at: Date | string | null;
  synced_at: Date | string | null;
  week_start?: Date | string | null;
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOrNull = (v: Date | string | null) => (v ? iso(v) : null);

function toWallet(r: WalletRow): Wallet {
  const allowance = Number(r.allowance_micros);
  const used = Number(r.used_micros);
  const topup = Number(r.topup_micros);
  const bonus = Math.max(0, Number(r.bonus_micros ?? 0));
  return {
    payer: r.payer,
    plan: r.plan === 'pro' ? 'pro' : r.payer.startsWith('d:') ? 'guest' : 'free',
    left: toCredits(Math.max(0, allowance - used) + bonus + topup),
    allowance: toCredits(allowance),
    used: toCredits(Math.min(used, allowance)),
    refreshAt: r.week_start ? new Date(new Date(r.week_start).getTime() + WEEK_MS).toISOString() : iso(r.period_end),
    topup: toCredits(topup),
    bonus: toCredits(bonus),
    earned: toCredits(Number(r.earned_micros ?? 0)),
    earnedTotal: toCredits(Number(r.earned_total_micros ?? 0)),
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
    cancelAt: isoOrNull(r.cancel_at),
    status: r.sub_status,
    stripeCustomer: r.stripe_customer,
    stripeSubscription: r.stripe_subscription,
    syncedAt: isoOrNull(r.synced_at),
  };
}

const WEEK_MS = 7 * 86400_000;

/** The UTC week around `now`, from Monday 00:00: the period of every plan's credits. */
export function weekOf(now: Date): { start: Date; end: Date } {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(day - ((now.getUTCDay() + 6) % 7) * 86400_000);
  return { start, end: new Date(start.getTime() + WEEK_MS) };
}

/** A plan's weekly credits (they follow the settings at once). */
export function allowanceOf(plan: Plan, cfg: PlansConfig): number {
  return plan === 'pro' ? cfg.pro.credits : plan === 'guest' ? cfg.guest : cfg.free;
}

/**
 * The payer's wallet, made on first use, with its plan credits refreshed once their week is over,
 * on every plan. Whether an account is on Pro, and its paid month, follow Stripe (./billing.ts).
 */
export async function ensureWallet(db: Db, payer: string, cfg: PlansConfig = plansConfig(), now: Date = new Date()): Promise<Wallet> {
  const rows = await db.query<WalletRow>(`select * from orb_wallets where payer = $1`, [payer]);
  const row = rows[0];
  const guest = payer.startsWith('d:');
  const { start, end } = weekOf(now);
  const allowance = toMicros(allowanceOf(row?.plan === 'pro' ? 'pro' : guest ? 'guest' : 'free', cfg));
  if (row?.week_start && new Date(row.week_start) >= start && Number(row.allowance_micros) === allowance) return toWallet(row);
  // Two requests may get here at once: the week test in the update itself keeps it to one refresh.
  const fresh = await db.query<WalletRow>(
    `insert into orb_wallets as w (payer, plan, period_start, period_end, allowance_micros, week_start)
     values ($1, $2, $3::timestamptz, $4::timestamptz, $5::bigint, $3::timestamptz)
     on conflict (payer) do update set
       used_micros = case when w.week_start is null or w.week_start < $3::timestamptz then 0 else w.used_micros end,
       week_start = greatest(coalesce(w.week_start, $3::timestamptz), $3::timestamptz),
       period_start = case when w.plan = 'pro' then w.period_start else excluded.period_start end,
       period_end = case when w.plan = 'pro' then w.period_end else excluded.period_end end,
       allowance_micros = case when w.plan = 'pro' then $6::bigint else excluded.allowance_micros end,
       updated_at = now()
     returning *`,
    [payer, guest ? 'guest' : 'free', start, end, toMicros(allowanceOf(guest ? 'guest' : 'free', cfg)), toMicros(cfg.pro.credits)],
  );
  return toWallet(fresh[0] ?? (await db.query<WalletRow>(`select * from orb_wallets where payer = $1`, [payer]))[0]);
}

export async function readWallet(db: Db, payer: string): Promise<Wallet | null> {
  const rows = await db.query<WalletRow>(`select * from orb_wallets where payer = $1`, [payer]);
  return rows[0] ? toWallet(rows[0]) : null;
}

/** The account a Stripe customer belongs to. */
export async function walletOfCustomer(db: Db, customer: string): Promise<Wallet | null> {
  const rows = await db.query<WalletRow>(`select * from orb_wallets where stripe_customer = $1 order by updated_at desc limit 1`, [customer]);
  return rows[0] ? toWallet(rows[0]) : null;
}

/**
 * Take what a build cost (millionths of a US$) from the payer's credits: this period's plan credits
 * first, then bonus credits, then top-ups, which may go below zero. The wallet after it, and how much
 * of the cost came from top-ups (a refund gives that much back to them, and no more: see refundCredits).
 */
export async function chargeCredits(db: Db, payer: string, micros: number, cfg: PlansConfig = plansConfig(), now: Date = new Date()): Promise<Wallet & { fromTopup: number }> {
  await ensureWallet(db, payer, cfg, now);
  const amount = Math.max(0, Math.round(micros));
  const rows = await db.query<WalletRow & { from_topup: string | number }>(
    `with w as (
       select payer, least($2::bigint, greatest(0, allowance_micros - used_micros)) as from_plan, greatest(0, bonus_micros) as b from orb_wallets where payer = $1 for update
     ), part as (
       select payer, from_plan, least($2::bigint - from_plan, b) as from_bonus from w
     )
     update orb_wallets o set
       used_micros = o.used_micros + part.from_plan,
       bonus_micros = greatest(0, o.bonus_micros) - part.from_bonus,
       topup_micros = o.topup_micros - ($2::bigint - part.from_plan - part.from_bonus),
       updated_at = now()
     from part where o.payer = part.payer
     returning o.*, $2::bigint - part.from_plan - part.from_bonus as from_topup`,
    [payer, amount],
  );
  return { ...toWallet(rows[0]), fromTopup: Number(rows[0].from_topup) || 0 };
}

/**
 * Give back what a build that came to nothing cost — once per `ref` (the job). What came from top-ups
 * (`fromTopup`) goes back to the top-ups; the rest (plan and bonus credits, which nobody bought) to
 * this week's plan credits, as far as it used them, and then to bonus credits. A refund never turns
 * credits nobody bought into top-ups, which count as bought (in worlds' shops, what bought credits buy
 * earns makers money), also when the week they came from is over. Null if it already was.
 */
export async function refundCredits(db: Db, payer: string, micros: number, ref: string, fromTopup = 0): Promise<Wallet | null> {
  const amount = Math.max(0, Math.round(micros));
  if (!amount) return null;
  const toTopup = Math.min(amount, Math.max(0, Math.round(fromTopup)));
  const rows = await db.query<WalletRow>(
    `with logged as (
       insert into orb_credit_log (payer, kind, micros, ref) values ($1, 'refund', $2::bigint, $3)
       on conflict (kind, ref) where ref is not null do nothing
       returning micros
     )
     update orb_wallets set
       used_micros = used_micros - least((select micros from logged) - $4::bigint, used_micros),
       bonus_micros = greatest(0, bonus_micros) + ((select micros from logged) - $4::bigint - least((select micros from logged) - $4::bigint, used_micros)),
       topup_micros = topup_micros + $4::bigint,
       updated_at = now()
     where payer = $1 and exists (select 1 from logged)
     returning *`,
    [payer, amount, ref, toTopup],
  );
  return rows[0] ? toWallet(rows[0]) : null;
}

/** Add credits to top-ups or bonus credits — once per `ref` (its kind's). Null if it already was. */
async function grantOnce(db: Db, payer: string, kind: 'topup' | 'gift', credits: number, ref: string, cfg: PlansConfig, now: Date): Promise<Wallet | null> {
  await ensureWallet(db, payer, cfg, now);
  const add = kind === 'topup' ? 'topup_micros = topup_micros' : 'bonus_micros = greatest(0, bonus_micros)';
  const rows = await db.query<WalletRow>(
    `with logged as (
       insert into orb_credit_log (payer, kind, micros, ref) values ($1, $4, $2::bigint, $3)
       on conflict (kind, ref) where ref is not null do nothing
       returning micros
     )
     update orb_wallets set ${add} + (select micros from logged), updated_at = now()
     where payer = $1 and exists (select 1 from logged)
     returning *`,
    [payer, toMicros(credits), ref, kind],
  );
  return rows[0] ? toWallet(rows[0]) : null;
}

/** Add a bought pack of credits — once per `ref` (the Stripe checkout). Null if it already was. */
export function grantTopup(db: Db, payer: string, credits: number, ref: string, cfg: PlansConfig = plansConfig(), now: Date = new Date()): Promise<Wallet | null> {
  return grantOnce(db, payer, 'topup', credits, ref, cfg, now);
}

/**
 * Gift credits from Orb (an admin): bonus credits, which build like any others but earn nobody
 * anything when spent in worlds, so they can't be cashed out. Once per `ref`; null if it already was.
 */
export function grantGift(db: Db, payer: string, credits: number, ref: string, cfg: PlansConfig = plansConfig(), now: Date = new Date()): Promise<Wallet | null> {
  return grantOnce(db, payer, 'gift', credits, ref, cfg, now);
}

/** Note what a finished build cost its maker (once per job). */
export async function logBuild(db: Db, payer: string, micros: number, ref: string): Promise<void> {
  if (!(micros > 0)) return;
  await db.query(`insert into orb_credit_log (payer, kind, micros, ref) values ($1, 'build', $2::bigint, $3) on conflict (kind, ref) where ref is not null do nothing`, [payer, Math.round(micros), ref]);
}

export interface ProPeriod {
  start: Date;
  end: Date;
  credits: number;
  customer: string | null;
  subscription: string;
  status: string;
  cancelAt: Date | null;
}

/**
 * The account is on Pro for this paid month (Stripe's period). Its credits are Pro's for the week
 * at once (an upgrade adds the difference to what's left this week); they go on refreshing every
 * week (ensureWallet), so a renewal, or Stripe repeating itself, only updates the period's details.
 */
export async function setProPeriod(db: Db, payer: string, p: ProPeriod, now: Date = new Date()): Promise<Wallet> {
  const rows = await db.query<WalletRow>(
    `insert into orb_wallets as w (payer, plan, period_start, period_end, allowance_micros, used_micros, stripe_customer, stripe_subscription, sub_status, cancel_at, synced_at, week_start)
     values ($1, 'pro', $2::timestamptz, $3::timestamptz, $4::bigint, 0, $5, $6, $7, $8::timestamptz, now(), $9::timestamptz)
     on conflict (payer) do update set
       used_micros = case when w.week_start is null or w.week_start < excluded.week_start then 0 else w.used_micros end,
       week_start = greatest(coalesce(w.week_start, excluded.week_start), excluded.week_start),
       allowance_micros = excluded.allowance_micros,
       plan = 'pro',
       period_start = excluded.period_start,
       period_end = excluded.period_end,
       stripe_customer = coalesce(excluded.stripe_customer, w.stripe_customer),
       stripe_subscription = excluded.stripe_subscription,
       sub_status = excluded.sub_status,
       cancel_at = excluded.cancel_at,
       synced_at = now(),
       updated_at = now()
     returning *`,
    [payer, p.start, p.end, toMicros(p.credits), p.customer, p.subscription, p.status, p.cancelAt, weekOf(now).start],
  );
  return toWallet(rows[0]);
}

/** Pro is over (cancelled, or never paid): back on Free, with the week's Free credits (what's used this week stays used). */
export async function endPro(db: Db, payer: string, status: string | null, cfg: PlansConfig = plansConfig(), now: Date = new Date()): Promise<Wallet | null> {
  const { start, end } = weekOf(now);
  const rows = await db.query<WalletRow>(
    `update orb_wallets set plan = 'free', period_start = $2::timestamptz, period_end = $3::timestamptz, allowance_micros = $4::bigint,
       used_micros = case when week_start is null or week_start < $2::timestamptz then 0 else used_micros end,
       week_start = greatest(coalesce(week_start, $2::timestamptz), $2::timestamptz), sub_status = $5, cancel_at = null, synced_at = now(), updated_at = now()
     where payer = $1 and plan = 'pro'
     returning *`,
    [payer, start, end, toMicros(cfg.free), status],
  );
  return rows[0] ? toWallet(rows[0]) : null;
}

/** Remember the account's Stripe customer (made by its first checkout). */
export async function setCustomer(db: Db, payer: string, customer: string, cfg: PlansConfig = plansConfig()): Promise<void> {
  await ensureWallet(db, payer, cfg);
  await db.query(`update orb_wallets set stripe_customer = $2, updated_at = now() where payer = $1 and stripe_customer is distinct from $2`, [payer, customer]);
}

/** Note that the wallet was just checked against Stripe (lookups are spaced out by it). */
export async function markSynced(db: Db, payer: string): Promise<void> {
  await db.query(`update orb_wallets set synced_at = now() where payer = $1`, [payer]);
}

// -- what people are told -------------------------------------------------------------------------

const day = (isoDate: string) => new Date(isoDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Why a build can't start (or goes on no further) for lack of credits, in the builder's terms. With
 * `light`, an account keeps building on the lighter model: a build that pauses says so.
 */
export function outOfCredits(w: Wallet, cfg: PlansConfig, payments: boolean, pause = false, light = false): string {
  // Without an account: no word of how much or until when (that allowance may change).
  if (w.plan === 'guest') {
    const offer = `free account (You → Account) to keep going — it comes with ${fmt(cfg.free)} credits every week!`;
    return pause ? `That's all the building without an account for now, so I'll pause here — what I made so far is saved. Create a ${offer}` : `To keep building, create a ${offer}`;
  }
  if (pause && light) {
    const more = w.plan === 'pro' ? (payments ? ' — or top up in You → Plan' : '') : payments ? ` — or go Pro for ${fmt(cfg.pro.credits)} credits a week` : '';
    return `You're out of credits, so I'll pause here — what I made so far is saved. Say “keep going” and I'll go on with my lighter model${more}.`;
  }
  // What happened (a build that pauses says so instead), then what to do.
  const say = (used: string, rest: string) => `${pause ? "You're out of credits, so I'll pause here — what I made so far is saved." : used} ${rest}`;
  if (w.plan === 'pro') {
    const keep = payments ? 'Top up in You → Plan to keep building' : 'Add your own AI key in You → Model to keep building';
    return say("You've used this week's credits.", `${keep} now — or wait for ${day(w.refreshAt)}, when they refresh.`);
  }
  return say(
    `You've used this week's ${fmt(w.allowance)} free credits.`,
    `They're back on ${day(w.refreshAt)}${payments ? ` — or go Pro for ${fmt(cfg.pro.credits)} a week` : ''}. Or add your own AI key in You → Model to keep building now.`,
  );
}
