// POST /api/friends/invite { worldId, to: [friend ids] } — invite friends into a public world
// → { invited }: how many got an invite (a friend invited to it a few minutes ago isn't again).

import { getViewer } from '@/server/auth';
import { accountId, inviteFriends } from '@/server/friends';
import { handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { limitOrThrow } from '@/server/worlds';

export const POST = handle(async (req: Request) => {
  const db = await ready();
  const me = await accountId(db, getViewer(req));
  const body = await readJson<{ worldId?: unknown; to?: unknown }>(req, 20_000);
  await limitOrThrow(db, `friends:invite:${me}`, 30, 3600, 'You sent a lot of invites just now. Try again in a little while.');
  return json({ invited: await inviteFriends(db, me, body?.worldId, body?.to) });
});
