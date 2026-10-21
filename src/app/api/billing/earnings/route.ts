// POST /api/billing/earnings (signed in) — put everything the account earned in its worlds' shops into
// its own building (top-up credits) → BillingInfo.

import { getViewer } from '@/server/auth';
import { billingView } from '@/server/billing';
import { plansConfig } from '@/server/credits';
import { handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { buildWithEarnings } from '@/server/shop';

export const POST = handle(async (req: Request) => {
  const db = await ready();
  const cfg = plansConfig();
  const wallet = await buildWithEarnings(db, getViewer(req), cfg);
  return json(await billingView(db, wallet, wallet.payer, cfg, req));
});
