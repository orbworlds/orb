// POST /api/billing/webhook — Stripe's events (subscriptions, renewals, checkouts), signed with
// STRIPE_WEBHOOK_SECRET or the secret of the endpoint Orb registered itself (src/server/stripe.ts).

// A failure answers 500, and Stripe delivers the event again later.

import { handleStripeEvent } from '@/server/billing';
import { error, handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { verifySignature, webhookSecrets } from '@/server/stripe';

export const POST = handle(async (req: Request) => {
  const payload = await req.text();
  if (payload.length > 1_000_000) return error(413, 'too_large');
  const db = await ready();
  const signature = req.headers.get('stripe-signature');
  const secrets = await webhookSecrets(db);
  if (!secrets.some((s) => verifySignature(payload, signature, s))) return error(400, 'bad_signature', 'That isn’t signed by Stripe for Orb.');
  await handleStripeEvent(db, JSON.parse(payload));
  return json({ received: true });
});
