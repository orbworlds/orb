// POST /api/admin/payouts/:id { action: 'approve' | 'reject', note? } — (admin) Orb's answer to a
// cash-out request: approved, it's sent to the maker's Stripe account now; rejected, the earnings are
// theirs again (src/server/payouts.ts).
import { isAdmin } from '@/server/auth';
import { error, json, readJson } from '@/server/http';
import { reviewPayout } from '@/server/payouts';
import { ready } from '@/server/schema';
import { fail, route } from '@/server/worlds';

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  if (!isAdmin(req)) return error(401, 'unauthorized', 'Admin token required.');
  const { id } = await ctx.params;
  const body = await readJson<{ action?: unknown; note?: unknown }>(req, 4000);
  if (!/^po_[\w-]{4,40}$/.test(id) || (body?.action !== 'approve' && body?.action !== 'reject')) fail(400, 'bad_request', 'Say { "action": "approve" } or { "action": "reject" }.');
  return json(await reviewPayout(await ready(), id, body.action === 'approve', typeof body.note === 'string' ? body.note : ''));
});
