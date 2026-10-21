#!/usr/bin/env node
// End-to-end tests for accounts (passkeys, src/server/passkeys.ts + src/lib/passkey.ts) and the
// GitHub OAuth routes, driven through the dev harness page /dev/passkey.
//
//   ORB_MOCK_AI=1 ORB_PGLITE_DIR=.data/pglite-accounts npx next dev -p 3104 &   # or let the script start it
//   node scripts/test-passkeys.mjs                  # ORB_TEST_BASE=http://localhost:3104 by default
//
// If nothing answers on the base URL, the script wipes .data/pglite-accounts, starts `next dev`
// itself (with fake GITHUB_CLIENT_ID/SECRET so the OAuth redirect logic can be exercised) and stops
// it at the end. Exit code 0 = all checks passed.
//
// Passkeys use Chrome's CDP virtual authenticator (ctap2, internal, resident keys, UV).
import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../kit/lib/browser.mjs';
import { addAuthenticator, check, finish, inPage, options, root, section, startNext, stopNext } from './harness.mjs';

options.details = true;
const BASE = (process.env.ORB_TEST_BASE || 'http://localhost:3104').replace(/\/$/, '');
const PORT = new URL(BASE).port || '3104';
const DATA_DIR = process.env.ORB_PGLITE_DIR || '.data/pglite-accounts';

// ------------------------------------------------------------------------------------------
// Dev server

async function ensureServer() {
  try {
    if ((await fetch(`${BASE}/dev/passkey`, { signal: AbortSignal.timeout(90_000) })).ok) return null;
  } catch {}
  fs.rmSync(path.join(root, DATA_DIR), { recursive: true, force: true });
  console.log(`Starting next dev on :${PORT} (data: ${DATA_DIR}) …`);
  return startNext({
    port: PORT,
    ready: '/dev/passkey',
    echo: true,
    env: {
      ORB_MOCK_AI: '1',
      ORB_PGLITE_DIR: DATA_DIR,
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || 'orb-test-client',
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || 'orb-test-secret',
    },
  });
}

// ------------------------------------------------------------------------------------------
// Browser helpers

/** A fresh browser context (= a new device: own localStorage key, own cookies) with a virtual authenticator. */
async function newDevice(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { cdp, authenticatorId } = await addAuthenticator(context, page);
  page.on('pageerror', (e) => console.log('    [pageerror]', e.message));
  await openHarness(page);
  return { context, page, cdp, authenticatorId };
}

async function openHarness(page, hash = '') {
  await page.goto(`${BASE}/dev/passkey${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__orbPasskey, null, { timeout: 60_000 });
}

/** The server's view of this page's cookie + device (dev-only /dev/passkey/state). */
function serverSession(page) {
  return page.evaluate(() => window.__orbPasskey.session());
}

/** /api/me, as this page's device. */
function apiMe(page) {
  return page.evaluate(async () => (await fetch('/api/me', { headers: { 'x-orb-device': window.__orbPasskey.deviceKey() } })).json());
}

async function postJson(page, url, body, headers = {}) {
  return page.evaluate(
    async ({ url, body, headers }) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-orb-device': window.__orbPasskey.deviceKey(), ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, json };
    },
    { url, body, headers },
  );
}

/** A world this page's device makes without an account (its id). */
async function createAnonymousWorld(page, name) {
  const viaApi = await postJson(page, '/api/worlds', { name, code: '<!doctype html><title>t</title>' });
  if (viaApi.status < 200 || viaApi.status >= 300) throw new Error(`POST /api/worlds → ${viaApi.status}`);
  return viaApi.json.world.id;
}

// ------------------------------------------------------------------------------------------

async function main() {
  const server = await ensureServer();
  const browser = await launch();
  try {
    const A = await newDevice(browser);
    let userId = null;
    let deviceIdA = null;
    let worldA = null;

    await section('Passkey endpoints reject bad input', async () => {
      const noName = await postJson(A.page, '/api/auth/passkey/register/options', { name: '   ' });
      check('register/options without a name → 400 name_required', noName.status === 400 && noName.json?.error === 'name_required', noName);
      const noChal = await postJson(A.page, '/api/auth/passkey/register/verify', { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'x', attestationObject: 'x' } });
      check('register/verify without a challenge → 400 challenge_expired', noChal.status === 400 && noChal.json?.error === 'challenge_expired', noChal);
      const junk = await postJson(A.page, '/api/auth/passkey/login/verify', 'not json');
      check('login/verify with junk → 400 bad_request', junk.status === 400 && junk.json?.error === 'bad_request', junk);
    });

    await section('Sign up claims the anonymous world', async () => {
      check('passkeysSupported()', await A.page.evaluate(() => window.__orbPasskey.supported()));
      worldA = await createAnonymousWorld(A.page, 'Anonymous castle');
      check('anonymous world created', typeof worldA === 'string' && worldA.length > 0, worldA);

      const before = await serverSession(A.page);
      check('not signed in before sign-up', before.user === null);

      const res = await inPage(A.page, (name) => window.__orbPasskey.signUp(name), '  Test   Pilot 🚀  ');
      check('signUp() resolves', res.ok, res.ok ? undefined : res.error);
      const me = res.value;
      userId = me?.user?.id;
      deviceIdA = me?.deviceId;
      check('MeResponse.user.id is u_ + 12', /^u_[0-9A-Za-z]{12}$/.test(userId || ''), userId);
      check('name is cleaned ("Test Pilot 🚀")', me?.user?.name === 'Test Pilot 🚀' && me?.name === 'Test Pilot 🚀', me?.user?.name);
      check('deviceId is the 12-char public id', /^[0-9a-f]{12}$/.test(me?.deviceId || ''), me?.deviceId);

      const cookies = await A.context.cookies(BASE);
      const session = cookies.find((c) => c.name === 'orb_session');
      check('session cookie set (HttpOnly, Lax)', !!session && session.httpOnly && session.sameSite === 'Lax');
      check('challenge cookie cleared', !cookies.some((c) => c.name === 'orb_chal' && c.value));

      const meApi = await apiMe(A.page);
      check('/api/me shows the user', meApi.user?.id === userId, meApi);
      const s = await serverSession(A.page);
      check('server sees the session user', s.user?.id === userId && s.user?.name === 'Test Pilot 🚀', s.user);
      check('anonymous world now owned by the user', s.worlds.some((x) => x.id === worldA), s.worlds);
      check('one passkey stored', s.passkeys === 1, s.passkeys);
      check('device linked to the user', s.deviceUser === userId, s.deviceUser);
    });

    let assertionBody = null;
    await section('Log out, sign in again → same user', async () => {
      const out = await inPage(A.page, () => window.__orbPasskey.logout());
      check('logout → { ok: true }', out.ok && out.value?.ok === true, out);
      const cookies = await A.context.cookies(BASE);
      check('session cookie removed', !cookies.some((c) => c.name === 'orb_session' && c.value));
      const s = await serverSession(A.page);
      check('server sees no session after logout', s.user === null);
      check('device unlinked from the user', s.deviceUser === null, s.deviceUser);
      const meApi = await apiMe(A.page);
      check('/api/me shows no user after logout', meApi.user === null, meApi);

      A.page.on('request', (r) => {
        if (r.url().endsWith('/api/auth/passkey/login/verify')) assertionBody = r.postData();
      });
      const res = await inPage(A.page, () => window.__orbPasskey.signIn());
      check('signIn() resolves', res.ok, res.ok ? undefined : res.error);
      check('same user after sign-in', res.value?.user?.id === userId, res.value?.user);
      const s2 = await serverSession(A.page);
      check('server session restored + device relinked', s2.user?.id === userId && s2.deviceUser === userId, s2);

      const again = await inPage(A.page, () => window.__orbPasskey.signIn());
      check('second sign-in works (counter advances)', again.ok && again.value?.user?.id === userId, again.ok ? undefined : again.error);
    });

    await section('Replay protection', async () => {
      check('captured an assertion', !!assertionBody);
      const replay = await postJson(A.page, '/api/auth/passkey/login/verify', assertionBody);
      check('replayed assertion is rejected (challenge consumed)', replay.status === 400, replay);
      // Fresh challenge, but an old signature over a different challenge.
      await postJson(A.page, '/api/auth/passkey/login/options', {});
      const stale = await postJson(A.page, '/api/auth/passkey/login/verify', assertionBody);
      check('old assertion against a new challenge is rejected', stale.status === 400 && stale.json?.error === 'passkey_failed', stale);
    });

    await section('Synced passkey on a second device', async () => {
      const B = await newDevice(browser);
      const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authenticatorId });
      check('virtual authenticator holds a resident credential', credentials.length === 1 && credentials[0].isResidentCredential, credentials.length);
      await B.cdp.send('WebAuthn.addCredential', { authenticatorId: B.authenticatorId, credential: credentials[0] });

      const phoneWorld = await createAnonymousWorld(B.page, 'Phone world');
      const res = await inPage(B.page, () => window.__orbPasskey.signIn());
      check('device B signs in as the same user', res.ok && res.value?.user?.id === userId, res.ok ? res.value?.user : res.error);
      check('device B has its own deviceId', /^[0-9a-f]{12}$/.test(res.value?.deviceId || '') && res.value.deviceId !== deviceIdA, res.value?.deviceId);
      const s = await serverSession(B.page);
      check("device B's anonymous world is claimed too", s.worlds.some((x) => x.id === phoneWorld) && s.worlds.some((x) => x.id === worldA), s.worlds.map((x) => x.name));

      // A cancelled/dismissed system prompt surfaces as Error('cancelled').
      const cancelled = await inPage(B.page, async () => {
        const orig = navigator.credentials.get.bind(navigator.credentials);
        navigator.credentials.get = () => Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
        try {
          return await window.__orbPasskey.signIn();
        } finally {
          navigator.credentials.get = orig;
        }
      });
      check("dismissed prompt → Error('cancelled')", !cancelled.ok && cancelled.error === 'cancelled', cancelled);
      await B.context.close();
    });

    await section('Names are sanitised and capped at 40 characters', async () => {
      const C = await newDevice(browser);
      const long = 'A\u0007very\u202e long\tname '.repeat(6);
      const res = await inPage(C.page, (n) => window.__orbPasskey.signUp(n), long);
      const name = res.value?.user?.name || '';
      check('sign-up with a long, messy name', res.ok, res.ok ? undefined : res.error);
      check('stored name ≤ 40 chars, no control/bidi characters', [...name].length <= 40 && !/[\u0000-\u001f\u202e]/.test(name) && name.startsWith('Avery long name'), name);
      check('a different account from the first one', res.value?.user?.id && res.value.user.id !== userId);
      await C.context.close();
    });

    await section('GitHub OAuth routes', async () => {
      const req = A.context.request;
      const login = await req.get(`${BASE}/api/github/login?next=/w/abc123`, { maxRedirects: 0 });
      if (login.status() === 404) {
        const body = await login.json();
        check('not configured → 404 JSON not_configured', body.error === 'not_configured', body);
        return;
      }
      check('login → 302', login.status() === 302, login.status());
      const loc = new URL(login.headers()['location']);
      check('redirects to GitHub authorize', loc.origin + loc.pathname === 'https://github.com/login/oauth/authorize', loc.toString());
      check('scope=repo, redirect_uri = <origin>/api/github/callback', loc.searchParams.get('scope') === 'repo' && loc.searchParams.get('redirect_uri') === `${BASE}/api/github/callback`, loc.searchParams.get('redirect_uri'));
      const state = loc.searchParams.get('state');
      const setCookie = login.headers()['set-cookie'] || '';
      check('state cookie is HttpOnly + SameSite=Lax', /orb_gh_state=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), setCookie);

      const wrong = await req.get(`${BASE}/api/github/callback?code=abc&state=nope`, { maxRedirects: 0 });
      check('wrong state → #gh_error=state', wrong.status() === 302 && wrong.headers()['location'] === `${BASE}/w/abc123#gh_error=state`, wrong.headers()['location']);

      // The previous callback cleared the cookie; start again for the remaining checks.
      const login2 = await req.get(`${BASE}/api/github/login`, { maxRedirects: 0 });
      const state2 = new URL(login2.headers()['location']).searchParams.get('state');
      const denied = await req.get(`${BASE}/api/github/callback?error=access_denied&state=${state2}`, { maxRedirects: 0 });
      check('user declined → /#gh_error=access_denied', denied.headers()['location'] === `${BASE}/#gh_error=access_denied`, denied.headers()['location']);

      const login3 = await req.get(`${BASE}/api/github/login`, { maxRedirects: 0 });
      const state3 = new URL(login3.headers()['location']).searchParams.get('state');
      const exch = await req.get(`${BASE}/api/github/callback?code=fake-code&state=${state3}`, { maxRedirects: 0, timeout: 30_000 });
      // GitHub is unreachable from the sandbox (or rejects the fake client) → exchange error.
      check('valid state + failing code exchange → #gh_error=exchange', exch.headers()['location'] === `${BASE}/#gh_error=exchange`, exch.headers()['location']);
      check('state is single-use', state !== state2 && state2 !== state3);
    });

    await A.context.close();
  } finally {
    await browser.close();
    await stopNext(server);
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
