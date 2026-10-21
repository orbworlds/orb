// POST /api/worlds/:id/like — toggle this device's like → { liked, likes }.

import { getViewer } from '@/server/auth';
import { clientIp, handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { actorKey, limitOrThrow, toggleLike, worldIdParam, type IdContext } from '@/server/worlds';

export const POST = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  const db = await ready();
  const ip = clientIp(req);
  await limitOrThrow(db, `like:${actorKey(viewer, ip)}`, 60, 60);
  // Device keys are free to mint, so also bound how many likes one IP can hand out.
  await limitOrThrow(db, `like:ip:${ip}`, 120, 3600);
  return json(await toggleLike(db, viewer, id));
});
