// POST /api/billing/earnings (signed in) — put everything the account earned in its worlds' shops into
// its own building (top-up credits) → BillingInfo.

import { getViewer } from '@/server/auth';
import { billingInfo, paymentsForPayer } from '@/server/billing';
import { plansConfig } from '@/server/credits';
import { json } from '@/server/http';
import { withPayouts } from '@/server/payouts';
import { ready } from '@/server/schema';
import { buildWithEarnings } from '@/server/shop';
import { route } from '@/server/worlds';

export const POST = route(async (req: Request) => {
  const db = await ready();
  const cfg = plansConfig();
  const wallet = await buildWithEarnings(db, getViewer(req), cfg);
  return json(await withPayouts(db, billingInfo(wallet, cfg, new Date(), await paymentsForPayer(db, wallet.payer)), wallet.payer, req));
});
