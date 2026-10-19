// GET /api/admin/payouts — (admin) makers' cash-out requests waiting for Orb's check, with what's
// behind each (src/server/payouts.ts): cashable sales, how many players, the biggest buyer's part.
import { isAdmin } from '@/server/auth';
import { error, json } from '@/server/http';
import { payoutRequests } from '@/server/payouts';
import { ready } from '@/server/schema';

export async function GET(req: Request): Promise<Response> {
  if (!isAdmin(req)) return error(401, 'unauthorized', 'Admin token required.');
  return json({ requests: await payoutRequests(await ready()) });
}
