// The GitHub repository a world is kept in sync with (src/server/reposync.ts); its owner only.
// POST /api/worlds/:id/github { action: 'sync' } — bring in the branch's new commits now, and send
//   Orb's new versions there → { world }
// POST /api/worlds/:id/github { action: 'create' } — put the world in a new private repository of
//   the owner's GitHub account (their token kept on Orb), linked from now on → { world }
// DELETE /api/worlds/:id/github — stop syncing (nothing is deleted on GitHub) → { world }

import { getViewer } from '@/server/auth';
import { GitHubError } from '@/server/github';
import { clientIp, json, readJson } from '@/server/http';
import { getLink, keepOnGitHub, pullRepo, pushRepo, SyncError, tokenOf, unlinkRepo } from '@/server/reposync';
import { ready } from '@/server/schema';
import { actorKey, fail, getWorldForViewer, limitOrThrow, route, worldIdParam, type IdContext } from '@/server/worlds';
import type { Db } from '@/server/db';
import type { Viewer } from '@/server/auth';

export const maxDuration = 120;

async function ownWorld(db: Db, viewer: Viewer, id: string) {
  const world = await getWorldForViewer(db, viewer, id);
  if (!world) fail(404, 'not_found', 'This world does not exist.');
  if (!world.canEdit) fail(403, 'forbidden', 'Only the owner can change this world.');
  if (world.kind !== 'native') fail(400, 'bad_request', 'Only worlds made on Orb can be kept on GitHub.');
  return world;
}

export const POST = route(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  const body = await readJson<{ action?: unknown }>(req, 2000);
  const db = await ready();
  await limitOrThrow(db, `github:${actorKey(viewer, clientIp(req))}`, 20, 600, 'That was a lot of GitHub at once — try again in a few minutes.');
  const world = await ownWorld(db, viewer, id);
  try {
    if (body?.action === 'sync') {
      if (!(await getLink(db, id))) fail(400, 'bad_request', 'This world isn’t linked to a GitHub repository.');
      await pullRepo(db, id, { force: true });
      await pushRepo(db, id);
    } else if (body?.action === 'create') {
      if (await getLink(db, id)) fail(409, 'conflict', 'This world is already kept on GitHub.');
      const token = await tokenOf(db, viewer.userId, viewer.deviceHash);
      if (!token) fail(400, 'github_required', 'Connect GitHub first, in You → GitHub.');
      await keepOnGitHub(db, id, token);
    } else fail(400, 'bad_request', 'Expected { action: "sync" | "create" }.');
  } catch (e) {
    if (e instanceof SyncError || e instanceof GitHubError) fail(400, 'github_failed', e.message);
    throw e;
  }
  return json({ world: await getWorldForViewer(db, viewer, id) });
});

export const DELETE = route(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  const db = await ready();
  await ownWorld(db, viewer, id);
  await unlinkRepo(db, id);
  return json({ world: await getWorldForViewer(db, viewer, id) });
});
