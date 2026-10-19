// Rate limits for builds (the free tier bounds tokens per person, per hour and per day; builds
// on people's own keys only get light abuse limits), and the builder's credits (./credits.ts),
// for /api/agent/jobs. The quota rules themselves live in ./freetier.ts.

import type { BuildRequest } from '@/lib/types';
import { getViewer } from './auth';
import { currentWallet, paidWallet, paymentsForPayer } from './billing';
import { ANON_SPENT, BUDGET_SPENT, budgetConfig, chargeFree, chargePaid, overBudget, spentToday } from './budget';
import { chargeCredits, outOfCredits, payerOf, plansConfig, type Wallet } from './credits';
import type { Db } from './db';
import { clientIp, error, json } from './http';
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

/** Either the answer that turns the build away, or the quotas it was counted against. */
export type Quota = { response: Response } | { charged: LimitCheck[] };

/**
 * Free-tier quotas (see ./freetier.ts): burst, hourly and daily per person; then the day's budget
 * (./budget.ts). A builder who pays for their credits (`paid`) skips the daily caps and the budget.
 */
export async function checkRateLimits(req: Request, cost: number, cfg: FreeTierConfig, paid = false): Promise<Quota> {
  const viewer = getViewer(req);
  const checks = freeTierChecks({ deviceHash: viewer.deviceHash, ip: clientIp(req), userId: viewer.userId }, cost, cfg, new Date(), paid && !!viewer.userId);
  const charged: LimitCheck[] = [];
  try {
    const db = await ready();
    for (const c of checks) {
      const r = await rateLimit(db, c.key, c.limit, c.windowSec, c.cost);
      if (!r.ok) {
        // A build turned away by a later quota doesn't use up the earlier ones.
        await refundQuota(charged);
        const retryAfter = Math.max(1, Math.ceil(c.daily ? Math.min(r.retryAfter || Infinity, secondsUntilUtcMidnight()) : r.retryAfter));
        return { response: json({ error: 'rate_limited', message: c.message, retryAfter }, { status: 429, headers: { 'retry-after': String(retryAfter) } }) };
      }
      if (c.cost) charged.push(c);
    }
    const over = paid ? null : overBudget(await spentToday(db), budgetConfig(), !viewer.userId);
    if (over) {
      await refundQuota(charged);
      const retryAfter = secondsUntilUtcMidnight();
      const headers = { 'retry-after': String(retryAfter) };
      return {
        response:
          over === 'all'
            ? json({ error: 'ai_unavailable', message: BUDGET_SPENT, retryAfter }, { status: 503, headers })
            : json({ error: 'rate_limited', message: ANON_SPENT, retryAfter }, { status: 429, headers }),
      };
    }
    return { charged };
  } catch (e) {
    // Fail closed: without working limits the free tier could run up unbounded cost.
    console.error('[orb] build rate limit check failed', e);
    return { response: error(503, 'ai_unavailable', 'Orb is having a little trouble right now. Please try again in a moment.') };
  }
}

/** Whose credits a build on Orb's AI uses, and whether they pay for them (see ./billing.ts). */
export interface Billing {
  payer: string;
  plan: Wallet['plan'];
  paid: boolean;
}

/**
 * The builder's credits: who pays for a build on Orb's AI, or the answer that turns it away when
 * their credits are used up (402 out_of_credits). Null billing: no one to charge (no device key).
 */
export async function checkCredits(req: Request): Promise<{ billing: Billing | null; wallet: Wallet | null } | { response: Response }> {
  const payer = payerOf(getViewer(req));
  if (!payer) return { billing: null, wallet: null };
  try {
    const cfg = plansConfig();
    const db = await ready();
    const wallet = await currentWallet(db, payer, cfg);
    if (wallet.left < 1) return { response: json({ error: 'out_of_credits', message: outOfCredits(wallet, cfg, await paymentsForPayer(db, payer)), plan: wallet.plan }, { status: 402 }) };
    return { billing: { payer, plan: wallet.plan, paid: paidWallet(wallet) }, wallet };
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
