// GET /api/me — who am I (device + optional account). PATCH /api/me { name } — set my display name.
// Renaming also updates `author_name` on every world the viewer owns, and the account name when
// signed in (one "your name" everywhere).

import { cleanLook } from '@/lib/looks';
import type { MeResponse } from '@/lib/types';
import { getViewer, touchDevice, type Viewer } from '@/server/auth';
import type { Db } from '@/server/db';
import { clientIp, fail, handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';
import { actorKey, cleanDisplayName, limitOrThrow, renameAuthor } from '@/server/worlds';

async function me(db: Db, viewer: Viewer): Promise<MeResponse> {
  const rows = await db.query<{ user_id: string | null; user_name: string | null; handle: string | null; password: boolean | null; look: unknown; device_name: string | null }>(
    `select u.id as user_id, u.name as user_name, (u.password_hash is not null) as password, u.look,
            (select h.handle from orb_handles h where h.owner_user = u.id) as handle,
            (select d.name from orb_devices d where d.hash = $2::text) as device_name
     from (select 1) as one left join orb_users u on u.id = $1::text`,
    [viewer.userId, viewer.deviceHash],
  );
  const r = rows[0];
  return {
    user: r?.user_id ? { id: r.user_id, name: r.user_name ?? '', handle: r.handle, password: !!r.password, look: cleanLook(r.look) } : null,
    deviceId: viewer.deviceId ?? '',
    // Empty when the server knows no name yet; the client then keeps its local one.
    name: r?.device_name?.trim() || r?.user_name?.trim() || '',
  };
}

export const GET = handle(async (req: Request) => {
  const viewer = getViewer(req);
  const db = await ready();
  return json(await me(db, viewer));
});

export const PATCH = handle(async (req: Request) => {
  const viewer = getViewer(req);
  if (!viewer.deviceHash && !viewer.userId) fail(400, 'device_required', 'Missing device key.');
  const body = await readJson<unknown>(req, 10_000);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'bad_request', 'Expected { name }.');
  const name = cleanDisplayName((body as { name?: unknown }).name);
  if (!name) fail(400, 'invalid_name', 'Please enter a name.');

  const db = await ready();
  await limitOrThrow(db, `me:${actorKey(viewer, clientIp(req))}`, 20, 60);
  await touchDevice(db, viewer, name);
  if (viewer.userId) await db.query(`update orb_users set name = $2 where id = $1`, [viewer.userId, name]);
  await renameAuthor(db, viewer, name);
  return json(await me(db, viewer));
});
