// POST /api/looks/buy { item, price } (signed in) — buy a look for the blob for that price, the one
// the You tab showed, and put it on (src/server/looks.ts). Orb keeps the sale.

import { getViewer } from '@/server/auth';
import { json, readJson } from '@/server/http';
import { buyLook } from '@/server/looks';
import { ready } from '@/server/schema';
import { limitOrThrow, route } from '@/server/worlds';

export const POST = route(async (req: Request) => {
  const viewer = getViewer(req);
  const body = await readJson<{ item?: unknown; price?: unknown }>(req, 10_000);
  const db = await ready();
  await limitOrThrow(db, `shop:buy:${viewer.userId ?? viewer.deviceHash ?? 'anon'}`, 30, 600, 'That’s a lot of shopping! Try again in a few minutes.');
  return json(await buyLook(db, viewer, body?.item, body?.price));
});
