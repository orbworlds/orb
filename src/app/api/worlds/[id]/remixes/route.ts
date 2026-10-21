// GET /api/worlds/:id/remixes — the public remixes of this world that their makers changed,
// newest first: one level down its remix tree (each remix says what it came from).

import { handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { remixesOf, worldIdParam, type IdContext } from '@/server/worlds';

export const GET = handle(async (_req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const db = await ready();
  return json({ worlds: await remixesOf(db, id) }, { headers: { 'cache-control': 'public, max-age=30' } });
});
