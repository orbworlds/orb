// GET /api/billing — the plans, and the viewer's plan and credits (src/server/billing.ts).

import { getViewer } from '@/server/auth';
import { billingInfo, billingView, currentWallet, paymentsFor } from '@/server/billing';
import { payerOf, plansConfig, readWallet } from '@/server/credits';
import { handle, json } from '@/server/http';
import { ready } from '@/server/schema';

export const GET = handle(async (req: Request) => {
  const viewer = getViewer(req);
  const payer = payerOf(viewer);
  const cfg = plansConfig();
  if (!payer) return json(billingInfo(null, cfg, new Date(), paymentsFor(null)));
  const db = await ready();
  // A device without an account gets a wallet with its first build, not by looking.
  const wallet = payer.startsWith('d:') && !(await readWallet(db, payer)) ? null : await currentWallet(db, payer, cfg);
  return json(await billingView(db, wallet, payer, cfg, req));
});
