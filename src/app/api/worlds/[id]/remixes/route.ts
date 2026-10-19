// GET /api/worlds/:id/remixes — the public remixes of this world that their makers changed,
// newest first: one level down its remix tree (each remix says what it came from).

import { json } from '@/server/http';
import { ready } from '@/server/schema';
import { remixesOf, route, worldIdParam, type IdContext } from '@/server/worlds';

export const GET = route(async (_req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const db = await ready();
  return json({ worlds: await remixesOf(db, id) }, { headers: { 'cache-control': 'public, max-age=30' } });
});
