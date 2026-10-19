// Dev-only companion of the /dev/passkey harness (404 in production).
//   GET  → the server's view of this request: session user, passkey count, the user's worlds and
//          the user this device is linked to.
//   POST { name } → create a world owned anonymously by this device (x-orb-device), for claim tests.
//   POST { action: 'expire-move', code } → make a domain-move hand-off code (src/server/move.ts)
//          expire now, for scripts/test-move.mjs.
// It is a route handler rather than page code so it uses the same server module instances
// (and therefore the same DB handle) as /api/auth/*.
import crypto from 'node:crypto';
import { getViewer, randomId } from '@/server/auth';
import { error, handle, json, readJson } from '@/server/http';
import { ready } from '@/server/schema';

const devOnly = () => (process.env.NODE_ENV === 'production' ? error(404, 'not_found') : null);

export const GET = handle(async (req: Request) => {
  const blocked = devOnly();
  if (blocked) return blocked;
  const viewer = getViewer(req);
  const db = await ready();
  const linked = viewer.deviceHash
    ? (await db.query<{ user_id: string | null }>(`select user_id from orb_devices where hash = $1`, [viewer.deviceHash]))[0]?.user_id ?? null
    : null;
  if (!viewer.userId) return json({ user: null, worlds: [], passkeys: 0, deviceUser: linked });
  const users = await db.query<{ id: string; name: string }>(`select id, name from orb_users where id = $1`, [viewer.userId]);
  const worlds = await db.query<{ id: string; name: string }>(`select id, name from orb_worlds where owner_user = $1 order by created_at`, [viewer.userId]);
  const passkeys = await db.query<{ n: number | string }>(`select count(*) as n from orb_passkeys where user_id = $1`, [viewer.userId]);
  return json({ user: users[0] ?? null, worlds, passkeys: Number(passkeys[0]?.n ?? 0), deviceUser: linked });
});

export const POST = handle(async (req: Request) => {
  const blocked = devOnly();
  if (blocked) return blocked;
  const body = await readJson<{ name?: unknown; action?: unknown; code?: unknown }>(req, 10_000);
  const db = await ready();
  if (body?.action === 'expire-move') {
    const hash = crypto.createHash('sha256').update(String(body.code ?? '')).digest('hex');
    const rows = await db.query(`update orb_moves set expires_at = now() - interval '1 second' where code_hash = $1 returning 1`, [hash]);
    return json({ expired: rows.length });
  }
  const viewer = getViewer(req);
  if (!viewer.deviceHash) return error(400, 'no_device', 'Send x-orb-device.');
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'Harness world';
  const id = randomId(10);
  await db.query(
    `insert into orb_worlds (id, name, code, owner_device, author_name, version) values ($1, $2, $3, $4, 'Harness', 1)`,
    [id, name, '<!doctype html><title>harness</title>', viewer.deviceHash],
  );
  return json({ id });
});
