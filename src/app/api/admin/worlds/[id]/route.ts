// POST /api/admin/worlds/:id — curate a world. Header `x-admin-token: $ORB_ADMIN_TOKEN`;
// body { verified?, featured?, ownerUser?, visibility?, authorName?, sourceUrl?, tags? } → { ok: true }.
// DELETE removes the world.

import { isAdmin } from '@/server/auth';
import { fail, handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { adminSetFlags, worldIdParam, type IdContext } from '@/server/worlds';

export const POST = handle(async (req: Request, ctx: IdContext) => {
  if (!isAdmin(req)) fail(401, 'unauthorized', 'Admin token required.');
  const id = await worldIdParam(ctx);
  const body = await readJson<unknown>(req, 10_000);
  if (body === null) fail(400, 'bad_request', 'Expected a JSON body.');
  const db = await ready();
  await adminSetFlags(db, id, body);
  return json({ ok: true });
});

/** DELETE /api/admin/worlds/:id — remove a world (spam, tests). */
export const DELETE = handle(async (req: Request, ctx: IdContext) => {
  if (!isAdmin(req)) fail(401, 'unauthorized', 'Admin token required.');
  const id = await worldIdParam(ctx);
  const db = await ready();
  await db.query(`delete from orb_worlds where id = $1`, [id]);
  return json({ ok: true });
});
