// GET /api/worlds/:id/versions — saved versions, newest first (the last 50 are kept).
// Prompts are only included for the owner.

import { getViewer } from '@/server/auth';
import { handle, json } from '@/server/http';
import { ready } from '@/server/schema';
import { listVersions, worldIdParam, type IdContext } from '@/server/worlds';

export const GET = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const db = await ready();
  const versions = await listVersions(db, getViewer(req), id);
  return json({ versions });
});
