// Setting up the account's payouts with Stripe (src/server/payouts.ts):
//   POST { country, from? } → { url } of Stripe's onboarding, coming back to `from`
//   GET ?to=… — Stripe's link expired or was used (its refresh_url): a fresh one, by redirect

import { getViewer } from '@/server/auth';
import { returnTo } from '@/server/billingurls';
import { json, readJson } from '@/server/http';
import { setupLink } from '@/server/payouts';
import { ready } from '@/server/schema';
import { fail, limitOrThrow, route, sessionUser } from '@/server/worlds';

const urls = (origin: string, to: string) => ({
  refresh: `${origin}/api/billing/payouts/setup?to=${encodeURIComponent(to)}`,
  back: `${origin}/api/billing/payouts/return?to=${encodeURIComponent(to)}`,
});

export const POST = route(async (req: Request) => {
  const body = await readJson<{ country?: unknown; from?: unknown }>(req, 10_000);
  const db = await ready();
  const userId = await sessionUser(db, getViewer(req));
  if (!userId) fail(401, 'account_required', 'Sign in first.');
  await limitOrThrow(db, `payout-setup:u:${userId}`, 20, 3600);
  const country = typeof body?.country === 'string' ? body.country.trim().toUpperCase() : null;
  return json({ url: await setupLink(db, userId, country, urls(new URL(req.url).origin, returnTo(body?.from))) });
});

export const GET = route(async (req: Request) => {
  const url = new URL(req.url);
  const to = returnTo(url.searchParams.get('to'));
  const db = await ready();
  const userId = await sessionUser(db, getViewer(req));
  if (!userId) return new Response(null, { status: 303, headers: { location: to, 'cache-control': 'no-store' } });
  await limitOrThrow(db, `payout-setup:u:${userId}`, 20, 3600);
  const link = await setupLink(db, userId, null, urls(url.origin, to));
  return new Response(null, { status: 303, headers: { location: link, 'cache-control': 'no-store' } });
});
