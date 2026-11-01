// Making a world together (SPEC §2 "Making a world together").
// GET /api/worlds/:id/editors — (those who may change it) how it stands → TogetherNow
//   { version, editors, makers }: `makers` are the others at it right now (it's on their screen, or
//   their build is changing it: `building`, what they asked for), with their blob's look
// POST /api/worlds/:id/editors { invite: true | false } — (its owner) the invite: made, or kept →
//   { invite }; turned off → { invite: null } (whoever it let in stays)
// POST /api/worlds/:id/editors { token } — (an account) come in with the owner's invite → { world }
// DELETE /api/worlds/:id/editors?user=<id> — its owner takes someone off; anyone else leaves → { ok }

import { getViewer } from '@/server/auth';
import { clientIp, fail, handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { actorKey, joinWorld, limitOrThrow, removeEditor, setInvite, togetherOf, worldIdParam, type IdContext } from '@/server/worlds';

export const GET = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  const db = await ready();
  return json(await togetherOf(db, viewer, id));
});

export const POST = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const viewer = getViewer(req);
  const body = await readJson<{ invite?: unknown; token?: unknown }>(req, 2000);
  const db = await ready();
  await limitOrThrow(db, `editors:${actorKey(viewer, clientIp(req))}`, 30, 600);
  if (typeof body?.token === 'string') return json({ world: await joinWorld(db, viewer, id, body.token.slice(0, 100)) });
  if (typeof body?.invite === 'boolean') return json({ invite: await setInvite(db, viewer, id, body.invite) });
  fail(400, 'bad_request', 'Send { invite: true } or { invite: false }, or { token } to come in.');
});

export const DELETE = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const user = new URL(req.url).searchParams.get('user') ?? '';
  if (!user || user.length > 100) fail(400, 'bad_request', 'Say whom (?user=).');
  await removeEditor(await ready(), getViewer(req), id, user);
  return json({ ok: true });
});
