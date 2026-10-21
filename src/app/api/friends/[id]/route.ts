// POST /api/friends/:id — say yes to their friend request. DELETE /api/friends/:id — unfriend,
// turn a request down or take yours back. Both → { friends }.

import { getViewer } from '@/server/auth';
import { acceptFriend, accountId, friendsData, isUserId, removeFriend } from '@/server/friends';
import { fail, handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { limitOrThrow, type IdContext } from '@/server/worlds';

const answer = (act: typeof acceptFriend) =>
  handle(async (req: Request, ctx: IdContext) => {
    const { id } = await ctx.params;
    if (!isUserId(id)) fail(404, 'not_found', 'That friend request isn’t there anymore.');
    const db = await ready();
    const me = await accountId(db, getViewer(req));
    await limitOrThrow(db, `friends:act:${me}`, 60, 60);
    await act(db, me, id);
    return json({ friends: await friendsData(db, me) });
  });

export const POST = answer(acceptFriend);
export const DELETE = answer(removeFriend);
