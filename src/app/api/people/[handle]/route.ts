// GET /api/people/:handle — the maker at /<handle>: name, worlds, and how you stand with them
// → { profile }.

import { getViewer } from '@/server/auth';
import { profile } from '@/server/friends';
import { clientIp, handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { actorKey, limitOrThrow } from '@/server/worlds';

export const GET = handle(async (req: Request, ctx: { params: Promise<{ handle: string }> }) => {
  const { handle } = await ctx.params;
  const viewer = getViewer(req);
  const db = await ready();
  await limitOrThrow(db, `people:${actorKey(viewer, clientIp(req))}`, 120, 60);
  return json({ profile: await profile(db, viewer, handle) });
});
