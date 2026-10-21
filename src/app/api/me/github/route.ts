// The viewer's GitHub connection: their token, kept on Orb sealed (src/server/reposync.ts), the only
// place Orb keeps one. With it Orb pushes their linked worlds' new versions and reads their private
// repositories; `auto` keeps every world of theirs on GitHub.
// GET /api/me/github → { login, auto } | { login: null }
// POST /api/me/github { token?, auto? } → { login, auto } (a token is checked with GitHub first)
// DELETE /api/me/github → { login: null }

import { getViewer } from '@/server/auth';
import { clientIp, fail, handle, json, readJson } from '@/server/http';
import { connection, dropToken, saveToken, setAuto, SyncError } from '@/server/reposync';
import { ready } from '@/server/schema';
import { actorKey, limitOrThrow } from '@/server/worlds';

export const GET = handle(async (req: Request) => {
  const db = await ready();
  return json((await connection(db, getViewer(req))) ?? { login: null });
});

export const POST = handle(async (req: Request) => {
  const viewer = getViewer(req);
  if (!viewer.deviceHash && !viewer.userId) fail(400, 'device_required', 'Missing device key.');
  const body = await readJson<{ token?: unknown; auto?: unknown }>(req, 4000);
  const token = typeof body?.token === 'string' ? body.token.trim() : null;
  if (token !== null && !/^[\w-]{20,255}$/.test(token)) fail(400, 'bad_request', 'Expected { token }: a GitHub token.');
  if (token === null && typeof body?.auto !== 'boolean') fail(400, 'bad_request', 'Expected { token } or { auto }.');
  const db = await ready();
  await limitOrThrow(db, `ghtoken:${actorKey(viewer, clientIp(req))}`, 20, 600);
  try {
    let out = token ? await saveToken(db, viewer, token) : await connection(db, viewer);
    if (!out) fail(400, 'github_required', 'Connect GitHub first.');
    if (typeof body?.auto === 'boolean' && body.auto !== out.auto) out = (await setAuto(db, viewer, body.auto)) ?? out;
    return json(out);
  } catch (e) {
    if (e instanceof SyncError) fail(400, 'github_failed', e.message);
    throw e;
  }
});

export const DELETE = handle(async (req: Request) => {
  const db = await ready();
  await dropToken(db, getViewer(req));
  return json({ login: null });
});
