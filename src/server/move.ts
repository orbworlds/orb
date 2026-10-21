// Moving to a new domain — the server side of the hand-off (docs/operations.md "Moving to a new domain").
//
//   1. A page visit to a former address is redirected (next.config.ts) to
//      GET /api/move/start/<former host>/<path> on the site, which marks the browser with a
//      short-lived cookie (orb_move_<key>) and sends it back to <former>/move?s=<key>.<secret>.
//   2. /move there POSTs the browser's packed `orb:*` storage to /api/move; its session cookie
//      comes along. It's kept under a random single-use code for 10 minutes, the former address
//      remembers that this browser moved (orb_moved: later visits go straight over) and the page
//      goes on to <site>/move?code=….
//   3. That page claims it (POST /api/move/claim). Only the browser holding the cookie from step 1
//      can, so a link can't push someone else's things or account into your browser. Claiming
//      signs the browser in as the carried account, moves what a replaced device key owned to the
//      carried one, and returns the packed storage for the page to merge (src/lib/move.ts).
//
// Passkeys: a browser that can't use Orb's RP ID on its address (no Related Origin Requests)
// makes its passkey at the passkey home instead. POST /api/move/passkey starts the same round
// trip there with ?passkey=…, and only the signed-in session comes back.

import { MAX_BUNDLE, MOVED_COOKIE, safeTo } from '@/lib/move';
import { getViewer, linkDeviceToUser, randomId, readCookie, sameString, sessionCookie } from './auth';
import type { Db } from './db';
import { sha256 } from './files';
import { clientIp, error, json, readJson, retryLater, withCookies } from './http';
import { originForHost, originsConfig, requestOrigin } from './origins';
import { cleanName } from './passkeys';
import { rateLimit } from './ratelimit';
import { ready } from './schema';
import { sessionUser } from './worlds';

const STATE_COOKIE = 'orb_move_';
/** Only the claim needs the state cookie. */
const STATE_PATH = '/api/move';
const STATE_TTL_SEC = 15 * 60;
const CODE_TTL_SEC = 10 * 60;
/** Browsers cap cookie lifetimes at 400 days. */
const MOVED_MAX_AGE_SEC = 400 * 86400;
const KEY = /^[0-9A-Za-z]{10}$/;
const SECRET = /^[0-9A-Za-z]{32}$/;

const secure = () => (process.env.NODE_ENV === 'production' ? '; Secure' : '');

function redirect(location: string, ...cookies: string[]): Response {
  return withCookies(new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } }), ...cookies);
}

const tooMany = (retryAfter: number) => retryLater(429, 'rate_limited', 'Too many tries. Please wait a moment and try again.', retryAfter);

/**
 * Begin a hand-off from `source` that ends at `target` (this address): the URL of the source's
 * /move page, and the cookie that lets only this browser pick up what it sends.
 */
function begin(source: string, target: string, to: string, extra: Record<string, string> = {}): { url: string; cookie: string } {
  const key = randomId(10);
  const secret = randomId(32);
  const url = new URL('/move', source);
  url.searchParams.set('s', `${key}.${secret}`);
  url.searchParams.set('back', target);
  url.searchParams.set('to', to);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return { url: url.toString(), cookie: `${STATE_COOKIE}${key}=${secret}; Path=${STATE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_SEC}${secure()}` };
}

/**
 * GET /api/move/start/<former host>/<path…>?<query> — a page visit to a former address (redirected
 * here by next.config.ts), or a retry: hand the browser over from there, then land on the path.
 */
export async function startHandoff(req: Request, fromHost: string): Promise<Response> {
  const o = originsConfig();
  const { origin } = requestOrigin(req);
  if (!o.targets.includes(origin)) return error(404, 'not_found');
  const url = new URL(req.url);
  const rest = url.pathname.split('/').slice(5).join('/');
  const to = safeTo(`/${rest}${url.search}`);
  const source = originForHost(o.former, fromHost);
  if (!source) return redirect(to);
  const { url: next, cookie } = begin(source, origin, to);
  return redirect(next, cookie);
}

/**
 * POST /api/move/passkey {kind: 'signin' | 'signup', name?, to} — for browsers that can't use Orb's
 * passkeys on this address: do the ceremony at the passkey home and come back signed in to `to`.
 * Returns { url } to go to.
 */
export async function startPasskey(req: Request): Promise<Response> {
  const o = originsConfig();
  const { origin } = requestOrigin(req);
  const body = await readJson<{ kind?: unknown; name?: unknown; to?: unknown }>(req, 10_000);
  const kind = body?.kind === 'signup' || body?.kind === 'signin' ? body.kind : null;
  if (!kind) return error(400, 'bad_request', 'Expected { kind, to }.');
  const name = kind === 'signup' ? cleanName(body?.name) : '';
  if (kind === 'signup' && !name) return error(400, 'name_required', 'Please choose a name first.');
  if (!o.targets.includes(origin) || origin === o.home) return error(400, 'not_available', 'Please reload the page and try again.');
  const { url, cookie } = begin(o.home, origin, safeTo(body?.to), name ? { passkey: kind, name } : { passkey: kind });
  return withCookies(json({ url }), cookie);
}

/**
 * POST /api/move on a former address (or, with x-orb-passkey, on the passkey home) — body: the
 * packed `orb:*` storage, possibly empty. Headers: x-orb-move (the `s` the page got), x-orb-back
 * (where it ends), x-orb-to, x-orb-pack ('gzip' | 'json'), and optionally x-orb-device and
 * x-orb-dropped (some entries had to stay behind). Returns { url } to go to.
 */
export async function createHandoff(req: Request): Promise<Response> {
  const o = originsConfig();
  const { origin } = requestOrigin(req);
  const passkey = req.headers.get('x-orb-passkey') === '1';
  if (passkey ? origin !== o.home : !o.former.includes(origin)) return error(404, 'not_found');
  const [key = '', secret = '', ...more] = (req.headers.get('x-orb-move') ?? '').split('.');
  const back = req.headers.get('x-orb-back') ?? '';
  if (!KEY.test(key) || !SECRET.test(secret) || more.length || !o.targets.includes(back)) return error(400, 'bad_request', 'This link has expired.');
  const to = safeTo(req.headers.get('x-orb-to'));
  const format = req.headers.get('x-orb-pack') === 'gzip' ? 'gzip' : 'json';

  const db = await ready();
  const rl = await rateLimit(db, `move:ip:${clientIp(req)}`, 30, 600);
  if (!rl.ok) return tooMany(rl.retryAfter);

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > MAX_BUNDLE) return error(413, 'too_large', 'That was too much to bring along.');
  const viewer = getViewer(req);
  if (passkey && !viewer.userId) return error(401, 'signed_out', 'Please use your passkey first.');
  const device = passkey ? null : viewer.deviceHash;
  const data = passkey || !body.byteLength ? null : body;
  const moved = passkey ? [] : [`${MOVED_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MOVED_MAX_AGE_SEC}${secure()}`];

  // Nothing to bring: straight on.
  if (!viewer.userId && !device && !data) return withCookies(json({ url: new URL(to, back).toString() }), ...moved);

  await db.query(`delete from orb_moves where expires_at < now()`);
  const code = randomId(32);
  await db.query(
    `insert into orb_moves (code_hash, state_key, state_hash, user_id, device_hash, data, pack, expires_at)
     values ($1, $2, $3, (select id from orb_users where id = $4::text), $5, $6, $7, now() + interval '${CODE_TTL_SEC} seconds')`,
    [sha256(code), key, sha256(secret), viewer.userId, device, data ? Buffer.from(data) : null, data ? format : 'none'],
  );
  const next = new URL('/move', back);
  next.searchParams.set('code', code);
  next.searchParams.set('to', to);
  if (passkey) next.searchParams.set('passkey', '1');
  else next.searchParams.set('from', new URL(origin).host);
  if (req.headers.get('x-orb-dropped')) next.searchParams.set('dropped', '1');
  return withCookies(json({ url: next.toString() }), ...moved);
}

interface MoveRow {
  state_key: string;
  state_hash: string;
  user_id: string | null;
  device_hash: string | null;
  data: Uint8Array | null;
  pack: string;
  valid: boolean;
}

/**
 * POST /api/move/claim on the site — header x-orb-move-code, plus this browser's own x-orb-device
 * if it has one. Single use. Answers with the packed storage (x-orb-pack says how it's packed;
 * 'none' and an empty body when nothing came along) and signs the browser in as the carried
 * account.
 */
export async function claimHandoff(req: Request): Promise<Response> {
  const o = originsConfig();
  const { origin } = requestOrigin(req);
  if (!o.targets.includes(origin)) return error(404, 'not_found');
  const code = req.headers.get('x-orb-move-code') ?? '';
  const gone = () => error(410, 'move_expired', 'This link has expired.');
  if (!SECRET.test(code)) return gone();

  const db = await ready();
  const rl = await rateLimit(db, `move-claim:ip:${clientIp(req)}`, 30, 600);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const rows = await db.query<MoveRow>(
    `delete from orb_moves where code_hash = $1
     returning state_key, state_hash, user_id, device_hash, data, pack, (expires_at > now()) as valid`,
    [sha256(code)],
  );
  const row = rows[0];
  if (!row || !row.valid) return gone();
  const clearState = `${STATE_COOKIE}${row.state_key}=; Path=${STATE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure()}`;
  const secret = readCookie(req, STATE_COOKIE + row.state_key);
  if (!secret || !sameString(sha256(secret), row.state_hash)) return withCookies(error(403, 'move_mismatch', 'This link was meant for another browser.'), clearState);

  const viewer = getViewer(req);
  if (row.device_hash && viewer.deviceHash && row.device_hash !== viewer.deviceHash) await adoptDevice(db, viewer.deviceHash, row.device_hash);
  const device = row.device_hash ?? viewer.deviceHash;
  const userId = row.user_id ?? (await sessionUser(db, viewer));
  if (userId) await linkDeviceToUser(db, device, userId);

  const res = new Response(row.data ? new Uint8Array(row.data) : null, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-orb-pack': row.data ? row.pack : 'none' },
  });
  return withCookies(res, clearState, ...(row.user_id ? [sessionCookie(row.user_id)] : []));
}

/**
 * This browser's device key gives way to the one it carried from a former address: everything
 * the replaced key owned (worlds, builds, its handle, likes) moves to the carried key.
 */
async function adoptDevice(db: Db, from: string, to: string): Promise<void> {
  await db.query(`update orb_worlds set owner_device = $2 where owner_device = $1`, [from, to]);
  await db.query(`update orb_agent_jobs set owner_device = $2 where owner_device = $1`, [from, to]);
  await db.query(`update orb_handles set owner_device = $2 where owner_device = $1 and not exists (select 1 from orb_handles where owner_device = $2)`, [from, to]);
  // One like per world and device: a world both keys liked keeps one.
  await db.query(
    `with dup as (
       delete from orb_likes l where l.device_hash = $1
          and exists (select 1 from orb_likes c where c.world_id = l.world_id and c.device_hash = $2)
       returning l.world_id
     )
     update orb_worlds set likes = greatest(0, likes - 1) where id in (select world_id from dup)`,
    [from, to],
  );
  await db.query(`update orb_likes set device_hash = $2 where device_hash = $1`, [from, to]);
  await db.query(
    `insert into orb_devices (hash, name) values ($2, (select name from orb_devices where hash = $1))
     on conflict (hash) do update set name = coalesce(orb_devices.name, excluded.name)`,
    [from, to],
  );
  await db.query(`update orb_devices set user_id = null where hash = $1`, [from]);
}
