// GET /api/billing/payouts/return?to=… — where Stripe's payout onboarding sends people back: the
// account is read from Stripe, then they're on the page they came from with ?billing=payouts (ready)
// or ?billing=payouts-pending (Stripe still needs something).

import { getViewer } from '@/server/auth';
import { returnTo } from '@/server/billingurls';
import { recordServerError } from '@/server/errors';
import { returnFromSetup } from '@/server/payouts';
import { ready } from '@/server/schema';
import { sessionUser } from '@/server/worlds';
import { after } from 'next/server';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const to = new URL(returnTo(url.searchParams.get('to')), url.origin);
  let note = 'payouts-pending';
  try {
    const db = await ready();
    const userId = await sessionUser(db, getViewer(req));
    if (userId && (await returnFromSetup(db, userId))) note = 'payouts';
  } catch (e) {
    console.error('[orb] coming back from payout setup failed', e);
    after(() => recordServerError(e, '/api/billing/payouts/return'));
  }
  to.searchParams.set('billing', note);
  return new Response(null, { status: 303, headers: { location: `${to.pathname}${to.search}`, 'cache-control': 'no-store' } });
}
