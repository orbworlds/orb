// GET /api/saves/:worldId?since=<ms> — the signed-in person's progress in a world: 200 { data, at }
// when the account's copy is newer than `since`, else 204 (x-orb-save-at: the account's copy's time,
// 0 for none). PUT /api/saves/:worldId { data, at } — keep this copy, unless the account's is newer.

import { getViewer } from '@/server/auth';
import { fail, handle, json, readJson } from '@/server/http';
import { cleanSave, getSave, MAX_SAVE_CHARS, putSave } from '@/server/saves';
import { ready } from '@/server/schema';
import { limitOrThrow, sessionUser, worldIdParam, type IdContext } from '@/server/worlds';

export const GET = handle(async (req: Request, ctx: IdContext) => {
  const viewer = getViewer(req);
  if (!viewer.userId) fail(401, 'account_required', 'Sign in to keep your progress on every device.');
  const id = await worldIdParam(ctx);
  const since = Number(new URL(req.url).searchParams.get('since')) || 0;
  const save = await getSave(await ready(), viewer.userId, id);
  if (save && save.at > since) return json(save);
  return new Response(null, { status: 204, headers: { 'x-orb-save-at': String(save?.at ?? 0), 'cache-control': 'no-store' } });
});

export const PUT = handle(async (req: Request, ctx: IdContext) => {
  const id = await worldIdParam(ctx);
  const body = await readJson<{ data?: unknown; at?: unknown }>(req, MAX_SAVE_CHARS + 10_000);
  const data = cleanSave(body?.data);
  if (!data || !Number.isSafeInteger(body?.at) || Number(body?.at) <= 0) fail(400, 'bad_request', 'Expected { data: { key: value }, at }.');
  const db = await ready();
  const userId = await sessionUser(db, getViewer(req));
  if (!userId) fail(401, 'account_required', 'Sign in to keep your progress on every device.');
  await limitOrThrow(db, `saves:${userId}`, 1200, 3600, 'Saving a lot right now — your progress is kept on this device meanwhile.');
  // A clock far in the future would freeze the save (the newer copy wins): clamp it.
  const r = await putSave(db, userId, id, data, Math.min(Number(body!.at), Date.now() + 86_400_000));
  if (r.saved || r.reason === 'older') return json(r);
  if (r.reason === 'no_world') fail(404, 'not_found', 'This world does not exist.');
  fail(413, 'saves_full', 'This account keeps a lot of saved progress already — it stays on this device.');
});
