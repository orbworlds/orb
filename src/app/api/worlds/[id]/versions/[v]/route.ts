// GET /api/worlds/:id/versions/:v — the code of one saved version.

import { getViewer } from '@/server/auth';
import { fail, handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { getVersion, isWorldId } from '@/server/worlds';

export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string; v: string }> }) => {
  const { id, v } = await ctx.params;
  if (!isWorldId(id)) fail(404, 'not_found', 'This world does not exist.');
  const version = /^\d{1,9}$/.test(v) ? Number(v) : 0;
  if (version < 1) fail(404, 'not_found', 'That version does not exist.');
  const db = await ready();
  return json(await getVersion(db, getViewer(req), id, version));
});
