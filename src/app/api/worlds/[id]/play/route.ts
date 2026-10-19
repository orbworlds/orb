// POST /api/worlds/:id/play — count a visit (once per device per world per UTC day) → { plays }.

import { getViewer } from '@/server/auth';
import { clientIp, json } from '@/server/http';
import { ready } from '@/server/schema';
import { recordPlay, route, worldIdParam, type IdContext } from '@/server/worlds';

export const POST = route(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const db = await ready();
  const plays = await recordPlay(db, getViewer(req), id, clientIp(req));
  return json({ plays });
});
