#!/usr/bin/env node
// End-to-end tests for moving Orb to a new domain (docs/operations.md "Moving to a new domain"): the redirects
// on former addresses (next.config.ts), the hand-off (src/server/move.ts, src/app/move) and
// passkeys across addresses, including the round trip through the passkey home
// (src/server/origins.ts, src/lib/passkey.ts). Runs src/server/__tests__/move.test.mjs first.
//
//   node scripts/test-move.mjs
//
// Starts `next dev` on :3333 (ORB_TEST_PORT) with a fresh database (.data/pglite-move) and
//   NEXT_PUBLIC_SITE_URL=http://new.localhost:3333  ORB_FORMER_ORIGINS=http://localhost:3333
//   ORB_PASSKEY_RP_ID=localhost  ORB_MOCK_AI=1
// so http://localhost:3333 plays Orb's old address (and passkey home) and http://new.localhost:3333
// the new one. Chromium resolves *.localhost itself; Node's requests go to localhost with the
// address's Host header. A server already answering there with these settings is used as is.
// Chromium refuses the RP ID "localhost" on new.localhost, so passkeys on the new address take the
// round trip that browsers without Related Origin Requests take. Exit code 0 = all checks passed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch } from '../kit/lib/browser.mjs';
import { addAuthenticator, check, finish, inPage, root, section, startNext, stopNext } from './harness.mjs';

const PORT = process.env.ORB_TEST_PORT || '3333';
const OLD = `http://localhost:${PORT}`;
const NEW = `http://new.localhost:${PORT}`;
const FROM = `localhost%3A${PORT}`;
const DATA_DIR = '.data/pglite-move';
const SETTINGS = { NEXT_PUBLIC_SITE_URL: NEW, ORB_FORMER_ORIGINS: OLD, ORB_PASSKEY_RP_ID: 'localhost' };
const ORIGINS = [NEW, 'https://localhost', OLD];

// ------------------------------------------------------------------------------------------
// Dev server

/** A request from Node to this machine, with the URL's own Host header. */
function raw(url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: u.port, method, path: u.pathname + u.search, headers: { host: u.host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(180_000, () => req.destroy(new Error(`timeout: ${url}`)));
    req.end(body);
  });
}

async function serverState() {
  try {
    const res = await raw(`${OLD}/.well-known/webauthn`);
    return res.status === 200 && JSON.stringify(JSON.parse(res.text).origins) === JSON.stringify(ORIGINS) ? 'ready' : 'other';
  } catch {
    return 'down';
  }
}

async function ensureServer() {
  const state = await serverState();
  if (state === 'ready') return null;
  if (state === 'other') throw new Error(`Something without the move settings is answering on :${PORT}. Stop it first.`);
  fs.rmSync(path.join(root, DATA_DIR), { recursive: true, force: true });
  console.log(`Starting next dev on :${PORT} (data: ${DATA_DIR}) …`);
  return startNext({ port: PORT, env: { ...SETTINGS, ORB_MOCK_AI: '1', ORB_PGLITE_DIR: DATA_DIR }, ready: async () => (await serverState()) === 'ready', echo: true });
}

// ------------------------------------------------------------------------------------------
// Browser helpers

/** A fresh browser (own cookies and storage), optionally with a virtual passkey authenticator. */
async function newBrowser(browser, { passkeys = false, init } = {}) {
  const context = await browser.newContext();
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  if (passkeys) await addAuthenticator(context, page);
  const visited = [];
  page.on('framenavigated', (f) => f === page.mainFrame() && visited.push(f.url()));
  page.on('pageerror', (e) => console.log('    [pageerror]', e.message));
  return { context, page, visited };
}

async function openHarness(page, origin) {
  await page.goto(`${origin}/dev/passkey`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__orbPasskey, null, { timeout: 180_000 });
}

/** Start a navigation (it may hop across addresses) and wait until it settles on `url`. */
async function travel(page, from, url) {
  await page.goto(from, { waitUntil: 'commit' });
  await page.waitForURL((u) => u.href === url, { timeout: 180_000 });
}

/** fetch() from the page (its cookies, and its device key unless `device: false`). */
function api(page, url, { method = 'GET', headers = {}, body, device = true } = {}) {
  return page.evaluate(
    async ({ url, method, headers, body, device }) => {
      const key = localStorage.getItem('orb:device');
      const res = await fetch(url, {
        method,
        headers: { ...(device && key ? { 'x-orb-device': key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json, bytes: text.length, pack: res.headers.get('x-orb-pack') };
    },
    { url, method, headers, body, device },
  );
}

const storage = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('orb:')).map((k) => [k, localStorage.getItem(k)])));
const setStorage = (page, entries) => page.evaluate((e) => Object.entries(e).forEach(([k, v]) => localStorage.setItem(k, v)), entries);
const cookie = async (context, origin, name) => (await context.cookies(origin)).find((c) => c.name === name && c.value) ?? null;

const thread = (id, updatedAt) => ({ id, worldId: 'new', title: `Chat ${id}`, createdAt: 1, updatedAt });
const messages = (text) => JSON.stringify([{ id: `m-${text.length}`, role: 'user', text, createdAt: 1 }]);
const chatIds = (s) => JSON.parse(s['orb:chats'] || '[]').map((t) => t.id);

/**
 * A hand-off begun for browser `b` (its pick-up cookie set) but held before the old address's
 * /move sends anything. Returns that page's query: s, back, to.
 */
async function heldHandoff(b, to) {
  const res = await raw(`${NEW}/api/move/start/${FROM}${to}`);
  const state = [].concat(res.headers['set-cookie'] || []).find((c) => c.startsWith('orb_move_')) || '';
  const [name, value] = state.split(';')[0].split('=');
  await b.context.addCookies([{ name, value, domain: 'new.localhost', path: '/api/move', httpOnly: true, sameSite: 'Lax' }]);
  return Object.fromEntries(new URL(res.headers.location || '/', NEW).searchParams);
}

/** What the old address's /move sends for a held hand-off: `entries` as JSON, as the device `key`. */
async function sendHeld(q, { entries, key, headers = {} } = {}) {
  const res = await raw(`${OLD}/api/move`, {
    method: 'POST',
    headers: { 'x-orb-move': q.s, 'x-orb-back': q.back, 'x-orb-to': q.to, 'x-orb-pack': 'json', ...(key ? { 'x-orb-device': key } : {}), ...headers },
    body: entries ? JSON.stringify(entries) : undefined,
  });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {}
  return { status: res.status, json, cookies: [].concat(res.headers['set-cookie'] || []) };
}

// ------------------------------------------------------------------------------------------

async function main() {
  await section('Unit tests (src/server/__tests__/move.test.mjs)', async () => {
    const r = spawnSync(process.execPath, ['--test', '--experimental-strip-types', 'src/server/__tests__/move.test.mjs'], { cwd: root, encoding: 'utf8' });
    const counts = (r.stdout.match(/^# (pass|fail) \d+$/gm) || []).map((l) => l.slice(2)).join(', ');
    check(`all pass (${counts})`, r.status === 0, r.stdout.split('\n').filter((l) => /^\s*not ok/.test(l)).join(' | ') || r.stderr.slice(-500));
  });

  const server = await ensureServer();
  const browser = await launch();
  const contexts = [];
  const fresh = async (opts) => {
    const b = await newBrowser(browser, opts);
    contexts.push(b.context);
    return b;
  };
  try {
    await section('Redirects on the old address; the API, files and /move stay put', async () => {
      const wk = await raw(`${OLD}/.well-known/webauthn`);
      check('/.well-known/webauthn lists every address (JSON)', wk.status === 200 && /^application\/json/.test(wk.headers['content-type']) && wk.text === JSON.stringify({ origins: ORIGINS }), wk.text);
      const doc = { 'sec-fetch-dest': 'document' };
      const crawler = await raw(`${OLD}/w/abc?x=1`);
      check('a crawler or link preview gets a 308 to the same page', crawler.status === 308 && crawler.headers.location === `${NEW}/w/abc?x=1`, [crawler.status, crawler.headers.location]);
      const visit = await raw(`${OLD}/w/abc?x=1`, { headers: doc });
      check('a page visit goes through the hand-off', visit.status === 307 && visit.headers.location === `${NEW}/api/move/start/${FROM}/w/abc?x=1`, [visit.status, visit.headers.location]);
      const home = await raw(`${OLD}/?ref=hn`, { headers: doc });
      check('…the home page too', home.status === 307 && home.headers.location === `${NEW}/api/move/start/${FROM}?ref=hn`, [home.status, home.headers.location]);
      const moved = await raw(`${OLD}/w/abc`, { headers: { ...doc, cookie: 'orb_moved=1' } });
      check('a browser that already moved gets a 308', moved.status === 308 && moved.headers.location === `${NEW}/w/abc`, [moved.status, moved.headers.location]);
      for (const p of ['/api/me', '/.well-known/webauthn', '/move', '/robots.txt', '/dev/passkey']) {
        const r = await raw(`${OLD}${p}`, { headers: doc });
        check(`${p} isn't redirected`, r.status === 200, r.status);
      }
      const here = await raw(`${NEW}/w/abc`, { headers: doc });
      check('the new address never redirects', here.status !== 307 && here.status !== 308, here.status);

      const start = await raw(`${NEW}/api/move/start/${FROM}/w/abc?x=1`);
      const next = new URL(start.headers.location || '/', NEW);
      const state = [].concat(start.headers['set-cookie'] || []).find((c) => c.startsWith('orb_move_')) || '';
      check(
        'start: on to the old address’s /move, with a cookie only this browser has',
        start.status === 302 &&
          next.origin === OLD &&
          next.pathname === '/move' &&
          /^[0-9A-Za-z]{10}\.[0-9A-Za-z]{32}$/.test(next.searchParams.get('s') || '') &&
          next.searchParams.get('back') === NEW &&
          next.searchParams.get('to') === '/w/abc?x=1' &&
          state.startsWith(`orb_move_${next.searchParams.get('s').split('.')[0]}=${next.searchParams.get('s').split('.')[1]};`) &&
          /HttpOnly/.test(state) &&
          /Path=\/api\/move/.test(state),
        [start.status, start.headers.location, state],
      );
      const unknown = await raw(`${NEW}/api/move/start/elsewhere.example/w/abc`);
      check('start from an address that isn’t a former one just lands', unknown.status === 302 && unknown.headers.location === '/w/abc', [unknown.status, unknown.headers.location]);
      const onOld = await raw(`${OLD}/api/move/start/${FROM}/w/abc`);
      check('start only answers on the new address', onOld.status === 404, onOld.status);
    });

    // One person's browser, from their first visit on the old address to signing in on the new one.
    const A = await fresh({ passkeys: true });
    let user = null;
    let deviceKey = '';
    let worldBefore = '';
    let worldAfter = '';
    let carried = {};
    await section('On the old address: an account, worlds, chats and settings', async () => {
      await openHarness(A.page, OLD);
      deviceKey = await A.page.evaluate(() => window.__orbPasskey.deviceKey());
      worldBefore = await A.page.evaluate(() => window.__orbPasskey.seedWorld('Made before signing up'));
      const res = await inPage(A.page, (n) => window.__orbPasskey.signUp(n), 'Mover');
      user = res.value?.user ?? null;
      check('signed up with a passkey', res.ok && /^u_/.test(user?.id || ''), res.ok ? res.value : res.error);
      const created = await api(A.page, '/api/worlds', { method: 'POST', body: { name: 'Made signed in', code: '<!doctype html><title>t</title>' } });
      worldAfter = created.json?.world?.id ?? '';
      check('made a world', created.status < 300 && !!worldAfter, created.status);
      carried = {
        'orb:chats': JSON.stringify([thread('castle', 2000), thread('garden', 1000)]),
        'orb:chat:castle': messages('Build me a castle in the clouds'),
        'orb:chat:garden': messages('A tiny garden with fireflies'),
        'orb:model': JSON.stringify({ provider: 'openrouter', model: 'test/model' }),
        'orb:pos': JSON.stringify({ side: 'left', y: 0.25 }),
        [`orb:ls:${worldAfter}`]: JSON.stringify({ best: '42' }),
      };
      await setStorage(A.page, carried);
      const s = await storage(A.page);
      check('chats, settings and a saved game are in this browser', Object.keys(carried).every((k) => s[k] === carried[k]));
    });

    await section('An old link opens the same page on the new address, signed in, with everything', async () => {
      const from = A.visited.length;
      await travel(A.page, `${OLD}/w/${worldAfter}?via=link#top`, `${NEW}/w/${worldAfter}?via=link#top`);
      const hops = A.visited.slice(from);
      check('went through /move on both addresses', hops.some((u) => u.startsWith(`${OLD}/move?s=`)) && hops.some((u) => u.startsWith(`${NEW}/move?code=`)), hops);
      const s = await storage(A.page);
      check('the same device key', s['orb:device'] === deviceKey, s['orb:device']);
      check('chats came along, messages and all', Object.keys(carried).filter((k) => k.startsWith('orb:chat')).every((k) => s[k] === carried[k]));
      check('settings and saved games came along', ['orb:model', 'orb:pos', `orb:ls:${worldAfter}`].every((k) => s[k] === carried[k]));
      const me = await api(A.page, '/api/me');
      check('signed in as the same account', me.json?.user?.id === user?.id, me.json);
      for (const [name, id] of [['made before signing up', worldBefore], ['made signed in', worldAfter]]) {
        const w = await api(A.page, `/api/worlds/${id}`);
        check(`the world ${name} is still theirs to edit`, w.json?.world?.canEdit === true, w.json?.world?.canEdit);
      }
      const session = (await A.context.cookies(NEW)).find((c) => c.name === 'orb_session');
      check('the session cookie is HttpOnly on the new address', !!session && session.httpOnly && session.sameSite === 'Lax');
      check('the hand-off’s cookie is gone', !(await A.context.cookies(NEW)).some((c) => c.name.startsWith('orb_move_') && c.value));
      check('the old address remembers this browser moved', !!(await cookie(A.context, OLD, 'orb_moved')));
      await A.page.goBack({ waitUntil: 'commit' });
      check('Back skips the hand-off', A.page.url() === `${OLD}/dev/passkey`, A.page.url());
    });

    await section('The old address keeps its own copy', async () => {
      await openHarness(A.page, OLD);
      const s = await inPage(A.page, () => window.__orbPasskey.session());
      check('still signed in there', s.value?.user?.id === user?.id, s.value?.user);
      check('its storage is untouched', (await storage(A.page))['orb:chats'] === carried['orb:chats']);
    });

    await section('Visiting the old address again goes straight over', async () => {
      const from = A.visited.length;
      const res = await A.page.goto(`${OLD}/w/${worldBefore}?again=1`, { waitUntil: 'commit' });
      let first = res.request();
      while (first.redirectedFrom()) first = first.redirectedFrom();
      const r = await first.response();
      check('a 308 to the same page', r?.status() === 308 && r.headers().location === `${NEW}/w/${worldBefore}?again=1`, [r?.status(), r?.headers().location]);
      await A.page.waitForURL((u) => u.href === `${NEW}/w/${worldBefore}?again=1`, { timeout: 180_000 });
      check('no hand-off this time', !A.visited.slice(from).some((u) => new URL(u).pathname === '/move'), A.visited.slice(from));
    });

    await section('The passkey made on the old address signs in on the new one (through the passkey home)', async () => {
      await openHarness(A.page, NEW);
      const out = await inPage(A.page, () => window.__orbPasskey.logout());
      check('signed out on the new address', out.ok && (await api(A.page, '/api/me')).json?.user === null);
      const from = A.visited.length;
      await A.page.evaluate(() => void window.__orbPasskey.signIn());
      await A.page.waitForURL((u) => u.origin === OLD && u.pathname === '/move', { timeout: 60_000 });
      await A.page.waitForURL((u) => u.href === `${NEW}/dev/passkey`, { timeout: 180_000 });
      await A.page.waitForFunction(() => !!window.__orbPasskey, null, { timeout: 180_000 });
      const hops = A.visited.slice(from);
      check('there and back: the ceremony at the passkey home', hops.some((u) => u.startsWith(`${OLD}/move?s=`) && u.includes('passkey=signin')) && hops.some((u) => u.startsWith(`${NEW}/move?code=`) && u.includes('passkey=1')), hops);
      const me = await api(A.page, '/api/me');
      check('signed in as the same account', me.json?.user?.id === user?.id, me.json);
      const s = await inPage(A.page, () => window.__orbPasskey.session());
      check('this device is linked to it', s.value?.deviceUser === user?.id, s.value);
      const chats = await api(A.page, '/api/chats');
      const saved = (chats.json?.chats || []).map((c) => c.thread.id).sort();
      check('this browser’s chats were saved to the account on the way back', JSON.stringify(saved) === JSON.stringify(['castle', 'garden']), saved);
    });

    await section('Signing up on the new address works the same way', async () => {
      const G = await fresh({ passkeys: true });
      await openHarness(G.page, NEW);
      const world = await G.page.evaluate(() => window.__orbPasskey.seedWorld('Made before signing up here'));
      await G.page.evaluate(() => void window.__orbPasskey.signUp('Newcomer'));
      await G.page.waitForURL((u) => u.origin === OLD && u.pathname === '/move', { timeout: 60_000 });
      const at = new URL(G.page.url());
      check('the passkey home is asked to make a passkey for “Newcomer”', at.searchParams.get('passkey') === 'signup' && at.searchParams.get('name') === 'Newcomer', at.href);
      await G.page.waitForURL((u) => u.href === `${NEW}/dev/passkey`, { timeout: 180_000 });
      await G.page.waitForFunction(() => !!window.__orbPasskey, null, { timeout: 180_000 });
      const s = await inPage(G.page, () => window.__orbPasskey.session());
      check('signed in to the new account', s.value?.user?.name === 'Newcomer' && s.value.passkeys === 1, s.value);
      check('this browser’s world is now the account’s', (s.value?.worlds || []).some((w) => w.id === world), s.value?.worlds);
    });

    const B = await fresh();
    await section('A pick-up code works once, only in its own browser, and not for long', async () => {
      const codeFrom = (sent) => new URL(sent.json?.url || '/', NEW).searchParams.get('code') || '';
      const claim = (b, code) => api(b.page, '/api/move/claim', { method: 'POST', headers: { 'x-orb-move-code': code } });
      const key = 'k'.repeat(43);
      const q = await heldHandoff(B, '/nowhere-b');
      const sent = await sendHeld(q, { entries: { 'orb:device': key, 'orb:model': 'm' }, key });
      const next = new URL(sent.json?.url || '/', NEW);
      check('sending answers with where to pick it up', sent.status === 200 && next.origin === NEW && next.pathname === '/move' && /^[0-9A-Za-z]{32}$/.test(codeFrom(sent)) && next.searchParams.get('from') === `localhost:${PORT}` && next.searchParams.get('to') === '/nowhere-b', sent);
      check('…and remembers on the old address that this browser moved', sent.cookies.some((c) => /^orb_moved=1;.*HttpOnly/.test(c)), sent.cookies);

      const C = await fresh();
      await openHarness(C.page, NEW);
      const stranger = await claim(C, codeFrom(sent));
      check('another browser with the link can’t pick it up', stranger.status === 403 && stranger.json?.error === 'move_mismatch', stranger);
      await openHarness(B.page, NEW);
      check('…and its try used the code up', (await claim(B, codeFrom(sent))).status === 410);

      const code2 = codeFrom(await sendHeld(await heldHandoff(B, '/nowhere-b'), { entries: { 'orb:device': key }, key }));
      const first = await claim(B, code2);
      check('its own browser picks it up', first.status === 200 && first.pack === 'json' && first.json?.['orb:device'] === key, first);
      const again = await claim(B, code2);
      check('once', again.status === 410 && again.json?.error === 'move_expired', again);

      const code3 = codeFrom(await sendHeld(await heldHandoff(B, '/nowhere-b'), { entries: { 'orb:device': key }, key }));
      const expired = await api(B.page, '/dev/passkey/state', { method: 'POST', body: { action: 'expire-move', code: code3 } });
      const late = await claim(B, code3);
      check('an expired code is refused', expired.json?.expired === 1 && late.status === 410, [expired.json, late.status]);
      check('junk codes are refused', (await claim(B, 'nope')).status === 410);

      await B.page.goto(`${NEW}/move?code=${code3}&to=%2Fnowhere-again&from=${FROM}`, { waitUntil: 'domcontentloaded' });
      await B.page.getByText('That didn’t quite work').waitFor({ timeout: 60_000 });
      check('a failed pick-up says so, calmly', await B.page.getByText('We couldn’t bring your things over just now.').isVisible());
      check('…and the spent code leaves the address bar', B.page.url() === `${NEW}/move?to=%2Fnowhere-again`, B.page.url());
      const from = B.visited.length;
      await B.page.getByRole('button', { name: 'Try again' }).click();
      await B.page.waitForURL((u) => u.href === `${NEW}/nowhere-again`, { timeout: 180_000 });
      check('“Try again” starts over from the old address and lands', B.visited.slice(from).some((u) => u.startsWith(`${OLD}/move?s=`)), B.visited.slice(from));
    });

    await section('A browser with nothing to bring is simply sent on', async () => {
      const D = await fresh();
      await travel(D.page, `${OLD}/nowhere-d?q=1#x`, `${NEW}/nowhere-d?q=1#x`);
      check('through the old address’s /move, but no pick-up', D.visited.some((u) => u.startsWith(`${OLD}/move?s=`)) && !D.visited.some((u) => u.startsWith(`${NEW}/move`)), D.visited);
      check('the old address remembers', !!(await cookie(D.context, OLD, 'orb_moved')));
    });

    await section('Where a hand-off ends can’t point anywhere else', async () => {
      const q = await heldHandoff(B, '/nowhere-b');
      for (const to of ['https://evil.example/x', '//evil.example', '/..//evil.example', '/\\evil.example']) {
        const r = await sendHeld({ ...q, to });
        check(`to=${to} → the new address’s home`, r.status === 200 && r.json?.url === `${NEW}/`, r);
      }
      const r = await sendHeld({ ...q, back: 'https://evil.example' });
      check('an end address that isn’t Orb’s is refused', r.status === 400, r);
      const onNew = await raw(`${NEW}/api/move`, { method: 'POST', headers: { 'x-orb-move': q.s, 'x-orb-back': q.back, 'x-orb-to': q.to } });
      check('only a former address sends', onNew.status === 404, onNew.status);
      await travel(B.page, `${NEW}/move?to=%2F..%2F%2Fevil.example`, `${NEW}/`);
      check('the /move page itself only lands on this site', new URL(B.page.url()).origin === NEW);
    });

    await section('Merging into a browser that already used the new address', async () => {
      const E = await fresh();
      await openHarness(E.page, NEW);
      const ownKey = await E.page.evaluate(() => window.__orbPasskey.deviceKey());
      const ownWorld = await E.page.evaluate(() => window.__orbPasskey.seedWorld('Made on the new address'));
      await setStorage(E.page, {
        'orb:name': 'New Wren',
        'orb:model': 'mine',
        'orb:chats': JSON.stringify([thread('shared', 100), thread('new-only', 50)]),
        'orb:chat:shared': messages('older copy'),
        'orb:chat:new-only': messages('only here'),
      });
      await openHarness(E.page, OLD);
      const oldKey = await E.page.evaluate(() => window.__orbPasskey.deviceKey());
      const oldWorld = await E.page.evaluate(() => window.__orbPasskey.seedWorld('Made on the old address'));
      await setStorage(E.page, {
        'orb:name': 'Old Otter',
        'orb:model': 'theirs',
        'orb:chats': JSON.stringify([thread('shared', 200), thread('old-only', 150)]),
        'orb:chat:shared': messages('newer copy'),
        'orb:chat:old-only': messages('only there'),
        [`orb:ls:${oldWorld}`]: '{"level":"3"}',
      });
      await travel(E.page, `${OLD}/nowhere-e`, `${NEW}/nowhere-e`);
      const s = await storage(E.page);
      check('the carried device key replaces this browser’s', s['orb:device'] === oldKey && oldKey !== ownKey);
      check('…and brings its name', s['orb:name'] === 'Old Otter', s['orb:name']);
      check('this browser keeps its own settings', s['orb:model'] === 'mine', s['orb:model']);
      check('chats merge: all three, newest first', JSON.stringify(chatIds(s)) === JSON.stringify(['shared', 'old-only', 'new-only']), chatIds(s));
      check('…the newer copy of a shared chat wins', s['orb:chat:shared'] === messages('newer copy') && s['orb:chat:old-only'] === messages('only there') && s['orb:chat:new-only'] === messages('only here'));
      check('saved games came along', s[`orb:ls:${oldWorld}`] === '{"level":"3"}');
      const mine = await api(E.page, `/api/worlds/${ownWorld}`);
      check('this browser’s world now belongs to the carried key', mine.json?.world?.canEdit === true, mine.json?.world?.canEdit);
      const byOldKey = await api(E.page, `/api/worlds/${ownWorld}`, { device: false, headers: { 'x-orb-device': ownKey } });
      check('…not to the replaced one', byOldKey.json?.world?.canEdit === false, byOldKey.json?.world?.canEdit);
      check('the old address’s world is editable here', (await api(E.page, `/api/worlds/${oldWorld}`)).json?.world?.canEdit === true);
    });

    await section('Too much to bring: the bulkiest stays behind, and the card says so', async () => {
      const F = await fresh({ init: () => (window.__orbMoveMaxBytes = 30_000) });
      await openHarness(F.page, OLD);
      const huge = await F.page.evaluate(() => Array.from({ length: 300_000 }, () => Math.floor(Math.random() * 16).toString(16)).join(''));
      await setStorage(F.page, {
        'orb:chats': JSON.stringify([thread('huge', 300), thread('tiny', 200)]),
        'orb:chat:huge': messages(huge),
        'orb:chat:tiny': messages('hi'),
        'orb:model': 'kept',
      });
      const key = await F.page.evaluate(() => window.__orbPasskey.deviceKey());
      await F.page.goto(`${OLD}/nowhere-f`, { waitUntil: 'commit' });
      await F.page.getByText('You’re all moved in').waitFor({ timeout: 180_000 });
      check('the card says a few things couldn’t come along', await F.page.getByText('A few very large chats or saved games couldn’t come along.').isVisible());
      await F.page.getByRole('button', { name: 'Continue' }).click();
      await F.page.waitForURL((u) => u.href === `${NEW}/nowhere-f`, { timeout: 60_000 });
      const s = await storage(F.page);
      check('the huge chat stayed behind, and isn’t listed empty', !s['orb:chat:huge'] && JSON.stringify(chatIds(s)) === JSON.stringify(['tiny']), chatIds(s));
      check('everything else came along', s['orb:chat:tiny'] === messages('hi') && s['orb:model'] === 'kept' && s['orb:device'] === key);
    });
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close();
    await stopNext(server);
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
