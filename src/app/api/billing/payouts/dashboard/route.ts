// POST /api/billing/payouts/dashboard { from? } (signed in) → { url }: Stripe's dashboard for the
// account's payouts (bank, payouts, tax forms), or its onboarding while that isn't finished.

import { getViewer } from '@/server/auth';
import { payoutUrls, returnTo } from '@/server/billingurls';
import { fail, handle, json, readJson } from '@/server/http';
import { dashboardLink } from '@/server/payouts';
import { ready } from '@/server/schema';
import { limitOrThrow, sessionUser } from '@/server/worlds';

export const POST = handle(async (req: Request) => {
  const body = await readJson<{ from?: unknown }>(req, 10_000);
  const db = await ready();
  const userId = await sessionUser(db, getViewer(req));
  if (!userId) fail(401, 'account_required', 'Sign in first.');
  await limitOrThrow(db, `payout-setup:u:${userId}`, 20, 3600);
  return json({ url: await dashboardLink(db, userId, payoutUrls(new URL(req.url).origin, returnTo(body?.from))) });
});
