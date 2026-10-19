// GET /api/worlds/:id — full world (404 if missing, or private and not the viewer's).
// PATCH /api/worlds/:id — owner edits (code changes create a new version, sent to its GitHub repository if it has one).
// DELETE /api/worlds/:id — owner deletes.

import { getViewer } from '@/server/auth';
import { after } from 'next/server';
import { clientIp, json, readJson } from '@/server/http';
import { pullRepo, pushRepo } from '@/server/reposync';
import { ready } from '@/server/schema';
import { actorKey, deleteWorld, fail, getWorldForViewer, limitOrThrow, route, updateWorld, worldIdParam, type IdContext } from '@/server/worlds';

export const GET = route(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const db = await ready();
  const world = await getWorldForViewer(db, getViewer(req), id);
  if (!world) fail(404, 'not_found', 'This world does not exist.');
  // a world kept in sync with GitHub: new commits there come in (at most once a minute; see reposync.ts)
  if (world.kind === 'native') after(() => pullRepo(db, id).catch(() => null));
  return json({ world });
});

export const PATCH = route(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  const body = await readJson<unknown>(req, 4_400_000); // worlds up to 3 MB of code
  if (body === null) fail(400, 'bad_request', 'Expected a JSON body (or it was too large).');
  const db = await ready();
  await limitOrThrow(db, `update:${actorKey(viewer, clientIp(req))}`, 90, 60, 'Saving a bit too fast — try again in a moment.');
  const world = await updateWorld(db, viewer, id, body);
  after(() => pushRepo(db, id));
  return json({ world });
});

export const DELETE = route(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  const db = await ready();
  await limitOrThrow(db, `delete:${actorKey(viewer, clientIp(req))}`, 30, 60);
  await deleteWorld(db, viewer, id);
  return json({ ok: true });
});
