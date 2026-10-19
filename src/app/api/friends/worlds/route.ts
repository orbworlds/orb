// GET /api/friends/worlds — your friends' newest worlds → { worlds } (for the start screen).

import { getViewer } from '@/server/auth';
import { accountId, friendsWorlds } from '@/server/friends';
import { json } from '@/server/http';
import { ready } from '@/server/schema';
import { limitOrThrow, route } from '@/server/worlds';

export const GET = route(async (req: Request) => {
  const db = await ready();
  const me = await accountId(db, getViewer(req));
  await limitOrThrow(db, `friends:read:${me}`, 60, 60);
  return json({ worlds: await friendsWorlds(db, me) });
});
