// POST /api/friends/:id — say yes to their friend request. DELETE /api/friends/:id — unfriend,
// turn a request down or take yours back. Both → { friends }.

import { getViewer } from '@/server/auth';
import { acceptFriend, accountId, friendsData, isUserId, removeFriend } from '@/server/friends';
import { json } from '@/server/http';
import { ready } from '@/server/schema';
import { fail, limitOrThrow, route, type IdContext } from '@/server/worlds';

async function other(ctx: IdContext): Promise<string> {
  const { id } = await ctx.params;
  if (!isUserId(id)) fail(404, 'not_found', 'That friend request isn’t there anymore.');
  return id;
}

export const POST = route(async (req: Request, ctx: IdContext) => {
  const id = await other(ctx);
  const db = await ready();
  const me = await accountId(db, getViewer(req));
  await limitOrThrow(db, `friends:act:${me}`, 60, 60);
  await acceptFriend(db, me, id);
  return json({ friends: await friendsData(db, me) });
});

export const DELETE = route(async (req: Request, ctx: IdContext) => {
  const id = await other(ctx);
  const db = await ready();
  const me = await accountId(db, getViewer(req));
  await limitOrThrow(db, `friends:act:${me}`, 60, 60);
  await removeFriend(db, me, id);
  return json({ friends: await friendsData(db, me) });
});
