// Rate limits for builds (the free tier bounds tokens per person, per hour and per day; builds
// on people's own keys only get light abuse limits), and the builder's credits (./credits.ts),
// for /api/agent/jobs. The quota rules themselves live in ./freetier.ts.

import { REPAIR_REQUEST } from '@/lib/engine/prompt';
import type { BuildRequest } from '@/lib/types';
import { getViewer } from './auth';
import { currentWallet, paidWallet, paymentsForPayer } from './billing';
import { ANON_SPENT, BUDGET_SPENT, budgetConfig, chargeFree, chargeLight, chargePaid, lightOn, overBudget, spentToday } from './budget';
import { chargeCredits, outOfCredits, payerOf, plansConfig, type Wallet } from './credits';
import type { Db } from './db';
import { clientIp, error, json, retryLater } from './http';
import { freeTierChecks, secondsUntilUtcMidnight, type FreeTierConfig, type LimitCheck } from './freetier';
import { rateLimit, refundRate } from './ratelimit';
import { ready } from './schema';

/**
 * Budget units of one build: 1 per started 100k characters of input (chat + errors), so the
 * hourly and daily caps bound tokens, not just requests (a typical build is 1 unit; a request
 * stuffed to the input limits is 5).
 */
export function buildCost(b: BuildRequest): number {
  let chars = 0;
  for (const m of b.messages) chars += m.content.length;
  for (const e of b.errors ?? []) chars += e.length;
  return Math.max(1, Math.ceil(chars / 100_000));
}

/**
 * Either the answer that turns the build away, or the quotas it was counted against; `light`: a
 * build without an account whose part of the budget is spent goes on with the lighter model.
 */
export type Quota = { response: Response } | { charged: LimitCheck[]; light?: boolean };

/**
 * Free-tier quotas (see ./freetier.ts): burst, hourly and daily per person; then the day's budget
 * (./budget.ts). A builder who pays for their credits (`paid`) skips the daily caps and the budget;
 * one on the lighter model (`light`) skips the budget, the lighter model having its own. Without an
 * account, once that part of the budget is spent, the build goes on with the lighter model.
 */
export async function checkRateLimits(req: Request, cost: number, cfg: FreeTierConfig, paid = false, light = false): Promise<Quota> {
  const viewer = getViewer(req);
  const checks = freeTierChecks({ deviceHash: viewer.deviceHash, ip: clientIp(req), userId: viewer.userId }, cost, cfg, new Date(), paid);
  const charged: LimitCheck[] = [];
  try {
    const db = await ready();
    for (const c of checks) {
      const r = await rateLimit(db, c.key, c.limit, c.windowSec, c.cost);
      if (!r.ok) {
        // A build turned away by a later quota doesn't use up the earlier ones.
        await refundQuota(charged);
        return { response: retryLater(429, 'rate_limited', c.message, c.daily ? Math.min(r.retryAfter, secondsUntilUtcMidnight()) : r.retryAfter) };
      }
      if (c.cost) charged.push(c);
    }
    const over = paid || light ? null : overBudget(await spentToday(db), budgetConfig(), !viewer.userId);
    if (over === 'anon' && lightOn(true)) return { charged, light: true };
    if (over) {
      await refundQuota(charged);
      const retryAfter = secondsUntilUtcMidnight();
      return { response: over === 'all' ? retryLater(503, 'ai_unavailable', BUDGET_SPENT, retryAfter) : retryLater(429, 'rate_limited', ANON_SPENT, retryAfter) };
    }
    return { charged };
  } catch (e) {
    // Fail closed: without working limits the free tier could run up unbounded cost.
    console.error('[orb] build rate limit check failed', e);
    return { response: error(503, 'ai_unavailable', 'Orb is having a little trouble right now. Please try again in a moment.') };
  }
}

/** Requests at least this long count for the script check: longer than Orb's own suggestion chips (34 characters at most). */
export const SCRIPTED_MIN = 35;
/** …and it takes this many other devices without an account sending the very same request in a day. */
const SCRIPTED_DEVICES = 3;
export const SCRIPTED = "Orb couldn't tell that a person sent this — sign in (You → Account) to keep building.";

/**
 * A script that builds as a new guest each time (a fresh device, for a fresh free quota) gives itself
 * away by sending the very same request from many devices: the same text (from SCRIPTED_MIN
 * characters; its first 120, case and spacing aside) from SCRIPTED_DEVICES other devices without an
 * account within a day. People don't type the same long request as strangers do. Its worlds of the
 * day are hidden from Explore (they still play by link) and the request is turned away; signing in
 * still works, as it does for a person.
 */
export async function scripted(db: Db, deviceHash: string, text: string): Promise<boolean> {
  // Orb's own words are the same for everyone: its repair round after a build that didn't work.
  if (text.trim().length < SCRIPTED_MIN || text === REPAIR_REQUEST) return false;
  const same = `select world_id, owner_device from orb_agent_jobs
    where created_at > now() - interval '1 day' and owner_user is null and owner_device is not null
      and left(lower(regexp_replace(btrim(prompt), '\\s+', ' ', 'g')), 120) = left(lower(regexp_replace(btrim($2::text), '\\s+', ' ', 'g')), 120)`;
  const [row] = await db.query<{ n: number }>(`select count(distinct owner_device) filter (where owner_device <> $1)::int as n from (${same}) s`, [deviceHash, text]);
  if ((row?.n ?? 0) < SCRIPTED_DEVICES) return false;
  await db.query(
    `update orb_worlds w set hidden = true where not w.hidden and w.owner_user is null
       and ((w.owner_device = $1 and w.created_at > now() - interval '1 day')
         or exists (select 1 from (${same}) s where s.world_id = w.id and s.owner_device = w.owner_device))`,
    [deviceHash, text],
  );
  return true;
}

/** Whose credits a build on Orb's AI uses, and whether they pay for them (see ./billing.ts). */
export interface Billing {
  payer: string;
  plan: Wallet['plan'];
  paid: boolean;
  /** Their credits are used up: the build runs on the lighter model, free (./budget.ts lightWait). */
  light?: boolean;
}

/**
 * The builder's credits: who pays for a build on Orb's AI. When they're used up, an account builds
 * on the lighter model; anyone else is turned away (402 out_of_credits). Null billing: no one to
 * charge (no device key).
 */
export async function checkCredits(req: Request): Promise<{ billing: Billing | null } | { response: Response }> {
  const payer = payerOf(getViewer(req));
  if (!payer) return { billing: null };
  try {
    const cfg = plansConfig();
    const db = await ready();
    const wallet = await currentWallet(db, payer, cfg);
    if (wallet.left < 1) {
      if (wallet.plan !== 'guest' && lightOn()) return { billing: { payer, plan: wallet.plan, paid: false, light: true } };
      return { response: json({ error: 'out_of_credits', message: outOfCredits(wallet, cfg, await paymentsForPayer(db, payer)), plan: wallet.plan }, { status: 402 }) };
    }
    return { billing: { payer, plan: wallet.plan, paid: paidWallet(wallet) } };
  } catch (e) {
    console.error('[orb] credits check failed', e);
    return { response: error(503, 'ai_unavailable', 'Orb is having a little trouble right now. Please try again in a moment.') };
  }
}

/**
 * What a build on Orb's AI cost (US$): taken from its maker's credits, and added to the day's
 * spend — the free builder's budget, unless they pay for their credits. The wallet after it, and
 * which part of the budget is spent now.
 */
export async function chargeBuild(db: Db, billing: Billing | null, usd: number, anonymous: boolean): Promise<{ wallet: (Wallet & { fromTopup: number }) | null; over: 'all' | 'anon' | null }> {
  if (!(usd > 0)) return { wallet: null, over: null };
  if (billing?.light) {
    await chargeLight(db, usd, new Date(), billing.plan === 'guest');
    return { wallet: null, over: null };
  }
  const wallet = billing ? await chargeCredits(db, billing.payer, Math.round(usd * 1e6)) : null;
  if (billing?.paid) {
    await chargePaid(db, usd);
    return { wallet, over: null };
  }
  return { wallet, over: overBudget(await chargeFree(db, usd, anonymous), budgetConfig(), anonymous) };
}

/** Give the units of a build that never happened back to the quotas it was counted against. */
export async function refundQuota(charged: LimitCheck[]): Promise<void> {
  if (!charged.length) return;
  try {
    const db = await ready();
    await Promise.all(charged.map((c) => refundRate(db, c.key, c.cost)));
  } catch (e) {
    console.error('[orb] build quota refund failed', e);
  }
}

/** Light abuse limits for builds that run on the user's own Cursor key. */
export async function checkByoLimits(req: Request): Promise<Response | null> {
  const viewer = getViewer(req);
  const ip = clientIp(req);
  try {
    const db = await ready();
    const checks: Array<[string, number]> = [[`byo:ip:${ip}`, 300]];
    if (viewer.deviceHash) checks.push([`byo:dev:${viewer.deviceHash}`, 200]);
    for (const [key, limit] of checks) {
      const r = await rateLimit(db, key, limit, 3600);
      if (!r.ok) return error(429, 'rate_limited', 'Slow down a little — try again in a moment.', { retryAfter: r.retryAfter });
    }
  } catch (e) {
    console.error('[orb] byo rate limit check failed', e);
  }
  return null;
}
