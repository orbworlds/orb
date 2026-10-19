// POST /api/kit/push?world=&name=&message= (Authorization: Bearer <kit token>, body: the world's
// files as a .tar.gz) → { world, url, outcome }: `orb push` (src/server/kit.ts). To a world of the
// pusher's, a new version; to someone else's remixable world, a remix; without `world`, a new world.

import { after } from 'next/server';
import { getViewer } from '@/server/auth';
import { FileError } from '@/server/files';
import { clientIp, json } from '@/server/http';
import { pushWorld } from '@/server/kit';
import { requestOrigin } from '@/server/origins';
import { pushRepo } from '@/server/reposync';
import { ready } from '@/server/schema';
import { actorKey, fail, isWorldId, limitOrThrow, route } from '@/server/worlds';

export const maxDuration = 120;

export const POST = route(async (req: Request) => {
  const viewer = getViewer(req);
  if (!viewer.deviceHash && !viewer.userId) fail(401, 'kit_login', 'Sign in first: orb push asks you to.');
  if (!req.body) fail(400, 'bad_request', 'Send the world’s files as a .tar.gz.');
  const q = new URL(req.url).searchParams;
  const world = q.get('world');
  if (world && !isWorldId(world)) fail(400, 'bad_request', 'That isn’t a world id.');
  const db = await ready();
  await limitOrThrow(db, `kitpush:${actorKey(viewer, clientIp(req))}`, 120, 3600, 'That’s a lot of pushes this hour. Try again in a bit.');
  try {
    const res = await pushWorld(db, viewer, req.body, { world, name: q.get('name'), message: q.get('message') });
    if (res.outcome !== 'unchanged') after(() => pushRepo(db, res.world.id));
    return json({ ...res, url: `${requestOrigin(req).origin}${res.world.path ? `/${res.world.path}` : `/w/${encodeURIComponent(res.world.id)}`}` });
  } catch (e) {
    if (e instanceof FileError) fail(400, 'push_failed', e.message);
    throw e;
  }
});
