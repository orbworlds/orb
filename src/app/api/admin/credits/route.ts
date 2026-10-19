// POST /api/admin/credits — (admin) gift someone credits, an account or a guest, by handle: { handle, credits, ref } → { wallet }.
// They're bonus credits (src/server/credits.ts grantGift): they build, but can't be cashed out.
// `ref` names the gift, so sending it again doesn't gift twice.
import { isAdmin } from '@/server/auth';
import { grantGift, payerOf, readWallet } from '@/server/credits';
import { error, json } from '@/server/http';
import { isPathPart } from '@/server/paths';
import { ready } from '@/server/schema';

export async function POST(req: Request): Promise<Response> {
  if (!isAdmin(req)) return error(401, 'unauthorized', 'Admin token required.');
  const body = (await req.json().catch(() => null)) as { handle?: unknown; credits?: unknown; ref?: unknown } | null;
  const handle = typeof body?.handle === 'string' ? body.handle.trim().toLowerCase() : '';
  const credits = typeof body?.credits === 'number' ? body.credits : NaN;
  const ref = typeof body?.ref === 'string' ? body.ref.trim().slice(0, 120) : '';
  if (!isPathPart(handle)) return error(400, 'bad_request', 'Give the account’s handle.');
  if (!Number.isInteger(credits) || credits < 1 || credits > 100_000) return error(400, 'bad_request', 'Give a whole number of credits, 1 to 100,000.');
  if (!ref) return error(400, 'bad_request', 'Name the gift (ref), so it is only given once.');
  const db = await ready();
  // An account, or a guest (a device's handle): their credits are where their builds are charged.
  const owner = (await db.query<{ owner_user: string | null; owner_device: string | null }>(`select owner_user, owner_device from orb_handles where handle = $1`, [handle]))[0];
  const payer = owner ? payerOf({ userId: owner.owner_user, deviceHash: owner.owner_device }) : null;
  if (!payer) return error(404, 'not_found', 'Nobody has that handle.');
  const wallet = await grantGift(db, payer, credits, ref);
  if (!wallet) return json({ given: false, note: 'That gift was already given.', wallet: await readWallet(db, payer) });
  return json({ given: true, wallet });
}
