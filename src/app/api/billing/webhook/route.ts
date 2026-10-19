// POST /api/billing/webhook — Stripe's events (subscriptions, renewals, checkouts), signed with
// STRIPE_WEBHOOK_SECRET or the secret of the endpoint Orb registered itself (src/server/stripe.ts).

import { handleStripeEvent } from '@/server/billing';
import { recordServerError } from '@/server/errors';
import { error, json } from '@/server/http';
import { ready } from '@/server/schema';
import { verifySignature, webhookSecrets } from '@/server/stripe';
import { after } from 'next/server';

export async function POST(req: Request): Promise<Response> {
  const payload = await req.text();
  if (payload.length > 1_000_000) return error(413, 'too_large');
  try {
    const db = await ready();
    const signature = req.headers.get('stripe-signature');
    const secrets = await webhookSecrets(db);
    if (!secrets.some((s) => verifySignature(payload, signature, s))) return error(400, 'bad_signature', 'That isn’t signed by Stripe for Orb.');
    await handleStripeEvent(db, JSON.parse(payload));
    return json({ received: true });
  } catch (e) {
    // Stripe delivers it again later.
    console.error('[orb] Stripe webhook failed', e);
    after(() => recordServerError(e, '/api/billing/webhook'));
    return error(500, 'server_error');
  }
}
