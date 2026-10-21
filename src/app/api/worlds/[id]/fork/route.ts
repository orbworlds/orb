// POST /api/worlds/:id/fork { authorName? } — remix: copy the code + thumbnail into a new world
// owned by the viewer. Requires a native world that allows remixing (owners may always duplicate).

import { getViewer } from '@/server/auth';
import { after } from 'next/server';
import { clientIp, handle, json, readJson } from '@/server/http';
import { pushRepo } from '@/server/reposync';
import { ready } from '@/server/schema';
import { actorKey, forkWorld, limitOrThrow, worldIdParam, type IdContext } from '@/server/worlds';

export const POST = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  // The body is optional; a missing/invalid one just means "no author name given".
  const body = await readJson<unknown>(req, 10_000);
  const db = await ready();
  const ip = clientIp(req);
  const tooMany = 'You remixed a lot just now! Try again in a few minutes.';
  await limitOrThrow(db, `fork:${actorKey(viewer, ip)}`, 30, 600, tooMany);
  await limitOrThrow(db, `fork:ip:${ip}`, 120, 600, tooMany);
  const world = await forkWorld(db, viewer, id, body);
  after(() => pushRepo(db, world.id));
  return json({ world }, { status: 201 });
});
