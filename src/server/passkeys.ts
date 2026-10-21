// Passkey (WebAuthn) accounts — server side. SPEC §2 "Account", §6 /api/auth/*.
//
// Flow (discoverable credentials, so signing in needs no username):
//   register/options {name} → creation options; the challenge (+ the new user id and name) is kept
//                              in orb_challenges under a random key held in the HttpOnly `orb_chal`
//                              cookie (5 min, single use).
//   register/verify          → verifies the attestation, creates orb_users + orb_passkeys, links this
//                              device (claiming its anonymous worlds) and sets the session cookie.
//   login/options            → request options with empty allowCredentials (the browser offers every
//                              Orb passkey on the device).
//   login/verify             → looks the credential up, verifies the assertion, bumps the counter,
//                              links this device and sets the session cookie.
//   logout                   → clears the session cookie and unlinks this device from its user.
//
// Every Orb address uses one RP ID (./origins.ts). Where the browser needs Related Origin Requests
// to use it, both options responses also carry `home`: the address to do the ceremony at instead
// if it can't (src/lib/passkey.ts).
//
// The route files under src/app/api/auth/** are thin wrappers around the handlers exported here.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { accountRoom, cleanText, countAccount, limited, signedIn } from './accounts';
import { clearSessionCookie, getViewer, linkDeviceToUser, randomId, readCookie, type Viewer } from './auth';
import { botCheck } from './botid';
import { isUniqueViolation, type Db } from './db';
import { clientIp, error, json, readJson, withCookies } from './http';
import { relyingParty } from './origins';
import { ready } from './schema';

const RP_NAME = 'Orb';
const CHALLENGE_COOKIE = 'orb_chal';
/** The challenge cookie is only ever needed by the passkey routes. */
const CHALLENGE_PATH = '/api/auth/passkey';
const CHALLENGE_TTL_SEC = 5 * 60;
/** How long the browser waits for the user to finish the passkey prompt. */
const CEREMONY_TIMEOUT_MS = 120_000;
export const MAX_NAME_LENGTH = 40;

const isProd = () => process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------------------------
// Challenges (single use, 5 minutes, keyed by an HttpOnly cookie)

type ChallengeData = { kind: 'register'; userId: string; name: string } | { kind: 'login' };

function challengeCookie(key: string, maxAge = CHALLENGE_TTL_SEC): string {
  return `${CHALLENGE_COOKIE}=${key}; Path=${CHALLENGE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isProd() ? '; Secure' : ''}`;
}

const clearChallengeCookie = () => challengeCookie('', 0);

/** Store a challenge and return the Set-Cookie value that points at it. */
async function saveChallenge(db: Db, challenge: string, data: ChallengeData): Promise<string> {
  // Opportunistic cleanup keeps the table tiny (abandoned ceremonies never come back).
  await db.query(`delete from orb_challenges where expires_at < now()`);
  const key = randomId(32);
  await db.query(
    `insert into orb_challenges (key, challenge, data, expires_at)
     values ($1, $2, $3::jsonb, now() + interval '${CHALLENGE_TTL_SEC} seconds')`,
    [key, challenge, JSON.stringify(data)],
  );
  return challengeCookie(key);
}

type TakenChallenge = { ok: true; challenge: string; data: ChallengeData } | { ok: false; response: Response };

/**
 * Consume (delete) the challenge referenced by the request's `orb_chal` cookie. A challenge can be
 * used exactly once, so a replayed response always fails.
 */
async function takeChallenge(db: Db, req: Request, kind: ChallengeData['kind']): Promise<TakenChallenge> {
  const expired = () => ({ ok: false as const, response: withCookies(error(400, 'challenge_expired', 'That took a little too long. Please try again.'), clearChallengeCookie()) });
  const key = readCookie(req, CHALLENGE_COOKIE);
  if (!key || key.length > 64) return expired();
  const rows = await db.query<{ challenge: string; data: unknown; valid: boolean }>(
    `delete from orb_challenges where key = $1 returning challenge, data, (expires_at > now()) as valid`,
    [key],
  );
  const row = rows[0];
  if (!row || !row.valid) return expired();
  const data = (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as ChallengeData | null;
  if (!data || data.kind !== kind) return expired();
  return { ok: true, challenge: row.challenge, data };
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Display name: printable, single-spaced, at most 40 characters (code points, never split emoji). */
export function cleanName(raw: unknown): string {
  return Array.from(cleanText(raw)).slice(0, MAX_NAME_LENGTH).join('').trim();
}

/** Options endpoints write a row per call; keep abuse bounded per IP and per device. */
function optionsLimited(db: Db, req: Request, viewer: Viewer): Promise<Response | null> {
  const checks: Array<[string, number, number]> = [[`passkey:ip:${clientIp(req)}`, 30, 600], ...(viewer.deviceHash ? [[`passkey:dev:${viewer.deviceHash}`, 30, 600] as [string, number, number]] : [])];
  return limited(db, checks, 'Too many tries. Please wait a moment and try again.');
}

function verifyFailed(): Response {
  return withCookies(error(400, 'passkey_failed', "We couldn't verify your passkey. Please try again."), clearChallengeCookie());
}

// ---------------------------------------------------------------------------------------------
// Registration

/** POST /api/auth/passkey/register/options — body `{ name }`. */
export async function registrationOptions(req: Request): Promise<Response> {
  const bot = await botCheck();
  if (bot) return bot;
  const body = await readJson<{ name?: unknown }>(req, 10_000);
  const name = cleanName(body?.name);
  if (!name) return error(400, 'name_required', 'Please choose a name first.');

  const db = await ready();
  const viewer = getViewer(req);
  const rl = (await optionsLimited(db, req, viewer)) ?? (await accountRoom(db, req));
  if (rl) return rl;

  const { rpID, home } = relyingParty(req);
  // The user id doubles as the WebAuthn user handle, so a discoverable credential maps straight
  // back to its account on sign-in.
  const userId = `u_${randomId(12)}`;
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: name,
    userDisplayName: name,
    userID: new TextEncoder().encode(userId),
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const cookie = await saveChallenge(db, options.challenge, { kind: 'register', userId, name });
  return withCookies(json(home ? { ...options, home } : options), cookie);
}

/** POST /api/auth/passkey/register/verify — body: the browser's RegistrationResponseJSON. */
export async function registrationVerify(req: Request): Promise<Response> {
  const response = await readJson<RegistrationResponseJSON>(req, 100_000);
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || !response.response) {
    return error(400, 'bad_request', 'Expected a passkey registration response.');
  }

  const db = await ready();
  const taken = await takeChallenge(db, req, 'register');
  if (!taken.ok) return taken.response;
  if (taken.data.kind !== 'register') return verifyFailed();
  const { userId, name } = taken.data;

  const { rpID, origin } = relyingParty(req);
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: taken.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      // userVerification is 'preferred': accept authenticators that only prove presence.
      requireUserVerification: false,
    });
  } catch (e) {
    console.warn('[orb] passkey registration rejected:', e instanceof Error ? e.message : e);
    return verifyFailed();
  }
  if (!verification.verified) return verifyFailed();

  const { credential } = verification.registrationInfo;
  await db.query(`insert into orb_users (id, name) values ($1, $2)`, [userId, name]);
  try {
    await db.query(`insert into orb_passkeys (id, user_id, public_key, counter, transports) values ($1, $2, $3, $4, $5)`, [
      credential.id,
      userId,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports?.length ? credential.transports.join(',') : null,
    ]);
  } catch (e) {
    await db.query(`delete from orb_users where id = $1`, [userId]).catch(() => {});
    if (isUniqueViolation(e)) {
      return withCookies(error(409, 'passkey_exists', 'This passkey is already registered. Try signing in instead.'), clearChallengeCookie());
    }
    throw e;
  }
  await countAccount(db, req);

  const viewer = getViewer(req);
  await linkDeviceToUser(db, viewer.deviceHash, userId);
  return withCookies(await signedIn(db, viewer, userId), clearChallengeCookie());
}

// ---------------------------------------------------------------------------------------------
// Authentication

/** POST /api/auth/passkey/login/options */
export async function authenticationOptions(req: Request): Promise<Response> {
  const db = await ready();
  const viewer = getViewer(req);
  const rl = await optionsLimited(db, req, viewer);
  if (rl) return rl;

  const { rpID, home } = relyingParty(req);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    timeout: CEREMONY_TIMEOUT_MS,
  });
  const cookie = await saveChallenge(db, options.challenge, { kind: 'login' });
  return withCookies(json(home ? { ...options, home } : options), cookie);
}

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number | string;
  transports: string | null;
}

/** POST /api/auth/passkey/login/verify — body: the browser's AuthenticationResponseJSON. */
export async function authenticationVerify(req: Request): Promise<Response> {
  const response = await readJson<AuthenticationResponseJSON>(req, 100_000);
  if (!response || typeof response !== 'object' || typeof response.id !== 'string' || !response.response) {
    return error(400, 'bad_request', 'Expected a passkey sign-in response.');
  }

  const db = await ready();
  const taken = await takeChallenge(db, req, 'login');
  if (!taken.ok) return taken.response;

  const rows = await db.query<PasskeyRow>(
    `select p.id, p.user_id, p.public_key, p.counter, p.transports
       from orb_passkeys p join orb_users u on u.id = p.user_id
      where p.id = $1`,
    [response.id],
  );
  const row = rows[0];
  if (!row) {
    return withCookies(
      error(404, 'unknown_passkey', "This passkey isn't connected to an Orb account anymore. Create a new one instead."),
      clearChallengeCookie(),
    );
  }

  // The user handle (our user id) is signed by the authenticator; it must match the stored owner.
  const handle = response.response.userHandle;
  if (handle && Buffer.from(handle, 'base64url').toString('utf8') !== row.user_id) return verifyFailed();

  const { rpID, origin } = relyingParty(req);
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: taken.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: Number(row.counter) || 0,
        transports: row.transports ? row.transports.split(',') : undefined,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    console.warn('[orb] passkey sign-in rejected:', e instanceof Error ? e.message : e);
    return verifyFailed();
  }
  if (!verification.verified) return verifyFailed();

  await db.query(`update orb_passkeys set counter = $2 where id = $1`, [row.id, verification.authenticationInfo.newCounter]);
  const viewer = getViewer(req);
  await linkDeviceToUser(db, viewer.deviceHash, row.user_id);
  return withCookies(await signedIn(db, viewer, row.user_id), clearChallengeCookie());
}

// ---------------------------------------------------------------------------------------------
// Logout

/**
 * POST /api/auth/logout — clears the session and unlinks this device from its account. The device
 * also stops owning the account's worlds (they were claimed by the account at sign-in or created
 * while signed in), so a shared computer doesn't keep edit access to — or a view of the private —
 * worlds of whoever signed out. It forgets the account's name too (signing up gave the device that
 * name): the browser picks a new guest name. Signing in again restores access through the account.
 */
export async function logout(req: Request): Promise<Response> {
  const viewer = getViewer(req);
  if (viewer.deviceHash) {
    const db = await ready();
    await db.query(
      `with dev as (
         select user_id from orb_devices where hash = $1
       ), unlinked as (
         update orb_devices set user_id = null, name = null where hash = $1
       )
       update orb_worlds set owner_device = null
        where owner_device = $1 and owner_user is not null
          and (owner_user = $2::text or owner_user = (select user_id from dev))`,
      [viewer.deviceHash, viewer.userId],
    );
  }
  return withCookies(json({ ok: true }), clearSessionCookie());
}
