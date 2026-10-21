// GET /api/friends — your friends (with where they are), requests both ways and notifications.
// POST /api/friends { username } — ask someone to be friends (or say yes, when they asked first)
// → { state, person, friends }.

import { getViewer } from '@/server/auth';
import { accountId, addFriend, friendsData } from '@/server/friends';
import { handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { limitOrThrow } from '@/server/worlds';

export const GET = handle(async (req: Request) => {
  const db = await ready();
  const me = await accountId(db, getViewer(req));
  await limitOrThrow(db, `friends:read:${me}`, 60, 60);
  return json(await friendsData(db, me));
});

export const POST = handle(async (req: Request) => {
  const db = await ready();
  const me = await accountId(db, getViewer(req));
  const body = await readJson<{ username?: unknown }>(req, 10_000);
  await limitOrThrow(db, `friends:add:${me}`, 30, 3600, 'You asked a lot of people just now. Try again in a little while.');
  const added = await addFriend(db, me, body?.username);
  return json({ ...added, friends: await friendsData(db, me) });
});
