// POST /api/billing/payouts/dashboard { from? } (signed in) → { url }: Stripe's dashboard for the
// account's payouts (bank, payouts, tax forms), or its onboarding while that isn't finished.

import { getViewer } from '@/server/auth';
import { returnTo } from '@/server/billingurls';
import { json, readJson } from '@/server/http';
import { dashboardLink } from '@/server/payouts';
import { ready } from '@/server/schema';
import { fail, limitOrThrow, route, sessionUser } from '@/server/worlds';

export const POST = route(async (req: Request) => {
  const body = await readJson<{ from?: unknown }>(req, 10_000);
  const db = await ready();
  const userId = await sessionUser(db, getViewer(req));
  if (!userId) fail(401, 'account_required', 'Sign in first.');
  await limitOrThrow(db, `payout-setup:u:${userId}`, 20, 3600);
  const origin = new URL(req.url).origin;
  const to = returnTo(body?.from);
  return json({ url: await dashboardLink(db, userId, { refresh: `${origin}/api/billing/payouts/setup?to=${encodeURIComponent(to)}`, back: `${origin}/api/billing/payouts/return?to=${encodeURIComponent(to)}` }) });
});
