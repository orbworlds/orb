// GET /api/billing — the plans, and the viewer's plan and credits (src/server/billing.ts).

import { getViewer } from '@/server/auth';
import { billingInfo, currentWallet, paymentsFor, paymentsForPayer } from '@/server/billing';
import { payerOf, plansConfig, readWallet } from '@/server/credits';
import { json } from '@/server/http';
import { withPayouts } from '@/server/payouts';
import { ready } from '@/server/schema';
import { route } from '@/server/worlds';

export const GET = route(async (req: Request) => {
  const viewer = getViewer(req);
  const payer = payerOf(viewer);
  const cfg = plansConfig();
  if (!payer) return json(billingInfo(null, cfg, new Date(), paymentsFor(null)));
  const db = await ready();
  // A device without an account gets a wallet with its first build, not by looking.
  const wallet = payer.startsWith('d:') && !(await readWallet(db, payer)) ? null : await currentWallet(db, payer, cfg);
  return json(await withPayouts(db, billingInfo(wallet, cfg, new Date(), await paymentsForPayer(db, payer)), payer, req));
});
