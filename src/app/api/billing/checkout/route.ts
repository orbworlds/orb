// POST /api/billing/checkout { item: 'pro' | <credit pack id>, from? } → { url }: a Stripe Checkout
// page for Pro or a pack of credits (for building, or things in worlds). `from` is the page to come back to.

import { getViewer } from '@/server/auth';
import { createCheckout, currentWallet, paymentsForPayer } from '@/server/billing';
import { returnTo } from '@/server/billingurls';
import { plansConfig } from '@/server/credits';
import { clientIp, fail, handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { paymentsOn } from '@/server/stripe';
import { limitOrThrow, sessionUser } from '@/server/worlds';

export const POST = handle(async (req: Request) => {
  if (!paymentsOn()) fail(503, 'payments_off', 'Payments aren’t open yet — check back soon!');
  const body = await readJson<{ item?: unknown; from?: unknown }>(req, 10_000);
  const item = typeof body?.item === 'string' ? body.item : '';
  const db = await ready();
  const viewer = getViewer(req);
  const userId = await sessionUser(db, viewer);
  if (!userId) fail(401, 'account_required', 'Create a free account first (You → Account) — then go Pro.');
  if (!(await paymentsForPayer(db, `u:${userId}`))) fail(503, 'payments_off', 'Payments aren’t open yet — check back soon!');
  await limitOrThrow(db, `billing:u:${userId}`, 30, 3600);
  await limitOrThrow(db, `billing:ip:${clientIp(req)}`, 60, 3600);

  const cfg = plansConfig();
  const wallet = await currentWallet(db, `u:${userId}`, cfg);
  const pack = cfg.topups.find((p) => p.id === item);
  if (item !== 'pro' && !pack) fail(400, 'bad_request', 'Unknown plan or credit pack.');
  if (item === 'pro' && wallet.plan === 'pro') fail(409, 'already_pro', 'You’re on Pro already — manage it in You → Plan.');

  const origin = new URL(req.url).origin;
  const from = returnTo(body?.from);
  const success = `${origin}/api/billing/return?session_id={CHECKOUT_SESSION_ID}&to=${encodeURIComponent(from)}`;
  const url = await createCheckout(db, wallet, pack ? { kind: 'topup', pack } : { kind: 'pro' }, { success, cancel: `${origin}${from}` }, cfg);
  return json({ url });
});
