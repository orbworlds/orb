// Viewer identity: anonymous device key (header) + optional account (signed session cookie, from a
// password or a passkey sign-in), or the Orb kit's token (a bearer token that acts as the browser
// that approved it, see ./kit.ts).

import crypto from 'node:crypto';
import type { Db } from './db';
import { adoptDeviceHandle } from './paths';

export const SESSION_COOKIE = 'orb_session';
const SESSION_DAYS = 365;

export interface Viewer {
  /** sha256(deviceKey) hex, or null if the request carried no device key. */
  deviceHash: string | null;
  /** Public short id derived from the device hash (safe to expose). */
  deviceId: string | null;
  /** Signed-in user id (from the session cookie), or null. */
  userId: string | null;
}

/** The server's signing secret (sessions, agent tick tokens, encrypted job keys). */
export function secret(): string {
  const s = process.env.ORB_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production' && process.env.VERCEL) throw new Error('ORB_SECRET is not set');
  return 'orb-dev-secret-not-for-production';
}

export function hashDevice(key: string): string {
  return crypto.createHash('sha256').update(`orb-device:${key}`).digest('hex');
}

export function publicDeviceId(hash: string): string {
  return hash.slice(0, 12);
}

/** Short, URL-safe random id (base62). */
export function randomId(len = 10): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: len }, () => alphabet[crypto.randomInt(62)]).join('');
}

/** Whether two strings are the same, compared in constant time. */
export function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

/** `data` as a signed token that holds for `days` (`scope` keeps one kind of token from passing for another). */
function seal(scope: string, data: Record<string, unknown>, days: number): string {
  const payload = Buffer.from(JSON.stringify({ ...data, e: Math.floor(Date.now() / 1000) + days * 86400 })).toString('base64url');
  return `${payload}.${hmac(scope + payload)}`;
}

/** What a sealed token holds, while its signature and expiry hold. */
function unseal(scope: string, token: string): Record<string, unknown> | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !sameString(hmac(scope + payload), sig)) return null;
  try {
    const o: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const data = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
    return data && typeof data.e === 'number' && data.e >= Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

export function signSession(userId: string): string {
  return seal('', { u: userId }, SESSION_DAYS);
}

export function verifySession(token: string | undefined | null): { userId: string } | null {
  const o = token ? unseal('', token) : null;
  return typeof o?.u === 'string' ? { userId: o.u } : null;
}

export function sessionCookie(userId: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${signSession(userId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null; // malformed %-escape: treat as absent instead of failing the request
      }
    }
  }
  return null;
}

const KIT_PREFIX = 'orbk_';
const KIT_DAYS = 365;

/** A token for the Orb kit that acts as this device (and account): signed like a session, for a year. */
export function signKitToken(deviceHash: string | null, userId: string | null): string {
  return KIT_PREFIX + seal('kit.', { k: 'kit', d: deviceHash, u: userId }, KIT_DAYS);
}

export function verifyKitToken(token: string | null | undefined): { deviceHash: string | null; userId: string | null } | null {
  if (!token?.startsWith(KIT_PREFIX)) return null;
  const o = unseal('kit.', token.slice(KIT_PREFIX.length));
  if (o?.k !== 'kit') return null;
  const deviceHash = typeof o.d === 'string' && /^[a-f0-9]{64}$/.test(o.d) ? o.d : null;
  const userId = typeof o.u === 'string' && o.u ? o.u : null;
  return deviceHash || userId ? { deviceHash, userId } : null;
}

export function getViewer(req: Request): Viewer {
  const kit = verifyKitToken(/^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]);
  if (kit) return { deviceHash: kit.deviceHash, deviceId: kit.deviceHash ? publicDeviceId(kit.deviceHash) : null, userId: kit.userId };
  const key = req.headers.get('x-orb-device');
  const deviceHash = key && key.length >= 16 && key.length <= 128 ? hashDevice(key) : null;
  const session = verifySession(readCookie(req, SESSION_COOKIE));
  return { deviceHash, deviceId: deviceHash ? publicDeviceId(deviceHash) : null, userId: session?.userId ?? null };
}

/** Make sure the device row exists (lazily created on first write). */
export async function touchDevice(db: Db, viewer: Viewer, name?: string): Promise<void> {
  if (!viewer.deviceHash) return;
  await db.query(
    `insert into orb_devices (hash, name) values ($1, $2)
     on conflict (hash) do update set name = coalesce(excluded.name, orb_devices.name)`,
    [viewer.deviceHash, name ?? null],
  );
}

/** Link the device to a user and claim its anonymous worlds. */
export async function linkDeviceToUser(db: Db, deviceHash: string | null, userId: string): Promise<void> {
  if (!deviceHash) return;
  // The device's handle (its world URLs) becomes the account's, if the account has none yet.
  await adoptDeviceHandle(db, deviceHash, userId);
  // Signing into another account on this device: the device stops being a key to the previous
  // account's worlds (they stay that account's, reachable by signing back in).
  await db.query(`update orb_worlds set owner_device = null where owner_device = $1 and owner_user is not null and owner_user <> $2`, [deviceHash, userId]);
  await db.query(
    `insert into orb_devices (hash, user_id) values ($1, $2)
     on conflict (hash) do update set user_id = excluded.user_id`,
    [deviceHash, userId],
  );
  await db.query(`update orb_worlds set owner_user = $2 where owner_device = $1 and owner_user is null`, [deviceHash, userId]);
}

export interface Ownable {
  owner_device: string | null;
  owner_user: string | null;
}

/** Ownership rule — see SPEC §6. */
export async function canEdit(db: Db, viewer: Viewer, world: Ownable): Promise<boolean> {
  if (viewer.userId && world.owner_user && viewer.userId === world.owner_user) return true;
  if (viewer.deviceHash && world.owner_device && viewer.deviceHash === world.owner_device) return true;
  if (viewer.deviceHash && world.owner_user) {
    const rows = await db.query<{ user_id: string | null }>(`select user_id from orb_devices where hash = $1`, [viewer.deviceHash]);
    if (rows[0]?.user_id && rows[0].user_id === world.owner_user) return true;
  }
  return false;
}

export function isAdmin(req: Request): boolean {
  const token = process.env.ORB_ADMIN_TOKEN;
  const given = req.headers.get('x-admin-token');
  return !!token && !!given && sameString(token, given);
}

// -- GitHub's OAuth round trip (/api/github/login, then /api/github/callback) ------------------

export const GH_STATE_COOKIE = 'orb_gh_state';
export const GH_STATE_PATH = '/api/github';

/** Same-origin relative path to return to after connecting (default "/"). */
export function safeNext(raw: string | null): string {
  if (!raw || raw.length > 300 || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw.split('#')[0] || '/';
}
