// GET /api/billing/return?session_id=…&to=… — where Stripe Checkout sends people after paying: the
// checkout is applied right away (the webhook may come later, or not be set up yet), then they are
// back on the page they came from, with ?billing=pro|topup|pending for the page to say so.

import { applyCheckoutById } from '@/server/billing';
import { backWith } from '@/server/billingurls';
import { recordServerError } from '@/server/errors';
import { ready } from '@/server/schema';
import { after } from 'next/server';

export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('session_id') ?? '';
  let note = 'pending';
  if (/^cs_[\w-]{4,200}$/.test(id)) {
    try {
      const applied = await applyCheckoutById(await ready(), id);
      if (applied.done && applied.kind) note = applied.kind;
    } catch (e) {
      console.error('[orb] applying a checkout failed', e);
      after(() => recordServerError(e, '/api/billing/return'));
    }
  }
  return backWith(req, note);
}
