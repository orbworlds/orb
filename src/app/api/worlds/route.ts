// GET /api/worlds — Explore listing (or the viewer's own worlds with ?mine=1).
// POST /api/worlds — create a world owned by this device (and account, if signed in).

import { getViewer } from '@/server/auth';
import { after } from 'next/server';
import { clientIp, fail, handle, json, readJson } from '@/server/http';
import { pushRepo } from '@/server/reposync';
import { ready } from '@/server/schema';
import { actorKey, createWorld, limitOrThrow, listWorlds, parseListParams } from '@/server/worlds';

export const GET = handle(async (req: Request) => {
  const params = parseListParams(new URL(req.url).searchParams);
  const viewer = getViewer(req);
  const db = await ready();
  const result = await listWorlds(db, viewer, params);
  // Public listings don't depend on the viewer, so a CDN may hold them briefly; the viewer's own
  // ("mine", "liked") never.
  const cache = params.mine || params.liked || params.hidden ? 'no-store' : 'public, max-age=0, s-maxage=10, stale-while-revalidate=60';
  return json(result, { headers: { 'cache-control': cache } });
});

export const POST = handle(async (req: Request) => {
  const viewer = getViewer(req);
  const body = await readJson<unknown>(req, 4_400_000); // worlds up to 3 MB of code
  if (body === null) fail(400, 'bad_request', 'Expected a JSON body (or it was too large).');
  const db = await ready();
  const ip = clientIp(req);
  const tooMany = 'You made a lot of worlds just now! Try again in a few minutes.';
  await limitOrThrow(db, `create:${actorKey(viewer, ip)}`, 30, 600, tooMany);
  await limitOrThrow(db, `create:ip:${ip}`, 120, 600, tooMany);
  const world = await createWorld(db, viewer, body);
  after(() => pushRepo(db, world.id));
  return json({ world }, { status: 201 });
});
