// POST /api/billing/portal { from? } → { url }: Stripe's customer portal for the account (cancel
// Pro, change the card, invoices), coming back to `from`.

import { getViewer } from '@/server/auth';
import { createPortal, currentWallet, forgetCustomer, missingCustomer } from '@/server/billing';
import { returnTo } from '@/server/billingurls';
import { json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { paymentsOn } from '@/server/stripe';
import { fail, limitOrThrow, route, sessionUser } from '@/server/worlds';

export const POST = route(async (req: Request) => {
  if (!paymentsOn()) fail(503, 'payments_off', 'Payments aren’t open yet.');
  const body = await readJson<{ from?: unknown }>(req, 10_000);
  const db = await ready();
  const userId = await sessionUser(db, getViewer(req));
  if (!userId) fail(401, 'account_required', 'Sign in first.');
  await limitOrThrow(db, `billing:u:${userId}`, 30, 3600);
  const wallet = await currentWallet(db, `u:${userId}`);
  const customer = wallet.stripeCustomer;
  if (!customer) fail(404, 'not_found', 'There’s no billing to manage yet.');
  try {
    return json({ url: await createPortal(db, customer, `${new URL(req.url).origin}${returnTo(body?.from)}`) });
  } catch (e) {
    if (!missingCustomer(e)) throw e;
    await forgetCustomer(db, wallet.payer, customer);
    fail(404, 'not_found', 'There’s no billing to manage yet.');
  }
});
