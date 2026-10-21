// POST /api/billing/payouts (signed in) — cash out what the account's worlds earned (all that's
// payable, src/server/payouts.ts) to its Stripe payout account → { payout, billing }.

import { getViewer } from '@/server/auth';
import { billingView, currentWallet } from '@/server/billing';
import { plansConfig } from '@/server/credits';
import { fail, handle, json } from '@/server/http';
import { cashOut } from '@/server/payouts';
import { ready } from '@/server/schema';
import { limitOrThrow, sessionUser } from '@/server/worlds';

export const POST = handle(async (req: Request) => {
  const db = await ready();
  const userId = await sessionUser(db, getViewer(req));
  if (!userId) fail(401, 'account_required', 'Sign in first.');
  await limitOrThrow(db, `payout:u:${userId}`, 10, 3600);
  const payout = await cashOut(db, userId);
  const cfg = plansConfig();
  const wallet = await currentWallet(db, `u:${userId}`, cfg);
  return json({ payout, billing: await billingView(db, wallet, wallet.payer, cfg, req) });
});
