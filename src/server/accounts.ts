// Accounts with a username and password (SPEC §2 "Account", §6 /api/auth/*). The username is
// the account's handle — the first part of its world URLs (/<username>/<world>, ./paths.ts) — so
// it is unique site-wide and URL-shaped: what people type ("Max Builds") becomes "max-builds",
// and signing in accepts it typed either way. There is no email: a forgotten password is reset by
// an admin (POST /api/admin/password). Passkeys (./passkeys.ts) still sign in the accounts made
// with one, and those can add a password to sign in anywhere.
//
// Passwords are stored as scrypt hashes. Every attempt to sign in counts against the IP and the
// username, so guessing is slow. Signing up and signing in are checked for bots (./botid.ts), and
// an IP makes a limited number of accounts a day, so accounts (each with its own free-builder
// quota, ./freetier.ts) can't be farmed.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { cleanLook } from '@/lib/looks';
import type { MeResponse, UserInfo } from '@/lib/types';
import { getViewer, isAdmin, linkDeviceToUser, randomId, sessionCookie, touchDevice, type Viewer } from './auth';
import { botCheck } from './botid';
import type { Db } from './db';
import { clientIp, error, json, readJson } from './http';
import { isPathPart, ownerHandle, repathAccount, RESERVED, slugify } from './paths';
import { rateLimit, underLimit } from './ratelimit';
import { ready } from './schema';
import { renameAuthor } from './worlds';

export const USERNAME_LENGTH = { min: 3, max: 24 };
export const PASSWORD_LENGTH = { min: 8, max: 200 };

// -- usernames ----------------------------------------------------------------------------------

/** What someone typed as a username → its handle ("Max Builds" → "max-builds"), or why it can't be one. */
export function parseUsername(raw: unknown): { name: string; handle: string } | { error: string } {
  const name =
    typeof raw === 'string'
      ? raw
          .normalize('NFC')
          .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  const handle = slugify(name, '');
  if (handle.length < USERNAME_LENGTH.min || name.length > 40) return { error: `Usernames are ${USERNAME_LENGTH.min} to ${USERNAME_LENGTH.max} letters, numbers or dashes.` };
  if (handle.length > USERNAME_LENGTH.max) return { error: `That's a long one — usernames have at most ${USERNAME_LENGTH.max} letters, numbers or dashes.` };
  if (RESERVED.has(handle) || !isPathPart(handle)) return { error: 'That username is taken — try another one.' };
  return { name, handle };
}

// -- passwords ----------------------------------------------------------------------------------

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };

function derive(password: string, salt: Buffer, o: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? reject(e) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Whether `password` matches the stored hash. Takes as long without a hash, so unknown usernames don't show. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [kind, N, r, p, salt, key] = (stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !key) {
    await derive(password, Buffer.alloc(16), SCRYPT);
    return false;
  }
  const want = Buffer.from(key, 'base64url');
  const got = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p), keylen: want.length });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Why a password won't do, or null. */
export function passwordProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < PASSWORD_LENGTH.min) return `Passwords need at least ${PASSWORD_LENGTH.min} characters.`;
  if (raw.length > PASSWORD_LENGTH.max) return 'That password is too long.';
  return null;
}

// -- helpers ------------------------------------------------------------------------------------

function withCookie(res: Response, cookie: string): Response {
  res.headers.append('set-cookie', cookie);
  return res;
}

const isUniqueViolation = (e: unknown) => !!e && typeof e === 'object' && (e as { code?: unknown }).code === '23505';

/** Over any of these limits → the 429 to answer with. Each check counts one attempt. */
async function limited(db: Db, checks: Array<[key: string, limit: number, windowSec: number]>): Promise<Response | null> {
  for (const [key, limit, windowSec] of checks) {
    const r = await rateLimit(db, key, limit, windowSec);
    if (!r.ok) {
      const retryAfter = Math.max(1, Math.ceil(r.retryAfter));
      return json({ error: 'rate_limited', message: 'Too many tries. Please wait a few minutes and try again.', retryAfter }, { status: 429, headers: { 'retry-after': String(retryAfter) } });
    }
  }
  return null;
}

/** New accounts per IP a day (with passkeys too): a school class can sign up together. */
const ACCOUNTS_PER_IP_DAY = 50;
const accountsKey = (req: Request) => `accounts:ip:${clientIp(req)}`;

/** The 429 when this IP has made its accounts for the day, or null (counts nothing: countAccount() does). */
export async function accountRoom(db: Db, req: Request): Promise<Response | null> {
  if (await underLimit(db, accountsKey(req), ACCOUNTS_PER_IP_DAY, 86400)) return null;
  return error(429, 'rate_limited', 'Lots of accounts were made from here today — please try again tomorrow.');
}

/** Count an account just made against its IP's day. */
export async function countAccount(db: Db, req: Request): Promise<void> {
  await rateLimit(db, accountsKey(req), ACCOUNTS_PER_IP_DAY, 86400);
}

/** An account as the client sees it: its name, username (handle) and whether it has a password. */
export async function accountOf(db: Db, userId: string): Promise<UserInfo | null> {
  const rows = await db.query<{ id: string; name: string; handle: string | null; password: boolean; look: unknown }>(
    `select u.id, u.name, (select h.handle from orb_handles h where h.owner_user = u.id) as handle, (u.password_hash is not null) as password, u.look
     from orb_users u where u.id = $1`,
    [userId],
  );
  const r = rows[0];
  return r ? { id: r.id, name: r.name, handle: r.handle, password: !!r.password, look: cleanLook(r.look) } : null;
}

async function signedIn(db: Db, viewer: Viewer, userId: string): Promise<Response> {
  const user = await accountOf(db, userId);
  const me: MeResponse = { user, deviceId: viewer.deviceId ?? '', name: user?.name ?? '' };
  return withCookie(json(me), sessionCookie(userId));
}

// -- routes -------------------------------------------------------------------------------------

/** POST /api/auth/signup — { username, password } → MeResponse + session cookie. Claims this device's worlds. */
export async function signUp(req: Request): Promise<Response> {
  const bot = await botCheck();
  if (bot) return bot;
  const body = await readJson<{ username?: unknown; password?: unknown }>(req, 10_000);
  const u = parseUsername(body?.username);
  if ('error' in u) return error(400, 'bad_username', u.error);
  const bad = passwordProblem(body?.password);
  if (bad) return error(400, 'bad_password', bad);

  const db = await ready();
  const viewer = getViewer(req);
  const rl = await limited(db, [[`signup:ip:${clientIp(req)}`, 30, 3600], ...(viewer.deviceHash ? [[`signup:dev:${viewer.deviceHash}`, 5, 3600] as [string, number, number]] : [])]);
  if (rl) return rl;

  // The username is free, or this device's own handle (its worlds' URLs already use it).
  const held = (await db.query<{ owner_user: string | null; owner_device: string | null }>(`select owner_user, owner_device from orb_handles where handle = $1`, [u.handle]))[0];
  const own = !!held && !held.owner_user && !!viewer.deviceHash && held.owner_device === viewer.deviceHash;
  const taken = () => error(409, 'username_taken', 'That username is taken — try another one.');
  if (held && !own) return taken();
  const full = await accountRoom(db, req);
  if (full) return full;

  const userId = `u_${randomId(12)}`;
  await db.query(`insert into orb_users (id, name, password_hash) values ($1, $2, $3)`, [userId, u.name, await hashPassword(body!.password as string)]);
  try {
    const claimed = own
      ? await db.query(`update orb_handles set owner_user = $2, owner_device = null where handle = $1 and owner_device = $3 and owner_user is null returning handle`, [u.handle, userId, viewer.deviceHash])
      : await db.query(`insert into orb_handles (handle, owner_user) values ($1, $2) returning handle`, [u.handle, userId]);
    if (!claimed.length) throw Object.assign(new Error('handle moved'), { code: '23505' });
  } catch (e) {
    await db.query(`delete from orb_users where id = $1`, [userId]).catch(() => {});
    if (isUniqueViolation(e)) return taken();
    throw e;
  }
  await countAccount(db, req);

  await linkDeviceToUser(db, viewer.deviceHash, userId);
  const me: Viewer = { ...viewer, userId };
  await touchDevice(db, me, u.name);
  await renameAuthor(db, me, u.name);
  await repathAccount(db, userId);
  return signedIn(db, viewer, userId);
}

/** POST /api/auth/signin — { username, password } → MeResponse + session cookie. Claims this device's worlds. */
export async function signIn(req: Request): Promise<Response> {
  const bot = await botCheck();
  if (bot) return bot;
  const body = await readJson<{ username?: unknown; password?: unknown }>(req, 10_000);
  const handle = slugify(typeof body?.username === 'string' ? body.username : '', '');
  const password = typeof body?.password === 'string' ? body.password.slice(0, PASSWORD_LENGTH.max) : '';
  const db = await ready();
  const viewer = getViewer(req);
  const rl = await limited(db, [
    [`signin:ip:${clientIp(req)}`, 40, 900],
    [`signin:user:${handle || '-'}`, 12, 900],
  ]);
  if (rl) return rl;

  const row = isPathPart(handle)
    ? (await db.query<{ id: string; password_hash: string | null }>(`select u.id, u.password_hash from orb_handles h join orb_users u on u.id = h.owner_user where h.handle = $1`, [handle]))[0]
    : undefined;
  const ok = await verifyPassword(password, row?.password_hash ?? null);
  if (!row || !ok) return error(401, 'wrong_password', "That username and password don't match.");

  await linkDeviceToUser(db, viewer.deviceHash, row.id);
  await repathAccount(db, row.id);
  return signedIn(db, viewer, row.id);
}

/** POST /api/auth/password — { password }, signed in: set or change the account's password. */
export async function setPassword(req: Request): Promise<Response> {
  const viewer = getViewer(req);
  if (!viewer.userId) return error(401, 'signed_out', 'Sign in first.');
  const body = await readJson<{ password?: unknown }>(req, 10_000);
  const bad = passwordProblem(body?.password);
  if (bad) return error(400, 'bad_password', bad);
  const db = await ready();
  const rl = await limited(db, [[`password:${viewer.userId}`, 10, 3600]]);
  if (rl) return rl;
  const user = await accountOf(db, viewer.userId);
  if (!user) return error(401, 'signed_out', 'Sign in first.');
  // Signing in takes the username: an account made with a passkey may not have one yet.
  if (!user.handle) await ownerHandle(db, { user: user.id, device: null, name: user.name });
  await db.query(`update orb_users set password_hash = $2 where id = $1`, [user.id, await hashPassword(body!.password as string)]);
  return signedIn(db, viewer, user.id);
}

/** POST /api/admin/password — { username, password } with x-admin-token: reset a forgotten password. */
export async function resetPassword(req: Request): Promise<Response> {
  if (!isAdmin(req)) return error(404, 'not_found', 'Not found.');
  const body = await readJson<{ username?: unknown; password?: unknown }>(req, 10_000);
  const bad = passwordProblem(body?.password);
  if (bad) return error(400, 'bad_password', bad);
  const handle = slugify(typeof body?.username === 'string' ? body.username : '', '');
  const db = await ready();
  const rows = await db.query<{ id: string }>(`update orb_users set password_hash = $2 where id = (select owner_user from orb_handles where handle = $1) returning id`, [handle, await hashPassword(body!.password as string)]);
  if (!rows.length) return error(404, 'not_found', 'No account has that username.');
  return json({ ok: true, username: handle });
}
