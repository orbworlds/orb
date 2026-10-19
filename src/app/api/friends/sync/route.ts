// POST /api/friends/sync { worldId, rooms? } — "I'm here, with this world on my screen" (null: none),
// in these of its rooms ([{ room, peer }]: friends can tell you apart from the others there and
// join you in the same room); the heartbeat a visible signed-in page sends every half minute → the
// same as GET /api/friends.
// { leave: true }, sent as the page goes away, shows you offline right away → { ok }.

import { getViewer } from '@/server/auth';
import { accountId, friendsData, heartbeat, leave } from '@/server/friends';
import { json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { limitOrThrow, route } from '@/server/worlds';

export const POST = route(async (req: Request) => {
  const db = await ready();
  const me = await accountId(db, getViewer(req));
  const body = await readJson<{ worldId?: unknown; rooms?: unknown; leave?: unknown }>(req, 10_000);
  if (body?.leave === true) {
    await leave(db, me);
    return json({ ok: true });
  }
  await limitOrThrow(db, `friends:sync:${me}`, 20, 60);
  await heartbeat(db, me, typeof body?.worldId === 'string' ? body.worldId : null, body?.rooms);
  return json(await friendsData(db, me));
});
