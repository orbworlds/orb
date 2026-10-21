// POST /api/admin/stripe — (admin) check Orb's Stripe key: the account it reaches (name and
// statement descriptor, as Checkout and card statements show them), live or sandbox, and what a
// first checkout sets up, made now: the Pro price, the portal's settings and the webhook.
import { isAdmin } from '@/server/auth';
import { stripeSetup } from '@/server/billing';
import { error, json } from '@/server/http';
import { ready } from '@/server/schema';

export async function POST(req: Request): Promise<Response> {
  if (!isAdmin(req)) return error(401, 'unauthorized', 'Admin token required.');
  return json(await stripeSetup(await ready()));
}
