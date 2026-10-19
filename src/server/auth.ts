// Viewer identity: anonymous device key (header) + optional passkey account (signed cookie), or
// the Orb kit's token (a bearer token that acts as the browser that approved it, see ./kit.ts).

import crypto from 'node:crypto';
import type { Db } from './db';

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
  const bytes = crypto.randomBytes(len * 2);
  let out = '';
  for (let i = 0; out.length < len && i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 248) out += alphabet[b % 62];
  }
  while (out.length < len) out += alphabet[crypto.randomInt(62)];
  return out;
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

export function signSession(userId: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = Buffer.from(JSON.stringify({ u: userId, e: exp })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

export function verifySession(token: string | undefined | null): { userId: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = hmac(payload);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof u !== 'string' || typeof e !== 'number' || e < Date.now() / 1000) return null;
    return { userId: u };
  } catch {
    return null;
  }
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
  const exp = Math.floor(Date.now() / 1000) + KIT_DAYS * 86400;
  const payload = Buffer.from(JSON.stringify({ k: 'kit', d: deviceHash, u: userId, e: exp })).toString('base64url');
  return `${KIT_PREFIX}${payload}.${hmac(`kit.${payload}`)}`;
}

export function verifyKitToken(token: string | null | undefined): { deviceHash: string | null; userId: string | null } | null {
  if (!token?.startsWith(KIT_PREFIX)) return null;
  const [payload, sig] = token.slice(KIT_PREFIX.length).split('.');
  if (!payload || !sig) return null;
  const expected = hmac(`kit.${payload}`);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const { k, d, u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (k !== 'kit' || typeof e !== 'number' || e < Date.now() / 1000) return null;
    const deviceHash = typeof d === 'string' && /^[a-f0-9]{64}$/.test(d) ? d : null;
    const userId = typeof u === 'string' && u ? u : null;
    return deviceHash || userId ? { deviceHash, userId } : null;
  } catch {
    return null;
  }
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
  const { adoptDeviceHandle } = await import('./paths');
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
  if (!token || !given || token.length !== given.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(given));
}
