// GET /api/worlds/:id/shop — what the world sells (`orb.shop`), what the viewer owns there and their credits.
// POST /api/worlds/:id/shop { item, price } (signed in) — buy it for that price, after Orb's own sheet asked
// the player (src/server/shop.ts): the price leaves their credits and the maker earns their share.

import { getViewer } from '@/server/auth';
import { handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { buyItem, shopView } from '@/server/shop';
import { limitOrThrow, worldIdParam, type IdContext } from '@/server/worlds';

export const GET = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const db = await ready();
  return json(await shopView(db, getViewer(req), id), { headers: { 'cache-control': 'private, no-store' } });
});

export const POST = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  const body = await readJson<{ item?: unknown; price?: unknown }>(req, 10_000);
  const db = await ready();
  await limitOrThrow(db, `shop:buy:${viewer.userId ?? viewer.deviceHash ?? 'anon'}`, 30, 600, 'That’s a lot of shopping! Try again in a few minutes.');
  return json(await buyItem(db, viewer, id, body?.item, body?.price));
});
